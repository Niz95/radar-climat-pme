import { GWLS, HAZARDS, LEVELS, MATRIX, QUESTIONS, SECTORS, TREND_PCT, assessSite } from "./risk-model.js?v=12";

const state = {
  data: null, // data/indicators.json
  nuts: null, // data/nuts2.geojson
  sector: "manufacturing",
  gwl: 2, // index dans GWLS
  answers: {}, // id de question -> booléen, communs à tous les sites
  sites: [], // { id, lat, lon, tip, short, title, region, nearKm, marker }
  active: null,
};

const REF = GWLS[0].year; // période de référence, « 1991–2020 »
// Au-delà de cette distance d'un contour, un point n'est rattaché à aucune région.
const NEAR_KM = 30;

const $ = (sel) => document.querySelector(sel);
const fmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const fmt3 = new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (v) => (v == null ? "–" : fmt.format(v));
const isNarrow = () => matchMedia("(max-width: 820px)").matches;

// --- Carte -----------------------------------------------------------------

const map = L.map("map", { zoomControl: true }).setView([50, 10], 4);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "© contributeurs OpenStreetMap",
}).addTo(map);
const regionLayer = L.geoJSON(null, { style: { color: "#1f6f5c", weight: 2, fillOpacity: 0.12 } }).addTo(map);
const markers = L.layerGroup().addTo(map);

map.on("click", (e) => addSite(e.latlng.lat, e.latlng.lng, pointNames(e.latlng.lat, e.latlng.lng)));

// --- Rattachement d'un point à sa région NUTS 2 -----------------------------

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(lon, lat, rings) {
  return inRing(lon, lat, rings[0]) && !rings.slice(1).some((hole) => inRing(lon, lat, hole));
}

// Distance en km d'un point au contour d'un anneau (projection plane locale, suffisante à cette échelle).
function ringDistanceKm(lat, lon, ring) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.57;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = (ring[j][0] - lon) * kx;
    const ay = (ring[j][1] - lat) * ky;
    const dx = (ring[i][0] - lon) * kx - ax;
    const dy = (ring[i][1] - lat) * ky - ay;
    const len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

const polygonsOf = (g) => (g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []);

// Les contours sont très simplifiés (1:20 000 000) : un port ou une ville côtière tombe souvent
// juste en dehors. À défaut de région contenant le point, on prend la plus proche.
function findRegion(lat, lon) {
  const inside = state.nuts.features.find((f) => polygonsOf(f.geometry).some((p) => inPolygon(lon, lat, p)));
  if (inside) return { region: inside, nearKm: 0 };
  let best = { region: null, nearKm: 0 };
  let bestKm = NEAR_KM;
  for (const f of state.nuts.features) {
    for (const p of polygonsOf(f.geometry)) {
      const d = ringDistanceKm(lat, lon, p[0]);
      if (d <= bestKm) {
        bestKm = d;
        best = { region: f, nearKm: d };
      }
    }
  }
  return best;
}

