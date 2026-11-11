# Radar climat PME

Un premier repérage, gratuit et sans inscription, des risques climatiques physiques auxquels les sites
d'une PME européenne sont ou seront exposés : chaleur, froid, pluies extrêmes, sécheresse, vent et feux,
sur la référence 1991–2020 et à +1,5 °C, +2 °C et +3 °C de réchauffement mondial (vers 2030, 2050 et 2100).

**👉 Essayer l'outil : https://niz95.github.io/radar-climat-pme/**

![Synthèse du rapport pour une entreprise de BTP fictive à Montpellier](docs/apercu-synthese.jpg)

## Comment ça marche

1. Saisissez l'adresse de vos sites, ou cliquez sur la carte.
2. Choisissez votre secteur et répondez à 12 questions par oui, non ou « ne sait pas » : 7 sur
   l'entreprise, 5 sur chaque site.
3. Lisez le rapport en 3 niveaux :
   - **Synthèse**, pour le dirigeant : les 3 risques principaux, le chiffre qui explique chaque note, 3 actions ;
   - **Détail**, pour le conseiller : notes justifiées, tous les horizons, comparaison des sites ;
   - **Annexe**, pour une banque, un assureur ou un auditeur : valeurs, fourchettes entre modèles, sources
     des seuils, export CSV.

![Détail : évolution dans le temps et comparaison des sites](docs/apercu-detail.jpg)

## Méthode

- **Données** : Copernicus Climate Change Service, jeu « Climate indicators for Europe »
  (`sis-ecde-climate-indicators` v2.0, CC-BY 4.0) : séries annuelles par modèle sur une grille de 0,25°,
  soit 18 simulations (9 couples de modèles EURO-CORDEX corrigés de leurs biais, scénarios RCP4.5 et
  RCP8.5 ; 10 pour le danger d'incendie).
- **Niveaux de réchauffement** : recalculés avec la méthode de l'Atlas du GIEC. Pour chaque simulation,
  moyenne sur les 20 ans centrés sur l'année où son modèle global atteint +1,5 °C, +2 °C ou +3 °C. La
  valeur affichée est la référence (moyenne 1991–2020 des mêmes simulations) plus la moyenne des écarts.
  Remoyennés par région, les résultats retrouvent les valeurs officielles du jeu agrégé de Copernicus
  (jours au-dessus de 30 °C : corrélation 0,99, hausses à 5 % près). À +3 °C, 12 simulations seulement
  atteignent le niveau.
- **Maille du site** : la maille terrestre la plus proche (masque terre-mer d'ERA5, au moins 70 % de terre),
  jusqu'à 40 km. Les mailles surtout marines ont un climat de mer et sont écartées. Sans maille (outre-mer,
  îles éloignées), l'outil revient aux moyennes régionales NUTS 2 du jeu
  `sis-ecde-aggregated-climate-indicators`.
- **Danger d'incendie** : fourni sur une autre grille, sans valeur au bord de la mer et des grands lacs.
  Une maille sans valeur reprend celle de la maille voisine la plus proche, à 35 km au plus.
- **Contraste local** : si les mailles voisines donneraient un autre niveau, le rapport l'indique.
- **Périmètre** : Union européenne, Royaume-Uni, Suisse, Liechtenstein, Norvège, Islande, Turquie et
  Balkans occidentaux.
- **Cadre** : phase de « screening » du guide de la Commission européenne sur le climate proofing des
  infrastructures (C(2021) 5430) : l'exposition et la sensibilité, notées sur 3 niveaux (Faible, Moyen,
  Élevé), sont croisées dans une matrice 3 × 3. Ni ce guide ni la méthode OCARA (Carbone 4 / ADEME) ne
  fixent de seuils chiffrés d'exposition : ceux de l'outil sont indiqués avec leur source.
- **Exposition** : l'indicateur le plus défavorable de l'aléa, selon une règle propre à chaque indicateur
  (`INDICATORS` dans [web/risk-model.js](web/risk-model.js)) :
  - des seuils absolus, conventions du prototype (par exemple, jours au-dessus de 30 °C : 5 et 20 par an) ;
  - pour les pluies, la position par rapport au reste de l'Europe (75ᵉ et 90ᵉ centiles des mailles) ;
  - pour les indices définis localement (vagues de chaleur, durée des sécheresses, vents extrêmes),
    l'évolution par rapport à la référence. Le vent n'a que cet indicateur : sans hausse, il est noté
    « Stable », car le niveau de risque de tempête actuel n'est pas mesuré.
