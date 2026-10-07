import { firebaseConfig } from "./firebase-config.js";
import { haversine, ghEncode, ghBounds, cellAreaKm2, fmtKm, fmtAgo, CELL_PREC, PREFIX_PREC } from "./geo.js";

const $ = (s) => document.querySelector(s);
const DEMO = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE");
const COLORS = ["#ffb020", "#3ddc97", "#5cc8ff", "#ff6b9a", "#c58bff", "#ff8a3d", "#9be15d", "#ffd84d"];
const STALE_MS = 5 * 60 * 1000, GONE_MS = 2 * 60 * 60 * 1000;

const S = {
  store: null, uid: null, profile: null, crew: null,
  members: new Map(), convoys: [], myVehicles: [], bass: [], bassClass: "All",
  explored: new Set(), pendingCells: new Set(),
  pos: null, lastFix: null, lastSent: null, km: 0, kmDirty: false,
  ghost: false, fog: false, view: "map", pick: false, pendingDest: null,
  map: null, markers: new Map(), meMarker: null, convoyLayer: null, fogLayer: null,
  unsubs: [], watchId: null, wakeLock: null, didFit: false,
};

/* ---------------- utils ---------------- */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const colorFor = (id) => { let x = 2166136261; for (const c of id) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0; return COLORS[(x ^ (x >>> 16)) % COLORS.length]; };
const initial = (s) => (s || "?").trim().charAt(0).toUpperCase() || "?";
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600); }
const kmh = (ms) => Math.round((ms || 0) * 3.6);
function avatar(id, name) { return h("div", { class: "av", style: `background:${colorFor(id)}` }, initial(name)); }
function memberState(m) {
  if (m.ghost) return "ghost";
  if (m.lat == null || !m.updatedAt) return "off";
  const age = Date.now() - m.updatedAt;
  if (age > GONE_MS) return "off";
  return age > STALE_MS ? "stale" : "live";
}

// Keep digits and a leading +; "0821234567" stays as typed, links convert it to +27.
function cleanPhone(v) { const t = String(v || "").trim().replace(/[^\d+]/g, ""); return t.replace(/\D/g, "").length >= 9 ? t : ""; }
function intlPhone(p) { const d = String(p || "").replace(/[^\d+]/g, ""); if (d.startsWith("+")) return d; if (d.startsWith("00")) return "+" + d.slice(2); if (d.startsWith("0")) return "+27" + d.slice(1); return "+" + d; }

/* ---------------- install screen ---------------- */
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; if (!$("#install").hidden) showInstallOptions(); });
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function showInstallOptions() {
  $("#inst-android").hidden = !installPrompt;
  $("#inst-ios").hidden = !!installPrompt || !isIOS();
  $("#inst-other").hidden = !!installPrompt || isIOS();
}
function installGate() {
  return new Promise((resolve) => {
    let skipped = false;
    try { skipped = sessionStorage.getItem("skipInstall") === "1"; } catch {}
    if (isStandalone() || skipped) return resolve();
    $("#install").hidden = false;
    showInstallOptions();
    $("#btn-install").onclick = async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice.catch(() => ({}));
      installPrompt = null;
      if (outcome === "accepted") { $("#inst-android").replaceChildren(h("p", { class: "fine", style: "font-size:15px" }, "Installed. Open THE CREW from your home screen.")); }
      else showInstallOptions();
    };
    $("#btn-skip-install").onclick = () => { try { sessionStorage.setItem("skipInstall", "1"); } catch {} $("#install").hidden = true; resolve(); };
  });
}

/* ---------------- boot ---------------- */
async function boot() {
  await installGate();
  try {
    if (DEMO) S.store = (await import("./store-demo.js")).createDemoStore();
    else S.store = await (await import("./store-firebase.js")).createFirebaseStore(firebaseConfig);
  } catch (e) {
    console.error(e);
    showOnboard("signin");
    obError("Couldn't reach the server. Check your connection and reopen the app.");
    return;
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  S.store.onAuth(async (user) => {
    if (!user) { teardown(); S.uid = null; showOnboard("signin"); return; }
    S.uid = user.uid;
    S.profile = (await S.store.getProfile(S.uid)) || {};
    route();
  });
}

async function route() {
  if (!S.profile.callsign || !S.profile.phone) return showOnboard("callsign");
  if (!S.profile.crewId) return showOnboard("crew");
  const crew = await S.store.getCrew(S.profile.crewId).catch(() => null);
  if (!crew) { await S.store.saveProfile(S.uid, { crewId: null }); S.profile.crewId = null; return showOnboard("crew"); }
  S.crew = crew;
  enterApp();
}

/* ---------------- onboarding ---------------- */
function showOnboard(step) {
  $("#app").hidden = true;
  $("#onboard").hidden = false;
  $("#ob-signin").hidden = step !== "signin";
  $("#ob-callsign").hidden = step !== "callsign";
  $("#ob-crew").hidden = step !== "crew";
  $("#ob-error").hidden = true;
  if (step === "callsign") $("#in-callsign").focus();
}
function obError(msg) { const e = $("#ob-error"); e.textContent = msg; e.hidden = false; }

$("#btn-google").addEventListener("click", () => S.store.signInAnon().catch((e) => obError(e.message)));
$("#ob-callsign").addEventListener("submit", async (e) => {
  e.preventDefault();
  const c = $("#in-callsign").value.trim();
  const phone = cleanPhone($("#in-phone").value);
  const make = $("#in-ob-make").value.trim(), model = $("#in-ob-model").value.trim(), year = $("#in-ob-year").value.trim();
  if (!c || !make || !model) return;
  if (!phone) return obError("Enter a phone number your crew can call, e.g. 082 123 4567.");
  if (!/^(19|20)\d\d$/.test(year)) return obError("Enter the car's year, e.g. 2007.");
  Object.assign(S.profile, { callsign: c, phone });
  await S.store.saveProfile(S.uid, { callsign: c, phone });
  const have = await S.store.getVehicles(S.uid).catch(() => []);
  if (!have.length) await S.store.saveVehicle(S.uid, { id: `v${Date.now().toString(36)}`, name: model, make, model, year, colour: "", engine: "", power: "", mods: [], active: true, photo: "" });
  $("#ob-error").hidden = true;
  route();
});
$("#form-join").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#in-code").value.trim().toUpperCase();
  if (code.length !== 6) return obError("Invite codes are 6 characters.");
  const crew = await S.store.getCrew(code).catch(() => null);
  if (!crew) return obError(`No crew found for ${code}. Check the code with whoever invited you.`);
  await S.store.saveProfile(S.uid, { crewId: code });
  S.profile.crewId = code;
  route();
});
$("#form-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#in-crewname").value.trim();
  if (!name) return obError("Give your crew a name first.");
  try {
    const code = await S.store.createCrew(name, S.uid);
    await S.store.saveProfile(S.uid, { crewId: code });
    S.profile.crewId = code;
    route();
  } catch (err) { obError(err.message); }
});

