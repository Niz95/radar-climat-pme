"""Calcule, maille par maille (0,25°), les indicateurs par niveau de réchauffement mondial.

Entrées : data/grid_raw/<indicateur>.zip (séries annuelles par modèle, voir fetch_grid.py) et
data/ref/CMIP5_Atlas_WarmingLevels.csv (années où chaque modèle global atteint +1,5, +2 et +3 °C,
dépôt IPCC-WG1/Atlas).

Méthode, reprise de l'Atlas du GIEC : pour chaque simulation, moyenne sur la fenêtre de 20 ans
[n-9, n+10] centrée sur l'année n où son modèle global atteint le niveau de réchauffement.
La référence est la moyenne 1991–2020 de la même simulation.

Usage :
    python scripts/build_grid.py reduce hot_days    # zip -> data/grid_agg/hot_days.npz (par simulation)
    python scripts/build_grid.py reduce --all
    python scripts/build_grid.py build              # npz -> web/data/grid/*.json
"""

import argparse
import csv
import io
import json
import warnings
import zipfile
from pathlib import Path

import numpy as np
import xarray as xr

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "grid_raw"
AGG_DIR = ROOT / "data" / "grid_agg"
GWL_TABLE = ROOT / "data" / "ref" / "CMIP5_Atlas_WarmingLevels.csv"

GWLS = ["1.5", "2", "3"]
REF_YEARS = (1991, 2020)
ATLAS_NAMES = {
    "ec_earth": "EC-EARTH", "hadgem2_es": "HadGEM2-ES", "ipsl_cm5a_mr": "IPSL-CM5A-MR",
    "mpi_esm_lr": "MPI-ESM-LR", "noresm1_m": "NorESM1-M", "cnrm_cm5": "CNRM-CM5",
}
# La table de l'Atlas ne contient pas ce membre : on prend le membre voisin du même modèle.
MEMBER_FALLBACK = {("EC-EARTH", "r1i1p1"): "r12i1p1"}


def load_gwl_years():
    """{(modèle, membre, scénario): {niveau: année centrale}} ; niveau absent si non atteint avant 2100."""
    table = {}
    with GWL_TABLE.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            model, member = row["model_run"].rsplit("_", 1)
            for rcp in ("rcp45", "rcp85"):
                years = {}
                for g in GWLS:
                    value = row[f"{g}_{rcp}"]
                    if value not in ("NA", "9999"):
                        years[g] = int(value)
                table[(model, member, rcp)] = years
    return table


def gwl_years_for(table, gcm, member, scenario):
    model = ATLAS_NAMES[gcm]
    member = member or "r1i1p1"
    member = MEMBER_FALLBACK.get((model, member), member)
    return table[(model, member, scenario.replace("_", "").replace("rcp", "rcp"))]


def simulation_of(filename, attrs):
    """Modèles, membre et scénario d'un fichier : lus dans ses attributs, sinon dans son nom."""
    import re

    scenario = attrs.get("scenario") or re.search(r"rcp_\d_\d", filename).group(0)
    member = attrs.get("ensemble_member") or (re.search(r"r\d+i\d+p\d+", filename) or [""])[0]
    gcm = attrs.get("gcm") or next(g for g in ATLAS_NAMES if f"-{g}-" in filename)
    rcm = attrs.get("rcm") or next((r for r in ("cclm4_8_17", "hirham5", "racmo22e", "rca4", "wrf381p") if f"-{r}-" in filename), "")
    return {"gcm": gcm, "rcm": rcm, "ensemble_member": member, "scenario": scenario.replace("_", "")}  # rcp_4_5 -> rcp45


def window_mean(data, years, first, last):
    """Moyenne sur [first, last] ; NaN si moins de 15 années disponibles."""
    sel = (years >= first) & (years <= last)
    chunk = data[sel]
    count = np.sum(~np.isnan(chunk), axis=0)
    with np.errstate(invalid="ignore"):
        mean = np.nansum(chunk, axis=0) / np.maximum(count, 1)
    mean[count < 15] = np.nan
    return mean.astype(np.float32)


def reduce_indicator(name):
    """Réduit les séries d'un indicateur à : référence et valeur à chaque niveau, par simulation."""
    table = load_gwl_years()
    path = RAW_DIR / f"{name}.zip"
    members, base, levels = [], [], []
    lat = lon = None
    with zipfile.ZipFile(path) as z:
        for entry in sorted(n for n in z.namelist() if n.endswith(".nc")):
            ds = xr.open_dataset(io.BytesIO(z.read(entry)), engine="h5netcdf")
            da = ds[list(ds.data_vars)[0]]
            a = simulation_of(entry, da.attrs)
            scenario = a["scenario"]
            years_at = gwl_years_for(table, a["gcm"], a["ensemble_member"], scenario)
            years = da["time"].dt.year.values
            data = da.values.astype(np.float32)
            lat, lon = da["lat"].values, da["lon"].values
            members.append({"gcm": a["gcm"], "rcm": a["rcm"], "member": a["ensemble_member"], "scenario": scenario, "gwl_years": years_at})
            base.append(window_mean(data, years, *REF_YEARS))
            per_level = []
            for g in GWLS:
                n = years_at.get(g)
                per_level.append(window_mean(data, years, n - 9, n + 10) if n and n + 10 <= years.max() + 1 else np.full(data.shape[1:], np.nan, np.float32))
            levels.append(np.stack(per_level))
            print(f"  {entry.split('-projections-')[1][:60]:60s} niveaux atteints : {years_at}", flush=True)
    AGG_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(AGG_DIR / f"{name}.npz", base=np.stack(base), levels=np.stack(levels), lat=lat, lon=lon, members=json.dumps(members))
    print(f"{name} : {len(members)} simulations -> {AGG_DIR / (name + '.npz')}")


