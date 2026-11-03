"""Convertit les fichiers CDS téléchargés en données pour l'application web.

Entrées : data/raw/<indicateur>__<produit>.zip (voir fetch_cds.py), limites NUTS 2 de GISCO.
Sorties : web/data/indicators.json et web/data/nuts2.geojson.

Pour chaque région et indicateur :
- v  : moyenne multi-modèles [climat actuel 1991–2020, +1,5 °C, +2 °C, +3 °C]
       (climat actuel = valeur au GWL − écart au GWL par rapport à 1991–2020)
- lo, hi : quantiles 17 % et 83 % entre modèles aux mêmes GWL (null pour le climat actuel)

Usage :
    python scripts/build_data.py --inspect   # décrit les fichiers de data/raw
    python scripts/build_data.py
"""

import argparse
import io
import json
import math
import urllib.request
import zipfile
from pathlib import Path

import xarray as xr

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data" / "indicators.json"
NUTS_OUT = ROOT / "web" / "data" / "nuts2.geojson"

# Le CDS utilise le découpage NUTS 2024, plus les régions britanniques de 2021.
GISCO = "https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_20M_{year}_4326_LEVL_2.geojson"

GWLS = ["1.5", "2", "3"]

# Sens de lecture (+1 : plus haut = plus exposé), identique à web/risk-model.js.
DIRECTIONS = {
    "hot_days": 1, "hot_days_35": 1, "heatwave_days": 1, "tropical_nights": 1, "cooling_degree_days": 1,
    "frost_days": 1, "extreme_precipitation_total": 1, "maximum_consecutive_five_day_precipitation": 1,
    "consecutive_dry_days": 1, "duration_of_meteorological_droughts": 1,
    "extreme_wind_speed_days": 1, "days_with_high_fire_danger": 1,
}


def open_raw(indicator, product):
    """Ouvre le NetCDF contenu dans data/raw/<indicateur>__<produit>.zip."""
    path = RAW_DIR / f"{indicator}__{product}.zip"
    if not path.exists():
        return None
    with zipfile.ZipFile(path) as z:
        names = [n for n in z.namelist() if n.endswith(".nc")]
        content = z.read(names[0])
    return xr.open_dataset(io.BytesIO(content), engine="h5netcdf")


def squeeze_var(ds, indicator):
    da = ds[indicator] if indicator in ds else ds[list(ds.data_vars)[0]]
    # Indicateurs annuels : la dimension « month » ne contient qu'une valeur.
    return da.squeeze([d for d in da.dims if d not in ("gwl", "nuts", "quantile", "ref_period") and da.sizes[d] == 1])


def clean(x):
    x = float(x)
    return None if math.isnan(x) else round(x, 2)


def build_indicators():
    regions, units = {}, {}
    for indicator in DIRECTIONS:
        gwl, change, quant = (open_raw(indicator, p) for p in ("gwl", "gwl_absolute_change", "gwl_uncertainty_quantiles"))
        if gwl is None or change is None:
            print(f"absent : {indicator}")
            continue
        level = squeeze_var(gwl, indicator)
        delta = squeeze_var(change, indicator).sel(ref_period="1991-01-01")
        q = squeeze_var(quant, indicator) if quant is not None else None
        units[indicator] = level.attrs.get("units", "")

        for code in map(str, level.nuts.values):
            lv = [level.sel(nuts=code, gwl=g).item() for g in GWLS]
            # Référence 1991–2020 : moyenne des estimations aux différents GWL (identiques à l'arrondi près).
            bases = [lv[i] - delta.sel(nuts=code, gwl=g).item() for i, g in enumerate(GWLS)]
            bases = [b for b in bases if not math.isnan(b)]
            entry = {"v": [clean(sum(bases) / len(bases)) if bases else None] + [clean(x) for x in lv]}
            if q is not None:
                entry["lo"] = [None] + [clean(q.sel(nuts=code, gwl=g, quantile=0.17).item()) for g in GWLS]
                entry["hi"] = [None] + [clean(q.sel(nuts=code, gwl=g, quantile=0.83).item()) for g in GWLS]
            regions.setdefault(code, {})[indicator] = entry
        print(f"ok : {indicator} ({units[indicator]})")
    return regions, units


def percentile(sorted_values, p):
    k = (len(sorted_values) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (k - lo)


def thresholds(regions):
    """Médiane, P75 et P90 des régions européennes en climat actuel, sur valeur × direction."""
    out = {}
    for ind, direction in DIRECTIONS.items():
        base = sorted(r[ind]["v"][0] * direction for r in regions.values() if r.get(ind) and r[ind]["v"][0] is not None)
        if base:
            out[ind] = [round(percentile(base, p), 3) for p in (0.5, 0.75, 0.9)]
    return out


def build_nuts(codes):
    def load(year):
        with urllib.request.urlopen(GISCO.format(year=year)) as r:
            return json.load(r)["features"]

    features = load(2024)
    known = {f["properties"]["NUTS_ID"] for f in features}
    features += [f for f in load(2021) if f["properties"]["CNTR_CODE"] == "UK" and f["properties"]["NUTS_ID"] not in known]
    keep = ("NUTS_ID", "CNTR_CODE", "NAME_LATN")
    features = [
        {"type": "Feature", "properties": {k: f["properties"][k] for k in keep}, "geometry": f["geometry"]}
        for f in features
        if f["properties"]["NUTS_ID"] in codes
    ]
    NUTS_OUT.write_text(json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":")), encoding="utf-8")
    print(f"{NUTS_OUT} : {len(features)} régions sur {len(codes)}")


def build():
    regions, units = build_indicators()
    meta = {
        "demo": False,
        "source": "Copernicus C3S, sis-ecde-aggregated-climate-indicators v2.0, NUTS 2, moyenne multi-modèles",
        "gwls": ["0"] + GWLS,
        "units": units,
        "thresholds": thresholds(regions),
    }
    OUT.write_text(json.dumps({"meta": meta, "regions": regions}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{OUT} : {len(regions)} régions, {len(meta['thresholds'])} indicateurs")
    build_nuts(set(regions))


def inspect():
    for path in sorted(RAW_DIR.glob("*.zip")):
        indicator, product = path.stem.split("__")
        ds = open_raw(indicator, product)
        print(f"\n=== {path.name}")
        print(ds)
        for v in ds.data_vars:
            print(v, ds[v].attrs)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect", action="store_true")
    args = parser.parse_args()
    inspect() if args.inspect else build()