/* ---------------- app ---------------- */
function teardown() {
  S.unsubs.forEach((u) => u && u()); S.unsubs = [];
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
}

async function enterApp() {
  teardown();
  $("#onboard").hidden = true;
  $("#app").hidden = false;
  $("#demo-banner").hidden = !DEMO;
  $("#app").classList.toggle("is-demo", DEMO);
  $("#crew-title").textContent = S.crew.name;
  $("#invite-code").textContent = S.crew.id;
  $("#in-me-callsign").value = S.profile.callsign;
  $("#in-me-phone").value = S.profile.phone || "";
  S.ghost = !!lsGet("ghost", false);
  S.km = Number(lsGet(`km:${S.uid}`, 0)) || 0;
  renderGhost();
  initMap();

  await S.store.joinCrew(S.crew.id, S.uid, {
    callsign: S.profile.callsign, phone: S.profile.phone || "", ghost: S.ghost,
    ...(S.ghost ? { lat: null, lng: null, speed: null } : {}),
  });
  S.explored = await S.store.loadExplored(S.uid).catch(() => new Set());

  S.unsubs.push(S.store.onMembers(S.crew.id, (list) => {
    S.members = new Map(list.map((m) => [m.id, m]));
    if (!S.members.has(S.uid)) { // removed from crew by owner
      toast("You're no longer in this crew.");
      S.store.saveProfile(S.uid, { crewId: null }).then(() => { S.profile.crewId = null; route(); });
      return;
    }
    renderMembers(); renderConvoyOverlay(); renderActiveView();
    if (!S.didFit && !S.pos) { S.didFit = true; fitCrew(); }
  }, () => toast("Lost connection to the crew. Retrying…")));
  S.unsubs.push(S.store.onConvoys(S.crew.id, (list) => {
    S.convoys = list.sort((a, b) => b.createdAt - a.createdAt);
    renderConvoyOverlay(); renderActiveView(); updateWakeLock();
  }));
  S.unsubs.push(S.store.onBass(S.crew.id, (list) => {
    S.bass = list;
    if (S.view === "bass") renderBass();
  }));
  S.unsubs.push(S.store.onVehicles(S.uid, (list) => {
    S.myVehicles = list;
    syncActiveCar();
    if (S.view === "garage") renderGarage();
  }));
  startGps();
  setView(lsGet("view", "map"));
}

/* ---------------- map ---------------- */
function initMap() {
  if (S.map) { setTimeout(() => S.map.invalidateSize(), 50); return; }
  S.map = L.map("map", { zoomControl: false, attributionControl: true, worldCopyJump: true }).setView([-25.75, 28.23], 11);
  // OpenStreetMap tiles, darkened with a CSS filter (see .leaflet-tile-pane in styles.css)
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(S.map);
  S.map.createPane("fog").style.zIndex = 350;
  S.convoyLayer = L.layerGroup().addTo(S.map);
  S.fogLayer = new FogLayer();
  S.map.on("click", (e) => {
    if (!S.pick) return;
    S.pendingDest = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) };
    S.pick = false;
    $("#pick-banner").hidden = true;
    openConvoyDialog(true);
  });
}

const FogLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._c = L.DomUtil.create("canvas", "fog-canvas", map.getPane("fog"));
    this._c.style.pointerEvents = "none";
    map.on("move zoom resize viewreset", this._draw, this);
    this._draw();
  },
  onRemove(map) { map.off("move zoom resize viewreset", this._draw, this); this._c.remove(); },
  redraw() { if (this._map) this._draw(); },
  _draw() {
    const map = this._map, c = this._c, size = map.getSize(), dpr = window.devicePixelRatio || 1;
    L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
    c.width = size.x * dpr; c.height = size.y * dpr;
    c.style.width = size.x + "px"; c.style.height = size.y + "px";
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "rgba(6,8,12,0.74)";
    ctx.fillRect(0, 0, size.x, size.y);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    const vb = map.getBounds().pad(0.05);
    const pad = map.getZoom() >= 14 ? 3 : 4;
    for (const gh of S.explored) {
      const b = ghBounds(gh);
      if (b.n < vb.getSouth() || b.s > vb.getNorth() || b.e < vb.getWest() || b.w > vb.getEast()) continue;
      const p1 = map.latLngToContainerPoint([b.n, b.w]), p2 = map.latLngToContainerPoint([b.s, b.e]);
      const w = Math.max(5, p2.x - p1.x + pad), hgt = Math.max(5, p2.y - p1.y + pad);
      ctx.fillRect(p1.x - pad / 2, p1.y - pad / 2, w, hgt);
    }
    ctx.globalCompositeOperation = "source-over";
  },
});