def ensemble(name):
    """Référence et valeurs par niveau pour un indicateur : (v[4], lo[3], hi[3], lat, lon, effectifs).

    Valeur à un niveau = référence d'ensemble + moyenne des écarts des simulations qui l'atteignent.
    Passer par les écarts évite qu'un changement de composition de l'ensemble d'un niveau à l'autre
    fasse varier la valeur. La fourchette applique les quantiles 17 % et 83 % aux mêmes écarts.
    """
    z = np.load(AGG_DIR / f"{name}.npz")
    base, levels = z["base"], z["levels"]
    # Les mailles sans donnée (mer lointaine, niveau non atteint) donnent des moyennes vides : attendu.
    with np.errstate(all="ignore"), warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        ref = np.nanmean(base, axis=0)
        delta = levels - base[:, None]
        counts, mean, lo, hi = [], [], [], []
        for g in range(len(GWLS)):
            # Une simulation qui n'atteint pas le niveau est vide partout : on l'écarte d'abord, les
            # quantiles se calculent alors sans traitement lent des valeurs manquantes.
            reached = delta[~np.isnan(delta[:, g]).all(axis=(1, 2)), g]
            counts.append(len(reached))
            mean.append(np.nanmean(reached, axis=0))
            q = np.quantile(reached, [0.17, 0.83], axis=0)
            # Quelques mailles de bord manquent dans certains modèles régionaux seulement.
            partial = np.isnan(q[0]) & ~np.isnan(reached).all(axis=0)
            if partial.any():
                q[:, partial] = np.nanquantile(reached[:, partial], [0.17, 0.83], axis=0)
            lo.append(q[0])
            hi.append(q[1])
        mean, lo, hi = np.stack(mean), np.stack(lo), np.stack(hi)
    # Tous les indicateurs sont des comptes ou des cumuls : jamais négatifs.
    clip = lambda a: np.maximum(a, 0)
    return np.stack([ref, *clip(ref + mean)]), clip(ref + lo), clip(ref + hi), z["lat"], z["lon"], counts


LAND_MIN = 0.7  # part de terre minimale d'une maille, d'après le masque terre-mer d'ERA5


def land_mask(lat, lon):
    """Mailles terrestres du périmètre couvert.

    Sur le littoral, les mailles majoritairement marines ont un climat de mer (à Marseille, moins de
    2 jours par an au-dessus de 30 °C, contre 37 dans la maille terrestre voisine) : on les écarte avec
    le masque terre-mer d'ERA5, sur lequel la grille est alignée. Le périmètre est celui des régions
    NUTS 2, élargi d'un sixième de degré pour ne pas perdre les mailles côtières.
    """
    from shapely import contains_xy
    from shapely.geometry import shape
    from shapely.ops import unary_union

    lsm = xr.open_dataset(ROOT / "data" / "ref" / "era5_land_sea_mask.nc", engine="h5netcdf")["lsm"].squeeze(drop=True)
    lsm = lsm.sel(latitude=lat, longitude=lon, method="nearest").values
    features = json.loads((ROOT / "web" / "data" / "nuts2.geojson").read_text(encoding="utf-8"))["features"]
    area = unary_union([shape(f["geometry"]).buffer(1 / 6) for f in features])
    lon2d, lat2d = np.meshgrid(lon, lat)
    return (lsm >= LAND_MIN) & contains_xy(area, lon2d, lat2d)


def weighted_percentiles(values, weights, points):
    order = np.argsort(values)
    cum = np.cumsum(weights[order]) / weights.sum()
    return [float(values[order][np.searchsorted(cum, p)]) for p in points]


def rounded(x):
    if np.isnan(x):
        return None
    return round(float(x), 2 if abs(x) < 10 else 1)