// --- Géocodage (Nominatim) --------------------------------------------------

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=fr&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Géocodage indisponible (${res.status})`);
  return res.json();
}

$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const list = $("#results");
  list.innerHTML = "<li class='muted'>Recherche…</li>";
  try {
    const hits = await geocode($("#address").value.trim());
    list.innerHTML = hits.length ? "" : "<li class='muted'>Aucun résultat. Essayez une adresse plus simple, ou cliquez sur la carte.</li>";
    for (const hit of hits) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = hit.display_name;
      btn.onclick = () => {
        list.innerHTML = "";
        addSite(Number(hit.lat), Number(hit.lon), addressNames(hit.display_name));
      };
      li.append(btn);
      list.append(li);
    }
  } catch (err) {
    // Le service de recherche d'adresse est partagé et peut saturer : le clic sur la carte
    // fonctionne sans lui.
    list.innerHTML = `<li class='muted'>${esc(err.message)}. Vous pouvez cliquer directement sur la carte pour placer le site.</li>`;
  }
});

// --- Sites ------------------------------------------------------------------

// Noms d'un site : infobulle de la carte, liste des sites, titre du rapport.
function addressNames(displayName) {
  const parts = displayName.split(",").map((s) => s.trim());
  return { tip: parts[0], short: parts.slice(0, 2).join(", "), title: parts.slice(0, 3).join(", ") };
}

function pointNames(lat, lon) {
  const name = `Point ${fmt3.format(lat)} ; ${fmt3.format(lon)}`;
  return { tip: name, short: name, title: name };
}

let siteSeq = 0;

function addSite(lat, lon, names) {
  // Un élément plutôt qu'une chaîne : Leaflet interpréterait une chaîne comme du HTML.
  const tip = Object.assign(document.createElement("span"), { textContent: names.tip });
  const marker = L.marker([lat, lon]).addTo(markers).bindTooltip(tip);
  const site = { id: ++siteSeq, lat, lon, ...names, ...findRegion(lat, lon), marker };
  state.sites.push(site);
  selectSite(site.id);
}

function selectSite(id) {
  state.active = id;
  render();
  // Sur petit écran, le rapport est loin sous les réglages : on y amène le lecteur.
  if (isNarrow()) showReport();
}

function removeSite(id) {
  const site = state.sites.find((s) => s.id === id);
  markers.removeLayer(site.marker);
  state.sites = state.sites.filter((s) => s.id !== id);
  if (state.active === id) state.active = state.sites.at(-1)?.id ?? null;
  if (!state.sites.length) regionLayer.clearLayers();
  render();
}

const showReport = () => $("#report").scrollIntoView({ block: "start" });

function renderSites() {
  $("#sites-block").hidden = state.sites.length === 0;
  const list = $("#sites");
  list.innerHTML = "";
  for (const site of state.sites) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = site.id === state.active ? "active" : "";
    btn.textContent = site.short;
    btn.onclick = () => selectSite(site.id);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "remove";
    del.textContent = "×";
    del.title = "Retirer ce site";
    del.setAttribute("aria-label", `Retirer le site ${site.short}`);
    del.onclick = () => removeSite(site.id);
    li.append(btn, del);
    list.append(li);
  }
}

// --- Contrôles --------------------------------------------------------------

function renderControls() {
  const select = $("#sector");
  select.innerHTML = Object.entries(SECTORS)
    .map(([id, s]) => `<option value="${id}" ${id === state.sector ? "selected" : ""}>${esc(s.label)}</option>`)
    .join("");
  select.onchange = () => {
    state.sector = select.value;
    renderReport();
  };

  const seg = $("#gwl");
  seg.innerHTML = "";
  GWLS.forEach((g, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(i === state.gwl));
    btn.innerHTML = i === 0 ? `Référence<small>Climat ${esc(REF)}</small>` : `${esc(g.year)}<small>${esc(g.label)}</small>`;
    btn.onclick = () => {
      state.gwl = i;
      renderControls();
      renderReport();
    };
    seg.append(btn);
  });

  const box = $("#questions");
  const themes = [...new Set(QUESTIONS.map((q) => q.theme))];
  box.innerHTML = themes
    .map(
      (theme) => `<fieldset><legend>${esc(theme)}</legend>${QUESTIONS.filter((q) => q.theme === theme)
        .map(
          (q) => `<label class="check"><input type="checkbox" data-q="${q.id}" ${state.answers[q.id] ? "checked" : ""}>
            <span>${esc(q.text)}<small class="q-effect">${
              q.hazards.length ? "Augmente la sensibilité : " + q.hazards.map(hazardName).join(", ") : "Signalé dans la synthèse, sans modifier les notes"
            }</small></span></label>`,
        )
        .join("")}</fieldset>`,
    )
    .join("");
  box.querySelectorAll("input[data-q]").forEach((input) => {
    input.onchange = () => {
      state.answers[input.dataset.q] = input.checked;
      renderReport();
    };
  });
}

// --- Éléments communs du rapport --------------------------------------------

const ARROWS = ["", "↑", "↑↑"];
const LEVEL_HELP = [
  "peu d'impact attendu pour votre activité",
  "à surveiller et à intégrer dans vos plans",
  "à traiter en priorité",
];
const STABLE_HELP = "pas de hausse notable ; le niveau de risque actuel n'est pas mesuré par ces données";

const hazardName = (id) => HAZARDS[id].label.toLowerCase();
const help = (text) => `<p class="help">${esc(text)}</p>`;
const horizonText = (g) => (g === 0 ? `sur la période ${REF}` : `en ${GWLS[g].year}`);

const trendText = (by, g) =>
  by ? `${by.ind.label} : +${Math.round(by.pct)} % ${horizonText(g)} par rapport à ${REF} (${num(by.ind.values[0])} → ${num(by.ind.values[g])} ${by.ind.unit})` : "";

const badge = (level, trend = 0, by = null, g = 0) =>
  `<span class="lvl ${level == null ? "lna" : "l" + level}" title="${level == null ? "Donnée non disponible" : esc(LEVELS[level] + " : " + LEVEL_HELP[level])}">${level == null ? "n.d." : LEVELS[level]}${
    trend ? ` <span class="trend" title="${esc(by ? trendText(by, g) : `Hausse d'au moins ${TREND_PCT[trend - 1]} % d'un indicateur par rapport à ${REF}`)}">${ARROWS[trend]}</span>` : ""
  }</span>`;

const stableBadge = () => `<span class="lvl lna" title="${esc("Stable : " + STABLE_HELP)}">Stable</span>`;

// Note d'un aléa à un horizon : niveau de risque, ou « Stable » pour un aléa dont on ne mesure que l'évolution.
const riskBadge = (h, i) => (h.stable[i] ? stableBadge() : badge(h.risk[i], h.trend[i], h.trendBy[i], i));

// Légende commune des niveaux et des flèches.
const legend = () => `<div class="legend">
  ${LEVELS.map((l, i) => `<span>${badge(i)} ${esc(LEVEL_HELP[i])}</span>`).join("")}
  <span>${stableBadge()} ${esc(STABLE_HELP)} (vent)</span>
  <span>${badge(null)} pas de données pour cette région</span>
  <span><strong>↑</strong> et <strong>↑↑</strong> : le risque s'aggrave. Un des chiffres qui servent à noter cet aléa (par exemple le nombre de jours au-dessus de 30 °C) augmente d'au moins ${TREND_PCT[0]} % (↑) ou ${TREND_PCT[1]} % (↑↑) par rapport à ${esc(REF)}. Ce chiffre est indiqué dans la synthèse et dans la fiche de l'aléa.</span>