- **Tendance** : ↑ ou ↑↑ quand un indicateur au moins Moyen augmente de 25 % ou 50 % par rapport à
  la référence, affichée seulement sur un risque Moyen ou Élevé.
- **Fourchette** : la même règle appliquée aux quantiles 17 % et 83 % de l'ensemble de modèles,
  affichée sous la note quand elle s'en écarte.
- **Sensibilité** : une note par secteur, relevée d'un cran, et d'un seul, dès qu'une réponse « oui » du
  questionnaire concerne l'aléa. Les 12 questions suivent les 4 thèmes du guide européen : 7 décrivent
  l'entreprise, 5 décrivent un lieu (cours d'eau, bâtiment, forêt, origine de l'eau) et se posent pour
  chaque site. Sous chaque question, l'outil indique l'effet réel de la réponse sur la note du site.
  Ces notes sont des hypothèses, à valider avec des PME.

## Limites

- Les valeurs sont des moyennes sur une maille d'environ 25 km : elles ne décrivent pas un bâtiment, en
  particulier pour les inondations. Consultez les cartes officielles des zones inondables de votre pays.
- Une maille d'environ 25 km reste trop grande pour une bande côtière étroite ou une vallée de montagne ;
  le « contraste local » le signale.
- Les notes sont des niveaux d'attention (une vulnérabilité au sens du guide européen, pas un risque
  chiffré). Elles décrivent le climat moyen, pas les événements exceptionnels : les lieux de la crue de
  l'Ahr (2021) et des crues du Pas-de-Calais (2023-24) restent notés « Faible » pour les pluies extrêmes.
- Ce sont des projections de modèles climatiques, pas des prévisions.
- Un site hors des contours simplifiés (littoral, île, pays voisin non couvert) est rattaché à la région
  la plus proche, jusqu'à 30 km. Les régions d'outre-mer et certaines îles éloignées n'ont pas de données.
- Pas encore de crues de rivières, de submersion marine, de grêle ni de mouvements de terrain.
- L'outil est informatif : ni conseil professionnel, ni notation, ni attestation de conformité. Voir
  [les mentions et limites complètes](web/mentions.html).

## Sources et licences

- Code : licence MIT, voir [LICENSE](LICENSE).
- Contient des informations modifiées du Copernicus Climate Change Service (2026). Ni la Commission
  européenne ni l'ECMWF ne sont responsables de l'usage qui peut être fait des informations Copernicus ou
  des données qu'elles contiennent.
- © EuroGeographics pour les limites administratives (GISCO, Eurostat), usage non commercial.
- Fond de carte et recherche d'adresse : © contributeurs OpenStreetMap (ODbL), service Nominatim.
- Outil indépendant, non affilié à Copernicus, à l'ECMWF ni à la Commission européenne.

Auteur : Deniz Caliskan.

## Pour les développeurs

L'application est un site statique (HTML, JavaScript, données JSON) dans [web/](web/), sans serveur ni
compilation. GitHub Pages la publie à chaque push sur `main` ([.github/workflows/pages.yml](.github/workflows/pages.yml)).

### Lancer en local

```
python -m http.server 8765 --directory web
```

puis ouvrir http://localhost:8765.

### Regénérer les données Copernicus

1. Créez un compte gratuit sur https://cds.climate.copernicus.eu.
2. Acceptez la licence CC-BY sur les pages des deux jeux de données (onglet *Download*, en bas de page) :
   `sis-ecde-climate-indicators` et `sis-ecde-aggregated-climate-indicators`, ainsi que la licence
   Copernicus sur `reanalysis-era5-single-levels` (masque terre-mer).
3. Copiez votre clé API depuis votre profil CDS dans le fichier `~/.cdsapirc` (jamais dans le repo) :

   ```
   url: https://cds.climate.copernicus.eu/api
   key: <votre-clé>
   ```

4. Installez les dépendances :

   ```
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt
   ```

5. Grille de 0,25° (environ 1 Go par indicateur, à réduire au fur et à mesure) :

   ```
   .venv\Scripts\python scripts\fetch_grid.py --only hot_days
   .venv\Scripts\python scripts\build_grid.py reduce hot_days
   ```

   à répéter pour chaque indicateur (liste dans `scripts/fetch_grid.py`), puis :

   ```
   .venv\Scripts\python scripts\build_grid.py build
   ```

6. Moyennes régionales, utilisées à défaut de maille :

   ```
   .venv\Scripts\python scripts\fetch_cds.py
   .venv\Scripts\python scripts\build_data.py
   ```
