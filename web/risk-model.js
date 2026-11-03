// Modèle de risque du prototype, aligné sur la phase de « screening » du guide européen
// C(2021) 5430 (climate proofing) : sensibilité × exposition = vulnérabilité, sur 3 niveaux.
// Les seuils marqués « convention » et les sensibilités sectorielles sont des hypothèses du
// prototype, pas des valeurs réglementaires.

export const GWLS = [
  { id: "0", label: "Climat actuel", horizon: "1991–2020", year: "aujourd'hui" },
  { id: "1.5", label: "+1,5 °C", horizon: "vers 2030", year: "2030" },
  { id: "2", label: "+2 °C", horizon: "vers 2050", year: "2050" },
  { id: "3", label: "+3 °C", horizon: "vers 2100", year: "2100" },
];

export const LEVELS = ["Faible", "Moyen", "Élevé"];

export const HAZARDS = {
  heat: {
    label: "Chaleur extrême",
    help: "Températures élevées le jour et la nuit : santé des équipes, tenue des équipements, coût de la climatisation.",
    icon: "🌡️",
    adaptation: [
      "Adapter les horaires et les postes exposés (plan canicule)",
      "Isolation, protections solaires, ventilation ou climatisation des locaux",
      "Vérifier la tenue des équipements et stocks sensibles à la chaleur",
    ],
  },
  cold: {
    label: "Froid et gel",
    help: "Jours de gel : arrêts d'activité extérieure, réseaux d'eau et équipements exposés. Ils diminuent avec le réchauffement.",
    icon: "❄️",
    adaptation: [
      "Protéger les réseaux d'eau et les équipements extérieurs",
      "Prévoir les arrêts de chantier et d'activité en période de gel",
    ],
  },
  rain: {
    label: "Pluies extrêmes et inondations",
    help: "Pluies très intenses sur un ou plusieurs jours, qui peuvent provoquer ruissellement et inondations soudaines. Ne remplace pas la carte officielle des zones inondables.",
    icon: "🌧️",
    adaptation: [
      "Consulter la cartographie officielle des zones inondables de votre pays",
      "Surélever les équipements critiques, stocks et archives",
      "Vérifier la couverture d'assurance et le plan de continuité d'activité",
    ],
  },
  drought: {
    label: "Sécheresse et stress hydrique",
    help: "Longues périodes sans pluie : restrictions d'usage de l'eau, sols argileux qui se rétractent sous les bâtiments.",
    icon: "🏜️",
    adaptation: [
      "Mesurer et réduire la consommation d'eau des procédés",
      "Anticiper les restrictions d'usage de l'eau (arrêtés sécheresse)",
      "Vérifier les fondations des bâtiments sur sols argileux",
    ],
  },
  wind: {
    label: "Tempêtes et vents violents",
    help: "Jours de vent exceptionnellement fort pour la région : toitures, structures légères, coupures de réseaux.",
    icon: "💨",
    adaptation: [
      "Contrôler toitures, bardages, enseignes et structures légères",
      "Sécuriser les zones de stockage extérieures",
    ],
  },
  fire: {
    label: "Feux de forêt",
    help: "Conditions météo qui favorisent le départ et la propagation des feux de végétation.",
    icon: "🔥",
    adaptation: [
      "Débroussaillement et coupure de combustible autour des sites",
      "Plan d'évacuation et protection des stocks inflammables",
    ],
  },
};

// Règles d'exposition (Faible < seuil 1 ≤ Moyen < seuil 2 ≤ Élevé) :
// - abs : seuils absolus sur la valeur ;
// - europe : seuils = P75 et P90 des régions européennes en climat actuel (meta.thresholds) ;
// - change : indice défini par rapport au climat local (presque identique partout aujourd'hui),
//   exposition lue dans son évolution (abs en unités, pct en %) ;
// - info : affiché, mais n'entre pas dans le calcul.
const WEEKS = "Convention du prototype : moins d'une semaine, 1 à 3 semaines, plus de 3 semaines par an";