function setFog(on) {
  S.fog = on;
  $("#btn-fog").setAttribute("aria-pressed", on);
  if (on && !S.map.hasLayer(S.fogLayer)) S.fogLayer.addTo(S.map);
  if (!on && S.map.hasLayer(S.fogLayer)) S.map.removeLayer(S.fogLayer);
}
$("#btn-fog").addEventListener("click", () => { setFog(!S.fog); toast(S.fog ? "Showing roads you've driven" : "Fog off"); });
$("#btn-locate").addEventListener("click", () => {
  if (S.pos) S.map.flyTo([S.pos.lat, S.pos.lng], Math.max(S.map.getZoom(), 15), { duration: 0.6 });
  else toast("Waiting for GPS…");
});
$("#btn-crewfit").addEventListener("click", fitCrew);
function fitCrew() {
  const pts = [...S.members.values()].filter((m) => m.id !== S.uid && ["live", "stale"].includes(memberState(m))).map((m) => [m.lat, m.lng]);
  if (S.pos) pts.push([S.pos.lat, S.pos.lng]);
  if (!pts.length) return toast("Nobody from the crew is on the map right now.");
  if (pts.length === 1) S.map.flyTo(pts[0], 14, { duration: 0.6 });
  else S.map.flyToBounds(L.latLngBounds(pts).pad(0.25), { duration: 0.6, maxZoom: 15 });
}

function renderMembers() {
  const seen = new Set();
  for (const m of S.members.values()) {
    if (m.id === S.uid) continue;
    const st = memberState(m);
    if (st !== "live" && st !== "stale") continue;
    seen.add(m.id);
    const speed = st === "live" && m.speed > 1.5 ? ` <small>${kmh(m.speed)} km/h</small>` : "";
    const car = m.car?.name ? ` <small>· ${esc(m.car.name)}</small>` : "";
    const html = `<div class="mk ${st === "stale" ? "stale" : ""}"><div class="mk-pin" style="background:${colorFor(m.id)}"><span>${esc(initial(m.callsign))}</span></div><div class="mk-label">${esc(m.callsign)}${car}${speed}</div></div>`;
    let mk = S.markers.get(m.id);
    const icon = L.divIcon({ className: "", html, iconSize: [0, 0] });
    if (!mk) {
      mk = L.marker([m.lat, m.lng], { icon, zIndexOffset: 500 }).addTo(S.map);
      mk.on("click", () => openMember(m.id));
      S.markers.set(m.id, mk);
    } else {
      mk.setLatLng([m.lat, m.lng]);
      if (mk._lastHtml !== html) mk.setIcon(icon);
    }
    mk._lastHtml = html;
  }
  for (const [id, mk] of S.markers) if (!seen.has(id)) { S.map.removeLayer(mk); S.markers.delete(id); }
}

function renderMe() {
  if (!S.pos) return;
  const icon = L.divIcon({ className: "", html: `<div class="me-dot ${S.ghost ? "ghost" : ""}" style="transform:translate(-50%,-50%)"></div>`, iconSize: [0, 0] });
  if (!S.meMarker) S.meMarker = L.marker([S.pos.lat, S.pos.lng], { icon, zIndexOffset: 1000, interactive: false }).addTo(S.map);
  else { S.meMarker.setLatLng([S.pos.lat, S.pos.lng]); S.meMarker.setIcon(icon); }
}

/* ---------------- GPS ---------------- */
function startGps() {
  if (DEMO && !navigator.geolocation) return simulateMe();
  if (!navigator.geolocation) return gpsWarn("This browser can't share location.");
  S.watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    if (DEMO) { simulateMe(); return; }
    gpsWarn(err.code === 1 ? "Location is blocked. Allow location for this app in your phone settings so the crew can see you." : "Can't get a GPS fix yet…");
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}
let simTimer;
async function simulateMe() {
  if (simTimer) return;
  const { DEMO_ME_ROUTE } = await import("./store-demo.js");
  let i = 0;
  const go = () => {
    const a = DEMO_ME_ROUTE[i % DEMO_ME_ROUTE.length], b = DEMO_ME_ROUTE[(i + 1) % DEMO_ME_ROUTE.length];
    onFix({ coords: { latitude: a.lat, longitude: a.lng, accuracy: 8, speed: 20, heading: Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180 / Math.PI }, timestamp: Date.now() });
    i++;
  };
  go();
  simTimer = setInterval(go, 1500);
}
function gpsWarn(msg) { const w = $("#gps-warn"); w.textContent = msg; w.hidden = !msg; }

function onFix(p) {
  gpsWarn("");
  const c = p.coords;
  const fix = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, speed: c.speed ?? null, heading: c.heading ?? null, t: p.timestamp || Date.now() };
  const first = !S.pos;
  // distance driven: only trust clean fixes, ignore jitter and teleports
  if (S.lastFix && fix.acc < 30) {
    const d = haversine(S.lastFix, fix), dt = (fix.t - S.lastFix.t) / 1000;
    if (d > 8 && d < 3000 && dt > 0 && d / dt < 70) { S.km += d / 1000; S.kmDirty = true; }
  }
  if (fix.acc < 40) S.lastFix = fix;
  if (fix.speed == null && S.pos) {
    const dt = (fix.t - S.pos.t) / 1000;
    if (dt > 0) fix.speed = haversine(S.pos, fix) / dt;
  }
  S.pos = fix;
  if (fix.acc < 50) {
    const cell = ghEncode(fix.lat, fix.lng, CELL_PREC);
    if (!S.explored.has(cell)) { S.explored.add(cell); S.pendingCells.add(cell); if (S.fog) S.fogLayer.redraw(); }
  }
  renderMe();
  if (first) S.map.setView([fix.lat, fix.lng], 14);
  maybeSend();
  if (S.view === "convoy") renderConvoy();
  renderConvoyOverlay();
}

function maybeSend(force = false) {
  if (!S.crew || !S.pos || S.ghost) return;
  const now = Date.now(), last = S.lastSent;
  const moved = last ? haversine(last, S.pos) : Infinity;
  if (!force && last && !((now - last.t > 4000 && moved > 20) || now - last.t > 45000)) return;
  S.lastSent = { lat: S.pos.lat, lng: S.pos.lng, t: now };
  S.store.updateMember(S.crew.id, S.uid, {
    lat: +S.pos.lat.toFixed(6), lng: +S.pos.lng.toFixed(6), acc: Math.round(S.pos.acc),
    speed: S.pos.speed != null ? +S.pos.speed.toFixed(1) : null, heading: S.pos.heading != null ? Math.round(S.pos.heading) : null,
    updatedAt: now, ghost: false,
  }).catch(() => { S.lastSent = null; });
}

