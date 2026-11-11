import { GWLS, HAZARDS, LEVELS, MATRIX, QUESTIONS, SECTORS, TREND_PCT, assessSite, indicatorLevel, sectorSensitivity } from "./risk-model.js?v=20";

const state = {
  data: null, // data/indicators.json : moyennes régionales, utilisées à défaut de maille
  grid: null, // data/grid/index.json : description de la grille de 0,25°
  nuts: null, // data/nuts2.geojson
  sector: "manufacturing",
  gwl: 2, // index dans GWLS
  // Réponses : true (oui), false (non), absente (ne sait pas). Ici celles qui décrivent l'entreprise ;
  // celles qui décrivent un lieu sont rangées dans chaque site.
  answers: {},
  sites: [], // { id, lat, lon, tip, short, title, region, nearKm, cell, marker, answers }
  active: null,
};

const REF = GWLS[0].year; // période de référence, « 1991–2020 »
// Au-delà de cette distance d'un contour, un point n'est rattaché à aucune région.
const NEAR_KM = 30;
// Maille terrestre la plus proche : cherchée à 2 mailles autour du point, retenue jusqu'à 40 km.
const CELL_REACH = 2;
const CELL_MAX_KM = 40;

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
const regionLayer = L.geoJSON(null, { style: { color: "#1f6f5c", weight: 1, dashArray: "4 4", fillOpacity: 0.04 } }).addTo(map);
const cellLayer = L.layerGroup().addTo(map);
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
  // Trou qu'aucune région ne comble : un micro-État enclavé (le Vatican dans le Latium). À cette
  // échelle, le trou déborde de plusieurs kilomètres sur la ville qui l'entoure : le centre de Rome y
  // tombe. Le point appartient donc très probablement à la région englobante.
  const around = state.nuts.features.find((f) => polygonsOf(f.geometry).some((p) => inRing(lon, lat, p[0])));
  if (around) return { region: around, nearKm: 0 };
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

// --- Maille de la grille de 0,25° autour du site -----------------------------

const tileCache = new Map();

function loadTile(id) {
  if (!state.grid.tiles.includes(id)) return Promise.resolve({});
  if (!tileCache.has(id)) {
    tileCache.set(
      id,
      fetch(`data/grid/${id}.json`)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})),
    );
  }
  return tileCache.get(id);
}

// Une maille stocke, par indicateur : 4 valeurs (référence et 3 horizons), puis bornes basses et hautes.
function cellData(cell) {
  const data = {};
  state.grid.indicators.forEach((name, k) => {
    const a = cell[k];
    if (a) data[name] = { v: a.slice(0, 4), lo: [null, ...a.slice(4, 7)], hi: [null, ...a.slice(7, 10)] };
  });
  return data;
}

