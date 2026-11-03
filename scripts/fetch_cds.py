"""Télécharge les indicateurs ECDE agrégés par niveau de réchauffement (GWL) et par région NUTS 2.

Source : Copernicus CDS, jeu « sis-ecde-aggregated-climate-indicators » (licence CC-BY 4.0),
le même que celui affiché par le European Climate Viewer.

Prérequis : un compte CDS, la licence CC-BY acceptée sur la page du jeu de données,
et la clé API dans ~/.cdsapirc (voir README.md).

Usage :
    python scripts/fetch_cds.py --test     # un seul indicateur, pour inspecter le format
    python scripts/fetch_cds.py            # tous les indicateurs du prototype
"""

import argparse
import sys
from pathlib import Path

import cdsapi

DATASET = "sis-ecde-aggregated-climate-indicators"
RAW_DIR = Path(__file__).resolve().parent.parent / "data" / "raw"

# Nom local -> paramètre complémentaire éventuel (seuil, statistique).
# Un nom local peut désigner une variante d'une variable CDS (voir ALIASES).
INDICATORS = {
    "hot_days": "30_c",
    "hot_days_35": "35_c",
    "tropical_nights": None,
    "heatwave_days": None,
    "cooling_degree_days": None,
    "frost_days": None,
    "extreme_precipitation_total": None,
    "maximum_consecutive_five_day_precipitation": None,
    "consecutive_dry_days": None,
    "duration_of_meteorological_droughts": None,
    "extreme_wind_speed_days": None,
    "days_with_high_fire_danger": None,
}

ALIASES = {"hot_days_35": "hot_days"}

PRODUCTS = ["gwl", "gwl_absolute_change", "gwl_uncertainty_quantiles"]


def build_request(variable, other, product):
    request = {
        "variable": [variable],
        "origin": "projections",
        "product": [product],
        "spatial_aggregation": "regional_layer",
        "regional_layer": ["nuts_level_2"],
        "temporal_aggregation": ["yearly"],
        "version": "v2_0",
    }
    if other:
        request["other_parameters"] = [other]
    return request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true", help="un seul indicateur et un seul produit")
    parser.add_argument("--force", action="store_true", help="retélécharger les fichiers existants")
    args = parser.parse_args()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    client = cdsapi.Client()

    jobs = [(v, o, p) for v, o in INDICATORS.items() for p in PRODUCTS]
    if args.test:
        jobs = jobs[:1]

    failures = []
    for variable, other, product in jobs:
        target = RAW_DIR / f"{variable}__{product}"
        if any(RAW_DIR.glob(target.name + ".*")) and not args.force:
            print(f"déjà présent : {target.name}")
            continue
        print(f"demande : {variable} / {product}")
        try:
            result = client.retrieve(DATASET, build_request(ALIASES.get(variable, variable), other, product))
            # L'extension réelle (zip, nc, csv) dépend du produit : on la reprend de l'URL.
            suffix = Path(result.location.split("?")[0]).suffix or ".bin"
            result.download(str(target) + suffix)
        except Exception as exc:  # une erreur sur un indicateur ne bloque pas les autres
            print(f"  échec : {exc}")
            failures.append(variable)

    if failures:
        print("Indicateurs en échec :", ", ".join(failures))
        sys.exit(1)


if __name__ == "__main__":
    main()
