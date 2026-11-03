import { GWLS, HAZARDS, LEVELS, MATRIX, QUESTIONS, SECTORS, TREND_PCT, assessSite } from "./risk-model.js?v=10";

const state = {
  data: null, // data/indicators.json
  nuts: null, // data/nuts2.geojson
  sector: "manufacturing",
  gwl: 2, // index dans GWLS
  answers: {}, // id de question -> booléen, communs à tous les sites
  sites: [], // { id, label, lat, lon, region }
  active: null,
};

const $ = (sel) => document.querySelector(sel);
const fmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (v) => (v == null ? "–" : fmt.format(v));
const shortLabel = (site) => site.label.split(",").slice(0, 2).join(",");

// --- Carte -----------------------------------------------------------------

const map = L.map("map", { zoomControl: true }).setView([50, 10], 4);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "© contributeurs OpenStreetMap",
}).addTo(map);
const regionLayer = L.geoJSON(null, { style: { color: "#1f6f5c", weight: 2, fillOpacity: 0.12 } }).addTo(map);
const markers = L.layerGroup().addTo(map);

map.on("click", (e) => addSite(e.latlng.lat, e.latlng.lng, `Point ${fmt.format(e.latlng.lat)}, ${fmt.format(e.latlng.lng)}`));

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

function findRegion(lat, lon) {
  return state.nuts.features.find(({ geometry: g }) => {
    if (g.type === "Polygon") return inPolygon(lon, lat, g.coordinates);
    if (g.type === "MultiPolygon") return g.coordinates.some((p) => inPolygon(lon, lat, p));
    return false;
  });
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
        addSite(Number(hit.lat), Number(hit.lon), hit.display_name);
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

function addSite(lat, lon, label) {
  const region = findRegion(lat, lon);
  const site = { id: crypto.randomUUID(), label, lat, lon, region };
  state.sites.push(site);
  state.active = site.id;
  L.marker([lat, lon]).addTo(markers).bindTooltip(label.split(",")[0]);
  render();
}

function renderSites() {
  $("#sites-block").hidden = state.sites.length === 0;
  const list = $("#sites");
  list.innerHTML = "";
  for (const site of state.sites) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = site.id === state.active ? "active" : "";
    btn.textContent = shortLabel(site);
    btn.onclick = () => {
      state.active = site.id;
      render();
    };
    li.append(btn);
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
    btn.innerHTML = `${i === 0 ? "Aujourd'hui" : esc(g.year)}<small>${esc(g.label)}${i === 0 ? " · " + esc(g.horizon) : ""}</small>`;
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

const hazardName = (id) => HAZARDS[id].label.toLowerCase();
const help = (text) => `<p class="help">${esc(text)}</p>`;

// Légende commune des niveaux et des flèches.
const legend = () => `<div class="legend">
  ${LEVELS.map((l, i) => `<span>${badge(i)} ${esc(LEVEL_HELP[i])}</span>`).join("")}
  <span><strong>↑</strong> et <strong>↑↑</strong> : le risque s'aggrave. Un des chiffres qui servent à noter cet aléa (par exemple le nombre de jours au-dessus de 30 °C) augmente d'au moins ${TREND_PCT[0]} % (↑) ou ${TREND_PCT[1]} % (↑↑) par rapport à aujourd'hui. Survolez une flèche pour voir lequel.</span>
</div>`;

const trendText = (by, g) =>
  by ? `${by.ind.label} : +${Math.round(by.pct)} % ${horizonText(g)} par rapport à aujourd'hui (${num(by.ind.values[0])} → ${num(by.ind.values[g])} ${by.ind.unit})` : "";

const badge = (level, trend = 0, by = null, g = 0) =>
  `<span class="lvl ${level == null ? "lna" : "l" + level}" title="${level == null ? "Donnée non disponible" : esc(LEVELS[level] + " : " + LEVEL_HELP[level])}">${level == null ? "n.d." : LEVELS[level]}${
    trend ? ` <span class="trend" title="${esc(by ? trendText(by, g) : `Hausse d'au moins ${TREND_PCT[trend - 1]} % d'un indicateur par rapport à aujourd'hui`)}">${ARROWS[trend]}</span>` : ""
  }</span>`;

const horizonText = (g) => (g === 0 ? "aujourd'hui" : `en ${GWLS[g].year}`);

function regionContext(site) {
  const { NUTS_ID: code, NAME_LATN: name, CNTR_CODE: country } = site.region.properties;
  return { code, name, country, data: state.data.regions[code] };
}

function assess(site) {
  const { data } = regionContext(site);
  return assessSite(data, state.data.meta, state.sector, state.answers);
}

// Phrase chiffrée pour le dirigeant : l'indicateur qui justifie la note, aujourd'hui → horizon.
function keyFigure(h, g) {
  const ind = h.exposure[g]?.driver;
  if (!ind) return "";
  const v = ind.values[g];
  const base = ind.values[0];
  if (g === 0) return `${num(v)} ${ind.unit} — ${ind.label.toLowerCase()}`;
  return `${ind.label} : ${num(v)} ${ind.unit} ${horizonText(g)}, contre ${num(base)} aujourd'hui`;
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
  const top = ranked(hazards, g).filter((h) => h.risk[g] != null && (h.risk[g] > 0 || h.trend[g] > 0)).slice(0, 3);
  const actions = top.map((h) => h.adaptation[0]);
  const legal =
    country === "FR" && top.some((h) => h.id === "heat")
      ? `<p class="note">En France, l'employeur doit prévoir des mesures pour les épisodes de chaleur intense dès la vigilance canicule jaune (décret n° 2025-482).</p>`
      : "";
  const indirect = state.answers.suppliers
    ? `<p class="note">Fournisseurs ou clients concentrés : vérifiez aussi l'exposition de leurs sites (risque indirect, non noté ici).</p>`
    : "";

  const body = top.length
    ? `<div class="top3">${top
        .map(
          (h) => `<div class="risk-top l${h.risk[g]}">
            <p class="top-title">${h.icon} ${esc(h.label)} ${badge(h.risk[g], h.trend[g], h.trendBy[g], g)}</p>
            <p class="top-fig"><span class="k">Pourquoi</span> ${esc(keyFigure(h, g))}</p>
            ${h.trendBy[g] ? `<p class="top-fig"><span class="k">Évolution ${ARROWS[h.trend[g]]}</span> ${esc(trendText(h.trendBy[g], g))}</p>` : ""}
            <p class="top-impact"><span class="k">Ce que ça peut provoquer</span> ${esc(h.impact)}</p>
          </div>`,
        )
        .join("")}</div>
      <h4>Actions prioritaires</h4>
      ${help("Une première action par risque, à approfondir avec votre conseiller.")}
      <ol class="actions">${actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>`
    : `<p>Aucun risque moyen ou élevé ${horizonText(g)} pour ce secteur dans cette région.</p>`;

  return `<section class="layer layer-1">
    <div class="layer-head"><span class="tag">1 · Synthèse</span><span class="muted">pour le dirigeant</span></div>
    <h2>${esc(site.label.split(",").slice(0, 3).join(","))}</h2>
    <p class="muted">${esc(SECTORS[state.sector].label)} · région ${esc(name)} (${esc(code)}) · horizon ${
      g === 0 ? "aujourd'hui" : esc(GWLS[g].year) + " (" + esc(GWLS[g].label) + ")"
    }</p>
    ${help(`Les aléas climatiques qui pèsent le plus sur votre activité ${horizonText(g)}, classés du plus au moins préoccupant. Les chiffres sont des moyennes pour la région ${name}, pas pour l'adresse exacte.${g === 0 ? "" : " Les valeurs futures sont des projections de modèles climatiques, pas des prévisions."}`)}
    ${body}
    ${legal}${indirect}
    ${legend()}
  </section>`;
}

// --- Niveau 2 : détail conseiller ---------------------------------------------

function justification(h, g) {
  const e = h.exposure[g];
  if (!e) return "Exposition non disponible.";
  const ind = e.driver;
  const rule = ind.rule;
  let why;
  if (rule.abs) why = `${ind.label} : ${num(ind.values[g])} (seuils ${rule.abs.join(" / ")})`;
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
      const lvl = ind.levels[g] == null ? `<span class="muted" title="Affiché pour information, n'entre pas dans la note">info</span>` : badge(ind.levels[g]);
      return `<tr><td>${esc(ind.label)} <span class="muted">${esc(ind.unit)}</span>${local}<small class="ind-help">${esc(ind.help)}</small></td>
        <td>${num(ind.values[0])}</td>${g === 0 ? "" : `<td>${num(v)}${range}</td>`}<td>${lvl}</td></tr>`;
    })
    .join("");
  return `<article class="card">
    <div class="card-head"><h3>${h.icon} ${esc(h.label)}</h3>${badge(h.risk[g], h.trend[g], h.trendBy[g], g)}</div>
    ${help(h.help)}
    <p class="why"><span class="k">Comment la note est obtenue</span> ${justification(h, g)}</p>
    ${h.trendBy[g] ? `<p class="why"><span class="k">Pourquoi la flèche ${ARROWS[h.trend[g]]}</span> ${esc(trendText(h.trendBy[g], g))}</p>` : ""}
    <p class="impact"><span class="k">Conséquence possible pour votre secteur</span> ${esc(h.impact)}</p>
    <table class="ind"><thead><tr><th>Indicateur</th><th>Aujourd'hui</th>${g === 0 ? "" : `<th>${esc(GWLS[g].year)}</th>`}<th>Niveau</th></tr></thead>
      <tbody>${rows}</tbody></table>
    ${help(`« Aujourd'hui » = moyenne 1991–2020. ${g === 0 ? "" : `« ${GWLS[g].year} » = moyenne des modèles climatiques ; la petite ligne donne la fourchette où se situent 2 modèles sur 3. `}« Niveau » = note de l'indicateur selon son seuil ; l'aléa retient l'indicateur le plus défavorable.`)}
    <p class="label-sm">Pistes d'adaptation <span class="muted">(exemples, à adapter à votre situation)</span></p>
    <ul>${h.adaptation.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
  </article>`;
}

function sitesTable(g) {
  const located = state.sites.filter((s) => s.region);
  if (located.length < 2) return "";
  const rows = located
    .map((site) => `<tr><td class="hz">${esc(shortLabel(site))}</td>${assess(site)
      .map((h) => `<td>${badge(h.risk[g], h.trend[g], h.trendBy[g], g)}</td>`)
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
      (x, i) => `<th class="${i === g ? "sel" : ""}">${i === 0 ? "Aujourd'hui" : esc(x.year)}<small>${esc(x.label)}</small></th>`,
    ).join("")}</tr></thead>
    <tbody>${hazards
      .map((h) => `<tr><td class="hz">${h.icon} ${esc(h.label)}</td>${h.risk.map((r, i) => `<td>${badge(r, h.trend[i], h.trendBy[i], i)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;

  return `<details class="layer layer-2" open>
    <summary><span class="tag">2 · Détail</span><span class="muted">pour le conseiller : notes justifiées, tous les horizons</span></summary>
    ${help("Chaque note croise deux éléments : l'exposition, c'est-à-dire ce que le climat fait subir à la région, et la sensibilité, c'est-à-dire à quel point votre activité en souffre (selon votre secteur et vos réponses au questionnaire).")}
    <h4>Évolution dans le temps</h4>
    ${help("Une ligne par aléa, une colonne par horizon. Les années indiquent quand le réchauffement mondial atteindrait ce niveau selon la trajectoire européenne de référence : elles sont indicatives.")}
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
    ${help("Le fichier CSV contient tous les sites, indicateurs et horizons, avec les fourchettes et les niveaux.")}
    <h4>Valeurs pour la région ${esc(code)}</h4>
    ${help("Moyenne des modèles climatiques ; la petite ligne donne la fourchette entre modèles (quantiles 17 % et 83 %, soit 2 modèles sur 3). La dernière colonne indique d'où vient chaque seuil.")}
    <div class="matrix-wrap"><table class="ind annex">
      <thead><tr><th>Aléa</th><th>Indicateur</th><th>Unité</th>${GWLS.map((g) => `<th>${esc(g.label)}</th>`).join("")}<th>Règle et source du seuil</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <h4>Méthode</h4>
    ${help("Comment les notes sont calculées, étape par étape.")}
    <ul class="method">
      <li>Démarche de « screening » du guide européen C(2021) 5430 sur le climate proofing : sensibilité × exposition = vulnérabilité, sur 3 niveaux (Faible, Moyen, Élevé).</li>
      <li>Exposition d'un aléa : indicateur le plus défavorable, au climat actuel (1991–2020) et à +1,5 °C, +2 °C et +3 °C de réchauffement mondial. Années indicatives selon la trajectoire de référence du European Climate Viewer.</li>
      <li>Sensibilité : note sectorielle d'expert, relevée d'un niveau par réponse « oui » au questionnaire (thèmes du guide européen), plafonnée à Élevé.</li>
      <li>Tendance : ↑ ou ↑↑ si un indicateur augmente d'au moins ${TREND_PCT[0]} % ou ${TREND_PCT[1]} % par rapport à aujourd'hui, comptée seulement pour un indicateur qui atteint lui-même au moins Moyen, et affichée seulement quand le risque est au moins Moyen.</li>
      <li>Données : Copernicus C3S, « Aggregated climate indicators for Europe » v2.0 (CDS, CC-BY 4.0) ; moyenne multi-modèles par région NUTS 2, fourchette 17–83 % entre modèles.</li>
    </ul>
    <h4>Matrice de croisement</h4>
    ${help("Lecture : une ligne par niveau d'exposition, une colonne par niveau de sensibilité ; la case donne le niveau de risque.")}
    <table class="matrix small"><thead><tr><th></th>${LEVELS.map((l) => `<th>Sensibilité ${l}</th>`).join("")}</tr></thead><tbody>${m}</tbody></table>
  </details>`;
}

function exportCsv() {
  const header = ["site", "nuts", "secteur", "alea", "indicateur", "unite", "horizon", "valeur", "p17", "p83", "niveau_indicateur", "risque_alea"];
  const lines = [header];
  for (const site of state.sites.filter((s) => s.region)) {
    const { code } = regionContext(site);
    for (const h of assess(site)) {
      for (const ind of h.indicators) {
        GWLS.forEach((g, i) => {
          lines.push([
            shortLabel(site), code, state.sector, h.id, ind.id, ind.unit, g.label,
            ind.values[i], ind.lo[i], ind.hi[i],
            ind.levels[i] == null ? "" : LEVELS[ind.levels[i]],
            h.risk[i] == null ? "" : LEVELS[h.risk[i]],
          ]);
        });
      }
    }
  }
  const csv = lines.map((row) => row.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
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
    report.innerHTML = `<section class="layer"><h2>${esc(site.label)}</h2>
      <p>Ce point n'est rattaché à aucune région NUTS 2 couverte (hors Europe ou en mer).</p></section>`;
    return;
  }
  regionLayer.addData(site.region);
  map.fitBounds(regionLayer.getBounds(), { maxZoom: 9 });

  const { code, data } = regionContext(site);
  if (!data) {
    report.innerHTML = `<section class="layer"><div class="banner">Pas de données Copernicus pour la région ${esc(code)}.</div></section>`;
    return;
  }
  const g = state.gwl;
  const hazards = assess(site);
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
// À l'impression, les trois niveaux sont dépliés.
window.addEventListener("beforeprint", () => document.querySelectorAll("#report details").forEach((d) => (d.open = true)));

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