async function flushProgress() {
  if (!S.crew) return;
  if (S.pendingCells.size) {
    const by = {};
    for (const c of S.pendingCells) (by[c.slice(0, PREFIX_PREC)] ||= []).push(c);
    const sent = new Set(S.pendingCells);
    S.pendingCells.clear();
    try { await S.store.addExplored(S.uid, by); }
    catch { sent.forEach((c) => S.pendingCells.add(c)); }
  }
  lsSet(`km:${S.uid}`, S.km);
  const me = S.members.get(S.uid);
  const cells = S.explored.size, km = Math.round(S.km);
  if (!me || me.stats?.cells !== cells || me.stats?.km !== km)
    S.store.updateMember(S.crew.id, S.uid, { stats: { cells, km } }).catch(() => {});
}
setInterval(flushProgress, 30000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushProgress();
  else { maybeSend(true); updateWakeLock(); }
});

/* ---------------- ghost ---------------- */
function renderGhost() {
  const b = $("#btn-ghost");
  b.setAttribute("aria-pressed", S.ghost);
  $("#ghost-label").textContent = S.ghost ? "Ghost" : "Visible";
  $("#live-dot").classList.toggle("on", !S.ghost);
  renderMe();
}
$("#btn-ghost").addEventListener("click", async () => {
  S.ghost = !S.ghost;
  lsSet("ghost", S.ghost);
  renderGhost();
  if (S.ghost) {
    await S.store.updateMember(S.crew.id, S.uid, { ghost: true, lat: null, lng: null, speed: null, heading: null, updatedAt: Date.now() });
    toast("Ghost mode on. The crew can't see where you are.");
  } else {
    await S.store.updateMember(S.crew.id, S.uid, { ghost: false });
    S.lastSent = null; maybeSend(true);
    toast("You're visible to the crew again.");
  }
});

/* ---------------- views ---------------- */
function setView(v) {
  if (!["map", "convoy", "garage", "explore", "bass", "crew"].includes(v)) v = "map";
  S.view = v; lsSet("view", v);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  for (const id of ["convoy", "garage", "explore", "bass", "crew"]) $(`#view-${id}`).hidden = id !== v;
  if (v === "map") setTimeout(() => S.map.invalidateSize(), 30);
  renderActiveView();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
function renderActiveView() {
  if (S.view === "convoy") renderConvoy();
  else if (S.view === "garage") renderGarage();
  else if (S.view === "explore") renderExplore();
  else if (S.view === "bass") renderBass();
  else if (S.view === "crew") renderCrew();
}

/* ---------------- convoy ---------------- */
const myConvoy = () => S.convoys.find((c) => c.memberIds?.includes(S.uid));
const posOf = (id) => (id === S.uid ? (S.ghost ? null : S.pos) : (() => { const m = S.members.get(id); return m && ["live", "stale"].includes(memberState(m)) ? m : null; })());
const nameOf = (id) => (id === S.uid ? `${S.profile.callsign} (you)` : S.members.get(id)?.callsign || "Left the crew");

function renderConvoy() {
  const body = $("#convoy-body");
  body.replaceChildren();
  const mine = myConvoy();
  if (mine) body.append(convoyCard(mine, true));
  const others = S.convoys.filter((c) => c !== mine);
  if (others.length) {
    body.append(h("h3", { class: "h3" }, mine ? "Other convoys" : "Convoys on the go"));
    const wrap = h("div", { class: "convoy-list" });
    others.forEach((c) => wrap.append(convoyCard(c, false)));
    body.append(wrap);
  }
  if (!mine) {
    if (!others.length) body.append(h("div", { class: "empty" }, h("div", { class: "big" }, "No convoy running"), h("p", {}, "Start one, pick where you're headed, and everyone who joins shows up with their distance to the destination.")));
    body.append(h("button", { class: "btn primary wide", style: "margin-top:16px", onclick: () => openConvoyDialog(false) }, "Start a convoy"));
  }
}

function convoyCard(c, mine) {
  const dest = c.dest;
  const rows = h("ul", { class: "rows" });
  const ids = [...(c.memberIds || [])].sort((a, b) => {
    const pa = posOf(a), pb = posOf(b);
    return (pa ? haversine(pa, dest) : 1e12) - (pb ? haversine(pb, dest) : 1e12);
  });
  for (const id of ids) {
    const p = posOf(id);
    const d = p ? haversine(p, dest) : null;
    const sp = p?.speed > 2 ? p.speed : null;
    const eta = d != null && sp ? `${Math.max(1, Math.round(d / sp / 60))} min` : "";
    const m = S.members.get(id);
    rows.append(h("li", {},
      avatar(id, id === S.uid ? S.profile.callsign : m?.callsign),
      h("div", { class: "grow" }, h("div", { class: "n" }, nameOf(id), id === c.leaderId ? "  ·  leader" : ""),
        h("div", { class: "s" }, p ? (sp ? `${kmh(sp)} km/h` : "Stopped") : (m?.ghost || (id === S.uid && S.ghost) ? "Ghost mode" : "No signal"))),
      h("div", { class: "num" }, d != null ? fmtKm(d) : "—", eta ? h("div", { class: "s", style: "margin-top:4px;color:var(--muted)" }, eta) : null)));
  }
  const nav = `${dest.lat},${dest.lng}`;
  const actions = h("div", { class: "btn-row" });
  if (mine) {
    actions.append(
      h("button", { class: "btn primary sm", onclick: () => { setView("map"); showConvoyOnMap(c); } }, "Show on map"),
      h("a", { class: "btn ghost sm", href: `https://www.google.com/maps/dir/?api=1&destination=${nav}`, target: "_blank", rel: "noopener" }, "Google Maps"),
      h("a", { class: "btn ghost sm", href: `https://waze.com/ul?ll=${nav}&navigate=yes`, target: "_blank", rel: "noopener" }, "Waze"),
      h("button", { class: "btn ghost sm", onclick: async () => { await S.store.leaveConvoy(S.crew.id, c.id, S.uid); if ((c.memberIds || []).length <= 1) await S.store.endConvoy(S.crew.id, c.id); toast("You left the convoy."); } }, "Leave"),
    );
    if (c.leaderId === S.uid) actions.append(h("button", { class: "btn danger sm", onclick: () => S.store.endConvoy(S.crew.id, c.id).then(() => toast("Convoy ended.")) }, "End convoy"));
  } else {
    actions.append(h("button", { class: "btn primary sm", onclick: () => joinConvoy(c) }, "Join convoy"));
  }
  const me = S.ghost ? null : S.pos;
  return h("div", { class: "card convoy-card" },
    h("div", {}, h("div", { class: "title" }, c.name), h("div", { class: "dest" }, `To ${dest.label || "pinned spot"}`, me ? ` · ${fmtKm(haversine(me, dest))} from you` : "")),
    rows, actions);
}

async function joinConvoy(c) {
  const cur = myConvoy();
  if (cur) await S.store.leaveConvoy(S.crew.id, cur.id, S.uid);
  await S.store.joinConvoy(S.crew.id, c.id, S.uid);
  toast(`Joined ${c.name}`);
}

function renderConvoyOverlay() {
  if (!S.convoyLayer) return;
  S.convoyLayer.clearLayers();
  const c = myConvoy(), strip = $("#convoy-strip");
  if (!c) { strip.hidden = true; return; }
  const dest = [c.dest.lat, c.dest.lng];
  L.marker(dest, { icon: L.divIcon({ className: "", html: '<div class="dest-flag">🏁</div>', iconSize: [0, 0] }), interactive: false }).addTo(S.convoyLayer);
  for (const id of c.memberIds || []) {
    const p = posOf(id);
    if (p) L.polyline([[p.lat, p.lng], dest], { color: id === S.uid ? "#ffb020" : colorFor(id), weight: 3, opacity: 0.9, dashArray: "6 8", interactive: false }).addTo(S.convoyLayer);
  }
  const me = S.ghost ? null : S.pos;
  strip.replaceChildren(h("b", {}, c.name), h("div", { class: "meta" }, `${(c.memberIds || []).length} in convoy`, me ? ` · ${fmtKm(haversine(me, c.dest))} to ${c.dest.label || "destination"}` : ""));
  strip.hidden = false;
  strip.onclick = () => setView("convoy");
}
function showConvoyOnMap(c) {
  const pts = [[c.dest.lat, c.dest.lng], ...(c.memberIds || []).map(posOf).filter(Boolean).map((p) => [p.lat, p.lng])];
  if (pts.length === 1) S.map.flyTo(pts[0], 13); else S.map.flyToBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15 });
}