export const INDICATORS = {
  hot_days: {
    hazard: "heat", label: "Jours au-dessus de 30 °C",
    help: "Nombre moyen de jours par an où la température maximale dépasse 30 °C.", unit: "jours/an",
    rule: { abs: [5, 20] }, source: WEEKS,
  },
  hot_days_35: {
    hazard: "heat", label: "Jours au-dessus de 35 °C",
    help: "Nombre moyen de jours par an au-dessus de 35 °C, où le travail physique et certains équipements deviennent critiques.", unit: "jours/an",
    rule: { abs: [2, 10] }, source: "Convention du prototype : seuil de 35 °C, du même ordre que les exemples d'OCARA",
  },
  tropical_nights: {
    hazard: "heat", label: "Nuits tropicales (> 20 °C)",
    help: "Nuits où la température ne descend pas sous 20 °C : les personnes et les bâtiments ne récupèrent pas de la chaleur du jour.", unit: "nuits/an",
    rule: { abs: [5, 20] }, source: WEEKS + " ; indice TR20 de l'ETCCDI",
  },
  heatwave_days: {
    hazard: "heat", label: "Jours de vague de chaleur",
    help: "Jours compris dans une vague de chaleur, définie par rapport aux températures habituelles de la région.", unit: "jours/an", relative: true,
    rule: { change: { abs: [3, 8] } }, source: "Indice local : hausse de 3 jours (moyen) ou 8 jours (élevé) par an",
  },
  cooling_degree_days: {
    hazard: "heat", label: "Degrés-jours de climatisation",
    help: "Cumul annuel des degrés au-dessus du seuil de confort : plus il est élevé, plus la climatisation coûte cher.", unit: "°C·jours",
    rule: { info: true }, source: "Besoin de climatisation, affiché à titre d'information",
  },
  frost_days: {
    hazard: "cold", label: "Jours de gel",
    help: "Nombre moyen de jours par an où la température minimale descend sous 0 °C.", unit: "jours/an",
    rule: { abs: [30, 90] }, source: "Convention du prototype : moins d'un mois, 1 à 3 mois, plus de 3 mois par an",
  },
  extreme_precipitation_total: {
    hazard: "rain", label: "Cumul des pluies extrêmes",
    help: "Pluie cumulée sur les jours de pluie extrême de l'année.", unit: "mm/an",
    rule: { europe: true }, source: "Position par rapport aux régions européennes en climat actuel (P75, P90)",
  },
  maximum_consecutive_five_day_precipitation: {
    hazard: "rain", label: "Pluie maximale sur 5 jours",
    help: "Plus forte quantité de pluie tombée en 5 jours consécutifs dans l'année : un repère pour le risque de crue.", unit: "mm",
    rule: { europe: true }, source: "Position par rapport aux régions européennes en climat actuel (P75, P90)",
  },
  consecutive_dry_days: {
    hazard: "drought", label: "Plus longue période sèche",
    help: "Plus longue suite de jours sans pluie significative dans l'année.", unit: "jours",
    rule: { abs: [20, 40] }, source: "Convention du prototype : 3 semaines, 6 semaines",
  },
  duration_of_meteorological_droughts: {
    hazard: "drought", label: "Durée des sécheresses",
    help: "Durée moyenne des épisodes de sécheresse météorologique, mesurée par rapport au climat habituel de la région.", unit: "mois", relative: true,
    rule: { change: { pct: [25, 50] } }, source: "Indice local : hausse de 25 % (moyen) ou 50 % (élevé)",
  },
  extreme_wind_speed_days: {
    hazard: "wind", label: "Jours de vent extrême",
    help: "Jours où le vent dépasse les valeurs les plus fortes habituellement observées dans la région.", unit: "jours/an", relative: true,
    rule: { change: { pct: [15, 30] } }, source: "Indice local : hausse de 15 % (moyen) ou 30 % (élevé)",
  },
  days_with_high_fire_danger: {
    hazard: "fire", label: "Jours de danger d'incendie élevé",
    help: "Jours où l'indice météorologique de danger d'incendie (FWI) dépasse 30, niveau « danger élevé » de l'EFFIS.", unit: "jours/an",
    rule: { abs: [5, 20] }, source: WEEKS + " ; danger élevé = indice FWI > 30 (classification EFFIS)",
  },
};