// La grille couvre aussi la mer, où le climat est plus tempéré : les tuiles ne gardent que les mailles
// terrestres, et un site côtier prend la plus proche.
async function findCell(lat, lon) {
  const g = state.grid;
  if (!g) return null;
  const i0 = Math.round((lat - g.lat0) / g.step);
  const j0 = Math.round((lon - g.lon0) / g.step);
  const around = [];
  for (let i = i0 - CELL_REACH; i <= i0 + CELL_REACH; i++) for (let j = j0 - CELL_REACH; j <= j0 + CELL_REACH; j++) if (i >= 0 && j >= 0) around.push([i, j]);
  const ids = [...new Set(around.map(([i, j]) => `${Math.floor(i / g.tile)}_${Math.floor(j / g.tile)}`))];
  const cells = Object.assign({}, ...(await Promise.all(ids.map(loadTile))));
  let best = null;
  const near = {}; // par indicateur : minimum et maximum des mailles terrestres à portée, à chaque horizon
  for (const [i, j] of around) {
    const cell = cells[`${i}_${j}`];
    if (!cell) continue;
    const clat = g.lat0 + i * g.step;
    const clon = g.lon0 + j * g.step;
    const km = Math.hypot((clat - lat) * 110.57, (clon - lon) * 111.32 * Math.cos((lat * Math.PI) / 180));
    if (km > CELL_MAX_KM) continue;
    const data = cellData(cell);
    for (const [name, { v }] of Object.entries(data)) {
      near[name] ??= { min: [...v], max: [...v] };
      v.forEach((x, k) => {
        near[name].min[k] = Math.min(near[name].min[k], x);
        near[name].max[k] = Math.max(near[name].max[k], x);
      });
    }
    if (!best || km < best.km) best = { lat: clat, lon: clon, km, data };
  }
  return best && { ...best, near };
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

async function addSite(lat, lon, names) {
  // Un élément plutôt qu'une chaîne : Leaflet interpréterait une chaîne comme du HTML.
  const tip = Object.assign(document.createElement("span"), { textContent: names.tip });
  const marker = L.marker([lat, lon]).addTo(markers).bindTooltip(tip);
  const cell = await findCell(lat, lon);
  const site = { id: ++siteSeq, lat, lon, ...names, ...findRegion(lat, lon), cell, marker, answers: {} };
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
  if (!state.sites.length) {
    regionLayer.clearLayers();
    cellLayer.clearLayers();
  }
  render();
}

const showReport = () => $("#report").scrollIntoView({ block: "start" });

// Exemple en un clic, pour le visiteur qui découvre l'outil : une entreprise de BTP fictive à Montpellier.
const EXAMPLE = {
  lat: 43.6108,
  lon: 3.8767,
  sector: "construction",
  names: { tip: "Montpellier (exemple)", short: "Montpellier (exemple)", title: "Montpellier, Hérault, Occitanie (exemple)" },
};

function showExample() {
  state.sector = EXAMPLE.sector;
  addSite(EXAMPLE.lat, EXAMPLE.lon, EXAMPLE.names);
}

function renderSites() {
  $("#sites-block").hidden = state.sites.length === 0;
  // L'exemple sert à découvrir l'outil : il s'efface dès qu'un site est affiché.
  $("#example-block").hidden = state.sites.length > 0;
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

  renderQuestions();
}

// --- Questionnaire ----------------------------------------------------------

const COMPANY_QUESTIONS = QUESTIONS.filter((q) => q.scope !== "site");
const SITE_QUESTIONS = QUESTIONS.filter((q) => q.scope === "site");
const CHOICES = [["oui", "Oui", true], ["non", "Non", false], ["", "Ne sait pas", undefined]];

const activeSite = () => state.sites.find((s) => s.id === state.active);
// Réponses qui s'appliquent à un site : celles de l'entreprise, plus les siennes.
const answersFor = (site) => ({ ...state.answers, ...site?.answers });

// Trois réponses par question : un « non » se distingue d'une question laissée sans réponse.
function questionsHtml(questions, answers, group) {
  const themes = [...new Set(questions.map((q) => q.theme))];
  return themes
    .map(
      (theme) => `<fieldset><legend>${esc(theme)}</legend>${questions
        .filter((q) => q.theme === theme)
        .map(
          (q) => `<div class="q" data-q="${q.id}">
            <p class="q-text" id="qt-${group}-${q.id}">${esc(q.text)}</p>
            <div class="q-choice" role="radiogroup" aria-labelledby="qt-${group}-${q.id}">${CHOICES.map(
              ([value, label, stored]) =>
                `<label><input type="radio" name="q-${group}-${q.id}" value="${value}" ${answers[q.id] === stored ? "checked" : ""}><span>${label}</span></label>`,
            ).join("")}</div>
            <small class="q-effect"></small>
          </div>`,
        )
        .join("")}</fieldset>`,
    )
    .join("");
}

function bindQuestions(box, answers) {
  box.querySelectorAll(".q").forEach((block) => {
    block.querySelectorAll("input").forEach((input) => {
      input.onchange = () => {
        if (input.value) answers[block.dataset.q] = input.value === "oui";
        else delete answers[block.dataset.q];
        renderReport();
      };
    });
  });
}

function renderQuestions() {
  const box = $("#questions");
  box.innerHTML = questionsHtml(COMPANY_QUESTIONS, state.answers, "co");
  bindQuestions(box, state.answers);

  const site = activeSite();
  $("#site-quiz").hidden = !site;
  $("#site-quiz-empty").hidden = Boolean(site);
  if (!site) return;
  $("#site-quiz-name").textContent = site.short;
  const siteBox = $("#site-questions");
  siteBox.innerHTML = questionsHtml(SITE_QUESTIONS, site.answers, "site");
  bindQuestions(siteBox, site.answers);
}

// Sous chaque question : ce qu'un « oui » changerait, puis ce qu'il change vraiment pour le site
// affiché. Sans cela, un « oui » sans effet (secteur déjà au maximum, exposition faible) reste
// incompréhensible.
function effectText(q, site, hazards, g) {
  if (!q.hazards.length) return "Signalé dans la synthèse, sans modifier les notes";
  const maxed = (id) => sectorSensitivity(SECTORS[state.sector][id][0]) === 2;
  const answers = answersFor(site);
  if (answers[q.id] !== true || !hazards) {
    const open = q.hazards.filter((id) => !maxed(id));
    const shut = q.hazards.filter(maxed);
    const first = (text) => text.charAt(0).toUpperCase() + text.slice(1);
    return [
      open.length ? `Un « oui » relève la sensibilité : ${open.map(hazardName).join(", ")}` : "",
      shut.length ? `${first(shut.map(hazardName).join(", "))} : sensibilité déjà au maximum pour votre secteur, un « oui » n'y change rien` : "",
    ]
      .filter(Boolean)
      .join(". ");
  }
  const without = assess(site, { ...answers, [q.id]: false });
  const parts = q.hazards.map((id) => {
    const now = hazards.find((h) => h.id === id);
    const was = without.find((h) => h.id === id);
    let text;
    if (now.sensitivity.base === 2) text = "sensibilité déjà au maximum pour votre secteur";
    else if (now.stable[g]) text = "noté « Stable », sans note à relever : votre réponse est signalée dans la synthèse";
    else if (now.risk[g] == null) text = "pas de données ici";
    else if (was.sensitivity.level === now.sensitivity.level) text = "un seul cran au total avec vos autres « oui » sur cet aléa";
    else if (was.risk[g] !== now.risk[g]) text = `note relevée de ${LEVELS[was.risk[g]]} à ${LEVELS[now.risk[g]]}`;
    else if (now.exposure[g].level === 0) text = "note inchangée, car l'exposition est faible";
    else text = `note déjà ${LEVELS[now.risk[g]]}`;
    return `${hazardName(id)} : ${text}`;
  });
  return `Effet pour ${site.tip} ${horizonText(g)} · ${parts.join(" · ")}`;
}

function renderEffects(site, hazards) {
  document.querySelectorAll("#quiz .q").forEach((block) => {
    const q = QUESTIONS.find((x) => x.id === block.dataset.q);
    const effect = block.querySelector(".q-effect");
    effect.textContent = effectText(q, site, hazards, state.gwl);
    effect.classList.toggle("on", answersFor(site)[q.id] === true && q.hazards.length > 0 && Boolean(hazards));
  });
}

// --- Éléments communs du rapport --------------------------------------------

const ARROWS = ["", "↑", "↑↑"];
const LEVEL_HELP = [
  "pas de signal marqué dans les moyennes climatiques, ce qui ne dit rien des événements exceptionnels",
  "à surveiller et à intégrer dans vos plans",
  "à traiter en priorité",
];
const STABLE_HELP = "pas de hausse notable ; le niveau actuel de l'aléa n'est pas mesuré par ces données";

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
// Fourchette de la note selon les modèles climatiques, quand elle s'écarte de la note centrale.
function rangeText(h, i) {
  const r = h.range[i];
  if (!r) return "";
  // « Stable, jusqu'à Faible » n'aurait pas de sens : on ne signale qu'une borne haute au moins Moyen.
  if (h.stable[i]) return r.expoHi >= 1 && r.hi >= 1 ? `jusqu'à ${LEVELS[r.hi]}` : "";
  if (h.changeOnly && r.expoLo === 0) return `Stable à ${LEVELS[r.hi]}`;
  return r.lo === r.hi ? "" : `${LEVELS[r.lo]} à ${LEVELS[r.hi]}`;
}

const riskBadge = (h, i) => {
  const note = h.stable[i] ? stableBadge() : badge(h.risk[i], h.trend[i], h.trendBy[i], i);
  const range = rangeText(h, i);
  return range
    ? `<span class="noted">${note}<small class="range" title="Fourchette de la note selon les modèles climatiques (quantiles 17 % et 83 %)">${esc(range)}</small></span>`
    : note;
};

// Légende commune des niveaux et des flèches.
const legend = () => `<div class="legend">
  <span><strong>Niveau d'attention</strong></span>
  ${LEVELS.map((l, i) => `<span>${badge(i)} ${esc(LEVEL_HELP[i])}</span>`).join("")}
  <span>${stableBadge()} ${esc(STABLE_HELP)} (vent)</span>
  <span>${badge(null)} pas de données ici</span>
  <span><small class="range">Moyen à Élevé</small> sous une note : fourchette selon les modèles climatiques. La note affichée repose sur leur moyenne.</span>
  <span><strong>↑</strong> et <strong>↑↑</strong> : la tendance est à la hausse. Un des chiffres qui servent à noter cet aléa (par exemple le nombre de jours au-dessus de 30 °C) augmente d'au moins ${TREND_PCT[0]} % (↑) ou ${TREND_PCT[1]} % (↑↑) par rapport à ${esc(REF)}. Ce chiffre est indiqué dans la synthèse et dans la fiche de l'aléa. Une partie de cette hausse a déjà eu lieu depuis la période de référence.</span>
</div>`;

// Données du site : celles de sa maille si elle existe, sinon la moyenne de sa région.
function regionContext(site) {
  const { NUTS_ID: code, NAME_LATN: name, CNTR_CODE: country } = site.region.properties;
  return { code, name, country, data: site.cell?.data ?? state.data.regions[code] };
}

function assess(site, answers = answersFor(site)) {
  const { data } = regionContext(site);
  // Les seuils « position en Europe » se lisent sur la même base que les valeurs : mailles ou régions.
  const meta = site.cell ? { thresholds: state.grid.thresholds } : state.data.meta;
  return assessSite(data, meta, state.sector, answers);
}

// Côté d'une maille, arrondi : 0,25° font environ 28 km du nord au sud et 20 km d'est en ouest vers 45° N.
// Contraste local d'un indicateur : niveaux qu'il prendrait dans les mailles voisines (jusqu'à 40 km).
// Sur un littoral ou en montagne, la maille retenue peut mal représenter le site : on le signale.
function localContrast(site, ind, g) {
  const near = site.cell?.near?.[ind.id];
  if (!near || ind.rule.info || ind.rule.change) return null;
  const meta = { thresholds: state.grid.thresholds };
  const levelOf = (value) => {
    const values = [...ind.values];
    values[g] = value;
    return indicatorLevel(ind, values, g, meta);
  };
  const lo = levelOf(near.min[g]);
  const hi = levelOf(near.max[g]);
  return lo == null || hi == null || lo === hi ? null : { min: near.min[g], max: near.max[g], lo, hi };
}

// Contraste le plus fort parmi les indicateurs d'un aléa (null si les voisines donnent le même niveau).
function hazardContrast(site, h, g) {
  const found = h.indicators.map((ind) => ({ ind, c: localContrast(site, ind, g) })).filter((x) => x.c);
  if (!found.length) return null;
  return found.reduce((a, b) => (b.c.hi - b.c.lo > a.c.hi - a.c.lo ? b : a));
}

const contrastText = ({ ind, c }) =>
  `dans un rayon de ${CELL_MAX_KM} km, ${ind.label.charAt(0).toLowerCase() + ind.label.slice(1)} : de ${num(c.min)} à ${num(c.max)} ${ind.unit} (niveau ${LEVELS[c.lo]} à ${LEVELS[c.hi]})`;

const cellSize = () => Math.round(state.grid.step * 100);
const whereText = (site, name) =>
  site.cell
    ? `une maille d'environ ${cellSize()} km de côté autour du site`
    : `la région ${name} (données en grille indisponibles ici)`;

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
    notes.push(
      site.cell
        ? `Ce point est en dehors des contours simplifiés des régions (littoral, île ou pays voisin non couvert) : il est rattaché à la région ${name}, à ${num(Math.max(site.nearKm, 0.1))} km.`
        : `Ce point est en dehors des contours simplifiés des régions (littoral, île ou pays voisin non couvert) : les données sont celles de la région la plus proche, ${name}, à ${num(Math.max(site.nearKm, 0.1))} km.`,
    );
  if (site.cell && site.cell.km > (state.grid.step * 111) / 2)
    notes.push(`Site en bord de mer ou en limite de zone couverte : les données sont celles de la maille terrestre la plus proche, centrée à ${num(site.cell.km)} km.`);
  for (const h of hazards) {
    const contrast = hazardContrast(site, h, g);
    // Deux crans d'écart entre mailles voisines : la note de cet aléa dépend beaucoup de l'endroit exact.
    if (contrast && contrast.c.hi - contrast.c.lo >= 2)
      notes.push(`${h.label} : relief ou littoral marqué autour du site. ${contrastText(contrast).replace(/^d/, "D")}. La note est à lire avec prudence.`);
  }
  if (missing.length)
    notes.push(`Non évalué faute de données Copernicus ici : ${missing.map((h) => hazardName(h.id)).join(", ")}.`);
  const answers = answersFor(site);
  for (const h of stable)
    notes.push(
      `${h.label} : pas de hausse notable des vents extrêmes ${horizonText(g)}. Les données ne mesurent pas le niveau de risque de tempête actuel de la région.${
        // La réponse sur le bâtiment ne peut pas relever une note « Stable » : on la restitue ici.
        answers.building === true ? " Vous signalez un bâtiment léger ou ancien, ou des équipements en extérieur : faites contrôler toitures, bardages et structures légères, même sans hausse annoncée." : ""
      }`,
    );
  if (country === "FR" && top.some((h) => h.id === "heat"))
    notes.push("En France, l'employeur doit prévoir des mesures pour les épisodes de chaleur intense dès la vigilance canicule jaune (décret n° 2025-482).");
  if (answers.suppliers === true)
    notes.push("Fournisseurs ou clients concentrés : vérifiez aussi l'exposition de leurs sites (risque indirect, non noté ici).");
  const unanswered = QUESTIONS.filter((q) => answers[q.id] === undefined).length;
  if (unanswered)
    notes.push(
      unanswered === QUESTIONS.length
        ? "Questionnaire non rempli : la sensibilité repose sur votre secteur seul."
        : `Questionnaire : ${unanswered} question${unanswered > 1 ? "s" : ""} sur ${QUESTIONS.length} sans réponse. Pour ces points, la sensibilité repose sur votre secteur seul.`,
    );

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
      ${help("Une première action par aléa, à approfondir avec votre conseiller.")}
      <ol class="actions">${actions.map((a) => `<li>${esc(a)}</li>`).join("")}</ol>`
    : `<p>Aucun aléa en niveau d'attention moyen ou élevé ${horizonText(g)} parmi ceux qui sont évalués, pour ce secteur dans cette région.</p>`;

  return `<section class="layer layer-1">
    <div class="layer-head"><span class="tag">1 · Synthèse</span><span class="muted">pour le dirigeant</span></div>
    <h2>${esc(site.title)}</h2>
    <p class="muted">${esc(SECTORS[state.sector].label)} · région ${esc(name)} (${esc(code)})${site.cell ? ` · maille de ${cellSize()} km` : ""} · ${
      g === 0 ? "climat de référence " + esc(REF) : "horizon " + esc(GWLS[g].year) + " (" + esc(GWLS[g].label) + ")"
    }</p>
    ${help(`Les aléas climatiques qui pèsent le plus sur votre activité ${horizonText(g)}, classés du plus au moins préoccupant. Les chiffres sont des moyennes sur ${whereText(site, name)}, pas pour l'adresse exacte.${
      g === 0 ? "" : ` Les valeurs futures sont des projections de modèles climatiques, pas des prévisions. Elles sont comparées à la moyenne ${REF} : le climat d'aujourd'hui est déjà plus chaud que cette référence.`
    }`)}
    <div class="callout"><strong>Ce que montre ce rapport :</strong> les tendances de fond du climat autour du site, en année moyenne.
      <strong>Ce qu'il ne montre pas :</strong> les événements exceptionnels (crue, canicule record, tempête), ni la situation exacte de votre adresse (altitude, bord de mer, cours d'eau, chaleur des centres-villes).
      Un niveau « Faible » ne signifie donc pas une absence de risque.</div>
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
  else if (rule.europe) why = `${ind.label} : ${num(ind.values[g])}, par rapport au reste de l'Europe`;
  else why = `${ind.label} : ${num(ind.values[0])} → ${num(ind.values[g])} par rapport au climat local`;
  const s = h.sensitivity;
  const lower = (text) => text.charAt(0).toLowerCase() + text.slice(1);
  const sens = s.reasons.length
    ? `secteur : ${LEVELS[s.base]}, relevée d'un cran par vos réponses : ${s.reasons.map((q) => lower(q.text)).join(" ; ")}`
    : `secteur : ${LEVELS[s.base]}`;
  return `Exposition <strong>${LEVELS[e.level]}</strong> (${esc(why)}) × sensibilité <strong>${LEVELS[s.level]}</strong> (${esc(sens)}) → <strong>${LEVELS[h.risk[g]]}</strong>`;
}