async function updateWakeLock() {
  const want = !!myConvoy() && !document.hidden;
  try {
    if (want && !S.wakeLock && navigator.wakeLock) { S.wakeLock = await navigator.wakeLock.request("screen"); S.wakeLock.addEventListener("release", () => (S.wakeLock = null)); }
    if (!want && S.wakeLock) { await S.wakeLock.release(); S.wakeLock = null; }
  } catch {}
}

// convoy dialog
const dlgConvoy = $("#dlg-convoy");
function openConvoyDialog(keep) {
  if (!keep) { $("#form-convoy").reset(); S.pendingDest = null; }
  $("#convoy-dest-coords").textContent = S.pendingDest ? `Pinned at ${S.pendingDest.lat.toFixed(4)}, ${S.pendingDest.lng.toFixed(4)}` + (S.pos ? ` · ${fmtKm(haversine(S.pos, S.pendingDest))} from you` : "") : "No destination set yet.";
  $("#btn-convoy-pick").textContent = S.pendingDest ? "Move the pin" : "Pick destination on map";
  dlgConvoy.showModal();
}
$("#btn-convoy-pick").addEventListener("click", () => {
  dlgConvoy.close();
  setView("map");
  S.pick = true;
  $("#pick-banner").hidden = false;
});
$("#btn-pick-cancel").addEventListener("click", () => { S.pick = false; $("#pick-banner").hidden = true; openConvoyDialog(true); });
$("#btn-convoy-cancel").addEventListener("click", () => dlgConvoy.close());
$("#form-convoy").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!S.pendingDest) { toast("Pick a destination on the map first."); return; }
  const name = $("#in-convoy-name").value.trim();
  if (!name) return;
  const cur = myConvoy();
  if (cur) await S.store.leaveConvoy(S.crew.id, cur.id, S.uid);
  await S.store.createConvoy(S.crew.id, {
    name, dest: { ...S.pendingDest, label: $("#in-convoy-dest").value.trim() }, leaderId: S.uid,
    memberIds: [S.uid], active: true, createdAt: Date.now(),
  });
  dlgConvoy.close();
  S.pendingDest = null;
  toast("Convoy started. The crew can join from the Convoy tab.");
  setView("convoy");
});