def fill_from_neighbours(arrays, mask):
    """Donne aux mailles terrestres sans valeur celle de la maille voisine la plus proche qui en a une.

    Le danger d'incendie vient d'une autre grille, qui n'a pas de valeur au bord de la mer et des
    grands lacs : sans cela, Lisbonne, Porto ou Genève n'ont pas de note pour les feux. On ne regarde
    que les 8 voisines (35 km au plus), comme l'application le fait pour un site côtier.
    """
    source = [a.copy() for a in arrays]
    ref = source[0][0]
    offsets = sorted(((di, dj) for di in (-1, 0, 1) for dj in (-1, 0, 1) if di or dj), key=lambda o: o[0] ** 2 + o[1] ** 2)
    filled = 0
    for i, j in zip(*np.nonzero(mask & np.isnan(ref))):
        for di, dj in offsets:
            a, b = i + di, j + dj
            if 0 <= a < ref.shape[0] and 0 <= b < ref.shape[1] and not np.isnan(ref[a, b]):
                for target, src in zip(arrays, source):
                    target[:, i, j] = src[:, a, b]
                filled += 1
                break
    return filled


TILE = 16  # mailles par côté de tuile (4° × 4°)
GRID_OUT = ROOT / "web" / "data" / "grid"


def build():
    names = [n for n in INDICATOR_ORDER if (AGG_DIR / f"{n}.npz").exists()]
    lat = lon = mask = None
    fields, thresholds, counts = {}, {}, {}
    for name in names:
        v, lo, hi, la, lo_, n = ensemble(name)
        if lat is None:
            lat, lon = la, lo_
            mask = land_mask(lat, lon)
            weights = np.cos(np.deg2rad(np.meshgrid(lon, lat)[1]))
        elif la.shape != lat.shape or lo_.shape != lon.shape or not (np.allclose(la, lat) and np.allclose(lo_, lon)):
            # Le danger d'incendie est fourni sur une autre grille régulière, plus fine en latitude :
            # on lit, pour chaque maille de référence, la maille la plus proche.
            ii = np.abs(la[None, :] - lat[:, None]).argmin(axis=1)
            jj = np.abs(lo_[None, :] - lon[:, None]).argmin(axis=1)
            v, lo, hi = (a[:, ii[:, None], jj[None, :]] for a in (v, lo, hi))
            missing = int((mask & np.isnan(v[0])).sum())
            filled = fill_from_neighbours((v, lo, hi), mask)
            print(f"  {name} : réaligné depuis une grille {len(la)} × {len(lo_)} ; {filled} mailles sur {missing} sans valeur reprises d'une voisine")
        fields[name] = (v, lo, hi)
        counts[name] = n
        ok = mask & ~np.isnan(v[0])
        # Médiane, P75 et P90 des mailles terrestres sur la référence, pondérés par la surface.
        thresholds[name] = [round(x, 3) for x in weighted_percentiles(v[0][ok], weights[ok], (0.5, 0.75, 0.9))]
        print(f"ok : {name} (simulations par niveau : {n})", flush=True)

    GRID_OUT.mkdir(parents=True, exist_ok=True)
    for old in GRID_OUT.glob("*.json"):
        old.unlink()
    tiles = {}
    for i, j in zip(*np.nonzero(mask)):
        cell = []
        for name in names:
            v, lo, hi = fields[name]
            if np.isnan(v[0, i, j]):
                cell.append(None)
            else:
                cell.append([rounded(x) for x in (*v[:, i, j], *lo[:, i, j], *hi[:, i, j])])
        if any(c is not None for c in cell):
            tiles.setdefault(f"{i // TILE}_{j // TILE}", {})[f"{i}_{j}"] = cell
    for tile, cells in tiles.items():
        (GRID_OUT / f"{tile}.json").write_text(json.dumps(cells, separators=(",", ":")), encoding="utf-8")
    index = {
        "lat0": float(lat[0]), "lon0": float(lon[0]), "step": float(lat[1] - lat[0]), "tile": TILE,
        "indicators": names, "tiles": sorted(tiles), "thresholds": thresholds, "simulations": counts,
        "source": "Copernicus C3S, sis-ecde-climate-indicators v2.0, grille 0,25°, niveaux de réchauffement recalculés",
        "land_min": LAND_MIN,
    }
    (GRID_OUT / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size = sum(f.stat().st_size for f in GRID_OUT.glob("*.json")) / 1e6
    print(f"{GRID_OUT} : {sum(len(c) for c in tiles.values())} mailles, {len(tiles)} tuiles, {size:.1f} Mo")


# Ordre des indicateurs dans les tuiles (web/data/grid/index.json le rappelle).
INDICATOR_ORDER = [
    "hot_days", "hot_days_35", "tropical_nights", "heatwave_days", "cooling_degree_days", "frost_days",
    "extreme_precipitation_total", "maximum_consecutive_five_day_precipitation", "consecutive_dry_days",
    "duration_of_meteorological_droughts", "extreme_wind_speed_days", "days_with_high_fire_danger",
]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("reduce")
    p.add_argument("name", nargs="?")
    p.add_argument("--all", action="store_true")
    sub.add_parser("build")
    args = parser.parse_args()
    if args.command == "reduce":
        names = sorted(f.stem for f in RAW_DIR.glob("*.zip")) if args.all else [args.name]
        for n in names:
            reduce_indicator(n)
    else:
        build()