function hazardCard(site, h, g) {
  const contrast = hazardContrast(site, h, g);
  const rows = h.indicators
    .map((ind) => {
      const v = ind.values[g];
      const c = localContrast(site, ind, g);
      const nearby = c ? `<br><small class="muted" title="Valeurs des mailles terrestres voisines, jusqu'à ${CELL_MAX_KM} km">alentours : ${num(c.min)} à ${num(c.max)}</small>` : "";
      const range = g > 0 && ind.lo[g] != null ? `<br><small class="muted" title="Fourchette entre modèles (17–83 %)">${num(ind.lo[g])}–${num(ind.hi[g])}</small>` : "";
      const local = ind.relative ? `<br><small class="muted">par rapport au climat local</small>` : "";
      const lvl =
        ind.levels[g] == null
          ? `<span class="muted" title="Affiché pour information, n'entre pas dans la note">info</span>`
          : h.stable[g]
            ? stableBadge()
            : badge(ind.levels[g]);
      return `<tr><td>${esc(ind.label)} <span class="muted">${esc(ind.unit)}</span>${local}<small class="ind-help">${esc(ind.help)}</small></td>
        <td>${num(ind.values[0])}${g === 0 ? nearby : ""}</td>${g === 0 ? "" : `<td>${num(v)}${range}${nearby}</td>`}<td>${lvl}</td></tr>`;
    })
    .join("");
  const table = rows
    ? `<table class="ind"><thead><tr><th>Indicateur</th><th>${esc(REF)}</th>${g === 0 ? "" : `<th>${esc(GWLS[g].year)}</th>`}<th>Niveau</th></tr></thead>
      <tbody>${rows}</tbody></table>
    ${help(`« ${REF} » = climat de référence, moyenne sur cette période. ${g === 0 ? "" : `« ${GWLS[g].year} » = moyenne des modèles climatiques ; la petite ligne donne la fourchette où se situent 2 modèles sur 3. `}« Niveau » = note de l'indicateur selon son seuil ; l'aléa retient l'indicateur le plus défavorable.${contrast ? " « Alentours » = valeurs des mailles voisines quand elles changeraient le niveau." : ""}`)}`
    : "";
  return `<article class="card">
    <div class="card-head"><h3>${h.icon} ${esc(h.label)}</h3>${riskBadge(h, g)}</div>
    ${help(h.help)}
    <p class="why"><span class="k">Comment la note est obtenue</span> ${justification(h, g)}</p>
    ${rangeText(h, g) ? `<p class="why"><span class="k">Fourchette selon les modèles</span> ${esc(rangeText(h, g))}. La note repose sur la moyenne des modèles ; les quantiles 17 % et 83 % donnent ces bornes.</p>` : ""}
    ${contrast ? `<p class="why"><span class="k">Contraste local</span> ${esc(contrastText(contrast).replace(/^d/, "D"))}. Les mailles voisines donnent un niveau différent : la valeur dépend de l'endroit exact (relief, distance à la mer).</p>` : ""}
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
    ${help("Même secteur et mêmes réponses sur l'entreprise : d'un site à l'autre, seules changent l'exposition et les réponses propres à chaque site.")}
    <div class="matrix-wrap"><table class="matrix"><thead><tr><th>Site</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function detail(site, hazards, g) {
  const sims = site.cell ? state.grid.simulations.hot_days : null;
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
    ${help(`Une ligne par aléa, une colonne par horizon. La première colonne est la référence ${REF} ; le climat d'aujourd'hui se situe déjà entre cette référence et la colonne 2030. Les années indiquent quand le réchauffement mondial atteindrait chaque niveau selon la trajectoire européenne de référence : elles sont indicatives.${
      sims && sims[2] < sims[0] ? ` La colonne 2100 est moins robuste : ${sims[2]} simulations sur ${sims[0]} atteignent +3 °C avant la fin du siècle.` : ""
    }`)}
    ${matrix}
    ${legend()}
    ${sitesTable(g)}
    <h4>Fiches par aléa</h4>
    ${help("Du plus au moins préoccupant à l'horizon choisi, avec le détail des indicateurs Copernicus utilisés.")}
    <div class="cards">${ranked(hazards, g).map((h) => hazardCard(site, h, g)).join("")}</div>
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
    <h4>${site.cell ? `Valeurs pour la maille du site (centre ${fmt3.format(site.cell.lat)} ; ${fmt3.format(site.cell.lon)})` : `Valeurs pour la région ${esc(code)}`}</h4>
    ${help("Moyenne des modèles climatiques ; la petite ligne donne la fourchette entre modèles (quantiles 17 % et 83 %, soit 2 modèles sur 3). La dernière colonne indique d'où vient chaque seuil.")}
    <div class="matrix-wrap"><table class="ind annex">
      <thead><tr><th>Aléa</th><th>Indicateur</th><th>Unité</th>${GWLS.map((g) => `<th>${esc(g.label)}</th>`).join("")}<th>Règle et source du seuil</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <h4>Méthode</h4>
    ${help("Comment les notes sont calculées, étape par étape.")}
    <ul class="method">
      <li>Démarche de « screening » du guide européen C(2021) 5430 sur le climate proofing : sensibilité × exposition = vulnérabilité, sur 3 niveaux (Faible, Moyen, Élevé). Les notes sont des niveaux d'attention : une vulnérabilité au sens de ce guide, pas un risque chiffré (probabilité × gravité).</li>
      <li>Portée : des indicateurs de climat moyen, sur une maille d'environ 25 km. Confrontées à des catastrophes passées, les notes ne les anticipent pas toujours : Altenahr (crue de l'Ahr, 2021) et la vallée de l'Aa (crues du Pas-de-Calais, 2023-24) sont notées Faible pour les pluies extrêmes.</li>
      <li>Fourchette : la même règle est appliquée aux quantiles 17 % et 83 % de l'ensemble de modèles. Elle est affichée sous la note quand elle s'en écarte.</li>
      <li>Référence : moyenne ${esc(REF)} des mêmes simulations. Le climat de l'année en cours est déjà plus chaud que cette référence.</li>
      <li>Exposition d'un aléa : indicateur le plus défavorable, sur la référence et à +1,5 °C, +2 °C et +3 °C de réchauffement mondial. Années indicatives selon la trajectoire de référence du European Climate Viewer.</li>
      <li>Sensibilité : note sectorielle d'expert, relevée d'un cran, et d'un seul, dès qu'une réponse « oui » du questionnaire concerne l'aléa (thèmes du guide européen). ${COMPANY_QUESTIONS.length} questions décrivent l'entreprise et valent pour tous ses sites, ${SITE_QUESTIONS.length} décrivent un lieu et se posent pour chaque site. « Non » et « ne sait pas » laissent la note du secteur. Une sensibilité élevée donne un niveau Moyen même quand l'exposition est faible.</li>
      <li>Vent : le seul indicateur disponible est défini par rapport au climat local. Sans hausse d'au moins 15 %, l'aléa est noté « Stable » : le niveau de risque de tempête actuel n'est pas mesuré.</li>
      <li>Tendance : ↑ ou ↑↑ si un indicateur augmente d'au moins ${TREND_PCT[0]} % ou ${TREND_PCT[1]} % par rapport à ${esc(REF)}, comptée seulement pour un indicateur qui atteint lui-même au moins Moyen, et affichée seulement quand le risque est au moins Moyen.</li>
      <li>Données : Copernicus C3S, « Climate indicators for Europe » v2.0 (CDS, CC-BY 4.0) : séries annuelles par modèle sur une grille de 0,25°, issues de 9 couples de modèles EURO-CORDEX corrigés de leurs biais, sous deux scénarios (RCP4.5 et RCP8.5), soit 18 simulations (10 pour le danger d'incendie). Le danger d'incendie est fourni sur une autre grille, sans valeur au bord de la mer et des grands lacs : une maille sans valeur reprend celle de la maille voisine la plus proche (35 km au plus).</li>
      <li>Niveaux de réchauffement : recalculés avec la méthode de l'Atlas du GIEC. Pour chaque simulation, moyenne sur les 20 ans centrés sur l'année où son modèle global atteint +1,5 °C, +2 °C ou +3 °C. La valeur affichée est la référence plus la moyenne des écarts des simulations ; à +3 °C, 12 simulations seulement atteignent le niveau.</li>
      <li>Contraste local : la même règle est appliquée aux valeurs extrêmes des mailles terrestres situées à ${CELL_MAX_KM} km au plus du site. Si le niveau change, les valeurs des alentours sont affichées ; à deux crans d'écart, la synthèse le signale.</li>
      <li>Maille : on retient la maille terrestre dont le centre est le plus proche du site, jusqu'à ${CELL_MAX_KM} km. Sans maille (outre-mer, îles éloignées), l'outil revient à la moyenne régionale NUTS 2 du jeu « Aggregated climate indicators for Europe ».</li>
      <li>Région : elle sert à nommer le lieu. Un point situé hors des contours simplifiés (1:20 000 000) est rattaché à la région la plus proche, jusqu'à ${NEAR_KM} km.</li>
    </ul>
    <h4>Matrice de croisement</h4>
    ${help("Lecture : une ligne par niveau d'exposition, une colonne par niveau de sensibilité ; la case donne le niveau d'attention.")}
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
  const header = ["site", "nuts", "source", "maille_lat", "maille_lon", "secteur", "alea", "indicateur", "unite", "horizon", "valeur", "p17", "p83", "niveau_indicateur", "exposition_alea", "sensibilite_alea", "attention_alea", "attention_bas", "attention_haut"];
  const lines = [header];
  const level = (l) => (l == null ? "" : LEVELS[l]);
  for (const site of state.sites.filter((s) => s.region)) {
    const { code } = regionContext(site);
    for (const h of assess(site)) {
      for (const ind of h.indicators) {
        GWLS.forEach((g, i) => {
          lines.push([
            site.short, code, site.cell ? "maille 0,25°" : "région NUTS 2", site.cell?.lat, site.cell?.lon, SECTORS[state.sector].label, h.label, ind.id, ind.unit,
            i === 0 ? g.label : `${g.year} (${g.label})`,
            ind.values[i], ind.lo[i], ind.hi[i],
            h.stable[i] ? "Stable" : level(ind.levels[i]),
            h.stable[i] ? "Stable" : level(h.exposure[i]?.level),
            level(h.sensitivity.level),
            h.stable[i] ? "Stable (niveau non mesuré)" : level(h.risk[i]),
            h.stable[i] ? "Stable" : level(h.range[i]?.lo),
            h.stable[i] && !rangeText(h, i) ? "Stable" : level(h.range[i]?.hi),
          ]);
        });
      }
    }
  }
  const csv = lines.map((row) => row.map(csvCell).join(";")).join("\r\n");
  // Marque d'ordre d'octets en tête : sans elle, Excel lit mal les accents.
  const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + csv], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "radar-climat-pme.csv" });
  a.click();
  URL.revokeObjectURL(url);
}