/* ---------------- garage ---------------- */
function carCard(v, onclick) {
  const photo = v.photo ? h("img", { class: "car-photo", src: v.photo, alt: v.name }) : h("div", { class: "car-photo" }, initial(v.name));
  const spec = [v.year, v.make, v.model].filter(Boolean).join(" ");
  const extra = [v.colour, v.engine, v.power ? `${v.power} kW` : ""].filter(Boolean).join(" · ");
  return h(onclick ? "button" : "div", { class: "car", onclick },
    photo,
    h("div", { class: "car-body" },
      h("div", { class: "car-name" }, v.name, v.active ? h("span", { class: "badge" }, "Driving") : null),
      spec ? h("div", { class: "car-spec" }, spec) : null,
      extra ? h("div", { class: "car-spec" }, extra) : null,
      v.mods?.length ? h("div", { class: "mods" }, v.mods.map((m) => h("span", {}, m))) : null));
}
function renderGarage() {
  const list = $("#garage-list");
  list.replaceChildren();
  if (!S.myVehicles.length) {
    list.append(h("div", { class: "empty", style: "grid-column:1/-1" }, h("div", { class: "big" }, "Empty garage"), h("p", {}, "Add your car with its mods. The one you're driving shows next to your name on the crew map.")));
    return;
  }
  [...S.myVehicles].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0)).forEach((v) => list.append(carCard(v, () => openCar(v))));
}
const dlgCar = $("#dlg-car");
let editing = null, photoData = "";
function openCar(v) {
  editing = v || null;
  photoData = v?.photo || "";
  $("#car-dlg-title").textContent = v ? "Edit car" : "Add car";
  $("#in-car-name").value = v?.name || "";
  $("#in-car-make").value = v?.make || "";
  $("#in-car-model").value = v?.model || "";
  $("#in-car-year").value = v?.year || "";
  $("#in-car-colour").value = v?.colour || "";
  $("#in-car-engine").value = v?.engine || "";
  $("#in-car-power").value = v?.power || "";
  $("#in-car-mods").value = (v?.mods || []).join("\n");
  $("#in-car-active").checked = v ? !!v.active : !S.myVehicles.some((x) => x.active);
  const img = $("#car-photo-preview");
  img.src = photoData; img.hidden = !photoData;
  $("#btn-car-delete").hidden = !v;
  dlgCar.showModal();
}
$("#btn-addcar").addEventListener("click", () => openCar(null));
$("#btn-car-cancel").addEventListener("click", () => dlgCar.close());
$("#in-car-photo").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { photoData = await shrinkImage(f, 720, 0.72); const img = $("#car-photo-preview"); img.src = photoData; img.hidden = false; }
  catch { toast("Couldn't read that photo. Try a JPG or PNG."); }
});
function shrinkImage(file, max, q) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      res(c.toDataURL("image/jpeg", q));
    };
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}
$("#form-car").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = {
    id: editing?.id || `v${Date.now().toString(36)}`,
    name: $("#in-car-name").value.trim(), make: $("#in-car-make").value.trim(), model: $("#in-car-model").value.trim(),
    year: $("#in-car-year").value.trim(), colour: $("#in-car-colour").value.trim(), engine: $("#in-car-engine").value.trim(),
    power: $("#in-car-power").value.trim(), mods: $("#in-car-mods").value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20),
    active: $("#in-car-active").checked, photo: photoData,
  };
  if (!v.name) return;
  try {
    if (v.active) for (const o of S.myVehicles) if (o.id !== v.id && o.active) await S.store.saveVehicle(S.uid, { ...o, active: false });
    await S.store.saveVehicle(S.uid, v);
    dlgCar.close();
    toast(`${v.name} saved`);
  } catch { toast("Couldn't save. The photo might be too big; try another one."); }
});
$("#btn-car-delete").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to delete"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Delete"; }, 3000); return; }
  b.dataset.armed = ""; b.textContent = "Delete";
  await S.store.deleteVehicle(S.uid, editing.id);
  dlgCar.close();
  toast("Car removed");
});
function syncActiveCar() {
  if (!S.crew) return;
  const a = S.myVehicles.find((v) => v.active);
  const car = a ? { name: a.name, desc: [a.year, a.make, a.model].filter(Boolean).join(" ") } : null;
  const cur = S.members.get(S.uid)?.car || null;
  if (JSON.stringify(cur) !== JSON.stringify(car)) S.store.updateMember(S.crew.id, S.uid, { car }).catch(() => {});
}

/* ---------------- explore ---------------- */
function renderExplore() {
  const area = S.explored.size * cellAreaKm2(S.pos?.lat ?? -26);
  const stat = (v, k) => h("div", { class: "stat" }, h("div", { class: "v" }, v), h("div", { class: "k" }, k));
  $("#explore-stats").replaceChildren(
    stat(S.explored.size.toLocaleString("en-ZA"), "Road tiles"),
    stat(area < 10 ? area.toFixed(1) : Math.round(area).toLocaleString("en-ZA"), "km² cleared"),
    stat(Math.round(S.km).toLocaleString("en-ZA"), "km driven"));
  const rows = [...S.members.values()].map((m) => ({ id: m.id, name: m.id === S.uid ? `${S.profile.callsign} (you)` : m.callsign, cells: m.id === S.uid ? S.explored.size : m.stats?.cells || 0, km: m.id === S.uid ? Math.round(S.km) : m.stats?.km || 0 }))
    .sort((a, b) => b.cells - a.cells);
  const top = Math.max(1, rows[0]?.cells || 1);
  $("#leaderboard").replaceChildren(...rows.map((r) => h("li", {}, avatar(r.id, r.name),
    h("div", { class: "grow" }, h("div", { class: "n" }, r.name), h("div", { class: "bar" }, h("i", { style: `width:${(r.cells / top) * 100}%` }))),
    h("div", { class: "num" }, r.cells.toLocaleString("en-ZA"), h("div", { class: "s", style: "margin-top:4px;color:var(--muted)" }, `${r.km.toLocaleString("en-ZA")} km`)))));
}
$("#btn-showfog").addEventListener("click", () => {
  setView("map"); setFog(true);
  if (S.explored.size) {
    let s = 90, n = -90, w = 180, e = -180;
    for (const g of S.explored) { const b = ghBounds(g); s = Math.min(s, b.s); n = Math.max(n, b.n); w = Math.min(w, b.w); e = Math.max(e, b.e); }
    S.map.flyToBounds([[s, w], [n, e]], { padding: [30, 30], maxZoom: 14 });
  } else toast("Go for a drive. Roads you drive will clear up here.");
});

/* ---------------- bass ---------------- */
const BASS_CLASSES = ["All", "Daily", "Street", "Extreme"];
const bassName = (uid) => (uid === S.uid ? `${S.profile.callsign} (you)` : S.members.get(uid)?.callsign || "Ex-member");
const dbText = (n) => h("span", { class: "dbv" }, Number(n).toFixed(1), h("small", {}, "dB"));

