"""Télécharge les séries annuelles en grille (0,25°), modèle par modèle, des indicateurs ECDE.

Source : Copernicus CDS, jeu « sis-ecde-climate-indicators » (licence CC-BY 4.0). Contrairement au jeu
agrégé utilisé par fetch_cds.py, celui-ci ne fournit pas de moyenne entre modèles ni de niveaux de
réchauffement : build_grid.py les recalcule.

Usage :
    python scripts/fetch_grid.py --test     # un seul indicateur
    python scripts/fetch_grid.py            # tous les indicateurs
"""

import argparse
import sys
from pathlib import Path

import cdsapi

DATASET = "sis-ecde-climate-indicators"
RAW_DIR = Path(__file__).resolve().parent.parent / "data" / "grid_raw"

# Nom local -> (variable CDS, paramètre complémentaire éventuel)
INDICATORS = {
    "hot_days": ("hot_days", "30_c"),
    "hot_days_35": ("hot_days", "35_c"),
    "tropical_nights": ("tropical_nights", None),
    "heatwave_days": ("heatwave_days", None),
    "cooling_degree_days": ("cooling_degree_days", None),
    "frost_days": ("frost_days", None),
    "extreme_precipitation_total": ("extreme_precipitation_total", None),
    "maximum_consecutive_five_day_precipitation": ("maximum_consecutive_five_day_precipitation", None),
    "consecutive_dry_days": ("consecutive_dry_days", None),
    "duration_of_meteorological_droughts": ("duration_of_meteorological_droughts", None),
    "extreme_wind_speed_days": ("extreme_wind_speed_days", None),
    "days_with_high_fire_danger": ("days_with_high_fire_danger", None),
}

# Couples modèle global / modèle régional proposés en grille (version 2.0 du jeu).
GCMS = ["ec_earth", "hadgem2_es", "ipsl_cm5a_mr", "mpi_esm_lr", "noresm1_m"]
RCMS = ["cclm4_8_17", "hirham5", "racmo22e", "rca4", "wrf381p"]
MEMBERS = ["r12i1p1", "r1i1p1", "r3i1p1"]
# Le danger d'incendie vient d'une autre chaîne de modèles, sans modèle régional.
FIRE_GCMS = ["cnrm_cm5", "ec_earth", "hadgem2_es", "ipsl_cm5a_mr", "mpi_esm_lr"]


def build_request(name):
    variable, other = INDICATORS[name]
    request = {
        "variable": [variable],
        "origin": "projections",
        "experiment": ["rcp4_5", "rcp8_5"],
        "temporal_aggregation": ["yearly"],
        "spatial_aggregation": "gridded",
        "version": "v2_0",
    }
    if variable == "days_with_high_fire_danger":
        request["gcm"] = FIRE_GCMS
    else:
        request.update(gcm=GCMS, rcm=RCMS, ensemble_member=MEMBERS)
    if other:
        request["other_parameters"] = [other]
    return request


REF_DIR = RAW_DIR.parent / "ref"
GWL_TABLE_URL = "https://raw.githubusercontent.com/IPCC-WG1/Atlas/main/warming-levels/CMIP5_Atlas_WarmingLevels.csv"


def fetch_reference(client):
    """Fichiers d'appui de build_grid.py : années des niveaux de réchauffement et masque terre-mer."""
    import urllib.request

    REF_DIR.mkdir(parents=True, exist_ok=True)
    table = REF_DIR / "CMIP5_Atlas_WarmingLevels.csv"
    if not table.exists():
        urllib.request.urlretrieve(GWL_TABLE_URL, table)
    mask = REF_DIR / "era5_land_sea_mask.nc"
    if not mask.exists():
        client.retrieve("reanalysis-era5-single-levels", {
            "product_type": ["reanalysis"], "variable": ["land_sea_mask"],
            "year": ["2020"], "month": ["01"], "day": ["01"], "time": ["00:00"],
            "data_format": "netcdf", "download_format": "unarchived",
            "area": [72.5, -22, 26.5, 45.5],  # nord, ouest, sud, est : l'emprise de la grille ECDE
        }).download(str(mask))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true", help="un seul indicateur")
    parser.add_argument("--only", help="nom local d'un indicateur")
    parser.add_argument("--force", action="store_true", help="retélécharger les fichiers existants")
    args = parser.parse_args()

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    client = cdsapi.Client()
    fetch_reference(client)
    names = [args.only] if args.only else list(INDICATORS)
    if args.test:
        names = names[:1]

    failures = []
    for name in names:
        target = RAW_DIR / f"{name}.zip"
        if target.exists() and not args.force:
            print(f"déjà présent : {target.name}")
            continue
        print(f"demande : {name}", flush=True)
        try:
            client.retrieve(DATASET, build_request(name)).download(str(target))
        except Exception as exc:  # une erreur sur un indicateur ne bloque pas les autres
            print(f"  échec : {exc}", flush=True)
            failures.append(name)

    if failures:
        print("Indicateurs en échec :", ", ".join(failures))
        sys.exit(1)


if __name__ == "__main__":
    main()