</div>`;

function regionContext(site) {
  const { NUTS_ID: code, NAME_LATN: name, CNTR_CODE: country } = site.region.properties;
  return { code, name, country, data: state.data.regions[code] };
}

function assess(site) {
  const { data } = regionContext(site);
  return assessSite(data, state.data.meta, state.sector, state.answers);
}

// Phrase chiffrée pour le dirigeant : l'indicateur qui justifie la note, référence → horizon.
function keyFigure(h, g) {
  const ind = h.exposure[g]?.driver;
  if (!ind) return "";
  const figure =
    g === 0
      ? `${ind.label} : ${num(ind.values[g])} ${ind.unit}`
      : `${ind.label} : ${num(ind.values[g])} ${ind.unit} ${horizonText(g)}, contre ${num(ind.values[0])} en moyenne sur ${REF}`;
  // Exposition faible mais risque noté : la note vient de la sensibilité de l'activité, il faut le dire.
  return h.exposure[g].level === 0 ? `Exposition faible (${figure}), mais votre activité est très sensible à cet aléa` : figure;
}

function ranked(hazards, g) {
  return [...hazards].sort(
    (a, b) =>
      (b.risk[g] ?? -1) - (a.risk[g] ?? -1) ||
      (b.exposure[g]?.level ?? -1) - (a.exposure[g]?.level ?? -1) ||
      b.trend[g] - a.trend[g],
  );
}

// --- Niveau 1 : synthèse dirigeant --------------------------------------------

function synthesis(site, hazards, g) {
  const { name, code, country } = regionContext(site);
  const top = ranked(hazards, g).filter((h) => h.risk[g] > 0).slice(0, 3);
  const actions = top.map((h) => h.adaptation[0]);
  const missing = hazards.filter((h) => h.risk[g] == null && !h.stable[g]);
  const stable = hazards.filter((h) => h.stable[g]);

  const notes = [];
  if (site.nearKm > 0)
    notes.push(`Ce point est en dehors des contours simplifiés des régions (littoral, île ou pays voisin non couvert) : les données sont celles de la région la plus proche, ${name}, à ${num(Math.max(site.nearKm, 0.1))} km.`);
  if (missing.length)
    notes.push(`Non évalué faute de données Copernicus pour cette région : ${missing.map((h) => hazardName(h.id)).join(", ")}.`);
  for (const h of stable)
    notes.push(`${h.label} : pas de hausse notable des vents extrêmes ${horizonText(g)}. Les données ne mesurent pas le niveau de risque de tempête actuel de la région.`);
  if (country === "FR" && top.some((h) => h.id === "heat"))
    notes.push("En France, l'employeur doit prévoir des mesures pour les épisodes de chaleur intense dès la vigilance canicule jaune (décret n° 2025-482).");
  if (state.answers.suppliers)
    notes.push("Fournisseurs ou clients concentrés : vérifiez aussi l'exposition de leurs sites (risque indirect, non noté ici).");

  const body = top.length
    ? `<div class="top3">${top
        .map(
          (h) => `<div class="risk-top l${h.risk[g]}">
            <p class="top-title">${h.icon} ${esc(h.label)} ${riskBadge(h, g)}</p>
            <p class="top-fig"><span class="k">Pourquoi</span> ${esc(keyFigure(h, g))}</p>
            ${h.trendBy[g] ? `<p class="top-fig"><span class="k">Évolution ${ARROWS[h.trend[g]]}</span> ${esc(trendText(h.trendBy[g], g))}</p>` : ""}
            <p class="top-impact"><span class="k">Ce que ça peut provoquer</span> ${esc(h.impact)}</p>
          </div>`,
        )
        .join("")}</div>
      <h4>Actions prioritaires</h4>
      ${help("Une première action par risque, à approfondir avec votre conseiller.")}
      <ol class="actions">${actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>`
    : `<p>Aucun risque moyen ou élevé ${horizonText(g)} parmi les aléas évalués, pour ce secteur dans cette région.</p>`;

  return `<section class="layer layer-1">
    <div class="layer-head"><span class="tag">1 · Synthèse</span><span class="muted">pour le dirigeant</span></div>
    <h2>${esc(site.title)}</h2>
    <p class="muted">${esc(SECTORS[state.sector].label)} · région ${esc(name)} (${esc(code)}) · ${
      g === 0 ? "climat de référence " + esc(REF) : "horizon " + esc(GWLS[g].year) + " (" + esc(GWLS[g].label) + ")"
    }</p>
    ${help(`Les aléas climatiques qui pèsent le plus sur votre activité ${horizonText(g)}, classés du plus au moins préoccupant. Les chiffres sont des moyennes pour la région ${name}, pas pour l'adresse exacte.${
      g === 0 ? "" : ` Les valeurs futures sont des projections de modèles climatiques, pas des prévisions. Elles sont comparées à la moyenne ${REF} : le climat d'aujourd'hui est déjà plus chaud que cette référence.`
    }`)}
    ${body}
    ${notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}
    ${legend()}
  </section>`;
}

// --- Niveau 2 : détail conseiller ---------------------------------------------

function justification(h, g) {
  const e = h.exposure[g];
  if (!e) return "Pas de données Copernicus pour cet aléa dans cette région.";
  const ind = e.driver;
  if (h.stable[g])
    return `${esc(ind.label)} : ${num(ind.values[0])} → ${num(ind.values[g])} ${esc(ind.unit)}, sans hausse notable. Cet indice est défini par rapport au climat local : il mesure une évolution, pas le niveau de risque actuel de la région.`;
  const rule = ind.rule;
  let why;
  if (rule.abs) why = `${ind.label} : ${num(ind.values[g])} (seuils ${rule.abs.join(" / ")} ${ind.unit})`;
  else if (rule.europe) why = `${ind.label} : ${num(ind.values[g])}, par rapport aux régions européennes`;
  else why = `${ind.label} : ${num(ind.values[0])} → ${num(ind.values[g])} par rapport au climat local`;
  const s = h.sensitivity;
  const sens = [`secteur : ${LEVELS[s.base]}`, ...s.reasons.map((q) => "+ " + q.text.toLowerCase())].join(" ; ");
  return `Exposition <strong>${LEVELS[e.level]}</strong> (${esc(why)}) × sensibilité <strong>${LEVELS[s.level]}</strong> (${esc(sens)}) → <strong>${LEVELS[h.risk[g]]}</strong>`;
}

function hazardCard(h, g) {
  const rows = h.indicators
    .map((ind) => {
      const v = ind.values[g];
      const range = g > 0 && ind.lo[g] != null ? `<br><small class="muted" title="Fourchette entre modèles (17–83 %)">${num(ind.lo[g])}–${num(ind.hi[g])}</small>` : "";
      const local = ind.relative ? `<br><small class="muted">par rapport au climat local</small>` : "";
      const lvl =
        ind.levels[g] == null
          ? `<span class="muted" title="Affiché pour information, n'entre pas dans la note">info</span>`
          : h.stable[g]
            ? stableBadge()
            : badge(ind.levels[g]);
      return `<tr><td>${esc(ind.label)} <span class="muted">${esc(ind.unit)}</span>${local}<small class="ind-help">${esc(ind.help)}</small></td>
        <td>${num(ind.values[0])}</td>${g === 0 ? "" : `<td>${num(v)}${range}</td>`}<td>${lvl}</td></tr>`;
    })
    .join("");
  const table = rows
    ? `<table class="ind"><thead><tr><th>Indicateur</th><th>${esc(REF)}</th>${g === 0 ? "" : `<th>${esc(GWLS[g].year)}</th>`}<th>Niveau</th></tr></thead>
      <tbody>${rows}</tbody></table>
    ${help(`« ${REF} » = climat de référence, moyenne sur cette période. ${g === 0 ? "" : `« ${GWLS[g].year} » = moyenne des modèles climatiques ; la petite ligne donne la fourchette où se situent 2 modèles sur 3. `}« Niveau » = note de l'indicateur selon son seuil ; l'aléa retient l'indicateur le plus défavorable.`)}`
    : "";
  return `<article class="card">
    <div class="card-head"><h3>${h.icon} ${esc(h.label)}</h3>${riskBadge(h, g)}</div>
    ${help(h.help)}
    <p class="why"><span class="k">Comment la note est obtenue</span> ${justification(h, g)}</p>
    ${h.trendBy[g] ? `<p class="why"><span class="k">Pourquoi la flèche ${ARROWS[h.trend[g]]}</span> ${esc(trendText(h.trendBy[g], g))}</p>` : ""}
    <p class="impact"><span class="k">Conséquence possible pour votre secteur</span> ${esc(h.impact)}</p>
    ${table}
    <p class="label-sm">Pistes d'adaptation <span class="muted">(exemples, à adapter à votre situation)</span></p>
    <ul>${h.adaptation.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
  </article>`;
}

function sitesTable(g) {
  const located = state.sites.filter((s) => s.region);
  if (located.length < 2) return "";
  const rows = located
    .map((site) => `<tr><td class="hz">${esc(site.short)}</td>${assess(site)
      .map((h) => `<td>${riskBadge(h, g)}</td>`)
      .join("")}</tr>`)
    .join("");
  const head = assess(located[0]).map((h) => `<th>${h.icon} ${esc(h.label)}</th>`).join("");
  return `<h4>Comparaison des sites ${horizonText(g)}</h4>
    ${help("Même entreprise et mêmes réponses au questionnaire : seule l'exposition change d'un site à l'autre.")}
    <div class="matrix-wrap"><table class="matrix"><thead><tr><th>Site</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function detail(hazards, g) {
  const matrix = `<div class="matrix-wrap"><table class="matrix">
    <thead><tr><th>Aléa</th>${GWLS.map(
      (x, i) => `<th class="${i === g ? "sel" : ""}">${esc(x.year)}<small>${i === 0 ? "Référence" : esc(x.label)}</small></th>`,
    ).join("")}</tr></thead>
    <tbody>${hazards
      .map((h) => `<tr><td class="hz">${h.icon} ${esc(h.label)}</td>${GWLS.map((_, i) => `<td>${riskBadge(h, i)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;

  return `<details class="layer layer-2" open>
    <summary><span class="tag">2 · Détail</span><span class="muted">pour le conseiller : notes justifiées, tous les horizons</span></summary>
    ${help("Chaque note croise deux éléments : l'exposition, c'est-à-dire ce que le climat fait subir à la région, et la sensibilité, c'est-à-dire à quel point votre activité en souffre (selon votre secteur et vos réponses au questionnaire).")}
    <h4>Évolution dans le temps</h4>
    ${help(`Une ligne par aléa, une colonne par horizon. La première colonne est la référence ${REF} ; le climat d'aujourd'hui se situe déjà entre cette référence et la colonne 2030. Les années indiquent quand le réchauffement mondial atteindrait chaque niveau selon la trajectoire européenne de référence : elles sont indicatives.`)}
    ${matrix}
    ${legend()}
    ${sitesTable(g)}
    <h4>Fiches par aléa</h4>
    ${help("Du plus au moins préoccupant à l'horizon choisi, avec le détail des indicateurs Copernicus utilisés.")}
    <div class="cards">${ranked(hazards, g).map((h) => hazardCard(h, g)).join("")}</div>
  </details>`;
}

// --- Niveau 3 : annexe données et méthode --------------------------------------

function annex(site, hazards) {
  const { code } = regionContext(site);
  const rows = hazards
    .flatMap((h) => h.indicators.map((ind) => ({ h, ind })))
    .map(
      ({ h, ind }) => `<tr><td>${esc(h.label)}</td><td><code>${esc(ind.id)}</code><br>${esc(ind.label)}<small class="ind-help">${esc(ind.help)}</small></td><td>${esc(ind.unit)}</td>
        ${GWLS.map((_, i) => `<td>${num(ind.values[i])}${i > 0 && ind.lo[i] != null ? `<br><small class="muted">${num(ind.lo[i])}–${num(ind.hi[i])}</small>` : ""}</td>`).join("")}
        <td class="src">${esc(ind.source)}</td></tr>`,
    )
    .join("");
  const m = MATRIX.map(
    (row, e) => `<tr><th>Exposition ${LEVELS[e]}</th>${row.map((r) => `<td>${badge(r)}</td>`).join("")}</tr>`,
  ).join("");

  return `<details class="layer layer-3">
    <summary><span class="tag">3 · Annexe données et méthode</span><span class="muted">pour une banque, un assureur ou un auditeur</span></summary>
    ${help("Toutes les valeurs et règles utilisées, pour vérifier les notes ou les réutiliser dans vos propres outils.")}
    <div class="annex-actions"><button type="button" class="ghost" id="csv">Exporter les données (CSV)</button></div>
    ${help("Le fichier CSV contient tous les sites, indicateurs et horizons, avec les fourchettes et les niveaux. Il est au format français (point-virgule, virgule décimale).")}
    <h4>Valeurs pour la région ${esc(code)}</h4>
    ${help("Moyenne des modèles climatiques ; la petite ligne donne la fourchette entre modèles (quantiles 17 % et 83 %, soit 2 modèles sur 3). La dernière colonne indique d'où vient chaque seuil.")}
    <div class="matrix-wrap"><table class="ind annex">
      <thead><tr><th>Aléa</th><th>Indicateur</th><th>Unité</th>${GWLS.map((g) => `<th>${esc(g.label)}</th>`).join("")}<th>Règle et source du seuil</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <h4>Méthode</h4>
    ${help("Comment les notes sont calculées, étape par étape.")}
    <ul class="method">
      <li>Démarche de « screening » du guide européen C(2021) 5430 sur le climate proofing : sensibilité × exposition = vulnérabilité, sur 3 niveaux (Faible, Moyen, Élevé).</li>
      <li>Référence : moyenne ${esc(REF)}, reconstituée à partir des projections (valeur à un niveau de réchauffement moins l'écart à ce niveau), à 1 ou 2 jours près. Le climat de l'année en cours est déjà plus chaud que cette référence.</li>
      <li>Exposition d'un aléa : indicateur le plus défavorable, sur la référence et à +1,5 °C, +2 °C et +3 °C de réchauffement mondial. Années indicatives selon la trajectoire de référence du European Climate Viewer.</li>
      <li>Sensibilité : note sectorielle d'expert, relevée d'un niveau par réponse « oui » au questionnaire (thèmes du guide européen), plafonnée à Élevé. Une sensibilité élevée donne un risque Moyen même quand l'exposition est faible.</li>
      <li>Vent : le seul indicateur disponible est défini par rapport au climat local. Sans hausse d'au moins 15 %, l'aléa est noté « Stable » : le niveau de risque de tempête actuel n'est pas mesuré.</li>
      <li>Tendance : ↑ ou ↑↑ si un indicateur augmente d'au moins ${TREND_PCT[0]} % ou ${TREND_PCT[1]} % par rapport à ${esc(REF)}, comptée seulement pour un indicateur qui atteint lui-même au moins Moyen, et affichée seulement quand le risque est au moins Moyen.</li>
      <li>Données : Copernicus C3S, « Aggregated climate indicators for Europe » v2.0 (CDS, CC-BY 4.0) ; moyenne multi-modèles par région NUTS 2, fourchette 17–83 % entre modèles. L'ensemble de modèles varie d'un niveau de réchauffement à l'autre : de petits allers-retours entre deux horizons sont possibles.</li>
      <li>Rattachement : un point situé hors des contours simplifiés (1:20 000 000) est rattaché à la région la plus proche, jusqu'à ${NEAR_KM} km.</li>
    </ul>
    <h4>Matrice de croisement</h4>
    ${help("Lecture : une ligne par niveau d'exposition, une colonne par niveau de sensibilité ; la case donne le niveau de risque.")}
    <table class="matrix small"><thead><tr><th></th>${LEVELS.map((l) => `<th>Sensibilité ${l}</th>`).join("")}</tr></thead><tbody>${m}</tbody></table>
  </details>`;
}

// Cellule CSV au format français : virgule décimale, et apostrophe devant un texte qu'un tableur
// prendrait pour une formule.
function csvCell(value) {
  let text = typeof value === "number" ? String(value).replace(".", ",") : String(value ?? "");
  if (typeof value !== "number" && /^[=+\-@]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv() {
  const header = ["site", "nuts", "secteur", "alea", "indicateur", "unite", "horizon", "valeur", "p17", "p83", "niveau_indicateur", "exposition_alea", "sensibilite_alea", "risque_alea"];
  const lines = [header];
  const level = (l) => (l == null ? "" : LEVELS[l]);
  for (const site of state.sites.filter((s) => s.region)) {
    const { code } = regionContext(site);
    for (const h of assess(site)) {
      for (const ind of h.indicators) {
        GWLS.forEach((g, i) => {
          lines.push([
            site.short, code, SECTORS[state.sector].label, h.label, ind.id, ind.unit,
            i === 0 ? g.label : `${g.year} (${g.label})`,
            ind.values[i], ind.lo[i], ind.hi[i],
            h.stable[i] ? "Stable" : level(ind.levels[i]),
            h.stable[i] ? "Stable" : level(h.exposure[i]?.level),
            level(h.sensitivity.level),
            h.stable[i] ? "Stable (niveau non mesuré)" : level(h.risk[i]),
          ]);
        });
      }
    }
  }
  const csv = lines.map((row) => row.map(csvCell).join(";")).join("\r\n");
  // Marque d'ordre d'octets en tête : sans elle, Excel lit mal les accents.
  const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "risques-climatiques.csv" });
  a.click();
  URL.revokeObjectURL(url);
}

// --- Rapport -----------------------------------------------------------------

function renderReport() {
  const report = $("#report");
  const site = state.sites.find((s) => s.id === state.active);
  if (!site) {
    report.hidden = true;
    return;
  }
  report.hidden = false;
  regionLayer.clearLayers();

  if (!site.region) {
    report.innerHTML = `<section class="layer"><h2>${esc(site.title)}</h2>
      <p>Ce point est à plus de ${NEAR_KM} km de toute région couverte (hors Europe ou en mer). Essayez une autre adresse.</p></section>`;
    return;
  }
  regionLayer.addData(site.region);
  map.fitBounds(regionLayer.getBounds(), { maxZoom: 9 });

  const { code, name, data } = regionContext(site);
  const hazards = data ? assess(site) : [];
  // Outre-mer et certaines îles : la région existe, mais les projections européennes ne la couvrent pas.
  if (!hazards.some((h) => h.indicators.length)) {
    report.innerHTML = `<section class="layer"><h2>${esc(site.title)}</h2>
      <div class="banner">Pas de données Copernicus pour la région ${esc(name)} (${esc(code)}).</div>
      <p>Les projections utilisées couvrent l'Europe continentale et les îles proches. Les régions d'outre-mer et certaines îles éloignées n'y figurent pas : l'outil ne peut pas évaluer ce site, ce qui ne signifie pas qu'il est sans risque.</p></section>`;
    return;
  }
  const g = state.gwl;
  report.innerHTML = synthesis(site, hazards, g) + detail(hazards, g) + annex(site, hazards);
  $("#csv").onclick = exportCsv;
}

function render() {
  renderControls();
  renderSites();
  renderReport();
}

// --- Démarrage --------------------------------------------------------------

$("#print").onclick = () => window.print();
$("#to-report").onclick = showReport;
// À l'impression, les trois niveaux sont dépliés.
window.addEventListener("beforeprint", () => document.querySelectorAll("#report details").forEach((d) => (d.open = true)));
// Sur petit écran, le questionnaire replié laisse la carte et le rapport à portée de pouce.
if (isNarrow()) $("#quiz").open = false;

async function init() {
  const [data, nuts] = await Promise.all([
    fetch("data/indicators.json").then((r) => (r.ok ? r.json() : Promise.reject(new Error("data/indicators.json introuvable")))),
    fetch("data/nuts2.geojson").then((r) => r.json()),
  ]);
  state.data = data;
  state.nuts = nuts;
  $("#demo-banner").hidden = !data.meta.demo;
  render();
}

init().catch((err) => {
  const report = $("#report");
  report.hidden = false;
  report.innerHTML = `<div class="banner">Chargement impossible : ${esc(err.message)}. Voir README.md.</div>`;
});