function renderBass() {
  const runs = S.bass.filter((b) => S.bassClass === "All" || b.cls === S.bassClass);
  $("#bass-classes").replaceChildren(...BASS_CLASSES.map((c) => h("button", { "aria-pressed": String(S.bassClass === c), onclick: () => { S.bassClass = c; renderBass(); } }, c)));

  // best score per person
  const best = new Map();
  for (const b of runs) { const cur = best.get(b.uid); if (!cur || b.db > cur.db) best.set(b.uid, b); }
  const board = [...best.values()].sort((a, b) => b.db - a.db);
  const champ = board[0];
  $("#bass-champ").replaceChildren(champ ? h("div", { class: "champ" },
    h("div", { class: "db" }, Number(champ.db).toFixed(1), h("small", {}, "dB")),
    h("div", { class: "who" }, h("div", { class: "crown" }, S.bassClass === "All" ? "Loudest in the crew" : `Loudest · ${S.bassClass}`),
      h("div", { class: "n" }, bassName(champ.uid)), h("div", { class: "s", style: "color:var(--muted)" }, [champ.car, champ.hz ? `${champ.hz} Hz` : ""].filter(Boolean).join(" · ")))) : "");

  $("#bass-board").replaceChildren(...(board.length ? board.map((b) => h("li", {}, avatar(b.uid, bassName(b.uid)),
    h("div", { class: "grow" }, h("div", { class: "n" }, bassName(b.uid), h("span", { class: "cls" }, b.cls)),
      h("div", { class: "s" }, [b.car, b.setup].filter(Boolean).join(" · ") || "No setup listed")),
    h("div", { class: "num" }, dbText(b.db), h("div", { class: "seen", style: "margin-top:5px" }, (b.witnesses || []).length ? `${b.witnesses.length} saw it` : "")))) :
    [h("div", { class: "empty" }, h("div", { class: "big" }, "No scores yet"), h("p", {}, S.bassClass === "All" ? "Do a sound test, then tap Log a score to put the first number on the board." : `Nobody has logged a ${S.bassClass} score yet.`))]));

  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  $("#bass-runs").replaceChildren(...sorted.map((b) => {
    const mine = b.uid === S.uid;
    const seen = (b.witnesses || []).includes(S.uid);
    const names = (b.witnesses || []).map((w) => (w === S.uid ? "you" : S.members.get(w)?.callsign)).filter(Boolean);
    const acts = h("div", { class: "acts" });
    if (!mine && !seen) acts.append(h("button", { class: "btn ghost", onclick: () => S.store.witnessBass(S.crew.id, b.id, S.uid).then(() => toast("Marked as witnessed")) }, "I saw it"));
    if (mine) acts.append(h("button", { class: "btn danger", onclick: (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Tap again to delete"; setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Delete"; }, 3000); return; }
      S.store.deleteBass(S.crew.id, b.id).then(() => toast("Score deleted"));
    } }, "Delete"));
    return h("li", {},
      b.photo ? h("img", { class: "thumb", src: b.photo, alt: "Meter photo", onclick: () => showPhoto(b) }) : h("div", { class: "thumb" }, "No pic"),
      h("div", { class: "grow" },
        h("div", { class: "n" }, bassName(b.uid), h("span", { class: "cls" }, b.cls)),
        h("div", { class: "s" }, [b.car, b.hz ? `${b.hz} Hz` : "", b.venue].filter(Boolean).join(" · ")),
        h("div", { class: "s" }, fmtAgo(b.createdAt), b.setup ? ` · ${b.setup}` : ""),
        names.length ? h("div", { class: "seen" }, `Seen by ${names.join(", ")}`) : null,
        acts.childNodes.length ? acts : null),
      h("div", { class: "num" }, dbText(b.db)));
  }));
}

function showPhoto(b) {
  $("#member-body").replaceChildren(
    h("div", { class: "car-name", style: "margin-bottom:10px" }, `${bassName(b.uid)} · ${Number(b.db).toFixed(1)} dB`),
    h("img", { class: "photo-big", src: b.photo, alt: "Meter photo" }));
  dlgMember.showModal();
}

const dlgBass = $("#dlg-bass");
let bassPhoto = "";
$("#btn-addbass").addEventListener("click", () => {
  $("#form-bass").reset();
  bassPhoto = "";
  $("#bass-photo-preview").hidden = true;
  const active = S.myVehicles.find((v) => v.active);
  if (active) $("#in-bass-car").value = active.name;
  if (S.bassClass !== "All") $("#in-bass-class").value = S.bassClass;
  dlgBass.showModal();
});
$("#btn-bass-cancel").addEventListener("click", () => dlgBass.close());
$("#in-bass-photo").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { bassPhoto = await shrinkImage(f, 720, 0.72); const img = $("#bass-photo-preview"); img.src = bassPhoto; img.hidden = false; }
  catch { toast("Couldn't read that photo. Try a JPG or PNG."); }
});
$("#form-bass").addEventListener("submit", async (e) => {
  e.preventDefault();
  const dbv = parseFloat($("#in-bass-db").value.replace(",", "."));
  if (!(dbv > 60 && dbv < 200)) { toast("Enter the dB reading from the meter, e.g. 142.6"); return; }
  const hz = parseFloat($("#in-bass-hz").value.replace(",", "."));
  try {
    await S.store.addBass(S.crew.id, {
      uid: S.uid, db: Math.round(dbv * 10) / 10, hz: hz > 0 && hz < 1000 ? Math.round(hz) : null,
      cls: $("#in-bass-class").value, car: $("#in-bass-car").value.trim(), setup: $("#in-bass-setup").value.trim(),
      venue: $("#in-bass-venue").value.trim(), photo: bassPhoto, witnesses: [], createdAt: Date.now(),
    });
    dlgBass.close();
    const top = Math.max(0, ...S.bass.filter((b) => b.uid !== S.uid).map((b) => b.db));
    toast(dbv > top ? `${dbv.toFixed(1)} dB. That's the new crew record!` : `${dbv.toFixed(1)} dB logged`);
  } catch { toast("Couldn't save. The photo might be too big; try another one."); }
});