// Sensibilité 0–3 par aléas, et impact typique pour le secteur.
export const SECTORS = {
  agriculture: {
    label: "Agriculture et agroalimentaire amont",
    heat: [3, "Stress thermique des cultures et du bétail, baisse de rendement"],
    cold: [2, "Gelées tardives sur cultures et vergers"],
    rain: [3, "Parcelles inondées, érosion, récoltes perdues"],
    drought: [3, "Restrictions d'irrigation, pertes de récolte"],
    wind: [2, "Verse des cultures, dégâts aux serres et bâtiments"],
    fire: [2, "Destruction de récoltes et de bâtiments en lisière"],
  },
  forestry: {
    label: "Forêt, bois et papier",
    heat: [2, "Dépérissement des peuplements, ravageurs"],
    cold: [1, "Peu d'impact direct"],
    rain: [2, "Accès aux parcelles et chantiers compliqué"],
    drought: [3, "Mortalité des arbres, baisse de la ressource"],
    wind: [3, "Chablis, effondrement des prix du bois après tempête"],
    fire: [3, "Perte directe de la ressource et des équipements"],
  },
  construction: {
    label: "BTP et construction",
    heat: [3, "Arrêts de chantier, santé des compagnons, prise des bétons"],
    cold: [2, "Chantiers suspendus en période de gel"],
    rain: [2, "Retards de chantier, matériels et terrassements inondés"],
    drought: [1, "Retrait-gonflement des argiles, sinistres sur ouvrages livrés"],
    wind: [2, "Grues et échafaudages à l'arrêt"],
    fire: [1, "Chantiers en zone boisée menacés"],
  },
  manufacturing: {
    label: "Industrie manufacturière",
    heat: [2, "Productivité en atelier, surchauffe des machines"],
    cold: [1, "Approvisionnement en énergie sous tension"],
    rain: [2, "Site ou fournisseurs inondés, rupture d'approvisionnement"],
    drought: [2, "Procédés dépendant de l'eau, restrictions de prélèvement"],
    wind: [1, "Dégâts aux toitures et entrepôts"],
    fire: [1, "Sites industriels en interface forêt"],
  },
  logistics: {
    label: "Transport et logistique",
    heat: [2, "Chaîne du froid, conditions de travail des chauffeurs"],
    cold: [2, "Routes verglacées, retards"],
    rain: [3, "Routes coupées, entrepôts inondés"],
    drought: [1, "Transport fluvial limité par les basses eaux"],
    wind: [2, "Circulation des poids lourds restreinte"],
    fire: [1, "Axes routiers fermés"],
  },
  energy: {
    label: "Énergie",
    heat: [2, "Rendement des centrales et réseaux en baisse, pics de demande"],
    cold: [1, "Pics de demande hivernale"],
    rain: [2, "Postes électriques et installations inondés"],
    drought: [3, "Hydroélectricité et refroidissement des centrales limités"],
    wind: [2, "Lignes et éoliennes endommagées"],
    fire: [2, "Lignes et parcs solaires menacés"],
  },
  digital: {
    label: "Numérique et data centers",
    heat: [3, "Coût et capacité du refroidissement des serveurs"],
    cold: [0, "Peu d'impact"],
    rain: [2, "Salles techniques inondées"],
    drought: [1, "Refroidissement à l'eau limité"],
    wind: [1, "Coupures de réseau"],
    fire: [1, "Coupures de réseau"],
  },
  retail: {
    label: "Commerce et distribution",
    heat: [2, "Confort des clients, chaîne du froid, frais de climatisation"],
    cold: [1, "Baisse de fréquentation"],
    rain: [2, "Magasins et réserves inondés"],
    drought: [1, "Hausse des prix des produits agricoles"],
    wind: [1, "Enseignes et vitrines endommagées"],
    fire: [0, "Peu d'impact"],
  },
  tourism: {
    label: "Tourisme, hôtellerie et restauration",
    heat: [3, "Baisse d'attractivité en été, coûts de climatisation"],
    cold: [1, "Saison hivernale perturbée"],
    rain: [2, "Établissements inondés, annulations"],
    drought: [2, "Restrictions d'eau (piscines, arrosage)"],
    wind: [1, "Activités de plein air annulées"],
    fire: [2, "Évacuations et fermetures en zone touristique"],
  },
  health: {
    label: "Santé et médico-social",
    heat: [3, "Santé des patients fragiles, surcharge des soignants"],
    cold: [1, "Pathologies hivernales"],
    rain: [2, "Continuité des soins, accès des équipes coupé"],
    drought: [1, "Peu d'impact direct"],
    wind: [1, "Coupures d'électricité"],
    fire: [1, "Fumées et évacuations"],
  },
  services: {
    label: "Bureaux et services",
    heat: [1, "Confort et productivité au bureau"],
    cold: [1, "Peu d'impact"],
    rain: [1, "Accès aux locaux"],
    drought: [0, "Peu d'impact"],
    wind: [1, "Dégâts aux locaux"],
    fire: [0, "Peu d'impact"],
  },
};