// --- Rapport -----------------------------------------------------------------

// Pays présents dans les contours NUTS 2 utilisés (web/data/nuts2.geojson).
const COVERAGE =
  "L'outil couvre l'Union européenne, le Royaume-Uni, la Suisse, le Liechtenstein, la Norvège, l'Islande, la Turquie et les Balkans occidentaux.";

// Ligne visible seulement à l'impression : un PDF transmis à un tiers doit dire d'où il vient et de quand il date.
const printStamp = () =>
  `<p class="print-only">Rapport produit le ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })} avec Radar climat PME (https://niz95.github.io/radar-climat-pme/). Premier repérage à titre d'information : ni conseil professionnel, ni notation.</p>`;

// Sous le rapport : c'est en lisant ses propres résultats qu'un visiteur repère une note absurde.
const FEEDBACK = `<p class="feedback">Un résultat vous surprend, ou une question est mal posée ?
  <a href="mentions.html#contact">Écrivez à l'auteur</a> ou
  <a href="https://github.com/Niz95/radar-climat-pme/issues/new" target="_blank" rel="noopener">ouvrez un ticket sur GitHub</a>.
  Chaque retour sert à corriger l'outil.</p>`;

function renderReport() {
  const report = $("#report");
  const site = activeSite();
  // Par défaut, le questionnaire décrit l'effet possible de chaque « oui » ; il est précisé plus bas
  // quand le site a des données.
  renderEffects(site, null);
  if (!site) {
    report.hidden = true;
    return;
  }
  report.hidden = false;
  regionLayer.clearLayers();
  cellLayer.clearLayers();

  if (!site.region) {
    report.innerHTML = `<section class="layer"><h2>${esc(site.title)}</h2>
      <div class="banner">Ce lieu n'est pas couvert par les données.</div>
      <p>Il est à plus de ${NEAR_KM} km de toute région couverte : pays hors du périmètre des données, ou pleine mer. ${COVERAGE} Essayez une autre adresse.</p></section>`;
    return;
  }
  regionLayer.addData(site.region);
  if (site.cell) {
    const half = state.grid.step / 2;
    const square = L.rectangle(
      [[site.cell.lat - half, site.cell.lon - half], [site.cell.lat + half, site.cell.lon + half]],
      { color: "#1f6f5c", weight: 2, fillOpacity: 0.15 },
    ).addTo(cellLayer);
    map.fitBounds(square.getBounds().pad(2), { maxZoom: 9 });
  } else {
    map.fitBounds(regionLayer.getBounds(), { maxZoom: 9 });
  }

  const { code, name, data } = regionContext(site);
  const hazards = data ? assess(site) : [];
  // Outre-mer et certaines îles : la région existe, mais les projections européennes ne la couvrent pas.
  if (!hazards.some((h) => h.indicators.length)) {
    report.innerHTML = `<section class="layer"><h2>${esc(site.title)}</h2>
      <div class="banner">Pas de données Copernicus pour ce site (région ${esc(name)}, ${esc(code)}).</div>
      <p>Les projections utilisées couvrent l'Europe continentale et les îles proches. Les régions d'outre-mer et certaines îles éloignées n'y figurent pas : l'outil ne peut pas évaluer ce site, ce qui ne signifie pas qu'il est sans risque.</p></section>`;
    return;
  }
  const g = state.gwl;
  renderEffects(site, hazards);
  report.innerHTML = printStamp() + synthesis(site, hazards, g) + detail(site, hazards, g) + annex(site, hazards) + FEEDBACK;
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
  const [data, nuts, grid] = await Promise.all([
    fetch("data/indicators.json").then((r) => (r.ok ? r.json() : Promise.reject(new Error("data/indicators.json introuvable")))),
    fetch("data/nuts2.geojson").then((r) => r.json()),
    // Sans la grille, l'outil fonctionne encore avec les moyennes régionales.
    fetch("data/grid/index.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  state.data = data;
  state.nuts = nuts;
  state.grid = grid;
  $("#demo-banner").hidden = !data.meta.demo;
  $("#example").onclick = showExample;
  $("#example").disabled = false;
  render();
}

init().catch((err) => {
  const report = $("#report");
  report.hidden = false;
  report.innerHTML = `<div class="banner">Chargement impossible : ${esc(err.message)}. Voir README.md.</div>`;
});