/* ---------------- crew ---------------- */
function renderCrew() {
  const ul = $("#crew-list");
  const list = [...S.members.values()].sort((a, b) => (a.id === S.uid ? -1 : b.id === S.uid ? 1 : (b.updatedAt || 0) - (a.updatedAt || 0)));
  ul.replaceChildren(...list.map((m) => {
    const st = m.id === S.uid ? (S.ghost ? "ghost" : S.pos ? "live" : "off") : memberState(m);
    const label = { live: "Live", stale: m.updatedAt ? fmtAgo(m.updatedAt) : "Away", ghost: "Ghost", off: m.updatedAt ? fmtAgo(m.updatedAt) : "Offline" }[st];
    const dist = m.id !== S.uid && S.pos && ["live", "stale"].includes(st) ? fmtKm(haversine(S.pos, m)) + " away" : "";
    return h("li", { onclick: () => openMember(m.id) }, avatar(m.id, m.callsign),
      h("div", { class: "grow" }, h("div", { class: "n" }, m.id === S.uid ? `${m.callsign} (you)` : m.callsign),
        h("div", { class: "s" }, [m.car?.name, dist].filter(Boolean).join(" · ") || "No car added")),
      h("span", { class: `status ${st === "live" ? "live" : st === "ghost" ? "ghost" : ""}` }, label));
  }));
}
$("#btn-share").addEventListener("click", async () => {
  const text = `Join my crew on THE CREW app: "${S.crew.name}". Open ${location.origin}${location.pathname} and use invite code ${S.crew.id}`;
  try {
    if (navigator.share) await navigator.share({ title: "THE CREW", text });
    else { await navigator.clipboard.writeText(text); toast("Invite copied"); }
  } catch (e) { if (e?.name !== "AbortError") toast(`Invite code: ${S.crew.id}`); }
});
$("#form-me").addEventListener("submit", async (e) => {
  e.preventDefault();
  const c = $("#in-me-callsign").value.trim();
  const phone = cleanPhone($("#in-me-phone").value);
  if (!c) return;
  if (!phone) { toast("Enter a valid phone number"); return; }
  Object.assign(S.profile, { callsign: c, phone });
  await S.store.saveProfile(S.uid, { callsign: c, phone });
  await S.store.updateMember(S.crew.id, S.uid, { callsign: c, phone });
  toast("Saved");
});
$("#btn-leave").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to leave"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Leave crew"; }, 3000); return; }
  const cur = myConvoy();
  if (cur) await S.store.leaveConvoy(S.crew.id, cur.id, S.uid).catch(() => {});
  teardown();
  await S.store.leaveCrew(S.crew.id, S.uid);
  await S.store.saveProfile(S.uid, { crewId: null });
  S.profile.crewId = null; S.crew = null;
  b.dataset.armed = ""; b.textContent = "Leave crew";
  route();
});
$("#btn-signout").addEventListener("click", async () => { await flushProgress(); teardown(); S.store.signOut(); });

// member sheet
const dlgMember = $("#dlg-member");
$("#btn-member-close").addEventListener("click", () => dlgMember.close());
async function openMember(id) {
  const m = S.members.get(id);
  if (!m) return;
  const st = id === S.uid ? (S.ghost ? "ghost" : "live") : memberState(m);
  const where = id === S.uid ? S.pos : ["live", "stale"].includes(st) ? m : null;
  const body = $("#member-body");
  body.replaceChildren(
    h("div", { style: "display:flex;gap:12px;align-items:center;margin-bottom:12px" }, avatar(id, m.callsign),
      h("div", { class: "grow" }, h("div", { class: "car-name" }, m.callsign),
        h("div", { class: "s", style: "color:var(--muted)" },
          st === "ghost" ? "Ghost mode" : st === "live" ? (m.speed > 1.5 ? `Driving · ${kmh(m.speed)} km/h` : "Live · stopped") : m.updatedAt ? `Last seen ${fmtAgo(m.updatedAt)}` : "Hasn't shared a location yet",
          where && id !== S.uid && S.pos ? ` · ${fmtKm(haversine(S.pos, where))} away` : ""))),
    where && id !== S.uid ? h("div", { class: "btn-row", style: "margin-bottom:14px" },
      h("button", { class: "btn primary sm", onclick: () => { dlgMember.close(); setView("map"); S.map.flyTo([where.lat, where.lng], 15); } }, "Show on map"),
      h("a", { class: "btn ghost sm", href: `https://www.google.com/maps/dir/?api=1&destination=${where.lat},${where.lng}`, target: "_blank", rel: "noopener" }, "Drive to them")) : null,
    m.phone && id !== S.uid ? h("div", { class: "phone-row" },
      h("div", { class: "grow" }, h("div", { class: "lbl" }, "Phone"), h("div", { class: "n", style: "margin-top:4px;user-select:all" }, m.phone)),
      h("a", { class: "btn ghost sm", href: `tel:${intlPhone(m.phone)}` }, "Call"),
      h("a", { class: "btn ghost sm", href: `https://wa.me/${intlPhone(m.phone).slice(1)}`, target: "_blank", rel: "noopener" }, "WhatsApp")) : null,
    h("div", { class: "lbl", style: "margin:4px 0 10px" }, "Garage"),
    h("div", { class: "cars", id: "member-cars" }, h("div", { class: "s", style: "color:var(--muted)" }, "Loading…")));
  dlgMember.showModal();
  const cars = await S.store.getVehicles(id).catch(() => []);
  const box = $("#member-cars");
  if (!box) return;
  box.replaceChildren(...(cars.length ? cars.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0)).map((v) => carCard(v)) : [h("div", { class: "s", style: "color:var(--muted)" }, "No cars in the garage yet.")]));
}

// refresh "x min ago" labels and stale markers
setInterval(() => { if (S.crew) { renderMembers(); if (S.view === "crew") renderCrew(); } }, 30000);

boot();