// Notes d'expert 0–3 ci-dessus ramenées à l'échelle européenne à 3 niveaux :
// nulle ou faible → Faible, moyenne → Moyen, forte → Élevé.
export const sectorSensitivity = (note) => [0, 0, 1, 2][note];

// Questionnaire, rangé selon les 4 thèmes de sensibilité du guide européen.
// Chaque « oui » relève d'un niveau la sensibilité des aléas listés (plafond : Élevé).
export const QUESTIONS = [
  { id: "outdoor", theme: "Actifs et procédés", hazards: ["heat"],
    text: "Des salariés travaillent en extérieur ou dans un atelier non climatisé" },
  { id: "building", theme: "Actifs et procédés", hazards: ["heat", "wind"],
    text: "Le bâtiment est léger ou ancien (bardage, toiture en tôle, peu isolé)" },
  { id: "ground", theme: "Actifs et procédés", hazards: ["rain"],
    text: "Stocks ou équipements critiques au rez-de-chaussée ou en sous-sol, ou site proche d'un cours d'eau" },
  { id: "forest", theme: "Actifs et procédés", hazards: ["fire"],
    text: "Le site est en lisière de forêt, de garrigue ou de végétation dense" },
  { id: "water", theme: "Intrants (eau, énergie)", hazards: ["drought"],
    text: "Les procédés consomment beaucoup d'eau (lavage, refroidissement, irrigation)" },
  { id: "coldchain", theme: "Intrants (eau, énergie)", hazards: ["heat"],
    text: "Des produits ou matières sont sous chaîne du froid" },
  { id: "summer", theme: "Produits et services", hazards: ["heat"],
    text: "L'activité est concentrée sur l'été" },
  { id: "suppliers", theme: "Accès et transport", hazards: [],
    text: "Fournisseurs ou clients clés concentrés sur peu de sites" },
];


// Matrice de vulnérabilité du screening : ligne = exposition, colonne = sensibilité.
export const MATRIX = [
  [0, 0, 1],
  [0, 1, 2],
  [1, 2, 2],
];

// Signal de tendance : hausse d'au moins 25 % (↑) ou 50 % (↑↑) d'un indicateur par rapport
// au climat actuel, comptée seulement pour un indicateur qui atteint au moins Moyen, et
// affichée seulement quand le risque de l'aléa est au moins Moyen.
export const TREND_PCT = [25, 50];

function levelFrom(value, [t1, t2]) {
  if (value == null) return null;
  return value >= t2 ? 2 : value >= t1 ? 1 : 0;
}

export function indicatorLevel(ind, values, i, meta) {
  const { rule } = ind;
  const v = values[i];
  if (rule.info || v == null) return null;
  if (rule.abs) return levelFrom(v, rule.abs);
  if (rule.europe) {
    const t = meta.thresholds?.[ind.id];
    return t ? levelFrom(v, [t[1], t[2]]) : null;
  }
  if (rule.change) {
    const base = values[0];
    if (base == null) return null;
    if (rule.change.abs) return levelFrom(v - base, rule.change.abs);
    return base === 0 ? null : levelFrom(((v - base) / base) * 100, rule.change.pct);
  }
  return null;
}

// Variation en % par rapport au climat actuel (null si elle n'a pas de sens).
export function changePct(values, i) {
  const base = values[0];
  if (i === 0 || base == null || values[i] == null || base <= 0) return null;
  return ((values[i] - base) / base) * 100;
}

function trendOf(values, i) {
  const pct = changePct(values, i);
  if (pct == null) return 0;
  return pct >= TREND_PCT[1] ? 2 : pct >= TREND_PCT[0] ? 1 : 0;
}

export function sensitivityFor(sectorId, hazardId, answers) {
  const base = sectorSensitivity(SECTORS[sectorId][hazardId][0]);
  const reasons = QUESTIONS.filter((q) => answers[q.id] && q.hazards.includes(hazardId));
  return { level: Math.min(2, base + reasons.length), base, reasons };
}

export function assessSite(regionData, meta, sectorId, answers = {}) {
  return Object.entries(HAZARDS).map(([hazardId, hazard]) => {
    const indicators = Object.entries(INDICATORS)
      .filter(([, ind]) => ind.hazard === hazardId)
      .map(([id, ind]) => {
        const { v: values = null, lo = [], hi = [] } = regionData?.[id] ?? {};
        if (!values || values.every((v) => v == null)) return null;
        const full = { id, ...ind, values, lo, hi };
        full.levels = values.map((_, i) => indicatorLevel(full, values, i, meta));
        // Une hausse relative ne compte que si l'indicateur atteint lui-même Moyen
        // (évite un ↑↑ pour 0,6 → 1,7 jour par an).
        full.trends = values.map((_, i) => (full.levels[i] >= 1 ? trendOf(values, i) : 0));
        return full;
      })
      .filter(Boolean);

    const scored = indicators.filter((ind) => !ind.rule.info);
    // Exposition de l'aléa = indicateur le plus défavorable ; cet indicateur justifie la note.
    const exposure = GWLS.map((_, i) => {
      let best = null;
      for (const ind of scored) if (ind.levels[i] != null && (!best || ind.levels[i] > best.levels[i])) best = ind;
      return best ? { level: best.levels[i], driver: best } : null;
    });
    const rising = GWLS.map((_, i) => Math.max(0, ...scored.map((ind) => ind.trends[i])));
    const sensitivity = sensitivityFor(sectorId, hazardId, answers);
    const risk = exposure.map((e) => (e ? MATRIX[e.level][sensitivity.level] : null));
    // Pas de flèche sur un risque Faible : elle brouille la lecture pour le dirigeant.
    const trend = rising.map((t, i) => (risk[i] >= 1 ? t : 0));
    // Indicateur qui porte la flèche, parmi ceux qui la déclenchent : de préférence celui qui
    // justifie déjà la note, sinon le plus haut niveau, puis la hausse la plus modeste (un
    // « +1150 % » sur 0,6 jour par an serait exact mais trompeur).
    const trendBy = trend.map((t, i) => {
      if (!t) return null;
      const candidates = scored
        .filter((ind) => ind.trends[i] === t)
        .sort(
          (a, b) =>
            (b === exposure[i]?.driver) - (a === exposure[i]?.driver) ||
            b.levels[i] - a.levels[i] ||
            changePct(a.values, i) - changePct(b.values, i),
        );
      return { ind: candidates[0], pct: changePct(candidates[0].values, i) };
    });
    const impact = SECTORS[sectorId][hazardId][1];
    return { id: hazardId, ...hazard, indicators, exposure, trend, trendBy, sensitivity, risk, impact };
  });
}
