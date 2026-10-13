import { firebaseConfig } from "./firebase-config.js";
import { VAPID_PUBLIC, NOTIFY_URL } from "./push-config.js";
import { haversine, ghEncode, ghBounds, cellAreaKm2, fmtKm, fmtAgo, CELL_PREC, PREFIX_PREC } from "./geo.js";

const $ = (s) => document.querySelector(s);
const DEMO = !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("PASTE");
const COLORS = ["#ffb020", "#3ddc97", "#5cc8ff", "#ff6b9a", "#c58bff", "#ff8a3d", "#9be15d", "#ffd84d"];
const STALE_MS = 5 * 60 * 1000, GONE_MS = 2 * 60 * 60 * 1000, SEEN_MS = 24 * 60 * 60 * 1000;

const S = {
  store: null, uid: null, profile: null, crew: null,
  members: new Map(), convoys: [], myVehicles: [],
  boards: { bass: [], speed: [], t60: [], t100: [], qm: [] }, boardClass: { bass: "All", speed: "All", t60: "All", t100: "All", qm: "All" }, speedMode: "speed", period: "week",
  explored: new Set(), pendingCells: new Set(),
  pos: null, lastFix: null, lastSent: null, km: 0,
  ghost: false, fog: false, mapTheme: "night", meets: [], seg: "meets", homeHidden: false, view: "map", pick: false, pendingDest: null,
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
  if (age > SEEN_MS) return "off";
  if (age > GONE_MS) return "seen"; // faded "last seen" pin
  return age > STALE_MS ? "stale" : "live";
}

// Keep digits and a leading +; "0821234567" stays as typed, links convert it to +27.
function cleanPhone(v) { const t = String(v || "").trim().replace(/[^\d+]/g, ""); return t.replace(/\D/g, "").length >= 9 ? t : ""; }
const phoneKey = (p) => (p ? intlPhone(p).replace(/\D/g, "") : "");
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
  const pc = lsGet("pendingClaim", null);
  if (step === "crew" && pc?.crew && !$("#in-code").value) $("#in-code").value = pc.crew;
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
  S.justJoined = true;
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
  S.statsMerged = false; S.meetsLoaded = false;
  chatMsgs = []; chatFirst = true; founders = []; founderClaims = []; S.merchSubbed = false; merch = []; myOrders = []; allOrders = [];
  $("#onboard").hidden = true;
  $("#app").hidden = false;
  $("#demo-banner").hidden = !DEMO;
  $("#app").classList.toggle("is-demo", DEMO);
  $("#crew-title").textContent = S.crew.name;
  $("#invite-code").textContent = S.crew.id;
  $("#in-me-callsign").value = S.profile.callsign;
  $("#in-me-phone").value = S.profile.phone || "";
  S.ghost = !!lsGet("ghost", false);
  renderGhost();
  initMap();
  setFog(!!lsGet("fog", false));
  S.km = Number(lsGet(`km:${S.uid}`, 0)) || 0;
  renderHome(); renderHomeCircle();

  try {
    await S.store.joinCrew(S.crew.id, S.uid, {
      callsign: S.profile.callsign, phone: S.profile.phone || "", phoneKey: phoneKey(S.profile.phone), ghost: S.ghost,
      ...(S.ghost ? { lat: null, lng: null, speed: null } : {}),
    });
  } catch (e) {
    // blocked by the app founder (or the crew is gone): send them back to the crew screen
    const name = S.crew.name;
    teardown();
    await S.store.saveProfile(S.uid, { crewId: null }).catch(() => {});
    S.profile.crewId = null; S.crew = null;
    showOnboard("crew");
    obError(`You can't join ${name}. You were removed from this crew. Speak to whoever runs it.`);
    return;
  }

  S.unsubs.push(S.store.onMembers(S.crew.id, (list) => {
    S.members = new Map(list.map((m) => [m.id, m]));
    if (!S.members.has(S.uid)) { kickedOut(); return; } // removed from crew by the app founder
    noteRuns(list);
    if (!S.statsMerged) { S.statsMerged = true; mergeStats(S.members.get(S.uid)?.stats); ensureMonth(); }
    setTimeout(applyDeepLink, 0);
    renderMembers(); renderConvoyOverlay(); renderLiveStrip(); renderSos(); followWatched(); renderActiveView();
    if (!S.didFit && !S.pos) { S.didFit = true; fitCrew(); }
  }, (e) => { if (e?.code === "permission-denied") kickedOut(); else toast("Lost connection to the crew. Retrying…"); }));
  S.unsubs.push(S.store.onMeets(S.crew.id, (list) => {
    S.meets = list.sort((a, b) => a.when - b.when);
    S.meetsLoaded = true;
    syncReminders();
    setTimeout(applyDeepLink, 0);
    renderMeetPins();
    if (S.view === "convoy") renderDrive();
  }));
  S.unsubs.push(S.store.onConvoys(S.crew.id, (list) => {
    S.convoys = list.sort((a, b) => b.createdAt - a.createdAt);
    renderConvoyOverlay(); renderActiveView(); updateWakeLock();
  }));
  S.explored = await S.store.loadExplored(S.uid).catch(() => new Set());
  for (const c of lsGet(`pendingCells:${S.uid}`, [])) { S.explored.add(c); S.pendingCells.add(c); } // from a drive that didn't finish saving
  if (S.fog) S.fogLayer.redraw();
  for (const coll of new Set(Object.values(BOARDS).map((c) => c.coll))) S.unsubs.push(S.store.onBoard(S.crew.id, coll, (list) => {
    for (const [key, cfg] of Object.entries(BOARDS)) {
      if (cfg.coll !== coll) continue;
      S.boards[key] = list;
      if (S.view === key || (S.view === "speed" && S.speedMode === key)) renderBoard(key);
    }
    if (S.view === "explore") renderBadges();
  }));
  S.unsubs.push(S.store.onChat(S.crew.id, onChatList, () => {}));
  S.unsubs.push(S.store.onFounders(S.crew.id, (list) => {
    const wasAdmin = isAdmin();
    founders = list;
    if (!S.merchSubbed || wasAdmin !== isAdmin()) { S.merchSubbed = true; subscribeMerch(); }
    if (S.view === "crew") renderCrew();
    if (S.view === "explore") renderBadges();
  }, () => {}));
  checkins = [];
  S.unsubs.push(S.store.onCheckins(S.crew.id, (l) => {
    checkins = l;
    if (dlgMeetView.open && S.openMeet) openMeetView(S.openMeet);
    if (S.qrMeet && $("#qr-count")) $("#qr-count").textContent = `✅ ${checkinsFor(S.qrMeet).length} checked in`;
  }, () => {}));
  bans = [];
  if (S.crew.ownerId === S.uid) S.unsubs.push(S.store.onBans(S.crew.id, (list) => { bans = list; if (S.view === "crew") renderBans(); }, () => {}));
  if (S.crew.ownerId === S.uid) S.unsubs.push(S.store.onFounderClaims(S.crew.id, (list) => { founderClaims = list; if (S.view === "crew") renderFounders(); }, () => {}));
  S.unsubs.push(S.store.onVehicles(S.uid, (list) => {
    S.myVehicles = list;
    syncActiveCar();
    setStat("mods", list.reduce((n, v) => n + (v.log || []).filter((e) => e.type === "Mod").length, 0));
    if (S.view === "garage") renderGarage();
  }));
  startGps();
  S.speedMode = lsGet("speedMode", "speed");
  S.period = lsGet("speedPeriod", "week");
  setView(lsGet("view", "map"));
  handleDeepLink();
  refreshPush();
  loadDrive();
  tryClaim();
  if (S.justJoined) {
    S.justJoined = false;
    const car = (await S.store.getVehicles(S.uid).catch(() => []))[0];
    notifyCrew("join", { title: `👋 ${S.profile.callsign} joined ${S.crew.name}`, body: car ? `Rolling in a ${[car.year, car.make, car.model].filter(Boolean).join(" ")} · say hi in the chat` : "Say hi in the crew chat", url: "./?chat=1", tag: `join-${S.uid}` });
  }
}

/* ---------------- map ---------------- */
function initMap() {
  if (S.map) { setTimeout(() => S.map.invalidateSize(), 50); return; }
  S.map = L.map("map", { zoomControl: false, attributionControl: true, worldCopyJump: true }).setView([-25.75, 28.23], 11);
  // OpenStreetMap tiles; night mode darkens them with a CSS filter (see #map.night in styles.css)
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(S.map);
  S.map.createPane("fog").style.zIndex = 350;
  S.convoyLayer = L.layerGroup().addTo(S.map);
  S.fogLayer = new FogLayer();
  const hr = new Date().getHours();
  setMapTheme(lsGet("mapTheme", hr >= 18 || hr < 6 ? "night" : "day"));
  S.meetLayer = L.layerGroup().addTo(S.map);
  S.homeLayer = L.layerGroup().addTo(S.map);
  S.map.on("click", (e) => {
    if (!S.pick) return;
    const p = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) };
    const mode = S.pick;
    S.pick = false;
    $("#pick-banner").hidden = true;
    if (mode === "meet") { meetDraft.place = p; openMeetDialog(true); }
    else if (mode === "home") { setHome(p); setView("crew"); }
    else { S.pendingDest = p; openConvoyDialog(true); }
  });
}

/* ---------- drive-to-reveal fog ---------- */
// Soft, slowly drifting fog. Roads you've driven are cut out as smooth glowing trails.
const FOG_THEMES = {
  night: { base: "rgba(8,11,18,0.9)", wisp: [150, 165, 190], wispAlpha: 0.10, glow: "rgba(255,176,32,0.20)" },
  day: { base: "rgba(226,230,236,0.86)", wisp: [255, 255, 255], wispAlpha: 0.55, glow: "rgba(255,150,0,0.16)" },
};
function makeCloudTexture(rgb, alpha) {
  const N = 320, c = document.createElement("canvas");
  c.width = c.height = N;
  const ctx = c.getContext("2d");
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const x = rnd() * N, y = rnd() * N, r = 25 + rnd() * 70, a = alpha * (0.35 + rnd() * 0.65);
    for (const dx of [-N, 0, N]) for (const dy of [-N, 0, N]) { // wrap so the texture tiles without seams
      const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
      g.addColorStop(0, `rgba(${rgb},${a})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
    }
  }
  return c;
}

const FogLayer = L.Layer.extend({
  PAD: 0.3,
  onAdd(map) {
    this._map = map;
    this._c = L.DomUtil.create("canvas", "fog-canvas leaflet-zoom-animated", map.getPane("fog"));
    this._c.style.pointerEvents = "none";
    this._mask = document.createElement("canvas");
    this._glow = document.createElement("canvas");
    this._setTheme();
    map.on("moveend zoomend resize viewreset", this.redraw, this);
    map.on("zoomanim", this._onZoomAnim, this);
    this.redraw();
    this._t0 = performance.now();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  },
  onRemove(map) {
    map.off("moveend zoomend resize viewreset", this.redraw, this);
    map.off("zoomanim", this._onZoomAnim, this);
    cancelAnimationFrame(this._raf);
    this._c.remove();
  },
  _setTheme() {
    this._theme = FOG_THEMES[S.mapTheme] || FOG_THEMES.night;
    const t = this._theme;
    this._pattern = this._c.getContext("2d").createPattern(makeCloudTexture(t.wisp.join(","), t.wispAlpha), "repeat");
  },
  setTheme() { if (this._map) { this._setTheme(); this.redraw(); } },
  // Called when the map stops moving or a new road is driven: rebuild the "cleared" mask.
  redraw() {
    const map = this._map;
    if (!map) return;
    const size = map.getSize(), p = this.PAD;
    const min = map.containerPointToLayerPoint(size.multiplyBy(-p)).round();
    const W = Math.round(size.x * (1 + 2 * p)), H = Math.round(size.y * (1 + 2 * p));
    this._min = min; this._center = map.getCenter(); this._zoom = map.getZoom();
    for (const c of [this._c, this._mask, this._glow]) { c.width = W; c.height = H; }
    this._c.style.width = W + "px"; this._c.style.height = H + "px";
    L.DomUtil.setPosition(this._c, min);
    const m = this._mask.getContext("2d");
    m.clearRect(0, 0, W, H);
    const ne = map.layerPointToLatLng(min), sw = map.layerPointToLatLng(min.add([W, H]));
    // size of one road square on screen right now
    let cellPx = 10;
    for (const gh of S.explored) {
      const b = ghBounds(gh);
      if (b.n < sw.lat || b.s > ne.lat || b.e < ne.lng || b.w > sw.lng) continue;
      const a = map.latLngToLayerPoint([b.n, b.w]), z = map.latLngToLayerPoint([b.s, b.e]);
      cellPx = Math.abs(z.x - a.x);
      const r = Math.max(7, cellPx * 1.15);
      const cx = (a.x + z.x) / 2 - min.x, cy = (a.y + z.y) / 2 - min.y;
      const g = m.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(0.55, "rgba(0,0,0,0.85)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      m.fillStyle = g;
      m.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    // warm glow along the cleared trails
    const gctx = this._glow.getContext("2d");
    gctx.clearRect(0, 0, W, H);
    gctx.drawImage(this._mask, 0, 0);
    gctx.globalCompositeOperation = "source-in";
    gctx.fillStyle = this._theme.glow;
    gctx.fillRect(0, 0, W, H);
    gctx.globalCompositeOperation = "source-over";
    this._paint(performance.now());
  },
  _paint(now) {
    const c = this._c, ctx = c.getContext("2d"), W = c.width, H = c.height;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = this._theme.base;
    ctx.fillRect(0, 0, W, H);
    // two layers of wisps drifting at different speeds
    const t = (now - this._t0) / 1000;
    for (const [sp, sc] of [[6, 1], [-4, 1.7]]) {
      ctx.save();
      ctx.translate((t * sp) % 320, (t * sp * 0.4) % 320);
      ctx.scale(sc, sc);
      ctx.fillStyle = this._pattern;
      ctx.fillRect(-320, -320, W / sc + 640, H / sc + 640);
      ctx.restore();
    }
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(this._mask, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this._glow, 0, 0);
  },
  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    if (document.hidden || S.view !== "map" || this._map._animatingZoom) return;
    if (now - (this._last || 0) < 66) return; // ~15 fps is plenty for drifting fog
    this._last = now;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches && this._painted) return;
    this._painted = true;
    this._paint(now);
  },
  _onZoomAnim(e) {
    const map = this._map, scale = map.getZoomScale(e.zoom, this._zoom);
    const viewHalf = map.getSize().multiplyBy(0.5 + this.PAD);
    const offset = viewHalf.multiplyBy(-scale).add(map.project(this._center, e.zoom)).subtract(map._getNewPixelOrigin(e.center, e.zoom));
    L.DomUtil.setTransform(this._c, offset, scale);
  },
});

/* ---------- day / night map ---------- */
function setMapTheme(theme) {
  S.mapTheme = theme === "day" ? "day" : "night";
  lsSet("mapTheme", S.mapTheme);
  $("#map").classList.toggle("night", S.mapTheme === "night");
  const b = $("#btn-theme");
  b.setAttribute("aria-label", S.mapTheme === "night" ? "Switch to day map" : "Switch to night map");
  b.innerHTML = S.mapTheme === "night"
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  if (S.fogLayer) S.fogLayer.setTheme();
}
$("#btn-theme").addEventListener("click", () => {
  setMapTheme(S.mapTheme === "night" ? "day" : "night");
  toast(S.mapTheme === "night" ? "Night map" : "Day map");
});

function setFog(on) {
  S.fog = on;
  lsSet("fog", on);
  $("#btn-fog").setAttribute("aria-pressed", on);
  if (on && !S.map.hasLayer(S.fogLayer)) S.fogLayer.addTo(S.map);
  if (!on && S.map.hasLayer(S.fogLayer)) S.map.removeLayer(S.fogLayer);
  renderFogStat();
}
function renderFogStat() {
  const el = $("#fog-stat");
  el.hidden = !S.fog;
  if (!S.fog) return;
  const area = S.explored.size * cellAreaKm2(S.pos?.lat ?? -26);
  el.textContent = S.explored.size
    ? `${area < 10 ? area.toFixed(1) : Math.round(area).toLocaleString("en-ZA")} km² revealed`
    : "Drive anywhere to start revealing your map";
}
$("#btn-fog").addEventListener("click", () => {
  setFog(!S.fog);
  if (S.fog && S.explored.size) {
    let s = 90, n = -90, w = 180, e = -180;
    for (const g of S.explored) { const b = ghBounds(g); s = Math.min(s, b.s); n = Math.max(n, b.n); w = Math.min(w, b.w); e = Math.max(e, b.e); }
    S.map.flyToBounds([[s, w], [n, e]], { padding: [40, 40], maxZoom: 14, duration: 0.8 });
  }
});

$("#btn-locate").addEventListener("click", () => {
  if (S.pos) S.map.flyTo([S.pos.lat, S.pos.lng], Math.max(S.map.getZoom(), 15), { duration: 0.6 });
  else toast("Waiting for GPS…");
});
$("#btn-crewfit").addEventListener("click", fitCrew);
function fitCrew() {
  const others = [...S.members.values()].filter((m) => m.id !== S.uid);
  let pts = others.filter((m) => ["live", "stale"].includes(memberState(m))).map((m) => [m.lat, m.lng]);
  if (!pts.length) pts = others.filter((m) => memberState(m) === "seen").map((m) => [m.lat, m.lng]);
  if (S.pos) pts.push([S.pos.lat, S.pos.lng]);
  if (!pts.length) return toast("Nobody from the crew has been out in the last 24 hours.");
  if (pts.length === 1) S.map.flyTo(pts[0], 14, { duration: 0.6 });
  else S.map.flyToBounds(L.latLngBounds(pts).pad(0.25), { duration: 0.6, maxZoom: 15 });
}

function renderMembers() {
  const seen = new Set();
  for (const m of S.members.values()) {
    if (m.id === S.uid) continue;
    const st = memberState(m);
    if (st !== "live" && st !== "stale" && st !== "seen") continue;
    seen.add(m.id);
    const speed = st === "live" && m.speed > 1.5 ? ` <small>${kmh(m.speed)} km/h</small>` : "";
    const car = st !== "seen" && m.car?.name ? ` <small>· ${esc(m.car.name)}</small>` : "";
    const ago = st === "seen" ? ` <small>· ${esc(fmtAgo(m.updatedAt))}</small>` : "";
    const liveTag = isLiveRun(m) ? `<span class="mk-live">LIVE</span>` : "";
    const html = `<div class="mk ${st === "stale" ? "stale" : st === "seen" ? "seen" : ""}${watchId === m.id ? " watched" : ""}"><div class="mk-pin" style="background:${colorFor(m.id)}"><span>${esc(initial(m.callsign))}</span></div><div class="mk-label">${liveTag}${esc(m.callsign)}${car}${speed}${ago}</div></div>`;
    let mk = S.markers.get(m.id);
    const icon = L.divIcon({ className: "", html, iconSize: [0, 0] });
    if (!mk) {
      mk = L.marker([m.lat, m.lng], { icon, zIndexOffset: st === "seen" ? 100 : 500 }).addTo(S.map);
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
  const icon = L.divIcon({ className: "", html: `<div class="me-dot ${S.ghost || S.homeHidden ? "ghost" : ""}" style="transform:translate(-50%,-50%)"></div>`, iconSize: [0, 0] });
  if (!S.meMarker) S.meMarker = L.marker([S.pos.lat, S.pos.lng], { icon, zIndexOffset: 1000, interactive: false }).addTo(S.map);
  else { S.meMarker.setLatLng([S.pos.lat, S.pos.lng]); S.meMarker.setIcon(icon); }
}

/* ---------------- GPS ---------------- */
function startGps() {
  if (DEMO && !navigator.geolocation) return simulateMe();
  if (!navigator.geolocation) return gpsWarn("This browser can't share location.");
  S.watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    if (DEMO && !S.pos) { simulateMe(); return; } // demo without GPS: pretend to drive
    gpsWarn(err.code === 1 ? "Location is blocked, so the crew can't see you. Tap here to fix it." : "Can't get a GPS fix yet… Tap here if this doesn't clear.", err.code === 1);
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
function gpsWarn(msg, blocked) {
  const w = $("#gps-warn");
  w.textContent = msg; w.hidden = !msg;
  w.onclick = msg ? () => showLocationHelp(blocked) : null;
}
// Step-by-step fix, written for the phone the person is holding.
function showLocationHelp(blocked) {
  const ios = isIOS();
  const steps = ios ? [
    "Open Settings → Privacy & Security → Location Services and make sure it's ON.",
    "On that same screen, scroll down to Safari Websites → choose While Using the App, and switch on Precise Location.",
    "Go to Settings → Apps → Safari → Location (older iPhones: Settings → Safari → Location) and choose Ask or Allow.",
    "Still stuck? Open this link in Safari, tap aA in the address bar → Website Settings → Location → Allow.",
    "Close THE CREW fully, open it again, and tap Allow if it asks.",
  ] : [
    "Pull down from the top of the screen and make sure Location is ON.",
    "Open Chrome → ⋮ menu → Settings → Site settings → Location, and make sure it's allowed (and this site isn't under Blocked).",
    "Phone Settings → Location → App permissions (or App location permissions) → Chrome → Allow only while using the app, and turn on Use precise location.",
    "Close THE CREW fully, open it again, and tap Allow if it asks.",
  ];
  $("#member-body").replaceChildren(
    h("div", { class: "car-name", style: "margin-bottom:6px" }, "Turn on location"),
    h("p", { class: "fine", style: "font-size:14px;margin-bottom:10px" }, blocked
      ? `Your ${ios ? "iPhone" : "phone"} is blocking location for THE CREW. Follow these steps, then reopen the app.`
      : "Your phone hasn't found you yet. Make sure you're outside or near a window, then check these settings."),
    h("ol", { class: "steps" }, ...steps.map((s) => h("li", {}, s))),
    h("div", { class: "btn-row", style: "margin-top:14px" },
      h("button", { class: "btn primary sm", onclick: () => { dlgMember.close(); retryGps(); } }, "Try again")));
  dlgMember.showModal();
}
function retryGps() {
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
  gpsWarn("Looking for your location…");
  navigator.geolocation.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: true, timeout: 20000 });
  startGps();
}

function onFix(p) {
  gpsWarn("");
  const c = p.coords;
  const fix = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, speed: c.speed ?? null, heading: c.heading ?? null, t: p.timestamp || Date.now() };
  const rawSpeed = fix.speed;
  const first = !S.pos;
  // distance driven: only trust clean fixes, ignore jitter and teleports
  if (S.lastFix && fix.acc < 30) {
    const d = haversine(S.lastFix, fix), dt = (fix.t - S.lastFix.t) / 1000;
    if (d > 8 && d < 3000 && dt > 0 && d / dt < 70) S.km += d / 1000;
  }
  if (fix.acc < 40) S.lastFix = fix;
  // Many phones (most Androids in Chrome) don't report speed, so work it out from the distance moved.
  // Movement smaller than the GPS accuracy is just jitter, so it counts as standing still.
  if (fix.speed == null && S.pos) {
    const dt = (fix.t - S.pos.t) / 1000, d = haversine(S.pos, fix);
    if (dt > 0.4) fix.speed = d < Math.max(fix.acc || 0, 5) ? 0 : d / dt;
  }
  const derivedDt = rawSpeed == null && S.pos ? (fix.t - S.pos.t) : 0;
  S.pos = fix;
  speedFeed(fix, rawSpeed != null ? rawSpeed : fix.speed);
  launchFeed(fix, rawSpeed != null ? rawSpeed : fix.speed, derivedDt);
  driveFeed(fix, rawSpeed != null ? rawSpeed : fix.speed);
  meetPresence(fix);
  sosFeed(fix);
  if (fix.acc < 50) {
    // Phones often report every 5–10 s, which at speed skips whole road squares.
    // Fill in the straight line between this reading and the last good one.
    const prev = S.lastRevealFix;
    let pts = [fix];
    if (prev) {
      const d = haversine(prev, fix), dt = (fix.t - prev.t) / 1000;
      if (d > 60 && d < 2500 && dt > 0 && dt < 90 && d / dt < 75) {
        const n = Math.ceil(d / 50);
        pts = Array.from({ length: n }, (_, i) => ({ lat: prev.lat + (fix.lat - prev.lat) * (i + 1) / n, lng: prev.lng + (fix.lng - prev.lng) * (i + 1) / n }));
      }
    }
    S.lastRevealFix = fix;
    let added = false;
    for (const p of pts) {
      const cell = ghEncode(p.lat, p.lng, CELL_PREC);
      if (!S.explored.has(cell)) { S.explored.add(cell); S.pendingCells.add(cell); added = true; }
    }
    if (added) {
      lsSet(`pendingCells:${S.uid}`, [...S.pendingCells].slice(-4000)); // survive the app being closed before saving
      if (S.fog) { S.fogLayer.redraw(); renderFogStat(); }
    }
  }
  renderMe();
  if (first) S.map.setView([fix.lat, fix.lng], 14);
  maybeSend();
  if (S.view === "convoy") renderDrive();
  renderConvoyOverlay();
}

function maybeSend(force = false) {
  if (!S.crew || !S.pos || S.ghost) return;
  if (nearHome()) {
    if (!S.homeHidden) {
      S.homeHidden = true; S.lastSent = null;
      S.store.updateMember(S.crew.id, S.uid, { ghost: true, lat: null, lng: null, speed: null, heading: null, updatedAt: Date.now() }).catch(() => { S.homeHidden = false; });
      renderGhost();
    }
    return;
  }
  if (S.homeHidden) { S.homeHidden = false; force = true; renderGhost(); }
  const now = Date.now(), last = S.lastSent;
  const moved = last ? haversine(last, S.pos) : Infinity;
  // during a speed session, send every 2 s so the crew can watch live
  const every = session ? 2000 : 4000, minMove = session ? 0 : 20;
  if (!force && last && !((now - last.t > every && moved >= minMove) || now - last.t > 45000)) return;
  S.lastSent = { lat: S.pos.lat, lng: S.pos.lng, t: now };
  S.store.updateMember(S.crew.id, S.uid, {
    lat: +S.pos.lat.toFixed(6), lng: +S.pos.lng.toFixed(6), acc: Math.round(S.pos.acc),
    speed: S.pos.speed != null ? +S.pos.speed.toFixed(1) : null, heading: S.pos.heading != null ? Math.round(S.pos.heading) : null,
    updatedAt: now, ghost: false,
  }).catch(() => { S.lastSent = null; });
}

async function flushExplored() {
  if (!S.crew) return;
  lsSet(`km:${S.uid}`, S.km);
  const me = S.members.get(S.uid);
  const cells = S.explored.size, km = Math.round(S.km);
  const stats = { ...myStats, cells, km };
  if (me && S.statsMerged && JSON.stringify(me.stats || {}) !== JSON.stringify(stats)) S.store.updateMember(S.crew.id, S.uid, { stats }).catch(() => {});
  if (!S.pendingCells.size) return;
  const by = {};
  for (const c of S.pendingCells) (by[c.slice(0, PREFIX_PREC)] ||= []).push(c);
  const sent = new Set(S.pendingCells);
  S.pendingCells.clear();
  try { await S.store.addExplored(S.uid, by); }
  catch { sent.forEach((c) => S.pendingCells.add(c)); }
  lsSet(`pendingCells:${S.uid}`, [...S.pendingCells]);
}
setInterval(flushExplored, 10000);
window.addEventListener("pagehide", () => flushExplored());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushExplored();
  else { maybeSend(true); updateWakeLock(); }
});

/* ---------------- ghost ---------------- */
function renderGhost() {
  const b = $("#btn-ghost");
  b.setAttribute("aria-pressed", S.ghost);
  $("#ghost-label").textContent = S.ghost ? "Ghost" : S.homeHidden ? "At home" : "Visible";
  $("#live-dot").classList.toggle("on", !S.ghost && !S.homeHidden);
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
  if (!["map", "convoy", "garage", "explore", "speed", "bass", "crew", "chat", "merch"].includes(v)) v = "map";
  if (S.view !== "chat") S.prevView = S.view;
  S.view = v; if (v !== "chat" && v !== "merch") lsSet("view", v);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === v));
  $("#btn-chat").setAttribute("aria-pressed", String(v === "chat"));
  for (const id of ["convoy", "garage", "explore", "speed", "bass", "crew", "chat", "merch"]) $(`#view-${id}`).hidden = id !== v;
  if (v === "merch") document.querySelector('.tab[data-view="crew"]').classList.add("active");
  if (v === "map") setTimeout(() => S.map.invalidateSize(), 30);
  renderActiveView();
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));
function renderActiveView() {
  if (S.view === "convoy") renderDrive();
  else if (S.view === "garage") renderGarage();
  else if (S.view === "explore") renderExplore();
  else if (S.view === "bass") renderBoard("bass");
  else if (S.view === "speed") { setSpeedMode(S.speedMode, true); renderLiveRunsCard(); }
  else if (S.view === "crew") renderCrew();
  else if (S.view === "chat") renderChat(true);
  else if (S.view === "merch") renderMerch();
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
  strip.onclick = () => { setView("convoy"); setSeg("convoys"); };
}
function showConvoyOnMap(c) {
  const pts = [[c.dest.lat, c.dest.lng], ...(c.memberIds || []).map(posOf).filter(Boolean).map((p) => [p.lat, p.lng])];
  if (pts.length === 1) S.map.flyTo(pts[0], 13); else S.map.flyToBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 15 });
}

async function updateWakeLock() {
  const want = (!!myConvoy() || !!session || (!!launch && launch.state !== "done")) && !document.hidden;
  try {
    if (want && !S.wakeLock && navigator.wakeLock) { S.wakeLock = await navigator.wakeLock.request("screen"); S.wakeLock.addEventListener("release", () => (S.wakeLock = null)); }
    if (!want && S.wakeLock) { await S.wakeLock.release(); S.wakeLock = null; }
  } catch {}
}

// convoy dialog
const dlgConvoy = $("#dlg-convoy");
function openConvoyDialog(keep) {
  if (!keep) { $("#form-convoy").reset(); S.pendingDest = null; }
  if (!keep) $("#in-convoy-search").value = "";
  $("#convoy-results").hidden = true;
  renderConvoyPicked();
  dlgConvoy.showModal();
}
function renderConvoyPicked() {
  const el = $("#convoy-dest-coords");
  el.classList.toggle("ok", !!S.pendingDest);
  el.textContent = S.pendingDest ? `✓ Destination set${$("#in-convoy-dest").value ? `: ${$("#in-convoy-dest").value}` : ""}` + (S.pos ? ` · ${fmtKm(haversine(S.pos, S.pendingDest))} from you` : "") : "No destination set yet.";
}
placeSearch($("#in-convoy-search"), $("#convoy-results"), (r) => { S.pendingDest = { lat: r.lat, lng: r.lng }; $("#in-convoy-dest").value = r.name.slice(0, 40); renderConvoyPicked(); });
$("#in-convoy-dest").addEventListener("input", renderConvoyPicked);
function startPick(mode, text) {
  setView("map");
  S.pick = mode;
  $("#pick-banner span").textContent = text;
  $("#pick-banner").hidden = false;
}
$("#btn-convoy-pick").addEventListener("click", () => { dlgConvoy.close(); startPick("convoy", "Tap the map to set the convoy destination"); });
$("#btn-pick-cancel").addEventListener("click", () => {
  const mode = S.pick;
  S.pick = false; $("#pick-banner").hidden = true;
  if (mode === "meet") openMeetDialog(true); else if (mode === "home") setView("crew"); else openConvoyDialog(true);
});
$("#btn-convoy-cancel").addEventListener("click", () => dlgConvoy.close());
$("#form-convoy").addEventListener("submit", async (e) => {
  e.preventDefault();
  const typedDest = $("#in-convoy-search").value.trim();
  if (!S.pendingDest && typedDest.length >= 3) {
    try { const [r] = await searchPlaces(typedDest); if (r) { S.pendingDest = { lat: r.lat, lng: r.lng }; if (!$("#in-convoy-dest").value) $("#in-convoy-dest").value = r.name.slice(0, 40); } } catch {}
  }
  if (!S.pendingDest) { renderConvoyPicked(); toast("Couldn't find that place. Pick one from the list, or drop a pin on the map."); return; }
  const name = $("#in-convoy-name").value.trim();
  if (!name) return;
  const cur = myConvoy();
  if (cur) await S.store.leaveConvoy(S.crew.id, cur.id, S.uid);
  await S.store.createConvoy(S.crew.id, {
    name, dest: { ...S.pendingDest, label: $("#in-convoy-dest").value.trim() }, leaderId: S.uid,
    memberIds: [S.uid], active: true, createdAt: Date.now(),
  });
    bumpStat("convoys");
  dlgConvoy.close();
  S.pendingDest = null;
  toast("Convoy started. The crew can join from the Meets tab.");
  setView("convoy"); setSeg("convoys");
});

/* ---------------- place search ---------------- */
// Free OpenStreetMap search (Nominatim), limited to South Africa and biased to where you are.
let lastSearchAt = 0, searchCtl = null;
async function searchPlaces(q) {
  const wait = 1000 - (Date.now() - lastSearchAt); // their rule: at most one search a second
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearchAt = Date.now();
  searchCtl?.abort();
  searchCtl = new AbortController();
  let url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=za&accept-language=en&q=${encodeURIComponent(q)}`;
  if (S.pos) url += `&viewbox=${S.pos.lng - 1.5},${S.pos.lat + 1.5},${S.pos.lng + 1.5},${S.pos.lat - 1.5}`;
  const res = await fetch(url, { signal: searchCtl.signal });
  if (!res.ok) throw new Error("search");
  return (await res.json()).map((r) => {
    const parts = (r.display_name || "").split(",").map((s) => s.trim());
    return { name: r.name || parts[0], sub: parts.slice(r.name ? 1 : 1, 4).join(", "), lat: +(+r.lat).toFixed(6), lng: +(+r.lon).toFixed(6) };
  });
}
// Wires a search box to a results list. onPick({name, sub, lat, lng}) runs when a result is tapped.
function placeSearch(input, list, onPick) {
  let timer = null;
  const show = (nodes) => { list.replaceChildren(...nodes); list.hidden = !nodes.length; };
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 3) { show([]); return; }
    show([h("div", { class: "msg" }, "Searching…")]);
    try {
      const results = await searchPlaces(q);
      if (input.value.trim() !== q) return;
      show(results.length ? results.map((r) => h("button", { type: "button", onclick: () => { show([]); input.value = r.name; onPick(r); } },
        h("b", {}, r.name), h("small", {}, [r.sub, S.pos ? fmtKm(haversine(S.pos, r)) + " away" : ""].filter(Boolean).join(" · "))))
        : [h("div", { class: "msg" }, "No places found. Try adding the suburb or town, or drop a pin on the map.")]);
    } catch (e) {
      if (e.name !== "AbortError") show([h("div", { class: "msg" }, "Search isn't working right now. Drop a pin on the map instead.")]);
    }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 650); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); run(); } });
}

/* ---------------- meets & events ---------------- */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtTime = (t) => new Date(t).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false });
function countdown(t) {
  const s = (t - Date.now()) / 1000;
  if (s < -3 * 3600) return "Finished";
  if (s < 0) return "Happening now";
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  return d ? `in ${d} d ${hh} h` : hh ? `in ${hh} h ${mm} min` : `in ${mm} min`;
}
function setSeg(seg) {
  S.seg = seg;
  $("#seg-meets").setAttribute("aria-selected", seg === "meets");
  $("#seg-convoys").setAttribute("aria-selected", seg === "convoys");
  $("#meets-body").hidden = seg !== "meets";
  $("#convoy-body").hidden = seg !== "convoys";
  renderDrive();
}
$("#seg-meets").addEventListener("click", () => setSeg("meets"));
$("#seg-convoys").addEventListener("click", () => setSeg("convoys"));
function renderDrive() { if (S.seg === "meets") renderMeets(); else renderConvoy(); }

function goingRow(m) {
  const ids = m.going || [];
  return h("div", { class: "going" }, ...ids.slice(0, 6).map((id) => avatar(id, id === S.uid ? S.profile.callsign : S.members.get(id)?.callsign)),
    h("span", {}, ids.length ? `${ids.length} going${ids.includes(S.uid) ? " · you're in" : ""}` : "Nobody yet"));
}
function renderMeets() {
  const body = $("#meets-body");
  const list = S.meets.filter((m) => m.when > Date.now() - 3 * 3600000);
  body.replaceChildren(
    h("button", { class: "btn primary wide", style: "margin-bottom:14px", onclick: () => openMeetDialog(false) }, "Post a meet"),
    list.length ? h("div", { class: "meets" }, ...list.map((m) => {
      const d = new Date(m.when), soon = m.when - Date.now() < 24 * 3600000;
      return h("button", { class: `meet${soon ? " soon" : ""}`, onclick: () => openMeetView(m.id) },
        h("div", { class: "cal" }, h("div", { class: "m" }, MONTHS[d.getMonth()]), h("div", { class: "d" }, String(d.getDate())), h("div", { class: "w" }, `${DAYS[d.getDay()]} ${fmtTime(m.when)}`)),
        h("div", { class: "grow" }, h("div", { class: "t" }, m.title),
          h("div", { class: "s" }, "📍 ", [m.place?.label || "Pinned on the map", S.pos && m.place ? fmtKm(haversine(S.pos, m.place)) + " away" : ""].filter(Boolean).join(" · ")),
          h("span", { class: "countdown" }, countdown(m.when)), goingRow(m)));
    })) : h("div", { class: "empty" }, h("div", { class: "big" }, "No meets planned"), h("p", {}, "Post one with a time and a pin. The crew can tap I'm in, and it shows on the map.")));
}

function renderMeetPins() {
  if (!S.meetLayer) return;
  S.meetLayer.clearLayers();
  for (const m of S.meets) {
    if (!m.place || m.when < Date.now() - 3 * 3600000) continue;
    const d = new Date(m.when);
    const html = `<div class="meet-pin"><div class="b">${esc(m.title)}<small>${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${fmtTime(m.when)} · ${(m.going || []).length} going</small></div><div class="tip"></div></div>`;
    L.marker([m.place.lat, m.place.lng], { icon: L.divIcon({ className: "", html, iconSize: [0, 0] }), zIndexOffset: 300 })
      .on("click", () => openMeetView(m.id)).addTo(S.meetLayer);
  }
}

const dlgMeetView = $("#dlg-meet-view");
$("#btn-meet-view-close").addEventListener("click", () => dlgMeetView.close());
function openMeetView(id) {
  const m = S.meets.find((x) => x.id === id);
  if (!m) return;
  S.openMeet = id;
  const going = (m.going || []).includes(S.uid), host = m.hostId === S.uid, d = new Date(m.when);
  const nav = m.place ? `${m.place.lat},${m.place.lng}` : "";
  $("#meet-view-body").replaceChildren(
    h("div", { class: "car-name", style: "font-size:28px" }, m.title),
    h("div", { class: "s", style: "color:var(--muted);margin:6px 0" }, `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} at ${fmtTime(m.when)}`, m.place?.label ? ` · ${m.place.label}` : ""),
    h("span", { class: "countdown" }, countdown(m.when)),
    m.notes ? h("p", { style: "margin:12px 0;white-space:pre-wrap" }, m.notes) : null,
    h("div", { class: "s", style: "color:var(--muted);margin-top:8px" }, `Posted by ${m.hostId === S.uid ? "you" : S.members.get(m.hostId)?.callsign || "a crew member"}`),
    goingRow(m),
    checkinBlock(m),
    h("div", { class: "btn-row", style: "margin-top:14px" },
      h("button", { class: `btn ${going ? "ghost" : "primary"} sm`, onclick: async () => { await S.store.rsvpMeet(S.crew.id, m.id, S.uid, !going); toast(going ? "You're out" : pushPrefs.meet !== false && S.pushOn ? "You're in! We'll remind you an hour before." : "You're in!"); dlgMeetView.close(); setTimeout(syncReminders, 500); } }, going ? "Can't make it" : "I'm in"),
      ...(nav ? [
        h("button", { class: "btn ghost sm", onclick: () => { dlgMeetView.close(); setView("map"); S.map.flyTo([m.place.lat, m.place.lng], 15); } }, "Show on map"),
        h("a", { class: "btn ghost sm", href: `https://www.google.com/maps/dir/?api=1&destination=${nav}`, target: "_blank", rel: "noopener" }, "Directions"),
        h("button", { class: "btn ghost sm", onclick: () => { dlgMeetView.close(); S.pendingDest = { lat: m.place.lat, lng: m.place.lng }; openConvoyDialog(true); $("#in-convoy-name").value = `Convoy to ${m.title}`; $("#in-convoy-dest").value = m.place.label || ""; renderConvoyPicked(); } }, "Start a convoy there"),
      ] : []),
      ...(host ? [h("button", { class: "btn ghost sm", onclick: () => { dlgMeetView.close(); openMeetDialog(false, m); } }, "Edit")] : [])));
  dlgMeetView.showModal();
}

const dlgMeet = $("#dlg-meet");
let meetDraft = { place: null, editing: null };
function openMeetDialog(keep, editMeet) {
  if (!keep) {
    $("#form-meet").reset();
    meetDraft = { place: editMeet?.place ? { lat: editMeet.place.lat, lng: editMeet.place.lng } : null, editing: editMeet || null };
    if (editMeet) {
      $("#in-meet-title").value = editMeet.title;
      const d = new Date(editMeet.when), pad = (n) => String(n).padStart(2, "0");
      $("#in-meet-when").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      $("#in-meet-place").value = editMeet.place?.label || "";
      $("#in-meet-notes").value = editMeet.notes || "";
    }
  }
  if (!keep && !editMeet) {
    const t = new Date(); t.setMinutes(0, 0, 0); t.setHours(t.getHours() < 17 ? 18 : t.getHours() + 2);
    const pad = (n) => String(n).padStart(2, "0");
    $("#in-meet-when").value = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:00`;
  }
  $("#meet-dlg-title").textContent = meetDraft.editing ? "Edit meet" : "Post a meet";
  $("#btn-meet-delete").hidden = !meetDraft.editing;
  $("#form-meet button[type=submit]").textContent = meetDraft.editing ? "Save" : "Post meet";
  renderMeetPicked();
  $("#meet-results").hidden = true;
  if (!keep) $("#in-meet-search").value = editMeet?.place?.label || "";
  dlgMeet.showModal();
}
function renderMeetPicked() {
  const el = $("#meet-pin-text");
  el.classList.toggle("ok", !!meetDraft.place);
  el.textContent = meetDraft.place ? `✓ Place set${$("#in-meet-place").value ? `: ${$("#in-meet-place").value}` : ""}` + (S.pos ? ` · ${fmtKm(haversine(S.pos, meetDraft.place))} from you` : "") : "No place picked yet.";
}
placeSearch($("#in-meet-search"), $("#meet-results"), (r) => { meetDraft.place = { lat: r.lat, lng: r.lng }; $("#in-meet-place").value = r.name.slice(0, 50); renderMeetPicked(); });
$("#btn-meet-here").addEventListener("click", () => {
  if (!S.pos) { toast("Waiting for GPS. Try again in a moment."); return; }
  meetDraft.place = { lat: +S.pos.lat.toFixed(6), lng: +S.pos.lng.toFixed(6) };
  if (!$("#in-meet-place").value) $("#in-meet-place").value = "Where I am now";
  renderMeetPicked();
});
$("#in-meet-place").addEventListener("input", renderMeetPicked);
$("#btn-meet-pick").addEventListener("click", () => { dlgMeet.close(); startPick("meet", "Tap the map where the meet is"); });
$("#btn-meet-cancel").addEventListener("click", () => dlgMeet.close());
$("#btn-meet-delete").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to cancel it"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Cancel meet"; }, 3000); return; }
  b.dataset.armed = ""; b.textContent = "Cancel meet";
  await S.store.deleteMeet(S.crew.id, meetDraft.editing.id);
  remindApi({ op: "cancel", meet: meetDraft.editing.id });
  dlgMeet.close();
  toast("Meet cancelled");
});
$("#form-meet").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#form-meet button[type=submit]");
  const when = new Date($("#in-meet-when").value).getTime();
  if (!when || isNaN(when)) { toast("Pick a date and time"); return; }
  if (when < Date.now() - 15 * 60000) { toast("That time has already passed. Pick a time in the future."); return; }
  // typed a place but never tapped a suggestion: use the best match
  const typed = $("#in-meet-search").value.trim();
  if (!meetDraft.place && typed.length >= 3) {
    btn.disabled = true; btn.textContent = "Finding place…";
    try {
      const [r] = await searchPlaces(typed);
      if (r) { meetDraft.place = { lat: r.lat, lng: r.lng }; if (!$("#in-meet-place").value) $("#in-meet-place").value = r.name.slice(0, 50); }
    } catch {}
    btn.disabled = false;
  }
  btn.textContent = meetDraft.editing ? "Save" : "Post meet";
  if (!meetDraft.place) { renderMeetPicked(); toast("Couldn't find that place. Pick one from the list, or drop a pin on the map."); return; }
  const data = { title: $("#in-meet-title").value.trim(), when, notes: $("#in-meet-notes").value.trim(), place: { ...meetDraft.place, label: $("#in-meet-place").value.trim() || typed } };
  if (!data.title) return;
  const editing = meetDraft.editing;
  if (editing) {
    await S.store.updateMeet(S.crew.id, editing.id, data);
    if (editing.when !== data.when || editing.title !== data.title) remindApi({ op: "meet", meet: editing.id, when: data.when, title: data.title, place: data.place.label || "" });
  }
  else {
    const id = await S.store.createMeet(S.crew.id, { ...data, hostId: S.uid, going: [S.uid], createdAt: Date.now() });
    const d = new Date(when);
    notifyCrew("meet", { title: `📅 New meet: ${data.title}`, body: `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${fmtTime(when)}${data.place.label ? ` · ${data.place.label}` : ""} · tap to see who's going`, url: `./?meet=${id}`, tag: `meet-${id}` });
  }
  dlgMeet.close();
  meetDraft = { place: null, editing: null };
  // show it where it landed
  setView("map");
  S.map.flyTo([data.place.lat, data.place.lng], 15, { duration: 0.8 });
  toast(editing ? "Meet updated" : `Meet posted at ${data.place.label || "the pin"}`);
});

/* ---------------- 360° spin view ---------------- */
const SPIN_FRAMES = 24;

// Frames already loaded, so a re-render never downloads a 360° view twice.
const spinCache = new Map();
function loadSpinFrames(uid, spinId, count) {
  const key = `${uid}/${spinId}`;
  if (!spinCache.has(key)) spinCache.set(key, Promise.all(Array.from({ length: count }, (_, i) => S.store.getMedia(uid, `${spinId}_${i}`)))
    .then((l) => l.filter(Boolean)).catch(() => { spinCache.delete(key); return []; }));
  return spinCache.get(key);
}

// Interactive viewer: drag to turn, slow auto-turn until someone touches it.
// `src` is either an array of image URLs, or {uid, spinId, count, thumb} stored in the database.
function spinViewer(src, alt) {
  let frames = Array.isArray(src) ? src : [];
  const img = h("img", { class: "car-photo spin-img", src: frames[0] || src.thumb || "", alt: `${alt}, 360° view`, draggable: "false" });
  const badge = h("span", { class: "spin-badge" }, frames.length ? "360°" : "Loading 360°…");
  const wrap = h("div", { class: "spin", title: "Drag to spin" }, img, badge);
  let idx = 0, startX = 0, startIdx = 0, dragging = false, timer = null, touched = false;
  const show = (i) => { if (!frames.length) return; idx = ((i % frames.length) + frames.length) % frames.length; img.src = frames[idx]; };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const startAuto = () => { if (!reduce && !touched && !timer) timer = setInterval(() => { if (!wrap.isConnected) return clearInterval(timer); if (!document.hidden) show(idx + 1); }, 130); };
  const stopAuto = () => { touched = true; if (timer) { clearInterval(timer); timer = null; } wrap.classList.add("touched"); };
  const ready = (list) => {
    frames = list;
    if (!frames.length) { badge.textContent = "360° unavailable"; return; }
    badge.textContent = "360°";
    frames.forEach((f) => { const p = new Image(); p.src = f; });
    startAuto();
  };
  if (Array.isArray(src)) ready(src); else loadSpinFrames(src.uid, src.spinId, src.count).then(ready);
  wrap.addEventListener("pointerdown", (e) => { dragging = true; startX = e.clientX; startIdx = idx; stopAuto(); wrap.setPointerCapture(e.pointerId); e.stopPropagation(); });
  wrap.addEventListener("pointermove", (e) => {
    if (!dragging || !frames.length) return;
    const step = Math.max(6, wrap.clientWidth / (frames.length * 1.2));
    show(startIdx - Math.round((e.clientX - startX) / step));
  });
  const end = (e) => { dragging = false; e.stopPropagation(); };
  wrap.addEventListener("pointerup", end);
  wrap.addEventListener("pointercancel", end);
  wrap.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); });
  return wrap;
}

const FRAME_MAX = 1000, FRAME_Q = 0.8;
const waitFor = (target, ev, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => { target.removeEventListener(ev, ok); rej(new Error(`timeout:${ev}`)); }, ms);
  function ok() { clearTimeout(t); res(); }
  target.addEventListener(ev, ok, { once: true });
});
const nextPaint = (video) => new Promise((res) => {
  if (video.requestVideoFrameCallback) { video.requestVideoFrameCallback(() => res()); setTimeout(res, 400); }
  else requestAnimationFrame(() => requestAnimationFrame(res));
});

// How dark is a frame? Phones that can't decode a video hand back pure black.
function isBlack(ctx, w, h) {
  const sw = 24, sh = 14, t = document.createElement("canvas");
  t.width = sw; t.height = sh;
  const tc = t.getContext("2d");
  tc.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, sw, sh);
  const d = tc.getImageData(0, 0, sw, sh).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
  return sum / (d.length / 4) / 3 < 10;
}

// Pull evenly spaced frames out of a walk-around video (or use picked photos in order).
async function framesFromFiles(files, onProgress, stage) {
  const list = [...files];
  if (list.length > 1 || (list[0] && list[0].type.startsWith("image/"))) {
    const imgs = list.filter((f) => f.type.startsWith("image/")).slice(0, 36);
    const out = [];
    for (const f of imgs) { out.push(await shrinkImage(f, FRAME_MAX, FRAME_Q)); onProgress?.(out.length, imgs.length); }
    return out;
  }
  const url = URL.createObjectURL(list[0]);
  const video = document.createElement("video");
  video.muted = true; video.defaultMuted = true; video.playsInline = true;
  video.setAttribute("playsinline", ""); video.setAttribute("webkit-playsinline", ""); video.setAttribute("muted", "");
  video.preload = "auto"; video.className = "spin-work";
  // phones only decode video that is really on screen, so show it while we work
  (stage || document.body).append(video);
  video.src = url;
  try {
    const failed = new Promise((_, rej) => video.addEventListener("error", () => rej(new Error("decode")), { once: true }));
    await Promise.race([waitFor(video, "loadeddata", 45000), failed]);
    const dur = video.duration;
    if (!isFinite(dur) || dur < 2) throw new Error("short");
    const w0 = video.videoWidth, h0 = video.videoHeight;
    if (!w0 || !h0) throw new Error("size");
    const s = Math.min(1, FRAME_MAX / Math.max(w0, h0));
    const c = document.createElement("canvas");
    c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const times = Array.from({ length: SPIN_FRAMES }, (_, i) => Math.min(dur - 0.1, (dur * i) / SPIN_FRAMES + 0.05));
    const grab = () => { ctx.drawImage(video, 0, 0, c.width, c.height); return isBlack(ctx, c.width, c.height) ? null : c.toDataURL("image/jpeg", FRAME_Q); };

    // Method 1: jump to each point in the video
    try { await video.play(); } catch {}
    video.pause();
    let out = [], black = 0;
    for (let i = 0; i < times.length; i++) {
      video.currentTime = times[i];
      try { await waitFor(video, "seeked", 12000); } catch {}
      await nextPaint(video);
      const f = grab();
      if (f) out.push(f); else black++;
      onProgress?.(i + 1, times.length);
      if (i === 3 && black >= 3) break; // this phone gives black frames when jumping; switch method
    }
    if (out.length >= SPIN_FRAMES * 0.75) return out;

    // Method 2: play the video through and grab frames as they go past
    out = [];
    video.currentTime = 0;
    try { await waitFor(video, "seeked", 8000); } catch {}
    video.playbackRate = dur > 20 ? 2 : 1;
    let next = 0;
    await new Promise((resolve) => {
      const tick = () => {
        if (next < times.length && video.currentTime >= times[next] - 0.04) {
          const f = grab();
          if (f) out.push(f);
          next++;
          onProgress?.(next, times.length);
        }
        if (next >= times.length || video.ended) return resolve();
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
      };
      video.addEventListener("ended", resolve, { once: true });
      video.play().then(tick).catch(resolve);
      setTimeout(resolve, (dur / video.playbackRate + 10) * 1000);
    });
    video.pause();
    if (out.length < 6) throw new Error("black");
    return out;
  } finally { URL.revokeObjectURL(url); video.removeAttribute("src"); video.load(); video.remove(); }
}

// A single frame must stay under the database's 1 MB per-document limit.
async function capSize(dataUrl, maxChars = 900000) {
  let out = dataUrl, q = FRAME_Q, max = FRAME_MAX;
  while (out.length > maxChars && q > 0.4) {
    q -= 0.12; max = Math.round(max * 0.9);
    out = await new Promise((res) => { const im = new Image(); im.onload = () => { const s = Math.min(1, max / Math.max(im.width, im.height)); const c = document.createElement("canvas"); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", q)); }; im.src = dataUrl; });
  }
  return out;
}

/* ---------------- mod log ---------------- */
const fmtR = (n) => "R" + Math.round(n || 0).toLocaleString("en-ZA");
const fmtDate = (s) => { const d = new Date(s + "T12:00"); return isNaN(d) ? s : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
// Next service due: the most recent service entry that set a date or km.
function serviceDue(v) {
  const s = [...(v.log || [])].filter((e) => e.type === "Service" && (e.nextDate || e.nextKm)).sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
  if (!s) return null;
  const lastOdo = Math.max(0, ...(v.log || []).map((e) => e.odo || 0));
  const days = s.nextDate ? Math.round((new Date(s.nextDate + "T12:00") - Date.now()) / 86400000) : null;
  const km = s.nextKm && lastOdo ? s.nextKm - lastOdo : null;
  const parts = [];
  if (days != null) parts.push(days < 0 ? `${-days} days overdue` : `in ${days} days`);
  if (km != null) parts.push(km < 0 ? `${(-km).toLocaleString("en-ZA")} km over` : `or ${km.toLocaleString("en-ZA")} km`);
  return { text: `Service due ${parts.join(" ")}`, warn: (days != null && days < 21) || (km != null && km < 1000) };
}
const dlgLog = $("#dlg-log");
let logCtx = null; // {v, owner, editable}
function openLog(v, owner, editable) {
  logCtx = { v, owner, editable };
  $("#form-log").hidden = true;
  $("#log-actions").hidden = false;
  $("#btn-log-add").hidden = !editable;
  renderLog();
  dlgLog.showModal();
}
function renderLog() {
  const { v, editable } = logCtx;
  const log = [...(v.log || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const sum = (t) => log.filter((e) => !t || e.type === t).reduce((n, e) => n + (e.cost || 0), 0);
  const due = serviceDue(v);
  const stat = (val, k) => h("div", { class: "stat" }, h("div", { class: "v", style: "font-size:22px" }, val), h("div", { class: "k" }, k));
  $("#log-body").replaceChildren(
    h("div", { class: "car-name" }, `${v.name} · Mod log`),
    h("div", { class: "s", style: "color:var(--muted)" }, [v.year, v.make, v.model].filter(Boolean).join(" ")),
    h("div", { class: "log-sum" }, stat(fmtR(sum("Mod")), "On mods"), stat(fmtR(sum()), "All in"), stat(String(log.length), "Entries")),
    due ? h("div", { class: `due${due.warn ? " warn" : ""}`, style: "margin-bottom:8px" }, due.text) : null,
    log.length ? h("ul", { class: "log-list" }, ...log.map((e) => h("li", {},
      h("span", { class: `log-type ${e.type}` }, e.type),
      h("div", { class: "grow" },
        h("div", { class: "n" }, e.title),
        h("div", { class: "s" }, [fmtDate(e.date), e.odo ? `${Number(e.odo).toLocaleString("en-ZA")} km` : "", e.notes].filter(Boolean).join(" · ")),
        e.type === "Service" && (e.nextDate || e.nextKm) ? h("div", { class: "s" }, `Next: ${[e.nextDate ? fmtDate(e.nextDate) : "", e.nextKm ? `${Number(e.nextKm).toLocaleString("en-ZA")} km` : ""].filter(Boolean).join(" or ")}`) : null,
        editable ? h("button", { class: "log-del", onclick: async () => { const nv = { ...v, log: (v.log || []).filter((x) => x.id !== e.id) }; await S.store.saveVehicle(S.uid, nv); logCtx.v = nv; renderLog(); } }, "Remove") : null),
      h("div", { class: "num" }, e.cost ? fmtR(e.cost) : "")))) : h("div", { class: "empty" }, h("div", { class: "big" }, "Nothing logged yet"), h("p", {}, editable ? "Add mods, services and repairs to keep a full history of the build." : "No entries yet.")));
}
$("#btn-log-close").addEventListener("click", () => dlgLog.close());
$("#btn-log-add").addEventListener("click", () => {
  $("#form-log").reset();
  $("#in-log-date").value = new Date().toISOString().slice(0, 10);
  $("#log-next-wrap").hidden = true;
  $("#form-log").hidden = false;
  $("#log-actions").hidden = true;
  $("#in-log-title").focus();
});
$("#in-log-type").addEventListener("change", (e) => { $("#log-next-wrap").hidden = e.target.value !== "Service"; });
$("#btn-log-form-cancel").addEventListener("click", () => { $("#form-log").hidden = true; $("#log-actions").hidden = false; });
$("#form-log").addEventListener("submit", async (e) => {
  e.preventDefault();
  const num = (sel) => { const n = parseFloat($(sel).value.replace(/[^\d.]/g, "")); return isFinite(n) ? n : null; };
  const entry = {
    id: `l${Date.now().toString(36)}`, type: $("#in-log-type").value, date: $("#in-log-date").value, title: $("#in-log-title").value.trim(),
    cost: num("#in-log-cost"), odo: num("#in-log-odo"), notes: $("#in-log-notes").value.trim(),
    ...($("#in-log-type").value === "Service" ? { nextDate: $("#in-log-next-date").value || null, nextKm: num("#in-log-next-km") } : {}),
  };
  if (!entry.title) return;
  const nv = { ...logCtx.v, log: [...(logCtx.v.log || []), entry].slice(-200) };
  await S.store.saveVehicle(S.uid, nv);
  logCtx.v = nv;
  if (entry.type === "Mod") notifyCrew("mod", { title: `🔧 ${S.profile.callsign} added a mod`, body: `${entry.title} · ${nv.name}${entry.cost ? ` · ${fmtR(entry.cost)}` : ""}`, url: `./?member=${S.uid}`, tag: `mod-${S.uid}` });
  $("#form-log").hidden = true; $("#log-actions").hidden = false;
  renderLog();
  toast("Added to the log");
});

/* ---------------- garage ---------------- */
function carCard(v, onclick, owner = S.uid) {
  const photo = v.spinId ? spinViewer({ uid: owner, spinId: v.spinId, count: v.spinCount, thumb: v.spinThumb }, v.name)
    : v.spin?.length ? spinViewer(v.spin, v.name)
    : v.photo ? h("img", { class: "car-photo", src: v.photo, alt: v.name }) : h("div", { class: "car-photo" }, initial(v.name));
  const spec = [v.year, v.make, v.model].filter(Boolean).join(" ");
  const extra = [v.colour, v.engine, v.power ? `${v.power} kW` : ""].filter(Boolean).join(" · ");
  return h("div", { class: `car${onclick ? " editable" : ""}`, onclick, role: onclick ? "button" : null, tabindex: onclick ? "0" : null,
    onkeydown: onclick ? (e) => { if (e.key === "Enter") onclick(); } : null },
    photo,
    h("div", { class: "car-body" },
      h("div", { class: "car-name" }, v.name, v.active ? h("span", { class: "badge" }, "Driving") : null),
      spec ? h("div", { class: "car-spec" }, spec) : null,
      extra ? h("div", { class: "car-spec" }, extra) : null,
      v.mods?.length ? h("div", { class: "mods" }, v.mods.map((m) => h("span", {}, m))) : null,
      ...(() => { const due = owner === S.uid ? serviceDue(v) : null; return due ? [h("div", { class: `due${due.warn ? " warn" : ""}` }, due.text)] : []; })(),
      h("button", { class: "btn ghost sm log-btn", onclick: (e) => { e.stopPropagation(); openLog(v, owner, owner === S.uid); } }, `Mod log${v.log?.length ? ` (${v.log.length})` : ""}`)));
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
let editing = null, photoData = "", spinNew = null, spinRemoved = false;
function openCar(v) {
  editing = v || null;
  photoData = v?.photo || "";
  spinNew = null; spinRemoved = false;
  renderSpinEdit();
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
  try { photoData = await capSize(await shrinkImage(f, 1400, 0.82), 700000); const img = $("#car-photo-preview"); img.src = photoData; img.hidden = false; }
  catch { toast("Couldn't read that photo. Try a JPG or PNG."); }
});
function currentSpin() {
  if (spinNew) return spinNew;
  if (spinRemoved || !editing) return null;
  if (editing.spinId) return { uid: S.uid, spinId: editing.spinId, count: editing.spinCount, thumb: editing.spinThumb };
  return editing.spin?.length ? editing.spin : null;
}
function renderSpinEdit(status) {
  const box = $("#spin-edit");
  const cur = currentSpin();
  const n = Array.isArray(cur) ? cur.length : cur?.count;
  box.replaceChildren(
    h("div", { class: "lbl" }, "360° view"),
    ...(cur ? [spinViewer(cur, "Preview")] : []),
    h("div", { class: "fine" }, status || (cur ? `${n} angles. Drag the preview to check it.` : "Record a 15–30 second video walking slowly around the car, keeping it in the middle of the screen.")),
    h("div", { class: "btn-row" },
      h("label", { class: "btn ghost sm", for: "in-car-spin" }, cur ? "Record again" : "Record 360° video"),
      ...(cur ? [h("button", { type: "button", class: "btn danger sm", onclick: () => { spinNew = null; spinRemoved = true; renderSpinEdit(); } }, "Remove")] : [])));
}
$("#in-car-spin").addEventListener("change", async (e) => {
  const files = e.target.files;
  if (!files?.length) return;
  const saveBtn = $("#form-car button[type=submit]");
  saveBtn.disabled = true;
  try {
    renderSpinEdit("Making your 360° view… keep this screen open.");
    const stage = h("div", { class: "spin-stage" });
    $("#spin-edit .lbl").after(stage);
    const frames = await framesFromFiles(files, (n, t) => { const f = $("#spin-edit .fine"); if (f) f.textContent = `Making your 360° view… ${n}/${t}. Keep this screen open.`; }, stage);
    if (frames.length < 6) throw new Error("few");
    spinNew = await Promise.all(frames.map((f) => capSize(f)));
    renderSpinEdit();
    toast("360° view ready. Tap Save to keep it.");
  } catch (err) {
    console.warn("360 failed", err);
    renderSpinEdit(String(err?.message) === "black"
      ? "Your phone only gave black frames from that video. On iPhone: Settings → Camera → Record Video → turn off HDR Video, then record again. Or pick 12–24 photos taken around the car instead."
      : "Couldn't read that video on this phone. Record it again in the normal Camera app at 1080p (not 4K, HDR or Cinematic), or pick 12–24 photos taken around the car.");
  } finally { saveBtn.disabled = false; e.target.value = ""; }
});
async function deleteSpinFrames(spinId, count) {
  if (!spinId) return;
  for (let i = 0; i < (count || SPIN_FRAMES); i++) await S.store.deleteMedia(S.uid, `${spinId}_${i}`).catch(() => {});
}
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
    active: $("#in-car-active").checked, photo: photoData, log: editing?.log || [],
  };
  if (!v.name) return;
  const saveBtn = $("#form-car button[type=submit]");
  const old = editing ? { spinId: editing.spinId, count: editing.spinCount } : {};
  saveBtn.disabled = true;
  try {
    if (spinNew) {
      const spinId = `s${Date.now().toString(36)}`;
      for (let i = 0; i < spinNew.length; i++) {
        saveBtn.textContent = `Uploading 360° ${i + 1}/${spinNew.length}`;
        await S.store.saveMedia(S.uid, `${spinId}_${i}`, spinNew[i]);
      }
      Object.assign(v, { spinId, spinCount: spinNew.length, spinThumb: await capSize(await new Promise((res) => { const im = new Image(); im.onload = () => { const s = Math.min(1, 480 / Math.max(im.width, im.height)); const c = document.createElement("canvas"); c.width = Math.round(im.width * s); c.height = Math.round(im.height * s); c.getContext("2d").drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", 0.7)); }; im.src = spinNew[0]; }), 120000) });
      spinCache.set(`${S.uid}/${spinId}`, Promise.resolve(spinNew));
    } else if (!spinRemoved && editing) {
      if (editing.spinId) Object.assign(v, { spinId: editing.spinId, spinCount: editing.spinCount, spinThumb: editing.spinThumb || "" });
      else if (editing.spin?.length) v.spin = editing.spin;
    }
    saveBtn.textContent = "Saving…";
    if (v.active) for (const o of S.myVehicles) if (o.id !== v.id && o.active) await S.store.saveVehicle(S.uid, { ...o, active: false });
    await S.store.saveVehicle(S.uid, v);
    if ((spinNew || spinRemoved) && old.spinId) deleteSpinFrames(old.spinId, old.count);
    dlgCar.close();
    toast(`${v.name} saved`);
  } catch (err) {
    console.warn("save failed", err);
    toast("Couldn't save. Check your signal and try again.");
  } finally { saveBtn.disabled = false; saveBtn.textContent = "Save"; }
});
$("#btn-car-delete").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to delete"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Delete"; }, 3000); return; }
  b.dataset.armed = ""; b.textContent = "Delete";
  await S.store.deleteVehicle(S.uid, editing.id);
  deleteSpinFrames(editing.spinId, editing.spinCount);
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
  renderRanking();
  renderBadges();
  renderDrives();
  const area = (cells) => cells * cellAreaKm2(S.pos?.lat ?? -26);
  const fmtArea = (v) => (v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString("en-ZA"));
  const stat = (v, k) => h("div", { class: "stat" }, h("div", { class: "v" }, v), h("div", { class: "k" }, k));
  $("#explore-stats").replaceChildren(
    stat(fmtArea(area(S.explored.size)), "km² revealed"),
    stat(S.explored.size.toLocaleString("en-ZA"), "Road tiles"),
    stat(Math.round(S.km).toLocaleString("en-ZA"), "km driven"));
  const rows = [...S.members.values()].map((m) => {
    const me = m.id === S.uid;
    return { id: m.id, cells: me ? S.explored.size : m.stats?.cells || 0, km: me ? Math.round(S.km) : m.stats?.km || 0 };
  }).filter((r) => r.cells > 0).sort((a, b) => b.cells - a.cells);

  const podium = $("#explore-podium");
  if (!rows.length) {
    podium.replaceChildren(h("div", { class: "empty" }, h("div", { class: "big" }, "Nobody's explored yet"), h("p", {}, "Drive with THE CREW open and the roads you cover count toward the board.")));
  } else {
    const spot = (r, i) => r ? h("div", { class: `pod p${i + 1}` },
      h("div", { class: `medal ${MEDALS[i]}`, "aria-label": `${["1st", "2nd", "3rd"][i]} place` }, String(i + 1)),
      avatar(r.id, boardName(r.id)),
      h("div", { class: "pod-name" }, boardName(r.id)),
      h("span", { class: "pod-val" }, fmtArea(area(r.cells)), h("small", {}, "km²")),
      h("div", { class: "pod-car" }, `${r.km.toLocaleString("en-ZA")} km driven`),
      h("div", { class: "plinth" }, h("span", {}, String(i + 1)))) : h("div", { class: `pod p${i + 1} vacant` }, h("div", { class: "plinth" }, h("span", {}, String(i + 1))));
    podium.replaceChildren(h("div", { class: "podium" }, spot(rows[1], 1), spot(rows[0], 0), spot(rows[2], 2)));
  }
  const rest = rows.slice(3);
  $("#explore-rest-h").hidden = !rest.length;
  const ol = $("#explore-board");
  ol.style.counterReset = "b 3";
  ol.replaceChildren(...rest.map((r) => h("li", {}, avatar(r.id, boardName(r.id)),
    h("div", { class: "grow" }, h("div", { class: "n" }, boardName(r.id)), h("div", { class: "s" }, `${r.km.toLocaleString("en-ZA")} km driven`)),
    h("div", { class: "num" }, h("span", { class: "dbv" }, fmtArea(area(r.cells)), h("small", {}, "km²"))))));
}
$("#btn-showfog").addEventListener("click", () => { setView("map"); if (!S.fog) $("#btn-fog").click(); });

/* ---------------- leaderboards (bass + top speed) ---------------- */
const BOARDS = {
  bass: {
    coll: "bass", field: "db", unit: "dB", dec: 1, min: 60, max: 200,
    classes: ["Daily", "Street", "Extreme"], best: "Loudest", noun: "score",
    line: (b) => [b.car, b.hz ? `${b.hz} Hz` : "", b.venue],
    sub: (b) => [b.car, b.setup],
    extra: (b) => b.setup,
    empty: "Do a sound test, then tap Log a score to put the first number on the board.",
    badInput: "Enter the dB reading from the meter, e.g. 142.6",
    read: () => ({ hz: (v => (v > 0 && v < 1000 ? Math.round(v) : null))(parseFloat($("#in-bass-hz").value.replace(",", "."))), setup: $("#in-bass-setup").value.trim() }),
  },
  speed: {
    coll: "speed", field: "kmh", unit: "km/h", dec: 0, min: 20, max: 450,
    classes: ["Track", "Drag strip", "Airfield", "Road"], best: "Fastest", noun: "run",
    line: (b) => [b.car, b.method, b.venue],
    sub: (b) => [b.car, b.venue],
    extra: () => "",
    empty: "Start a speed session before a run and your top speed lands here automatically, or log one manually with a photo as proof.",
    badInput: "Enter the top speed in km/h, e.g. 212",
    read: () => ({ method: $("#in-speed-method").value }),
  },
  t60: {
    coll: "launch", field: "t60", unit: "s", dec: 2, asc: true, manual: false,
    classes: ["Drag strip", "Track", "Airfield", "Road"], best: "Quickest", noun: "0–60 run",
    line: (b) => [b.car, b.t100 ? `0–100 ${b.t100.toFixed(2)} s` : "", b.venue],
    sub: (b) => [b.car, b.venue],
    extra: () => "",
    empty: "Arm the launch timer above, come to a dead stop and launch. Your 0–60 time lands here automatically.",
  },
  t100: {
    coll: "launch", field: "t100", unit: "s", dec: 2, asc: true, manual: false,
    classes: ["Drag strip", "Track", "Airfield", "Road"], best: "Quickest", noun: "0–100 run",
    line: (b) => [b.car, b.qm ? `¼ mile ${b.qm.toFixed(2)} s` : "", b.venue],
    sub: (b) => [b.car, b.venue],
    extra: () => "",
    empty: "Arm the launch timer above, come to a dead stop and launch. Your 0–100 time lands here automatically.",
  },
  qm: {
    coll: "launch", field: "qm", unit: "s", dec: 2, asc: true, manual: false,
    classes: ["Drag strip", "Track", "Airfield", "Road"], best: "Quickest", noun: "¼ mile run",
    line: (b) => [b.car, b.trap ? `${b.trap} km/h trap` : "", b.venue],
    sub: (b) => [b.car, b.trap ? `${b.trap} km/h trap` : ""],
    extra: () => "",
    empty: "Arm the launch timer and run the full 402 m. Your time and trap speed land here automatically.",
  },
};
const BOARD_TITLE = { bass: "Bass", speed: "Top speed", t60: "0–60 km/h", t100: "0–100 km/h", qm: "Quarter mile" };
const boardName = (uid) => (uid === S.uid ? `${S.profile.callsign} (you)` : S.members.get(uid)?.callsign || "Ex-member");
const valText = (cfg, n, cls = "dbv") => h("span", { class: cls }, Number(n).toFixed(cfg.dec), h("small", {}, cfg.unit));
const MEDALS = ["gold", "silver", "bronze"];

function renderBoard(key) {
  const cfg = BOARDS[key], cur = S.boardClass[key];
  const weekly = key !== "bass" && S.period === "week";
  const ws = weekStart();
  const runs = (S.boards[key] || []).filter((b) => b[cfg.field] != null && (cur === "All" || b.cls === cur) && (!weekly || b.createdAt >= ws));
  const better = (x, y) => (cfg.asc ? x < y : x > y);
  if (key !== "bass") renderPeriod(key, cur);
  $(`#${key}-classes`).replaceChildren(...["All", ...cfg.classes].map((c) => h("button", { "aria-pressed": String(cur === c), onclick: () => { S.boardClass[key] = c; renderBoard(key); } }, c)));

  // each person's best
  const best = new Map();
  for (const b of runs) { const p = best.get(b.uid); if (!p || better(b[cfg.field], p[cfg.field])) best.set(b.uid, b); }
  const board = [...best.values()].sort((a, b) => (cfg.asc ? a[cfg.field] - b[cfg.field] : b[cfg.field] - a[cfg.field]));

  // podium: 2nd · 1st · 3rd
  const podium = $(`#${key}-podium`);
  if (!board.length) {
    podium.replaceChildren(h("div", { class: "empty" }, h("div", { class: "big" }, weekly ? `No ${cfg.noun}s this week` : `No ${cfg.noun}s yet`),
      h("p", {}, weekly ? `The weekly board resets every Monday at midnight. Get the first ${cfg.noun} in and own the week.` : cur === "All" ? cfg.empty : `Nobody has logged a ${cur} ${cfg.noun} yet.`)));
  } else {
    const spot = (b, i) => b ? h("div", { class: `pod p${i + 1}` },
      h("div", { class: `medal ${MEDALS[i]}`, "aria-label": `${["1st", "2nd", "3rd"][i]} place` }, String(i + 1)),
      avatar(b.uid, boardName(b.uid)),
      h("div", { class: "pod-name" }, boardName(b.uid)),
      valText(cfg, b[cfg.field], "pod-val"),
      h("div", { class: "pod-car" }, b.car || b.cls),
      (b.witnesses || []).length ? h("div", { class: "seen" }, `${b.witnesses.length} saw it`) : null,
      h("div", { class: "plinth" }, h("span", {}, String(i + 1)))) : h("div", { class: `pod p${i + 1} vacant` }, h("div", { class: "plinth" }, h("span", {}, String(i + 1))));
    podium.replaceChildren(h("div", { class: "podium" }, spot(board[1], 1), spot(board[0], 0), spot(board[2], 2)));
  }

  // 4th place and down
  const rest = board.slice(3);
  $(`#${key}-rest-h`).hidden = !rest.length;
  const ol = $(`#${key}-board`);
  ol.setAttribute("start", "4");
  ol.style.counterReset = "b 3";
  ol.replaceChildren(...rest.map((b) => h("li", {}, avatar(b.uid, boardName(b.uid)),
    h("div", { class: "grow" }, h("div", { class: "n" }, boardName(b.uid), h("span", { class: "cls" }, b.cls)),
      h("div", { class: "s" }, cfg.sub(b).filter(Boolean).join(" · ") || "—")),
    h("div", { class: "num" }, valText(cfg, b[cfg.field]), h("div", { class: "seen", style: "margin-top:5px" }, (b.witnesses || []).length ? `${b.witnesses.length} saw it` : "")))));

  // every run, newest first
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  $(`#${key}-runs-h`).hidden = !sorted.length;
  $(`#${key}-runs`).replaceChildren(...sorted.map((b) => {
    const mine = b.uid === S.uid;
    const seen = (b.witnesses || []).includes(S.uid);
    const names = (b.witnesses || []).map((w) => (w === S.uid ? "you" : S.members.get(w)?.callsign)).filter(Boolean);
    const acts = h("div", { class: "acts" });
    if (!mine && !seen) acts.append(h("button", { class: "btn ghost", onclick: () => S.store.witnessBoard(S.crew.id, cfg.coll, b.id, S.uid).then(() => toast("Marked as witnessed")) }, "I saw it"));
    if (mine) acts.append(h("button", { class: "btn danger", onclick: (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = "Tap again to delete"; setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Delete"; }, 3000); return; }
      S.store.deleteBoard(S.crew.id, cfg.coll, b.id).then(() => toast("Deleted"));
    } }, "Delete"));
    const ex = cfg.extra(b);
    return h("li", {},
      b.photo ? h("img", { class: "thumb", src: b.photo, alt: "Proof photo", onclick: () => showPhoto(cfg, b) }) : h("div", { class: "thumb" }, "No pic"),
      h("div", { class: "grow" },
        h("div", { class: "n" }, boardName(b.uid), h("span", { class: "cls" }, b.cls)),
        h("div", { class: "s" }, cfg.line(b).filter(Boolean).join(" · ")),
        h("div", { class: "s" }, fmtAgo(b.createdAt), ex ? ` · ${ex}` : ""),
        names.length ? h("div", { class: "seen" }, `Seen by ${names.join(", ")}`) : null,
        acts.childNodes.length ? acts : null),
      h("div", { class: "num" }, valText(cfg, b[cfg.field])));
  }));
}

function showPhoto(cfg, b) {
  $("#member-body").replaceChildren(
    h("div", { class: "car-name", style: "margin-bottom:10px" }, `${boardName(b.uid)} · ${Number(b[cfg.field]).toFixed(cfg.dec)} ${cfg.unit}`),
    h("img", { class: "photo-big", src: b.photo, alt: "Proof photo" }));
  dlgMember.showModal();
}

for (const key of Object.keys(BOARDS)) {
  const cfg = BOARDS[key];
  if (cfg.manual === false) continue;
  const dlg = $(`#dlg-${key}`);
  let photo = "";
  $(`#btn-add${key}`).addEventListener("click", () => {
    $(`#form-${key}`).reset();
    photo = "";
    $(`#${key}-photo-preview`).hidden = true;
    const active = S.myVehicles.find((v) => v.active);
    if (active) $(`#in-${key}-car`).value = active.name;
    if (S.boardClass[key] !== "All") $(`#in-${key}-class`).value = S.boardClass[key];
    dlg.showModal();
  });
  $(`#btn-${key}-cancel`).addEventListener("click", () => dlg.close());
  $(`#in-${key}-photo`).addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try { photo = await capSize(await shrinkImage(f, 1200, 0.8), 700000); const img = $(`#${key}-photo-preview`); img.src = photo; img.hidden = false; }
    catch { toast("Couldn't read that photo. Try a JPG or PNG."); }
  });
  $(`#form-${key}`).addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = parseFloat($(`#in-${key}-val`).value.replace(",", "."));
    if (!(v > cfg.min && v < cfg.max)) { toast(cfg.badInput); return; }
    const val = cfg.dec ? Math.round(v * 10) / 10 : Math.round(v);
    try {
      await S.store.addBoard(S.crew.id, cfg.coll, {
        uid: S.uid, [cfg.field]: val, cls: $(`#in-${key}-class`).value, car: $(`#in-${key}-car`).value.trim(),
        venue: $(`#in-${key}-venue`).value.trim(), photo, witnesses: [], createdAt: Date.now(), ...cfg.read(),
      });
      dlg.close();
      const txt = `${val.toFixed(cfg.dec)} ${cfg.unit}`;
      toast(claimRecord(key, val, $(`#in-${key}-car`).value.trim()) ? `${txt}. That's the new crew record!` : `${txt} logged`);
    } catch { toast("Couldn't save. The photo might be too big; try another one."); }
  });
}

/* ---------------- weekly speed boards ---------------- */
// Speed boards default to this week (Monday 00:00 to Sunday night) so everyone gets a fresh shot every week.
function weekStart(off = 0) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + off * 7); return d.getTime(); }
function renderPeriod(key, cls) {
  const box = $("#speed-period");
  if (!box) return;
  const cfg = BOARDS[key];
  const prev = (S.boards[key] || []).filter((b) => b[cfg.field] != null && (cls === "All" || b.cls === cls) && b.createdAt >= weekStart(-1) && b.createdAt < weekStart());
  const champ = prev.length ? prev.reduce((a, b) => ((cfg.asc ? b[cfg.field] < a[cfg.field] : b[cfg.field] > a[cfg.field]) ? b : a)) : null;
  const left = Math.ceil((weekStart(1) - Date.now()) / 86400000);
  fill(box,
    h("div", { class: "chips" }, ...[["week", "This week"], ["all", "All time"]].map(([p, label]) => h("button", { "aria-pressed": String(S.period === p), onclick: () => { S.period = p; lsSet("speedPeriod", p); renderBoard(key); } }, label))),
    S.period === "week" ? h("div", { class: "week-line" },
      h("span", {}, `Resets ${left <= 1 ? "tonight at midnight" : `Monday 00:00 · ${left} days left`}`),
      champ ? h("span", {}, "Last week: ", h("b", {}, `🏆 ${boardName(champ.uid)} ${Number(champ[cfg.field]).toFixed(cfg.dec)} ${cfg.unit}`)) : null) : null);
}

/* ---------------- watch a live speed run ---------------- */
// A run counts as live while its sender has updated in the last 30 seconds.
const runSeen = new Map(); // member id -> { key, at: local time we last saw their run change }
function noteRuns(list) {
  for (const m of list) {
    if (!m.run) { runSeen.delete(m.id); continue; }
    const key = `${m.run.start}|${m.run.at}|${m.run.now}`;
    const prev = runSeen.get(m.id);
    if (!prev || prev.key !== key) runSeen.set(m.id, { key, at: Date.now() });
  }
}
const isLiveRun = (m) => m.id !== S.uid && !!m.run && !m.ghost && Date.now() - (runSeen.get(m.id)?.at || 0) < 45000;
const liveRuns = () => [...S.members.values()].filter(isLiveRun);
let watchId = null, watchTrail = null, seenRuns = new Set();

function renderLiveStrip() {
  const strip = $("#live-strip");
  const runs = liveRuns();
  // tell people once when someone goes live
  for (const m of runs) if (!seenRuns.has(m.id + m.run.start)) { seenRuns.add(m.id + m.run.start); if (watchId !== m.id) toast(`🔴 ${m.callsign} is live on a speed run${m.run.venue ? ` at ${m.run.venue}` : ""}`); }
  const w = watchId && S.members.get(watchId);
  if (w && isLiveRun(w)) {
    const mins = Math.floor((Date.now() - w.run.start) / 60000);
    strip.className = "live-strip watching";
    strip.replaceChildren(
      h("div", { class: "lv-top" }, h("span", { class: "recdot" }), h("b", {}, `${w.callsign} · LIVE`), h("span", { class: "lv-where" }, [w.run.venue || w.run.cls, w.run.car, `${mins} min`].filter(Boolean).join(" · "))),
      h("div", { class: "lv-gauge" },
        w.lat == null ? h("div", { class: "lv-where", style: "font-size:14px" }, "Waiting for their GPS…") : h("div", { class: "lv-now" }, String(kmh(w.run.now ?? w.speed)), h("small", {}, "km/h")),
        h("div", { class: "lv-top-speed" }, h("b", {}, String(kmh(w.run.top))), "top")),
      h("button", { class: "btn ghost sm", onclick: stopWatching }, "Stop watching"));
    strip.hidden = false;
    return;
  }
  if (watchId) stopWatching(true);
  if (!runs.length) { strip.hidden = true; return; }
  const m = runs[0];
  strip.className = "live-strip";
  strip.replaceChildren(
    h("span", { class: "recdot" }),
    h("div", { class: "grow" }, h("b", {}, `${m.callsign} is live`), h("div", { class: "lv-where" }, `${kmh(m.run.now ?? m.speed)} km/h · top ${kmh(m.run.top)}${m.run.venue ? ` · ${m.run.venue}` : ""}${runs.length > 1 ? ` · +${runs.length - 1} more` : ""}`)),
    h("button", { class: "btn primary sm", onclick: () => watchRun(m.id) }, "Watch"));
  strip.hidden = false;
}
function watchRun(id) {
  watchId = id;
  setView("map");
  const m = S.members.get(id);
  if (watchTrail) S.map.removeLayer(watchTrail);
  watchTrail = L.polyline(m && m.lat != null ? [[m.lat, m.lng]] : [], { color: "#ff5d5d", weight: 4, opacity: 0.85, interactive: false }).addTo(S.map);
  if (m && m.lat != null) S.map.flyTo([m.lat, m.lng], 15, { duration: 0.6 });
  renderLiveStrip();
}
function stopWatching(ended) {
  if (ended && watchId) { const m = S.members.get(watchId); toast(`${m?.callsign || "Their"} run ended${m?.run?.top ? "" : ""}`); }
  watchId = null;
  if (watchTrail) { S.map.removeLayer(watchTrail); watchTrail = null; }
  renderLiveStrip();
}
// called on every crew update
function followWatched() {
  const m = watchId && S.members.get(watchId);
  if (!m || !isLiveRun(m) || m.lat == null || !watchTrail) return;
  const ll = [m.lat, m.lng];
  const pts = watchTrail.getLatLngs();
  const last = pts[pts.length - 1];
  if (!last || last.lat !== m.lat || last.lng !== m.lng) watchTrail.addLatLng(ll);
  if (!S.map.getBounds().pad(-0.25).contains(ll)) S.map.panTo(ll, { animate: true, duration: 0.5 });
}

function renderLiveRunsCard() {
  const box = $("#speed-live");
  if (!box) return;
  const runs = liveRuns();
  box.hidden = !runs.length;
  box.replaceChildren(...(runs.length ? [h("div", { class: "lbl", style: "margin-bottom:8px" }, "Live now"), ...runs.map((m) => h("div", { class: "live-card" },
    h("span", { class: "recdot" }),
    h("div", { class: "grow" }, h("div", { class: "n" }, m.callsign), h("div", { class: "s" }, [m.run.venue || m.run.cls, m.run.car, `top ${kmh(m.run.top)} km/h`].filter(Boolean).join(" · "))),
    h("div", { class: "num" }, h("span", { class: "dbv" }, String(kmh(m.run.now ?? m.speed)), h("small", {}, "km/h"))),
    h("button", { class: "btn primary sm", onclick: () => watchRun(m.id) }, "Watch")))] : []));
}

/* ---------------- automatic top speed (GPS speed session) ---------------- */
// A run only counts when the speed holds across 3 clean GPS readings in a row,
// so one-off GPS spikes never reach the board.
const SESSION_MAX_MS = 3 * 60 * 60 * 1000;
let session = lsGet("speedSession", null);
let recent = []; // last clean samples [{t, v}]
if (session && Date.now() - session.start > SESSION_MAX_MS) session = null;

function speedFeed(fix, raw) {
  if (!session) return;
  if (Date.now() - session.start > SESSION_MAX_MS) { endSession(); return; }
  const v = raw;
  session.now = v != null ? v : 0;
  if (v == null || fix.acc > 20 || v < 0 || v > 125) { recent = []; renderSession(); return; }
  const prev = recent[recent.length - 1];
  if (prev) {
    const dt = (fix.t - prev.t) / 1000;
    if (dt <= 0) return;
    if (dt > 5 || Math.abs(v - prev.v) / dt > 15) recent = []; // gap in signal or impossible jump: start over
  }
  recent.push({ t: fix.t, v });
  if (recent.length > 3) recent.shift();
  if (recent.length === 3) {
    const held = Math.min(...recent.map((r) => r.v));
    if (held > session.top) { session.top = held; lsSet("speedSession", session); }
  }
  renderSession();
}

// While a session runs, tell the crew every 2.5 s, moving or not, GPS or not.
let runStatus = { state: "idle" };
async function sendRun() {
  if (!session || !S.crew) return;
  if (S.ghost) { runStatus = { state: "ghost" }; renderSession(); return; }
  if (S.homeHidden) { runStatus = { state: "home" }; renderSession(); return; }
  const now = Date.now();
  const data = { run: { start: session.start, cls: session.cls, venue: session.venue, car: session.car, now: +(session.now || 0).toFixed(1), top: +(session.top || 0).toFixed(1), at: now } };
  if (S.pos && now - S.pos.t < 30000) Object.assign(data, { lat: +S.pos.lat.toFixed(6), lng: +S.pos.lng.toFixed(6), speed: S.pos.speed != null ? +S.pos.speed.toFixed(1) : null, updatedAt: now, ghost: false });
  try {
    await S.store.updateMember(S.crew.id, S.uid, data);
    runStatus = { state: S.pos ? "live" : "nogps", at: Date.now() };
  } catch (e) {
    console.warn("live run send failed", e);
    runStatus = { state: "error", at: Date.now() };
  }
  renderSession();
}
setInterval(sendRun, 2500);
function runStatusLine() {
  const ago = runStatus.at ? Math.round((Date.now() - runStatus.at) / 1000) : null;
  const msg = {
    idle: ["Connecting to the crew…", "var(--muted)"],
    live: [`Live to the crew · updated ${ago} s ago`, "var(--good)"],
    nogps: ["The crew can see you're live, but your phone has no GPS yet. Tap the red bar on the map for help.", "#ffb4b4"],
    ghost: ["Not visible: you're in ghost mode. Tap Ghost at the top to switch it off.", "#ffb4b4"],
    home: ["Not visible: you're inside your home zone (Crew tab → Hide me at home).", "#ffb4b4"],
    error: ["Not visible: can't reach the server. Check your signal or data.", "#ffb4b4"],
  }[runStatus.state] || ["", "var(--muted)"];
  return h("div", { class: "s", style: `color:${msg[1]};font-size:13px;text-align:center` }, msg[0]);
}
function startSession() {
  const active = S.myVehicles.find((v) => v.active);
  session = { start: Date.now(), top: 0, now: 0, cls: $("#in-sess-class").value, venue: $("#in-sess-venue").value.trim(), car: active?.name || "" };
  recent = [];
  lsSet("speedSession", session);
  updateWakeLock();
  renderSession();
  runStatus = { state: "idle" };
  sendRun();
  if (!S.ghost && !S.homeHidden) notifyCrew("run", { title: `🔴 ${S.profile.callsign} is live`, body: `Speed run${session.venue ? ` at ${session.venue}` : ""}${session.car ? ` in the ${session.car}` : ""} · tap to watch`, url: `./?watch=${S.uid}`, tag: `run-${S.uid}` });
  toast(S.ghost || S.homeHidden ? "Speed session started. You're hidden, so the crew can't watch this one." : "Speed session started. The crew can watch you live.");
}

async function endSession() {
  const s = session;
  session = null; recent = [];
  lsSet("speedSession", null);
  updateWakeLock();
  renderSession();
  if (S.crew) S.store.updateMember(S.crew.id, S.uid, { run: null }).catch(() => {});
  if (!s) return;
  const kmhTop = Math.round(s.top * 3.6);
  if (kmhTop < 20) { toast("Session ended. No clean GPS run was recorded."); return; }
  try {
    await S.store.addBoard(S.crew.id, "speed", { uid: S.uid, kmh: kmhTop, cls: s.cls, car: s.car, venue: s.venue, method: "GPS (auto)", photo: "", witnesses: [], createdAt: Date.now() });
    toast(claimRecord("speed", kmhTop, s.car) ? `${kmhTop} km/h. That's the new crew record!` : `${kmhTop} km/h saved to the board`);
  } catch { toast(`Couldn't save your ${kmhTop} km/h run. Check your signal and log it manually.`); }
}

function renderSession() {
  const box = $("#speed-session");
  if (!box || S.view !== "speed") return;
  if (S.speedMode !== "speed" && !session) { renderLaunch(); return; }
  if (!session) {
    box.className = "session";
    box.replaceChildren(
      h("div", {}, h("div", { class: "car-name" }, "Speed session"),
        h("div", { class: "s", style: "color:var(--muted);margin-top:4px" }, "Start it before a run. Your top speed is recorded automatically from GPS and saved to the board when you end it.")),
      h("div", { class: "grid2" },
        h("div", {}, h("label", { class: "lbl", for: "in-sess-class" }, "Where"),
          h("select", { id: "in-sess-class" }, ...BOARDS.speed.classes.map((c) => h("option", {}, c)))),
        h("div", {}, h("label", { class: "lbl", for: "in-sess-venue" }, "Venue"), h("input", { id: "in-sess-venue", maxlength: "40", placeholder: "Zwartkops" }))),
      h("button", { class: "btn primary wide", onclick: startSession }, "Start speed session"));
    return;
  }
  const mins = Math.floor((Date.now() - session.start) / 60000);
  box.className = "session live";
  box.replaceChildren(
    h("div", { class: "s", style: "color:var(--fg);font-weight:600" }, h("span", { class: "recdot" }), `Recording · ${session.venue || session.cls}`),
    h("div", { class: "gauge" },
      h("div", { class: "now" }, String(Math.round((session.now || 0) * 3.6)), h("small", {}, "km/h")),
      h("div", { class: "meta" },
        h("div", {}, h("b", {}, String(Math.round(session.top * 3.6))), "session top"),
        h("div", {}, h("b", {}, `${mins}`), "minutes"))),
    ...(S.pos ? [] : [h("div", { class: "s", style: "color:var(--bad)" }, "Waiting for GPS…")]),
    runStatusLine(),
    h("button", { class: "btn danger wide", onclick: endSession }, "End session and save"));
}

/* ---------------- hide me at home ---------------- */
// The home spot lives only in this phone's storage. It is never sent to the database.
let home = lsGet("homeGhost", null); // {lat, lng, radius, on}
const nearHome = () => !!(home?.on && S.pos && haversine(S.pos, home) <= home.radius);
function setHome(p) {
  home = { lat: p.lat, lng: p.lng, radius: Number($("#in-home-radius").value) || 500, on: true };
  lsSet("homeGhost", home);
  renderHome(); renderHomeCircle(); maybeSend(true);
  toast("Home spot saved on this phone");
}
function renderHome() {
  $("#in-home-on").checked = !!home?.on;
  $("#in-home-on").disabled = !home;
  if (home) $("#in-home-radius").value = String(home.radius);
  $("#btn-home-clear").hidden = !home;
  $("#home-status").textContent = !home ? "No home spot set yet."
    : !home.on ? "Home spot saved, but hiding is switched off."
    : nearHome() ? "You're near home right now, so you're hidden from the crew."
    : `On. You'll vanish from the map within ${home.radius >= 1000 ? home.radius / 1000 + " km" : home.radius + " m"} of home.`;
}
function renderHomeCircle() {
  if (!S.homeLayer) return;
  S.homeLayer.clearLayers();
  if (!home?.on) return;
  L.circle([home.lat, home.lng], { radius: home.radius, color: "#8b7cf0", weight: 3, opacity: 0.95, dashArray: "8 6", fillColor: "#8b7cf0", fillOpacity: 0.14, interactive: false }).addTo(S.homeLayer);
}
$("#btn-home-here").addEventListener("click", () => { if (!S.pos) { toast("Waiting for GPS. Try again in a moment."); return; } setHome(S.pos); });
$("#btn-home-pick").addEventListener("click", () => startPick("home", "Tap the map on your home"));
$("#btn-home-clear").addEventListener("click", () => { home = null; lsSet("homeGhost", null); renderHome(); renderHomeCircle(); maybeSend(true); toast("Home spot cleared"); });
$("#in-home-on").addEventListener("change", (e) => { if (!home) return; home.on = e.target.checked; lsSet("homeGhost", home); renderHome(); renderHomeCircle(); maybeSend(true); });
$("#in-home-radius").addEventListener("change", (e) => { if (!home) return; home.radius = Number(e.target.value); lsSet("homeGhost", home); renderHome(); renderHomeCircle(); maybeSend(true); });

/* ---------------- notifications ---------------- */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let pushPrefs = lsGet("pushPrefs", { run: true, meet: true, record: true, crew: true, chat: true });
function b64uToBytes(s) { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
async function currentSub() {
  if (DEMO) return lsGet("demoPush", false) ? { unsubscribe: async () => true } : null;
  if (!pushSupported() || Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function savePushSub(sub) {
  if (!S.crew) return;
  await S.store.savePush(S.crew.id, S.uid, { sub: JSON.stringify(sub), prefs: pushPrefs, platform: isIOS() ? "ios" : /android/i.test(navigator.userAgent) ? "android" : "other", updatedAt: Date.now() });
}
async function turnOnPush() {
  if (DEMO) {
    lsSet("demoPush", true); renderPush();
    toast("Preview: on. Example → 🔴 Stiaan is live · Speed run at Zwartkops · tap to watch");
    return;
  }
  try {
    if (Notification.permission === "denied") { renderPush("blocked"); return; }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { renderPush(perm === "denied" ? "blocked" : "off"); return; }
    const reg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC) });
    await savePushSub(sub);
    toast("Notifications on");
    setTimeout(syncReminders, 300);
  } catch (e) {
    console.warn("push", e);
    toast("Couldn't turn on notifications on this phone.");
  }
  renderPush();
}
async function turnOffPush() {
  if (DEMO) { lsSet("demoPush", false); toast("Notifications off"); renderPush(); return; }
  try { const sub = await currentSub(); if (sub) await sub.unsubscribe(); } catch {}
  if (S.crew) await S.store.deletePush(S.crew.id, S.uid).catch(() => {});
  toast("Notifications off");
  setTimeout(syncReminders, 300);
  renderPush();
}
// keep the crew's copy of this phone's subscription fresh (phones rotate them now and then)
async function refreshPush() { try { const sub = await currentSub(); if (sub) await savePushSub(sub); } catch {} }

async function renderPush(force) {
  const box = $("#push-box");
  if (!box) return;
  const sub = force ? null : await currentSub().catch(() => null);
  const state = force || (DEMO ? (sub ? "on" : "off") : !pushSupported() ? (isIOS() && !isStandalone() ? "ios-browser" : "unsupported")
    : Notification.permission === "denied" ? "blocked" : sub ? "on" : "off");
  S.pushOn = state === "on";
  const pref = (key, label) => h("label", { class: "check" }, h("input", { type: "checkbox", id: `push-${key}`, ...(pushPrefs[key] !== false ? { checked: true } : {}), onchange: async (e) => {
    pushPrefs = { ...pushPrefs, [key]: e.target.checked }; lsSet("pushPrefs", pushPrefs);
    const s = await currentSub(); if (s) await savePushSub(s);
    if (key === "meet") syncReminders();
  } }), label);
  const text = {
    on: "On. You'll get a notification even when THE CREW is closed.",
    off: "Get a notification when someone goes live on a speed run or posts a meet, even when the app is closed.",
    blocked: isIOS() ? "Notifications are blocked. Open iPhone Settings → Notifications → THE CREW → Allow Notifications, then come back." : "Notifications are blocked. Tap the lock icon by the address (or phone Settings → Apps → Chrome → Notifications) and allow them for this site.",
    "ios-browser": "On iPhone, notifications only work when THE CREW is opened from your home screen. In Safari tap Share → Add to Home Screen, then open it from there.",
    unsupported: "This browser can't show notifications. On Android use Chrome; on iPhone add THE CREW to your home screen (iOS 16.4 or newer).",
  }[state];
  box.replaceChildren(
    h("p", { class: "fine", style: "font-size:14px" }, text),
    ...(state === "on" ? [
      pref("run", "Someone goes live on a speed run"),
      pref("meet", "Meets: new meets, a reminder 1 hour before ones you're going to, and when the host arrives"),
      pref("record", "Someone takes #1 on a leaderboard"),
      pref("crew", "New members and new mods"),
      pref("chat", "Crew chat messages"),
      h("p", { class: "fine" }, "🆘 Breakdown SOS alerts always come through."),
    ] : []),
    h("div", { class: "btn-row" },
      state === "off" ? h("button", { type: "button", class: "btn primary sm", onclick: turnOnPush }, "Turn on notifications")
        : state === "on" ? h("button", { type: "button", class: "btn ghost sm", onclick: turnOffPush }, "Turn off") : null),
    ...(state === "on" && !NOTIFY_URL ? [h("p", { class: "fine" }, "Sending gets switched on shortly. You're all set, nothing more to do.")] : []));
}

// Ask the sender to notify the rest of the crew.
async function notifyCrew(type, msg) {
  if (!NOTIFY_URL || !S.crew || DEMO) return;
  try {
    const token = await S.store.getToken();
    if (!token) return;
    await fetch(NOTIFY_URL.replace(/\/$/, "") + "/notify", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ crew: S.crew.id, type, ...msg }), keepalive: true,
    });
  } catch (e) { console.warn("notify", e); }
}

// Open what a tapped notification points at: ?watch=<uid> or ?meet=<id>
function handleDeepLink(href) {
  let u;
  try { u = new URL(href || location.href); } catch { return; }
  const watch = u.searchParams.get("watch"), meet = u.searchParams.get("meet");
  const chat = u.searchParams.get("chat"), board = u.searchParams.get("board"), member = u.searchParams.get("member"), sos = u.searchParams.get("sos");
  if (sos) S.pendingSos = sos;
  const ci = u.searchParams.get("checkin"), ck = u.searchParams.get("k"), ccrew = u.searchParams.get("crew");
  if (ci && ck && !u.searchParams.get("claim")) S.pendingCheckin = { meet: ci, key: ck, crew: ccrew };
  if (u.searchParams.get("merch") && S.crew) setView("merch");
  if (watch) S.pendingWatch = watch;
  if (meet) S.pendingMeet = meet;
  if (member) S.pendingMember = member;
  if (chat && S.crew) setView("chat");
  if (board && BOARDS[board] && S.crew) { if (board === "bass") setView("bass"); else { S.speedMode = board; lsSet("speedMode", board); setView("speed"); } }
  if (watch || meet || chat || board || member || sos || ci || u.searchParams.get("merch")) history.replaceState(null, "", location.pathname);
  applyDeepLink();
}
function applyDeepLink() {
  if (!S.crew) return;
  if (S.pendingWatch) {
    const m = S.members.get(S.pendingWatch);
    if (m && isLiveRun(m)) { watchRun(m.id); S.pendingWatch = null; }
    else if (m && S.members.size && !m.run) { toast(`${m.callsign}'s run has already ended`); S.pendingWatch = null; }
  }
  if (S.pendingSos && S.members.has(S.pendingSos)) {
    const m = S.members.get(S.pendingSos);
    S.pendingSos = null;
    setView("map");
    if (activeSos(m) && m.sos.lat != null) S.map.flyTo([m.sos.lat, m.sos.lng], 16); else if (!activeSos(m)) toast(`${m.callsign} is sorted now 👍`);
  }
  if (S.pendingMember && S.members.has(S.pendingMember)) { openMember(S.pendingMember); S.pendingMember = null; }
  if (S.pendingCheckin && S.meets.length) {
    const p = S.pendingCheckin; S.pendingCheckin = null;
    if (p.crew && p.crew !== S.crew.id) toast("That check-in code is for a different crew."); else doCheckin(p.meet, p.key);
  }
  if (S.pendingMeet && S.meets.length) {
    if (S.meets.some((x) => x.id === S.pendingMeet)) { setView("convoy"); setSeg("meets"); openMeetView(S.pendingMeet); }
    S.pendingMeet = null;
  }
}
navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.type === "open") handleDeepLink(e.data.url); });

const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

/* ---------------- stats & badges ---------------- */
// My counters live on this phone and are copied onto my crew card so everyone sees my badges.
let myStats = {};
function mergeStats(server) {
  const local = lsGet(`stats:${S.uid}`, {});
  myStats = { ...local };
  for (const [k, v] of Object.entries(server || {})) if (!["cells", "km"].includes(k) && typeof v === "number") myStats[k] = Math.max(v, myStats[k] || 0);
  lsSet(`stats:${S.uid}`, myStats);
  checkBadges(true);
}
function bumpStat(k, n = 1) { setStat(k, (myStats[k] || 0) + n); }
function setStat(k, v) {
  if (myStats[k] === v) return;
  myStats[k] = v;
  lsSet(`stats:${S.uid}`, myStats);
  flushExplored();
  checkBadges();
}
const statsFor = (uid) => (uid === S.uid ? { ...myStats, cells: S.explored.size, km: Math.round(S.km) } : S.members.get(uid)?.stats || {});

function boardLeader(key) {
  const cfg = BOARDS[key];
  const runs = (S.boards[key] || []).filter((b) => b[cfg.field] != null);
  if (!runs.length) return null;
  return runs.reduce((a, b) => ((cfg.asc ? b[cfg.field] < a[cfg.field] : b[cfg.field] > a[cfg.field]) ? b : a)).uid;
}
const holdsRecord = (uid) => Object.keys(BOARDS).some((k) => boardLeader(k) === uid);

const BADGES = [
  { id: "km100", icon: "🛣️", name: "Road Tripper", desc: "Drive 100 km with THE CREW open", stat: "km", goal: 100 },
  { id: "km1000", icon: "🏁", name: "Road Warrior", desc: "Drive 1 000 km", stat: "km", goal: 1000 },
  { id: "km5000", icon: "🌍", name: "Long Haul", desc: "Drive 5 000 km", stat: "km", goal: 5000 },
  { id: "exp500", icon: "🧭", name: "Explorer", desc: "Reveal 500 road tiles", stat: "cells", goal: 500 },
  { id: "exp2000", icon: "🗺️", name: "Cartographer", desc: "Reveal 2 000 road tiles", stat: "cells", goal: 2000 },
  { id: "drives25", icon: "🔑", name: "Daily Driver", desc: "Finish 25 drives", stat: "drives", goal: 25 },
  { id: "night", icon: "🦉", name: "Night Owl", desc: "Start a drive between midnight and 4 am", stat: "night", goal: 1 },
  { id: "meet1", icon: "🤝", name: "Showed Up", desc: "Turn up at a crew meet", stat: "meets", goal: 1 },
  { id: "meet10", icon: "🎟️", name: "Regular", desc: "Turn up at 10 crew meets", stat: "meets", goal: 10 },
  { id: "convoy3", icon: "🚩", name: "Convoy Leader", desc: "Lead 3 convoys", stat: "convoys", goal: 3 },
  { id: "mods5", icon: "🔧", name: "Gearhead", desc: "Log 5 mods in your mod log", stat: "mods", goal: 5 },
  { id: "launch", icon: "🚀", name: "Launch Control", desc: "Record a 0–100 run", stat: "launches", goal: 1 },
  { id: "record", icon: "🏆", name: "Record Holder", desc: "Hold #1 on any crew board right now", live: holdsRecord },
  { id: "mvp", icon: "🏆", name: "Crew MVP", desc: "Top scorer in the crew last month", live: (uid) => isMvp(uid) },
  { id: "founder", icon: "⭐", name: "Crew Founder", desc: "One of the founders of this crew", live: (uid) => isFounder(uid) },
];
const badgeEarned = (b, uid) => (b.live ? !!b.live(uid) : (statsFor(uid)[b.stat] || 0) >= b.goal);
function checkBadges(silent) {
  if (!S.uid) return;
  const had = new Set(lsGet(`badges:${S.uid}`, []));
  const now = BADGES.filter((b) => !b.live && badgeEarned(b, S.uid)).map((b) => b.id);
  const fresh = now.filter((id) => !had.has(id));
  if (!fresh.length) return;
  lsSet(`badges:${S.uid}`, [...had, ...fresh]);
  if (!silent && had.size) { const b = BADGES.find((x) => x.id === fresh[0]); toast(`🏅 New badge: ${b.icon} ${b.name}`); }
  if (S.view === "explore") renderBadges();
}
function renderBadges() {
  const box = $("#badges");
  if (!box) return;
  const items = BADGES.map((b) => {
    const got = badgeEarned(b, S.uid);
    const have = b.live ? null : Math.min(statsFor(S.uid)[b.stat] || 0, b.goal);
    return { b, got, have };
  }).sort((x, y) => (y.got ? 1 : 0) - (x.got ? 1 : 0));
  fill(box, ...items.map(({ b, got, have }) => h("button", { class: `bdg${got ? " got" : ""}`, title: b.desc, onclick: () => openBadge(b) },
    h("div", { class: "bdg-i" }, b.icon),
    h("div", { class: "bdg-n" }, b.name),
    (() => { const n = badgeHolders(b).length; return h("div", { class: "bdg-who" }, n ? `${n} in the crew ${n === 1 ? "has" : "have"} it` : "Nobody yet"); })(),
    h("div", { class: "bdg-d" }, got ? b.desc : b.live ? b.desc : `${Math.floor(have).toLocaleString("en-ZA")} / ${b.goal.toLocaleString("en-ZA")}`),
    !got && !b.live ? h("div", { class: "bar" }, h("i", { style: `width:${Math.round((have / b.goal) * 100)}%` })) : null)));
}

// Who in the crew has a badge, and how close everyone else is.
const badgeHolders = (b) => [...S.members.values()].filter((m) => badgeEarned(b, m.id));
function openBadge(b) {
  const all = [...S.members.values()];
  const have = all.filter((m) => badgeEarned(b, m.id));
  const rest = b.live ? [] : all.filter((m) => !badgeEarned(b, m.id)).map((m) => ({ m, v: statsFor(m.id)[b.stat] || 0 })).sort((x, y) => y.v - x.v);
  const name = (m) => (m.id === S.uid ? `${m.callsign} (you)` : m.callsign);
  fill($("#member-body"),
    h("div", { class: "badge-head" }, h("div", { class: "bdg-big" }, b.icon),
      h("div", { class: "grow" }, h("div", { class: "car-name" }, b.name), h("div", { class: "s", style: "color:var(--muted)" }, b.desc))),
    h("div", { class: "lbl", style: "margin:14px 0 6px" }, `Unlocked · ${have.length}`),
    have.length ? h("ul", { class: "rows" }, ...have.map((m) => h("li", { onclick: () => openMember(m.id), style: "cursor:pointer" }, avatar(m.id, m.callsign),
      h("div", { class: "grow" }, h("div", { class: "n" }, name(m)), b.stat ? h("div", { class: "s" }, `${Math.floor(statsFor(m.id)[b.stat] || 0).toLocaleString("en-ZA")} ${STAT_UNIT[b.stat] || ""}`) : null),
      h("span", { class: "status live" }, b.icon)))) : h("p", { class: "fine", style: "font-size:14px" }, "Nobody in the crew has this one yet. Be the first."),
    rest.length ? h("div", { class: "lbl", style: "margin:16px 0 6px" }, "Still chasing it") : null,
    rest.length ? h("ul", { class: "rows" }, ...rest.map(({ m, v }) => h("li", { onclick: () => openMember(m.id), style: "cursor:pointer" }, avatar(m.id, m.callsign),
      h("div", { class: "grow" }, h("div", { class: "n" }, name(m)), h("div", { class: "bar" }, h("i", { style: `width:${Math.min(100, Math.round((v / b.goal) * 100))}%` }))),
      h("div", { class: "num" }, `${Math.floor(Math.min(v, b.goal)).toLocaleString("en-ZA")} / ${b.goal.toLocaleString("en-ZA")}`)))) : null);
  dlgMember.showModal();
}
const STAT_UNIT = { km: "km driven", cells: "road tiles", drives: "drives", night: "night drives", meets: "meets", convoys: "convoys led", mods: "mods", launches: "launch runs" };

/* ---------------- breakdown SOS ---------------- */
// Lives on my own crew card as `sos`, so it works without new database rules.
// It carries its own location, so the crew can find me even in ghost mode.
const SOS_TYPES = [["breakdown", "🔧 Breakdown"], ["tyre", "🛞 Flat tyre"], ["fuel", "⛽ Out of fuel"], ["battery", "🔋 Flat battery"], ["accident", "💥 Accident"], ["stuck", "🪨 Stuck"], ["other", "🆘 Other"]];
const SOS_MAX_MS = 6 * 3600000;
const sosLabel = (t) => (SOS_TYPES.find(([k]) => k === t) || SOS_TYPES[6])[1];
const activeSos = (m) => !!m?.sos?.at && Date.now() - m.sos.at < SOS_MAX_MS;
let sosType = "breakdown", sosSentAt = 0;
const dlgSos = $("#dlg-sos");
function openSosDialog() {
  if (activeSos(S.members.get(S.uid))) { toast("Your SOS is already out. Tap I'm sorted when you're okay."); return; }
  sosType = "breakdown";
  $("#in-sos-note").value = "";
  renderSosTypes();
  dlgSos.showModal();
}
function renderSosTypes() {
  fill($("#sos-types"), ...SOS_TYPES.map(([k, label]) => h("button", { type: "button", "aria-pressed": String(sosType === k), onclick: () => { sosType = k; renderSosTypes(); } }, label)));
}
$("#btn-sos").addEventListener("click", openSosDialog);
$("#btn-sos-cancel").addEventListener("click", () => dlgSos.close());
$("#form-sos").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pos = S.pos;
  if (!pos) { toast("No GPS yet. Your SOS will still go out, but call someone with your location."); }
  const note = $("#in-sos-note").value.trim().slice(0, 80);
  const sos = { at: Date.now(), type: sosType, note, ...(pos ? { lat: +pos.lat.toFixed(5), lng: +pos.lng.toFixed(5), posAt: Date.now() } : {}) };
  dlgSos.close();
  try {
    await S.store.updateMember(S.crew.id, S.uid, { sos, helping: null });
  } catch { toast("Couldn't send. Check your signal, or phone someone."); return; }
  sosSentAt = Date.now();
  const where = pos ? `https://maps.google.com/?q=${pos.lat.toFixed(5)},${pos.lng.toFixed(5)}` : "location unknown";
  notifyCrew("sos", { title: `🆘 ${S.profile.callsign} needs help`, body: `${sosLabel(sosType).replace(/^\S+ /, "")}${note ? ` · ${note}` : ""} · tap to see where`, url: `./?sos=${S.uid}`, tag: `sos-${S.uid}` });
  S.store.sendChat(S.crew.id, { uid: S.uid, name: S.profile.callsign, text: `🆘 SOS: ${sosLabel(sosType).replace(/^\S+ /, "")}${note ? ` · ${note}` : ""}\n📍 ${where}`, at: Date.now() }).catch(() => {});
  toast("SOS sent to the crew. Stay safe.");
  renderSos();
});
// keep my SOS location fresh while it's active
function sosFeed(fix) {
  const me = S.members.get(S.uid);
  if (!activeSos(me) || fix.acc > 80) return;
  if (Date.now() - (me.sos.posAt || 0) < 20000) return;
  S.store.updateMember(S.crew.id, S.uid, { sos: { ...me.sos, lat: +fix.lat.toFixed(5), lng: +fix.lng.toFixed(5), posAt: Date.now() } }).catch(() => {});
}
async function endSos() {
  await S.store.updateMember(S.crew.id, S.uid, { sos: null }).catch(() => {});
  S.store.sendChat(S.crew.id, { uid: S.uid, name: S.profile.callsign, text: "✅ I'm sorted, thanks crew. SOS cancelled.", at: Date.now() }).catch(() => {});
  toast("SOS cancelled. Glad you're okay.");
}
async function setHelping(uid, on) {
  await S.store.updateMember(S.crew.id, S.uid, { helping: on ? { uid, at: Date.now() } : null }).catch(() => {});
  if (on) {
    const m = S.members.get(uid);
    S.store.sendChat(S.crew.id, { uid: S.uid, name: S.profile.callsign, text: `🚗 On my way to ${m?.callsign || "help"}${m?.sos?.lat && S.pos ? ` (${fmtKm(haversine(S.pos, { lat: m.sos.lat, lng: m.sos.lng }))} away)` : ""}`, at: Date.now() }).catch(() => {});
    toast("Thanks! They can see you're coming.");
  }
}
const helpersOf = (uid) => [...S.members.values()].filter((m) => m.id !== uid && m.helping?.uid === uid && Date.now() - m.helping.at < SOS_MAX_MS);
function renderSos() {
  const strip = $("#sos-strip");
  if (!strip || !S.crew) return;
  // pins
  if (S.sosLayer) S.sosLayer.clearLayers(); else S.sosLayer = L.layerGroup().addTo(S.map);
  const list = [...S.members.values()].filter(activeSos).sort((a, b) => b.sos.at - a.sos.at);
  for (const m of list) {
    if (m.sos.lat == null) continue;
    L.marker([m.sos.lat, m.sos.lng], { icon: L.divIcon({ className: "", html: `<div class="sos-pin"><div class="ring"></div><div class="b">🆘 ${esc(m.id === S.uid ? "You" : m.callsign)}</div></div>`, iconSize: [0, 0] }), zIndexOffset: 2000 })
      .on("click", () => { S.map.flyTo([m.sos.lat, m.sos.lng], 16); }).addTo(S.sosLayer);
  }
  $("#live-strip").classList.toggle("pushed", !!list.length);
  if (!list.length) { strip.hidden = true; return; }
  const m = list[0];
  const mine = m.id === S.uid;
  const helpers = helpersOf(m.id);
  const coming = helpers.map((x) => x.id === S.uid ? "You" : x.callsign);
  const dist = !mine && S.pos && m.sos.lat != null ? fmtKm(haversine(S.pos, { lat: m.sos.lat, lng: m.sos.lng })) : "";
  const imHelping = S.members.get(S.uid)?.helping?.uid === m.id;
  const ago = fmtAgo(m.sos.at);
  strip.hidden = false;
  fill(strip,
    h("div", { class: "sos-top" }, h("span", { class: "sos-dot" }),
      h("div", { class: "grow" },
        h("b", {}, mine ? "Your SOS is out" : `${m.callsign} needs help`),
        h("div", { class: "lv-where" }, [sosLabel(m.sos.type).replace(/^\S+ /, ""), m.sos.note, dist ? `${dist} away` : "", ago].filter(Boolean).join(" · ")),
        h("div", { class: "lv-where", style: "color:var(--fg)" }, coming.length ? `🚗 Coming: ${coming.join(", ")}` : mine ? "Waiting for someone to respond…" : "Nobody's said they're coming yet"),
        list.length > 1 ? h("div", { class: "lv-where" }, `+${list.length - 1} more SOS`) : null)),
    h("div", { class: "btn-row" },
      mine ? h("button", { class: "btn primary sm", onclick: endSos }, "I'm sorted") : null,
      !mine ? h("button", { class: `btn ${imHelping ? "ghost" : "primary"} sm`, onclick: () => setHelping(m.id, !imHelping) }, imHelping ? "Not coming" : "I'm coming") : null,
      !mine && m.phone ? h("a", { class: "btn ghost sm", href: `tel:${intlPhone(m.phone)}` }, "Call") : null,
      !mine && m.sos.lat != null ? h("a", { class: "btn ghost sm", href: `https://www.google.com/maps/dir/?api=1&destination=${m.sos.lat},${m.sos.lng}`, target: "_blank", rel: "noopener" }, "Navigate") : null,
      m.sos.lat != null ? h("button", { class: "btn ghost sm", onclick: () => { setView("map"); S.map.flyTo([m.sos.lat, m.sos.lng], 16); } }, "Show") : null));
}

/* ---------------- remove & block (app founder only) ---------------- */
function kickedOut() {
  if (!S.crew) return;
  const name = S.crew.name;
  teardown();
  S.crew = null; S.profile.crewId = null;
  S.store.saveProfile(S.uid, { crewId: null }).catch(() => {});
  showOnboard("crew");
  obError(`You were removed from ${name}.`);
}
let bans = [];
async function removeMember(id, btn) {
  const m = S.members.get(id);
  if (!m) return;
  if (btn.dataset.armed !== "1") { btn.dataset.armed = "1"; btn.textContent = `Tap again to remove ${m.callsign}`; setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Remove from crew"; }, 4000); return; }
  const block = $("#in-block")?.checked;
  try {
    if (block) await S.store.banMember(S.crew.id, id, { name: m.callsign, phoneKey: m.phoneKey || phoneKey(m.phone), at: Date.now() });
    await S.store.removeMember(S.crew.id, id);
    dlgMember.close();
    toast(block ? `${m.callsign} removed and blocked` : `${m.callsign} removed. They can rejoin with the invite code.`);
  } catch { toast("Couldn't remove them. Check your signal and try again."); }
}
function renderBans() {
  const box = $("#bans-box");
  if (!box) return;
  const owner = S.crew?.ownerId === S.uid;
  box.hidden = !owner || !bans.length;
  $("#bans-h").hidden = box.hidden;
  if (box.hidden) return;
  fill(box, h("ul", { class: "rows" }, ...bans.map((b) => h("li", {},
    avatar(b.id, b.name), h("div", { class: "grow" }, h("div", { class: "n" }, b.name || "Someone"), h("div", { class: "s" }, `Blocked ${fmtAgo(b.at)}`)),
    h("button", { class: "btn ghost sm", onclick: async () => { await S.store.unbanMember(S.crew.id, b.id, b.phoneKey); toast(`${b.name || "They"} can join again`); } }, "Unblock")))));
}

/* ---------------- crew admins (app founder + crew founders) ---------------- */
const isAdmin = (uid = S.uid) => S.crew?.ownerId === uid || isFounder(uid);
const loadScript = (src) => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res(); const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = rej; document.head.append(s); });

/* ---------------- crew merch ---------------- */
let merch = [], myOrders = [], allOrders = [], merchSubs = [];
const ORDER_FLOW = { new: ["paid", "Mark paid"], paid: ["ready", "Mark ready"], ready: ["collected", "Mark collected"] };
const ORDER_LABEL = { new: "Waiting for payment", paid: "Paid", ready: "Ready to collect", collected: "Collected" };
const fmtRand = (n) => "R" + Number(n || 0).toLocaleString("en-ZA");
function subscribeMerch() {
  merchSubs.forEach((u) => u()); merchSubs = [];
  merchSubs.push(S.store.onMerch(S.crew.id, (l) => { merch = l.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)); if (S.view === "merch") renderMerch(); if (S.view === "crew") renderMerchCard(); }, () => {}));
  merchSubs.push(S.store.onMyOrders(S.crew.id, S.uid, (l) => { myOrders = l.sort((a, b) => b.at - a.at); if (S.view === "merch") renderMerch(); }, () => {}));
  if (isAdmin()) merchSubs.push(S.store.onAllOrders(S.crew.id, (l) => { allOrders = l.sort((a, b) => b.at - a.at); if (S.view === "merch") renderMerch(); if (S.view === "crew") renderMerchCard(); }, () => {}));
  S.unsubs.push(() => { merchSubs.forEach((u) => u()); merchSubs = []; });
}
function renderMerchCard() {
  const box = $("#merch-card");
  if (!box) return;
  const open = isAdmin() ? allOrders.filter((o) => o.status !== "collected").length : 0;
  fill(box,
    h("div", { class: "grow" }, h("div", { class: "n" }, "🛍️ Crew merch"),
      h("div", { class: "s" }, merch.length ? `${merch.length} item${merch.length === 1 ? "" : "s"} in the shop${open ? ` · ${open} open order${open === 1 ? "" : "s"}` : ""}` : isAdmin() ? "Add the first item to the shop" : "Nothing in the shop yet")),
    h("button", { class: "btn primary sm", onclick: () => setView("merch") }, "Open shop"));
}
const statusChip = (s) => h("span", { class: `ostatus ${s}` }, ORDER_LABEL[s] || s);
function renderMerch() {
  const admin = isAdmin();
  fill($("#merch-body"),
    h("div", { class: "h-row" }, h("h2", { class: "h" }, "Crew merch"),
      h("div", { class: "btn-row" }, admin ? h("button", { class: "btn primary sm", onclick: () => editMerch(null) }, "Add item") : null, h("button", { class: "btn ghost sm", onclick: () => setView("crew") }, "Close"))),
    h("p", { class: "sub" }, admin ? "You and the crew founders run the shop. Orders come to you; payment happens outside the app (EFT or cash)." : "Order crew gear here. You pay the founders directly; they'll update your order as it moves along."),
    merch.length ? h("div", { class: "merch-grid" }, ...merch.map((it) => h("button", { class: "merch-item", onclick: () => openMerchItem(it) },
      it.photo ? h("img", { src: it.photo, alt: it.name }) : h("div", { class: "merch-ph" }, "🛍️"),
      h("div", { class: "mi-body" }, h("div", { class: "n" }, it.name), h("div", { class: "p" }, fmtRand(it.price)), it.sizes?.length ? h("div", { class: "s" }, it.sizes.join(" · ")) : null)))) :
      h("div", { class: "empty" }, h("div", { class: "big" }, "Shop's empty"), h("p", {}, admin ? "Tap Add item to put the first thing up." : "The founders haven't added anything yet.")),
    myOrders.length ? h("h3", { class: "h3" }, "My orders") : null,
    myOrders.length ? h("ul", { class: "rows" }, ...myOrders.map((o) => h("li", {},
      h("div", { class: "grow" }, h("div", { class: "n" }, `${o.itemName}${o.size ? ` · ${o.size}` : ""} × ${o.qty}`), h("div", { class: "s" }, `${fmtRand(o.price * o.qty)} · ${fmtAgo(o.at)}${o.note ? ` · ${o.note}` : ""}`)),
      statusChip(o.status),
      o.status === "new" ? h("button", { class: "linkish", onclick: async () => { await S.store.deleteOrder(S.crew.id, o.id); toast("Order cancelled"); } }, "Cancel") : null))) : null,
    admin ? h("h3", { class: "h3" }, `Orders to sort out${allOrders.filter((o) => o.status !== "collected").length ? ` (${allOrders.filter((o) => o.status !== "collected").length})` : ""}`) : null,
    admin ? (allOrders.length ? h("ul", { class: "rows" }, ...allOrders.map((o) => h("li", { class: o.status === "collected" ? "done" : "" },
      avatar(o.uid, o.name),
      h("div", { class: "grow" }, h("div", { class: "n" }, `${o.name}: ${o.itemName}${o.size ? ` · ${o.size}` : ""} × ${o.qty}`),
        h("div", { class: "s" }, `${fmtRand(o.price * o.qty)} · ${fmtAgo(o.at)}${o.note ? ` · "${o.note}"` : ""}`),
        h("div", { class: "btn-row", style: "margin-top:6px" }, statusChip(o.status),
          ORDER_FLOW[o.status] ? h("button", { class: "btn primary sm", onclick: () => moveOrder(o) }, ORDER_FLOW[o.status][1]) : null,
          o.status !== "collected" ? h("button", { class: "linkish", onclick: async (e) => {
            const b = e.currentTarget;
            if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "tap again"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Cancel order"; }, 3000); return; }
            await S.store.deleteOrder(S.crew.id, o.id); toast("Order cancelled");
          } }, "Cancel order") : null))))) : h("p", { class: "fine", style: "font-size:14px" }, "No orders yet.")) : null);
}
async function moveOrder(o) {
  const [next] = ORDER_FLOW[o.status];
  await S.store.setOrderStatus(S.crew.id, o.id, next);
  const msg = { paid: "✅ Payment received", ready: "📦 Your order is ready to collect", collected: "🙌 Order collected, enjoy" }[next];
  notifyCrew("orderstatus", { to: o.uid, title: msg, body: `${o.itemName}${o.size ? ` · ${o.size}` : ""} × ${o.qty}`, url: "./?merch=1", tag: `order-${o.id}` });
  toast(`${o.name}'s order: ${ORDER_LABEL[next].toLowerCase()}`);
}
function openMerchItem(it) {
  const admin = isAdmin();
  fill($("#member-body"),
    it.photo ? h("img", { class: "photo-big", src: it.photo, alt: it.name, style: "margin-bottom:10px" }) : null,
    h("div", { class: "car-name" }, it.name),
    h("div", { class: "dbv", style: "color:var(--accent);margin:4px 0 8px" }, fmtRand(it.price)),
    it.desc ? h("p", { style: "margin:0 0 8px;white-space:pre-wrap" }, it.desc) : null,
    it.pay ? h("p", { class: "fine", style: "font-size:14px;margin-bottom:10px" }, `💳 How to pay: ${it.pay}`) : null,
    h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const qty = Math.max(1, Math.min(20, parseInt(f.qty.value, 10) || 1));
      const order = { uid: S.uid, name: S.profile.callsign, item: it.id, itemName: it.name, size: f.size ? f.size.value : "", qty, price: Number(it.price) || 0, note: f.note.value.trim().slice(0, 80), status: "new", at: Date.now() };
      try {
        const id = await S.store.placeOrder(S.crew.id, order);
        dlgMember.close();
        toast(`Order placed: ${it.name} × ${qty}. Pay ${fmtRand(order.price * qty)} as shown.`);
        notifyCrew("order", { title: `🛍️ New order: ${it.name}`, body: `${S.profile.callsign} · ${order.size ? `${order.size} · ` : ""}× ${qty} · ${fmtRand(order.price * qty)}`, url: "./?merch=1", tag: `order-${id}` });
      } catch { toast("Couldn't place the order. Try again."); }
    } },
      it.sizes?.length ? h("div", {}, h("label", { class: "lbl", for: "in-o-size" }, "Size"), h("select", { id: "in-o-size", name: "size" }, ...it.sizes.map((s) => h("option", {}, s)))) : null,
      h("div", { class: "grid2" },
        h("div", {}, h("label", { class: "lbl", for: "in-o-qty" }, "How many"), h("input", { id: "in-o-qty", name: "qty", type: "number", min: "1", max: "20", value: "1", inputmode: "numeric" })),
        h("div", {}, h("label", { class: "lbl", for: "in-o-note" }, "Note"), h("input", { id: "in-o-note", name: "note", maxlength: "80", placeholder: "Optional" }))),
      it.active === false ? h("p", { class: "fine" }, "Sold out for now.") : h("button", { class: "btn primary wide", type: "submit" }, "Place order")),
    admin ? h("div", { class: "btn-row", style: "margin-top:12px" },
      h("button", { class: "btn ghost sm", onclick: () => editMerch(it) }, "Edit item"),
      h("button", { class: "btn ghost sm", onclick: async () => { await S.store.saveMerch(S.crew.id, it.id, { active: it.active === false }); dlgMember.close(); toast(it.active === false ? "Back in stock" : "Marked sold out"); } }, it.active === false ? "Back in stock" : "Mark sold out"),
      h("button", { class: "btn danger sm", onclick: async (e) => {
        const b = e.currentTarget;
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again to remove"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Remove item"; }, 3000); return; }
        await S.store.deleteMerch(S.crew.id, it.id); dlgMember.close(); toast("Item removed");
      } }, "Remove item")) : null);
  if (!dlgMember.open) dlgMember.showModal();
}
function editMerch(it) {
  let photo = it?.photo || "";
  const prev = h("img", { class: "photo-big", alt: "", src: photo || "", ...(photo ? {} : { hidden: true }) });
  fill($("#member-body"),
    h("div", { class: "car-name", style: "margin-bottom:8px" }, it ? "Edit item" : "Add an item"),
    h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const data = { name: f.name.value.trim().slice(0, 40), price: Math.max(0, Math.round(parseFloat(f.price.value.replace(/[^\d.]/g, "")) || 0)),
        sizes: f.sizes.value.split(/[,/]/).map((s) => s.trim()).filter(Boolean).slice(0, 10), desc: f.desc.value.trim().slice(0, 300), pay: f.pay.value.trim().slice(0, 120), photo,
        ...(it ? {} : { active: true, createdAt: Date.now(), createdBy: S.uid }) };
      if (!data.name) { toast("Give it a name"); return; }
      try { await S.store.saveMerch(S.crew.id, it?.id || null, data); dlgMember.close(); toast(it ? "Item updated" : "Item added to the shop"); }
      catch { toast("Couldn't save. The photo might be too big; try another."); }
    } },
      prev,
      h("label", { class: "btn ghost sm", style: "align-self:flex-start" }, "📷 Photo", h("input", { type: "file", accept: "image/*", hidden: true, onchange: async (e) => {
        const file = e.target.files[0]; if (!file) return;
        try { photo = await capSize(await shrinkImage(file, 1000, 0.8), 600000); prev.src = photo; prev.hidden = false; } catch { toast("Couldn't read that photo"); }
      } })),
      h("label", { class: "lbl", for: "in-m-name" }, "Name"), h("input", { id: "in-m-name", name: "name", maxlength: "40", value: it?.name || "", placeholder: "Crew tee (black)", required: true }),
      h("div", { class: "grid2" },
        h("div", {}, h("label", { class: "lbl", for: "in-m-price" }, "Price (R)"), h("input", { id: "in-m-price", name: "price", inputmode: "decimal", value: it?.price ?? "", placeholder: "280" })),
        h("div", {}, h("label", { class: "lbl", for: "in-m-sizes" }, "Sizes"), h("input", { id: "in-m-sizes", name: "sizes", value: (it?.sizes || []).join(", "), placeholder: "S, M, L, XL (or leave empty)" }))),
      h("label", { class: "lbl", for: "in-m-desc" }, "Description"), h("textarea", { id: "in-m-desc", name: "desc", rows: "2", maxlength: "300" }, it?.desc || ""),
      h("label", { class: "lbl", for: "in-m-pay" }, "How to pay"), h("input", { id: "in-m-pay", name: "pay", maxlength: "120", value: it?.pay || "", placeholder: "EFT to Stiaan, ref = your name" }),
      h("button", { class: "btn primary wide", type: "submit" }, it ? "Save" : "Add to shop")));
  if (!dlgMember.open) dlgMember.showModal();
}

/* ---------------- QR check-in at meets ---------------- */
let checkins = [];
const checkinsFor = (meetId) => checkins.filter((c) => c.meet === meetId);
const checkinWindow = (m) => Date.now() > m.when - 3 * 3600000 && Date.now() < m.when + 6 * 3600000;
const randCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (x) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[x % 32]).join("");
const checkinUrl = (m, key) => `${location.origin}${location.pathname}?checkin=${m.id}&k=${key}&crew=${S.crew.id}`;
function checkinBlock(m) {
  const list = checkinsFor(m.id), mine = list.some((c) => c.uid === S.uid);
  const canShow = m.hostId === S.uid || isAdmin();
  const open = checkinWindow(m);
  if (!open && !list.length) return null;
  return h("div", { class: "checkin-box" },
    h("div", { class: "n" }, list.length ? `✅ ${list.length} checked in` : "Nobody's checked in yet"),
    list.length ? h("div", { class: "going" }, ...list.slice(0, 8).map((c) => avatar(c.uid, c.uid === S.uid ? S.profile.callsign : S.members.get(c.uid)?.callsign))) : null,
    open ? h("div", { class: "btn-row", style: "margin-top:8px" },
      canShow ? h("button", { class: "btn primary sm", onclick: () => showCheckinQR(m) }, "Show check-in QR") : null,
      !mine ? h("button", { class: `btn ${canShow ? "ghost" : "primary"} sm`, onclick: () => openScanner(m) }, "📷 Check in") : h("span", { class: "fine" }, "You're checked in ✅")) : null);
}
async function showCheckinQR(m) {
  let key = await S.store.getMeetKey(S.crew.id, m.id).catch(() => null);
  if (!key) { key = randCode(); await S.store.setMeetKey(S.crew.id, m.id, key); }
  try { await loadScript("lib/qrcode.js"); } catch { toast("Couldn't load the QR maker. Check your signal."); return; }
  const qr = window.qrcode(0, "M"); qr.addData(checkinUrl(m, key)); qr.make();
  const box = h("div", { class: "qr-big" }); box.innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  fill($("#member-body"),
    h("div", { class: "car-name" }, `Check in · ${m.title}`),
    h("p", { class: "fine", style: "font-size:14px;margin:4px 0 10px" }, "Let the crew scan this with THE CREW (Meets → the meet → Check in). Turn your screen brightness up."),
    box,
    h("div", { class: "qr-code" }, key),
    h("p", { class: "fine", style: "text-align:center" }, "Camera not working? They can type this code instead."),
    h("div", { class: "n", style: "text-align:center;margin-top:8px", id: "qr-count" }, `✅ ${checkinsFor(m.id).length} checked in`));
  if (!dlgMember.open) dlgMember.showModal();
  S.qrMeet = m.id;
}
let scanStream = null, scanTimer = null;
function stopScan() { clearInterval(scanTimer); scanTimer = null; scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null; }
$("#dlg-member").addEventListener("close", () => { stopScan(); S.qrMeet = null; });
async function openScanner(m) {
  const video = h("video", { class: "scan-video", playsinline: true, muted: true, autoplay: true });
  const status = h("p", { class: "fine", style: "text-align:center" }, "Point your camera at the check-in QR code.");
  fill($("#member-body"),
    h("div", { class: "car-name" }, `Check in · ${m.title}`),
    h("div", { class: "scan-wrap" }, video, h("div", { class: "scan-frame" })),
    status,
    h("form", { class: "row-end", onsubmit: (e) => { e.preventDefault(); const k = e.target.elements.code.value.trim().toUpperCase(); if (k) doCheckin(m.id, k); } },
      h("input", { name: "code", maxlength: "6", placeholder: "Or type the code", autocapitalize: "characters", style: "text-transform:uppercase" }),
      h("button", { class: "btn primary sm", type: "submit", style: "flex:none" }, "Check in")));
  if (!dlgMember.open) dlgMember.showModal();
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = scanStream; await video.play().catch(() => {});
  } catch { status.textContent = "Camera blocked or not available. Type the code shown on the host's screen."; return; }
  let detector = null;
  if ("BarcodeDetector" in window) { try { detector = new window.BarcodeDetector({ formats: ["qr_code"] }); } catch {} }
  if (!detector) { try { await loadScript("lib/jsQR.js"); } catch { status.textContent = "Couldn't load the scanner. Type the code instead."; return; } }
  const cv = document.createElement("canvas"), ctx = cv.getContext("2d", { willReadFrequently: true });
  let busy = false;
  scanTimer = setInterval(async () => {
    if (busy || !video.videoWidth) return;
    busy = true;
    try {
      let text = null;
      if (detector) { const r = await detector.detect(video); text = r[0]?.rawValue || null; }
      else {
        const w = Math.min(640, video.videoWidth), hh = Math.round(video.videoHeight * (w / video.videoWidth));
        cv.width = w; cv.height = hh; ctx.drawImage(video, 0, 0, w, hh);
        text = window.jsQR(ctx.getImageData(0, 0, w, hh).data, w, hh)?.data || null;
      }
      if (text) {
        let u; try { u = new URL(text); } catch {}
        const meet = u?.searchParams.get("checkin"), key = u?.searchParams.get("k"), crew = u?.searchParams.get("crew");
        if (!meet || !key) status.textContent = "That's not a THE CREW check-in code.";
        else if (crew !== S.crew.id) status.textContent = "That code is for a different crew.";
        else { stopScan(); doCheckin(meet, key); }
      }
    } catch {}
    busy = false;
  }, 250);
}
async function doCheckin(meetId, key) {
  const m = S.meets.find((x) => x.id === meetId);
  if (!m) { toast("That meet isn't on the list any more."); return; }
  if (S.pos && m.place && haversine(S.pos, m.place) > 3000) { toast(`You need to be at ${m.title} to check in.`); return; }
  try {
    await S.store.checkIn(S.crew.id, meetId, S.uid, key.toUpperCase());
    if (!lsGet(`att:${meetId}`, false)) { lsSet(`att:${meetId}`, true); bumpStat("meets"); }
    if (dlgMember.open) dlgMember.close();
    toast(`✅ Checked in at ${m.title}`);
    if (dlgMeetView.open) openMeetView(meetId);
  } catch { toast("That code isn't right for this meet. Check it with the host."); }
}

/* ---------------- crew ranking & monthly MVP ---------------- */
const monthKey = (off = 0) => { const t = new Date(); t.setDate(1); t.setMonth(t.getMonth() + off); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}`; };
const monthName = (off = 0) => { const t = new Date(); t.setDate(1); t.setMonth(t.getMonth() + off); return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][t.getMonth()]; };
// what earns points
const PTS = { meets: [25, "meet", "meets"], convoys: [20, "convoy led", "convoys led"], launches: [10, "launch run", "launch runs"], drives: [5, "drive", "drives"], mods: [10, "mod", "mods"], km: [0.1, "km", "km"], cells: [0.05, "road tile", "road tiles"] };
const ptsFrom = (s, base = {}) => Object.entries(PTS).reduce((n, [k, [w]]) => n + Math.max(0, (s[k] || 0) - (base[k] || 0)) * w, 0);
const snapStats = () => ({ ...myStats, cells: S.explored.size, km: Math.round(S.km) });
function monthPts(uid) {
  const m = S.members.get(uid);
  const base = m?.month?.key === monthKey(0) ? m.month.base : null;
  return base ? Math.round(ptsFrom(statsFor(uid), base)) : 0;
}
function lastMonthPts(uid) {
  const m = S.members.get(uid), prev = monthKey(-1);
  if (m?.lastMonth?.key === prev) return m.lastMonth.pts || 0;
  if (m?.month?.key === prev) return Math.round(ptsFrom(statsFor(uid), m.month.base)); // hasn't opened the app since the month turned
  return 0;
}
function mvpUids() {
  const scores = [...S.members.keys()].map((id) => [id, lastMonthPts(id)]);
  const top = Math.max(0, ...scores.map(([, p]) => p));
  return new Set(top > 0 ? scores.filter(([, p]) => p === top).map(([id]) => id) : []);
}
const isMvp = (uid) => mvpUids().has(uid);
function allTimePts(uid) {
  const s = statsFor(uid);
  const badges = BADGES.filter((b) => badgeEarned(b, uid)).length;
  const records = Object.keys(BOARDS).filter((k) => boardLeader(k) === uid).length;
  return { pts: Math.round(ptsFrom(s) + badges * 50 + records * 100), badges, records, s };
}
// first open in a new month: close last month's tally and start this one
function ensureMonth() {
  const me = S.members.get(S.uid);
  if (!me || !S.statsMerged) return;
  const cur = monthKey(0);
  if (me.month?.key === cur) return;
  const snap = snapStats();
  const data = { month: { key: cur, base: snap } };
  if (me.month?.key) data.lastMonth = { key: me.month.key, pts: Math.round(ptsFrom(snap, me.month.base)) };
  S.store.updateMember(S.crew.id, S.uid, data).catch(() => {});
}
function renderRanking() {
  const box = $("#ranking");
  if (!box || !S.crew) return;
  const mode = S.rankMode || "month";
  const ids = [...S.members.keys()];
  const rows = ids.map((id) => {
    if (mode === "month") {
      const m = S.members.get(id), base = m?.month?.key === monthKey(0) ? m.month.base : null, s = statsFor(id);
      const parts = base ? Object.entries(PTS).map(([k, [, one, many]]) => [Math.round(Math.max(0, (s[k] || 0) - (base[k] || 0))), one, many]).filter(([n]) => n > 0) : [];
      return { id, pts: monthPts(id), line: parts.length ? parts.slice(0, 3).map(([n, one, many]) => `+${n.toLocaleString("en-ZA")} ${n === 1 ? one : many}`).join(" · ") : "Nothing yet this month" };
    }
    const a = allTimePts(id);
    return { id, pts: a.pts, line: [`${a.badges} badge${a.badges === 1 ? "" : "s"}`, a.records ? `${a.records} record${a.records === 1 ? "" : "s"}` : "", `${(a.s.meets || 0)} meets`, `${Math.round(a.s.km || 0).toLocaleString("en-ZA")} km`].filter(Boolean).join(" · ") };
  }).sort((a, b) => b.pts - a.pts);
  const mvps = [...mvpUids()];
  const name = (id) => (id === S.uid ? `${S.profile.callsign} (you)` : S.members.get(id)?.callsign || "Ex-member");
  fill(box,
    mvps.length ? h("div", { class: "mvp-banner" }, h("span", { class: "mvp-cup" }, "🏆"),
      h("div", { class: "grow" }, h("div", { class: "lbl" }, `${monthName(-1)} Crew MVP`), h("div", { class: "n" }, mvps.map(name).join(" & ")),
        h("div", { class: "s" }, `${lastMonthPts(mvps[0])} points · wears the MVP tag all ${monthName(0)}`))) : null,
    h("div", { class: "chips", style: "margin:10px 0" }, ...[["month", `${monthName(0)} (MVP race)`], ["all", "All time"]].map(([k, l]) => h("button", { "aria-pressed": String(mode === k), onclick: () => { S.rankMode = k; renderRanking(); } }, l))),
    h("ol", { class: "rank-list" }, ...rows.map((r, i) => h("li", { onclick: () => openMember(r.id) },
      h("span", { class: `rk${i < 3 && r.pts > 0 ? ` m${i + 1}` : ""}` }, String(i + 1)),
      avatar(r.id, S.members.get(r.id)?.callsign),
      h("div", { class: "grow" }, h("div", { class: "n" }, name(r.id), isMvp(r.id) ? " 🏆" : ""), h("div", { class: "s" }, r.line)),
      h("div", { class: "num" }, h("span", { class: "dbv" }, r.pts.toLocaleString("en-ZA"), h("small", {}, "pts")))))),
    h("details", { class: "how-pts" }, h("summary", {}, "How points work"),
      h("p", { class: "fine" }, `Meet you turn up at or check in to: 25 · convoy you lead: 20 · launch run: 10 · mod logged: 10 · drive: 5 · every 10 km driven: 1 · every 20 new road tiles: 1. All time adds 50 per badge and 100 per crew record you hold. The month resets on the 1st; the top scorer becomes Crew MVP for the next month.`)));
}

/* ---------------- crew founders ---------------- */
// The app founder (whoever set the crew up) sends one-use links; opening one claims a founder spot.
let founders = [], founderClaims = [];
const MAX_FOUNDERS = 2;
const isFounder = (uid) => founders.some((f) => f.id === uid);
const roleTag = (uid) => (S.crew?.ownerId === uid ? "Developer" : isFounder(uid) ? "Founder" : "");
const tagEls = (uid, small) => [roleTag(uid) ? h("span", { class: `cls${roleTag(uid) === "Developer" ? " dev" : ""}`, style: small ? "font-size:10px" : null }, roleTag(uid) === "Developer" ? "🛠️ Developer" : roleTag(uid)) : null,
  isMvp(uid) ? h("span", { class: "cls mvp", style: small ? "font-size:10px" : null }, "🏆 MVP") : null];
const claimLink = (token) => `${location.origin}${location.pathname}?claim=${token}&crew=${S.crew.id}`;
function renderFounders() {
  const box = $("#founders");
  if (!box || !S.crew) return;
  const owner = S.crew.ownerId === S.uid;
  const open = founderClaims.length, left = MAX_FOUNDERS - founders.length - open;
  const share = async (token) => {
    const text = `You're one of the founders of ${S.crew.name} 🏁 Tap this link to claim your founder spot on THE CREW: ${claimLink(token)}`;
    try {
      if (navigator.share) await navigator.share({ title: "Claim your founder spot", text });
      else { await navigator.clipboard.writeText(text); toast("Link copied"); }
    } catch (e) { if (e?.name !== "AbortError") { try { await navigator.clipboard.writeText(claimLink(token)); toast("Link copied"); } catch { toast(claimLink(token)); } } }
  };
  fill(box,
    founders.length ? h("ul", { class: "rows" }, ...founders.map((f) => h("li", {},
      avatar(f.id, S.members.get(f.id)?.callsign),
      h("div", { class: "grow" }, h("div", { class: "n" }, "⭐ ", S.members.get(f.id)?.callsign || "Ex-member", f.id === S.uid ? " (you)" : ""), h("div", { class: "s" }, `Crew founder since ${fmtDate(new Date(f.at).toISOString().slice(0, 10))}`)),
      owner ? h("button", { class: "btn ghost sm", onclick: async (e) => {
        const b = e.currentTarget;
        if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Tap again"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "Remove"; }, 3000); return; }
        await S.store.removeFounder(S.crew.id, f.id); toast("Founder removed");
      } }, "Remove") : null))) : h("p", { class: "fine", style: "font-size:14px" }, owner ? "Nobody has claimed a founder spot yet." : "The crew founders haven't claimed their spots yet."),
    owner && open ? h("div", { class: "stack", style: "margin-top:10px" }, h("div", { class: "lbl" }, "Links waiting to be claimed"),
      ...founderClaims.map((c) => h("div", { class: "claim-row" },
        h("div", { class: "grow" }, h("div", { class: "n", style: "font-size:14px" }, c.note || "Founder link"), h("div", { class: "s" }, `Made ${fmtAgo(c.createdAt)} · works once`)),
        h("button", { class: "btn primary sm", onclick: () => share(c.id) }, "Send"),
        h("button", { class: "btn ghost sm", onclick: async () => { await S.store.deleteFounderClaim(S.crew.id, c.id); toast("Link cancelled"); } }, "Cancel")))) : null,
    owner && left > 0 ? h("form", { class: "stack", style: "margin-top:12px", onsubmit: async (e) => {
      e.preventDefault();
      const note = e.target.elements.who.value.trim();
      const token = Array.from(crypto.getRandomValues(new Uint8Array(15)), (x) => "abcdefghjkmnpqrstuvwxyz23456789"[x % 31]).join("");
      await S.store.createFounderClaim(S.crew.id, token, { createdAt: Date.now(), note: note ? `For ${note}` : "" });
      e.target.reset();
      share(token);
    } },
      h("label", { class: "lbl", for: "in-founder-who" }, `Send a founder link (${left} left)`),
      h("div", { class: "row-end", style: "margin:0" }, h("input", { id: "in-founder-who", name: "who", maxlength: "20", placeholder: "Who it's for, e.g. Ruan" }), h("button", { class: "btn primary sm", type: "submit", style: "flex:none" }, "Make link"))) : null,
    owner ? h("p", { class: "fine", style: "margin-top:8px" }, "Each link works once. Whoever opens it (and is in the crew) gets the ⭐ Crew Founder badge.") : null);
}
// Opened a founder link: remember it, then claim once inside the right crew.
function notePendingClaim() {
  try {
    const u = new URL(location.href), t = u.searchParams.get("claim"), c = u.searchParams.get("crew");
    if (t && c) { lsSet("pendingClaim", { token: t, crew: c.toUpperCase() }); history.replaceState(null, "", location.pathname); }
  } catch {}
}
notePendingClaim();
async function tryClaim() {
  const p = lsGet("pendingClaim", null);
  if (!p || !S.crew) return;
  if (p.crew !== S.crew.id) { toast(`That founder link is for crew ${p.crew}. Join that crew first.`); return; }
  lsSet("pendingClaim", null);
  if (isFounder(S.uid)) { toast("You're already a founder of this crew ⭐"); return; }
  try {
    await S.store.claimFounder(S.crew.id, p.token, S.uid);
    toast(`⭐ You're now a founder of ${S.crew.name}!`);
    notifyCrew("join", { title: `⭐ ${S.profile.callsign} claimed a founder spot`, body: `${S.crew.name} has a new crew founder`, url: `./?member=${S.uid}`, tag: `founder-${S.uid}` });
  } catch { toast("That founder link has already been used or cancelled. Ask for a new one."); }
}

/* ---------------- crew chat ---------------- */
let chatMsgs = [], chatPhoto = "", chatFirst = true;
const chatReadKey = () => `chatRead:${S.crew?.id}`;
function onChatList(list) {
  const prevIds = new Set(chatMsgs.map((m) => m.id));
  chatMsgs = [...list].sort((a, b) => a.at - b.at);
  if (!chatFirst && S.view !== "chat") {
    const fresh = chatMsgs.filter((m) => !prevIds.has(m.id) && m.uid !== S.uid);
    const m = fresh[fresh.length - 1];
    if (m) toast(`💬 ${m.name}: ${m.text ? m.text.slice(0, 60) : "📷 Photo"}`);
  }
  chatFirst = false;
  renderChatBadge();
  if (S.view === "chat") renderChat();
}
function renderChatBadge() {
  const read = lsGet(chatReadKey(), 0);
  const n = chatMsgs.filter((m) => m.uid !== S.uid && m.at > read).length;
  const b = $("#chat-badge");
  b.hidden = !n || S.view === "chat";
  b.textContent = n > 9 ? "9+" : String(n);
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function dayLabel(t) {
  const d = new Date(t), today = new Date();
  if (sameDay(t, today)) return "Today";
  if (sameDay(t, today.getTime() - 86400000)) return "Yesterday";
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
function renderChat(jump) {
  const list = $("#chat-list");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  lsSet(chatReadKey(), Date.now());
  renderChatBadge();
  const out = [];
  let prev = null;
  for (const m of chatMsgs) {
    if (!prev || !sameDay(prev.at, m.at)) out.push(h("div", { class: "chat-day" }, dayLabel(m.at)));
    const mine = m.uid === S.uid, cont = prev && prev.uid === m.uid && m.at - prev.at < 5 * 60000 && sameDay(prev.at, m.at);
    const bubble = h("div", { class: `msg${mine ? " mine" : ""}${cont ? " cont" : ""}` },
      !mine && !cont ? avatar(m.uid, m.name) : h("div", { class: "av-sp" }),
      h("div", { class: "bub" },
        !mine && !cont ? h("div", { class: "who", style: `color:${colorFor(m.uid)}` }, S.members.get(m.uid)?.callsign || m.name) : null,
        m.photo ? h("img", { class: "chat-img", src: m.photo, alt: "Photo", loading: "lazy", onclick: () => { fill($("#member-body"), h("img", { class: "photo-big", src: m.photo, alt: "Photo" })); dlgMember.showModal(); } }) : null,
        m.text ? h("div", { class: "txt" }, m.text) : null,
        h("div", { class: "meta" }, fmtTime(m.at),
          mine ? h("button", { class: "msg-del", onclick: (e) => {
            const b = e.currentTarget;
            if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "tap again"; setTimeout(() => { b.dataset.armed = ""; b.textContent = "delete"; }, 3000); return; }
            S.store.deleteChat(S.crew.id, m.id);
          } }, "delete") : null)));
    out.push(bubble);
    prev = m;
  }
  fill(list, ...(out.length ? out : [h("div", { class: "empty" }, h("div", { class: "big" }, "Say something"), h("p", {}, "Messages here go to everyone in the crew."))]));
  if (jump || nearBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}
$("#btn-chat").addEventListener("click", () => setView(S.view === "chat" ? S.prevView || "map" : "chat"));
$("#btn-chat-close").addEventListener("click", () => setView(S.prevView || "map"));
const chatIn = $("#in-chat");
chatIn.addEventListener("input", () => { chatIn.style.height = "auto"; chatIn.style.height = Math.min(chatIn.scrollHeight, 120) + "px"; });
chatIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); $("#form-chat").requestSubmit(); } });
$("#in-chat-photo").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try { chatPhoto = await capSize(await shrinkImage(f, 1100, 0.78), 650000); const img = $("#chat-photo-preview"); img.src = chatPhoto; img.hidden = false; }
  catch { toast("Couldn't read that photo. Try a JPG or PNG."); }
});
$("#chat-photo-preview").addEventListener("click", () => { chatPhoto = ""; $("#chat-photo-preview").hidden = true; });
$("#form-chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = chatIn.value.trim().slice(0, 1000);
  if (!text && !chatPhoto) return;
  const msg = { uid: S.uid, name: S.profile.callsign, text, at: Date.now(), ...(chatPhoto ? { photo: chatPhoto } : {}) };
  chatIn.value = ""; chatIn.style.height = "auto";
  const photo = chatPhoto;
  chatPhoto = ""; $("#chat-photo-preview").hidden = true;
  try {
    await S.store.sendChat(S.crew.id, msg);
    renderChat(true);
    notifyCrew("chat", { title: `💬 ${S.profile.callsign}`, body: text ? text.slice(0, 150) : "📷 Sent a photo", url: "./?chat=1", tag: `chat-${S.crew.id}` });
  } catch {
    chatIn.value = text; chatPhoto = photo;
    toast("Couldn't send. Check your signal and try again.");
  }
});

/* ---------------- launch timer: 0–100 km/h and quarter mile ---------------- */
// Uses GPS speed. The exact start is worked out from the first two moving readings,
// and the 100 km/h and 402 m marks are found between readings, so 1-second GPS still gives good times.
const V60 = 60 / 3.6, V100 = 100 / 3.6, QM = 402.336;
let launch = null; // {state, cls, venue, car, ...}
function setSpeedMode(mode, skipSave) {
  if (!["speed", "t60", "t100", "qm"].includes(mode)) mode = "speed";
  S.speedMode = mode;
  if (!skipSave) lsSet("speedMode", mode);
  document.querySelectorAll("#view-speed .seg3 button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  for (const k of ["speed", "t60", "t100", "qm"]) $(`#pane-${k}`).hidden = k !== mode;
  $("#btn-addspeed").hidden = mode !== "speed";
  renderBoard(mode);
  renderSession();
}
document.querySelectorAll("#view-speed .seg3 button").forEach((b) => b.addEventListener("click", () => setSpeedMode(b.dataset.mode)));

function armLaunch() {
  if (session) { toast("End your speed session first."); return; }
  const active = S.myVehicles.find((v) => v.active);
  launch = { state: "armed", cls: $("#in-launch-class")?.value || "Drag strip", venue: $("#in-launch-venue")?.value.trim() || "", car: active?.name || "", stillSince: null };
  lsSet("launchPrefs", { cls: launch.cls, venue: launch.venue });
  updateWakeLock();
  renderLaunch();
}
function cancelLaunch() { launch = null; updateWakeLock(); renderLaunch(); }

function launchFeed(fix, v, derivedDt) {
  if (!launch || launch.state === "done" || v == null || fix.acc > 25) return;
  // a speed worked out from two positions is the average between them, so it belongs to the midpoint in time
  const t = derivedDt ? fix.t - derivedDt / 2 : fix.t;
  const L = launch;
  if (L.state === "armed" || L.state === "ready") {
    if (v < 0.6) {
      // a worked-out speed of ~0 only proves the car was still at the START of that interval
      const stillAt = derivedDt ? fix.t - derivedDt : fix.t;
      L.stillSince ??= stillAt; L.lastStill = stillAt;
      if (L.state === "armed" && t - L.stillSince >= 1500) { L.state = "ready"; renderLaunch(); }
      return;
    }
    L.stillSince = null;
    if (L.state === "armed") return; // rolling: wait for a full stop
    if (v < 1.0) return;
    Object.assign(L, { state: "running", first: { t, v }, prev: { t, v }, dist: 0, top: v, t60: null, t100: null, qm: null, trap: null, tStart: null });
    renderLaunch();
    return;
  }
  // running
  const p = L.prev;
  const dt = (t - p.t) / 1000;
  if (dt <= 0) return;
  if (dt > 3.5) return finishLaunch("GPS signal dropped during the run.");
  if (L.tStart == null) {
    // extrapolate back to zero speed with the acceleration between the first two readings
    const a = (v - L.first.v) / ((t - L.first.t) / 1000);
    let ts = a > 0.3 ? L.first.t - (L.first.v / a) * 1000 : L.first.t - 500;
    ts = Math.min(L.first.t, Math.max(ts, (L.lastStill ?? L.first.t - 3000)));
    L.tStart = ts;
    L.dist = (L.first.v / 2) * ((L.first.t - ts) / 1000);
    // the 100 / 402 m marks can't fall before the first reading at these speeds, so carry on below
  }
  const d0 = L.dist;
  L.dist += ((p.v + v) / 2) * dt;
  if (L.t60 == null && p.v < V60 && v >= V60) L.t60 = (p.t + ((V60 - p.v) / (v - p.v)) * (t - p.t) - L.tStart) / 1000;
  if (L.t100 == null && p.v < V100 && v >= V100) L.t100 = (p.t + ((V100 - p.v) / (v - p.v)) * (t - p.t) - L.tStart) / 1000;
  if (L.qm == null && d0 < QM && L.dist >= QM) {
    const f = (QM - d0) / (L.dist - d0);
    L.qm = (p.t + f * (t - p.t) - L.tStart) / 1000;
    L.trap = Math.round((p.v + f * (v - p.v)) * 3.6);
  }
  L.top = Math.max(L.top, v);
  L.prev = { t, v };
  L.now = v;
  if (L.qm != null) return finishLaunch();
  if (v < L.top - 4) return finishLaunch(L.t60 == null ? "You lifted before 60 km/h." : L.t100 == null ? "You lifted before 100 km/h." : null);
  if ((t - L.tStart) / 1000 > 40) return finishLaunch("Run took longer than 40 s.");
  renderLaunch();
}
async function finishLaunch(why) {
  const L = launch;
  const t60 = L.t60 != null && L.t60 > 1 && L.t60 < 20 ? Math.round(L.t60 * 100) / 100 : null;
  const t100 = L.t100 != null && L.t100 > 1.8 && L.t100 < 30 ? Math.round(L.t100 * 100) / 100 : null;
  const qm = L.qm != null && L.qm > 7 && L.qm < 35 ? Math.round(L.qm * 100) / 100 : null;
  launch = { ...L, state: "done", result: { t60, t100, qm, trap: qm ? L.trap : null, why } };
  updateWakeLock();
  renderLaunch();
  if (t60 == null && t100 == null && qm == null) return;
  bumpStat("launches");
  try {
    await S.store.addBoard(S.crew.id, "launch", { uid: S.uid, t60, t100, qm, trap: qm ? L.trap : null, cls: L.cls, car: L.car, venue: L.venue, method: "GPS (auto)", photo: "", witnesses: [], createdAt: Date.now() });
    const rec = [t60 != null && claimRecord("t60", t60, L.car), t100 != null && claimRecord("t100", t100, L.car), qm != null && claimRecord("qm", qm, L.car)].some(Boolean);
    toast(rec ? "That's a new crew record! 🏆" : "Run saved to the board");
  } catch { toast("Couldn't save the run. Check your signal."); }
}
function renderLaunch() {
  const box = $("#speed-session");
  if (!box || S.view !== "speed" || S.speedMode === "speed") return;
  const prefs = lsGet("launchPrefs", { cls: "Drag strip", venue: "" });
  const L = launch;
  if (!L) {
    box.className = "session";
    fill(box, 
      h("div", {}, h("div", { class: "car-name" }, "Launch timer"),
        h("div", { class: "s", style: "color:var(--muted);margin-top:4px" }, "Times 0–60, 0–100 km/h and the ¼ mile (402 m) from GPS. Arm it, come to a dead stop, then launch. Only on a track, drag strip or closed road.")),
      h("div", { class: "grid2" },
        h("div", {}, h("label", { class: "lbl", for: "in-launch-class" }, "Where"),
          h("select", { id: "in-launch-class" }, ...BOARDS.t100.classes.map((c) => h("option", c === prefs.cls ? { selected: true } : {}, c)))),
        h("div", {}, h("label", { class: "lbl", for: "in-launch-venue" }, "Venue"), h("input", { id: "in-launch-venue", maxlength: "40", placeholder: "Tarlton", value: prefs.venue || "" }))),
      h("button", { class: "btn primary wide", onclick: armLaunch }, "Arm launch timer"),
      h("div", { class: "s", style: "color:var(--muted);font-size:12px;text-align:center" }, "Phone GPS is accurate to about ±0.2 s. Mount the phone, keep THE CREW open and the screen on."));
    return;
  }
  if (L.state === "done") {
    const r = L.result;
    box.className = "session";
    fill(box, 
      h("div", { class: "car-name" }, r.t60 || r.t100 || r.qm ? "Run complete" : "No time recorded"),
      r.t60 || r.t100 || r.qm ? h("div", { class: "launch-res four" },
        h("div", {}, h("b", {}, r.t60 ? r.t60.toFixed(2) : "–"), h("span", {}, "0–60 s")),
        h("div", {}, h("b", {}, r.t100 ? r.t100.toFixed(2) : "–"), h("span", {}, "0–100 s")),
        h("div", {}, h("b", {}, r.qm ? r.qm.toFixed(2) : "–"), h("span", {}, "¼ mile s")),
        h("div", {}, h("b", {}, r.trap ? String(r.trap) : "–"), h("span", {}, "trap km/h"))) : null,
      r.why ? h("div", { class: "s", style: "color:var(--muted)" }, r.why) : null,
      h("div", { class: "btn-row" }, h("button", { class: "btn primary sm", onclick: armLaunch }, "Run again"), h("button", { class: "btn ghost sm", onclick: cancelLaunch }, "Done")));
    return;
  }
  const running = L.state === "running";
  const el = running && L.tStart ? ((L.prev.t - L.tStart) / 1000).toFixed(1) : "0.0";
  box.className = `session live${L.state === "ready" ? " ready" : ""}`;
  fill(box, 
    h("div", { class: "s", style: "color:var(--fg);font-weight:600;text-align:center" },
      L.state === "armed" ? (S.pos ? "Armed · come to a complete stop" : "Armed · waiting for GPS…") : L.state === "ready" ? "READY · launch when you want" : "Timing…"),
    h("div", { class: "gauge" },
      h("div", { class: "now" }, String(Math.round((running ? L.now || 0 : (S.pos?.speed || 0)) * 3.6)), h("small", {}, "km/h")),
      h("div", { class: "meta" },
        h("div", {}, h("b", {}, el), "seconds"),
        h("div", {}, h("b", {}, L.t60 != null ? L.t60.toFixed(2) : "–"), "0–60"),
        h("div", {}, h("b", {}, L.t100 != null ? L.t100.toFixed(2) : "–"), "0–100"),
        h("div", {}, h("b", {}, running ? `${Math.round(L.dist || 0)}` : "0"), "metres"))),
    h("button", { class: "btn danger wide", onclick: cancelLaunch }, "Cancel"));
}

// Tell the crew when you take #1. Returns true when this beats everyone else.
function claimRecord(key, val, car) {
  const cfg = BOARDS[key];
  const others = (S.boards[key] || []).filter((b) => b.uid !== S.uid && b[cfg.field] != null).map((b) => b[cfg.field]);
  if (!others.length) return false;
  const best = cfg.asc ? Math.min(...others) : Math.max(...others);
  if (!(cfg.asc ? val < best : val > best)) return false;
  notifyCrew("record", { title: `🏆 New crew record: ${S.profile.callsign}`, body: `${BOARD_TITLE[key]} · ${Number(val).toFixed(cfg.dec)} ${cfg.unit}${car ? ` in the ${car}` : ""} · tap to see the board`, url: `./?board=${key}`, tag: `record-${key}` });
  return true;
}

/* ---------------- drive recap ---------------- */
// A drive starts when you get going and ends after 4 minutes parked (or if the app was closed for 10+ minutes).
let drive = null;
const driveKey = () => `drive:${S.uid}`, drivesKey = () => `drives:${S.uid}`;
function loadDrive() {
  drive = lsGet(driveKey(), null);
  checkDriveEnd();
  if (DEMO && !lsGet(drivesKey(), []).length) seedDemoDrive();
}
function driveFeed(fix, v) {
  if (fix.acc > 40) return;
  const t = fix.t;
  if (!drive) {
    if (v == null || v < 5) return;
    drive = { start: t, moving: t, last: t, pts: [[+fix.lat.toFixed(5), +fix.lng.toFixed(5), t]], dist: 0, top: 0, cells0: S.explored.size };
  }
  const lp = drive.pts[drive.pts.length - 1];
  const d = haversine({ lat: lp[0], lng: lp[1] }, fix), dt = (t - lp[2]) / 1000;
  if (d > 30 && d < 3000 && dt > 0 && d / dt < 75) {
    drive.dist += d;
    drive.pts.push([+fix.lat.toFixed(5), +fix.lng.toFixed(5), t]);
    if (drive.pts.length > 1500) drive.pts = drive.pts.filter((_, i) => i % 2 === 0 || i === drive.pts.length - 1);
  }
  if (v != null && fix.acc <= 20 && v < 90) {
    drive.recent = [...(drive.recent || []), v].slice(-3);
    if (drive.recent.length === 3) drive.top = Math.max(drive.top, Math.min(...drive.recent)); // held over 3 readings
  }
  if (v != null && v > 1.5) drive.moving = t;
  drive.last = t;
  if (t - (drive.saved || 0) > 15000) { drive.saved = t; lsSet(driveKey(), drive); }
  checkDriveEnd();
}
function checkDriveEnd() {
  if (!drive) return;
  const now = Date.now();
  if (now - drive.moving > 4 * 60000 || now - drive.last > 10 * 60000) finishDrive();
}
function finishDrive() {
  const d = drive;
  drive = null;
  lsSet(driveKey(), null);
  if (!d || d.dist < 1500) return;
  const end = d.moving;
  const rec = {
    id: `d${d.start.toString(36)}`, start: d.start, end, km: Math.round(d.dist / 100) / 10,
    top: Math.round(d.top * 3.6), avg: Math.round((d.dist / Math.max(1, (end - d.start) / 1000)) * 3.6),
    tiles: Math.max(0, S.explored.size - (d.cells0 || S.explored.size)), car: S.myVehicles.find((v) => v.active)?.name || "",
    pts: simplifyPts(d.pts.map((p) => [p[0], p[1]]), 400),
  };
  lsSet(drivesKey(), [rec, ...lsGet(drivesKey(), [])].slice(0, 30));
  bumpStat("drives");
  const hr = new Date(d.start).getHours();
  if (hr < 4) bumpStat("night");
  if (S.view === "explore") renderDrives();
  if (!document.hidden) openRecap(rec);
  else toast(`Drive saved · ${rec.km} km`);
}
function simplifyPts(pts, max) {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  return Array.from({ length: max }, (_, i) => pts[Math.min(pts.length - 1, Math.round(i * step))]).concat([pts[pts.length - 1]]);
}
function seedDemoDrive() {
  import("./store-demo.js").then(({ DEMO_ME_ROUTE }) => {
    const pts = DEMO_ME_ROUTE.map((p) => [p.lat, p.lng]);
    let km = 0; for (let i = 1; i < pts.length; i++) km += haversine({ lat: pts[i - 1][0], lng: pts[i - 1][1] }, { lat: pts[i][0], lng: pts[i][1] }) / 1000;
    const start = Date.now() - 26 * 3600000;
    lsSet(drivesKey(), [{ id: "ddemo", start, end: start + 41 * 60000, km: Math.round(km * 10) / 10, top: 118, avg: Math.round(km / (41 / 60)), tiles: 212, car: "Hellux", pts }]);
    if (S.view === "explore") renderDrives();
  });
}
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`; };
function renderDrives() {
  const box = $("#drives");
  if (!box) return;
  const list = lsGet(drivesKey(), []);
  fill(box, ...(list.length ? list.slice(0, 10).map((d) => {
    const s = new Date(d.start);
    return h("button", { class: "drive", onclick: () => openRecap(d) },
      routeSvg(d.pts, 64, 48),
      h("div", { class: "grow" }, h("div", { class: "n" }, `${d.km} km · ${fmtDur(d.end - d.start)}`),
        h("div", { class: "s" }, `${dayLabel(d.start)} ${fmtTime(d.start)}${d.tiles ? ` · ${d.tiles} new road tiles` : ""}`)),
      h("span", { class: "s", style: "color:var(--accent)" }, "Recap ›"));
  }) : [h("div", { class: "empty", style: "padding:18px" }, h("p", {}, "Drive with THE CREW open and you'll get a recap card after each drive, ready to share."))]));
}
function routeSvg(pts, w, hgt) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${hgt}`); svg.setAttribute("class", "route-mini"); svg.setAttribute("aria-hidden", "true");
  const xy = projectPts(pts, w, hgt, 5);
  const path = document.createElementNS(ns, "polyline");
  path.setAttribute("points", xy.map((p) => p.join(",")).join(" "));
  path.setAttribute("fill", "none"); path.setAttribute("stroke", "#ffb020"); path.setAttribute("stroke-width", "2"); path.setAttribute("stroke-linejoin", "round"); path.setAttribute("stroke-linecap", "round");
  svg.append(path);
  return svg;
}
function projectPts(pts, w, hgt, pad) {
  if (!pts?.length) return [];
  const lat0 = pts[0][0] * Math.PI / 180;
  const raw = pts.map(([la, ln]) => [ln * Math.cos(lat0), -la]);
  const xs = raw.map((p) => p[0]), ys = raw.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const sc = Math.min((w - 2 * pad) / Math.max(maxX - minX, 1e-9), (hgt - 2 * pad) / Math.max(maxY - minY, 1e-9));
  const ox = (w - (maxX - minX) * sc) / 2, oy = (hgt - (maxY - minY) * sc) / 2;
  return raw.map(([x, y]) => [+((x - minX) * sc + ox).toFixed(1), +((y - minY) * sc + oy).toFixed(1)]);
}
const dlgRecap = $("#dlg-recap");
let recapBlob = null, recapDrive = null;
$("#btn-recap-close").addEventListener("click", () => dlgRecap.close());
async function openRecap(d) {
  recapDrive = d; recapBlob = null;
  const stat = (v, k) => h("div", { class: "stat" }, h("div", { class: "v", style: "font-size:24px" }, v), h("div", { class: "k" }, k));
  const img = h("img", { class: "recap-img", alt: "Drive recap image" });
  fill($("#recap-body"), 
    h("div", { class: "car-name" }, "Drive recap"),
    h("div", { class: "s", style: "color:var(--muted);margin:4px 0 10px" }, `${dayLabel(d.start)} · ${fmtTime(d.start)}–${fmtTime(d.end)}${d.car ? ` · ${d.car}` : ""}`),
    img,
    h("div", { class: "stats", style: "margin-top:10px" }, stat(`${d.km}`, "km"), stat(fmtDur(d.end - d.start), "time"), stat(`${d.tiles || 0}`, "new tiles")));
  dlgRecap.showModal();
  const canvas = await drawRecap(d);
  img.src = canvas.toDataURL("image/jpeg", 0.9);
  canvas.toBlob((b) => { recapBlob = b; }, "image/jpeg", 0.92);
}
$("#btn-recap-share").addEventListener("click", async () => {
  if (!recapBlob) { toast("Still making the image…"); return; }
  const name = `the-crew-drive-${new Date(recapDrive.start).toISOString().slice(0, 10)}.jpg`;
  const file = new File([recapBlob], name, { type: "image/jpeg" });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: "THE CREW drive" }); return; }
  } catch (e) { if (e?.name === "AbortError") return; }
  const a = h("a", { href: URL.createObjectURL(recapBlob), download: name });
  document.body.append(a); a.click(); a.remove();
  toast("Image saved");
});
async function drawRecap(d) {
  try { await document.fonts.ready; await document.fonts.load("800 80px 'Saira Condensed'"); } catch {}
  const W = 1080, H = 1350;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  const bg = g.createRadialGradient(W / 2, 0, 50, W / 2, 200, 1300);
  bg.addColorStop(0, "#3a2706"); bg.addColorStop(0.45, "#121821"); bg.addColorStop(1, "#0b0f15");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // faint grid like a night map
  g.strokeStyle = "rgba(255,255,255,.035)"; g.lineWidth = 2;
  for (let x = 0; x < W; x += 60) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y < H; y += 60) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  const disp = "'Saira Condensed','Arial Narrow',sans-serif", body = "Barlow,system-ui,sans-serif";
  g.fillStyle = "#ffb020"; g.font = `800 64px ${disp}`; g.textBaseline = "top";
  g.fillText("THE CREW", 70, 64);
  g.fillStyle = "#8b97a8"; g.font = `600 30px ${body}`;
  g.fillText((S.crew?.name || "").toUpperCase(), 72, 138);
  g.textAlign = "right"; g.fillStyle = "#e8edf4"; g.font = `600 30px ${body}`;
  const ds = new Date(d.start);
  g.fillText(`${DAYS[ds.getDay()]} ${ds.getDate()} ${MONTHS[ds.getMonth()]} ${ds.getFullYear()}`, W - 70, 74);
  g.fillStyle = "#8b97a8"; g.fillText(`${fmtTime(d.start)} – ${fmtTime(d.end)}`, W - 70, 114);
  g.textAlign = "left";
  // route
  const box = { x: 70, y: 210, w: W - 140, h: 640 };
  g.fillStyle = "rgba(21,27,36,.75)"; roundRect(g, box.x, box.y, box.w, box.h, 28); g.fill();
  g.strokeStyle = "#2a3443"; g.lineWidth = 2; g.stroke();
  const xy = projectPts(d.pts, box.w, box.h, 60).map(([x, y]) => [x + box.x, y + box.y]);
  if (xy.length > 1) {
    g.lineJoin = "round"; g.lineCap = "round";
    g.shadowColor = "rgba(255,176,32,.8)"; g.shadowBlur = 30;
    g.strokeStyle = "#ffb020"; g.lineWidth = 9;
    g.beginPath(); xy.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
    g.shadowBlur = 0;
    g.strokeStyle = "#fff3d6"; g.lineWidth = 3; g.stroke();
    const dot = ([x, y], col) => { g.fillStyle = col; g.beginPath(); g.arc(x, y, 16, 0, Math.PI * 2); g.fill(); g.strokeStyle = "#0b0f15"; g.lineWidth = 5; g.stroke(); };
    dot(xy[0], "#3ddc97"); dot(xy[xy.length - 1], "#ff5d5d");
  }
  // stats
  const stats = [[`${d.km}`, "KM DRIVEN"], [fmtDur(d.end - d.start).toUpperCase(), "TIME"], [`${d.avg || 0}`, "AVG KM/H"], [`${d.tiles || 0}`, "NEW ROAD TILES"]];
  const sw = (W - 140 - 3 * 24) / 4;
  stats.forEach(([v, k], i) => {
    const x = 70 + i * (sw + 24), y = 890;
    g.fillStyle = "rgba(21,27,36,.9)"; roundRect(g, x, y, sw, 170, 22); g.fill(); g.strokeStyle = "#2a3443"; g.lineWidth = 2; g.stroke();
    g.fillStyle = i === 0 ? "#ffb020" : "#e8edf4"; g.font = `800 ${v.length > 6 ? 54 : 70}px ${disp}`;
    g.fillText(v, x + 24, y + 26);
    g.fillStyle = "#8b97a8"; g.font = `600 22px ${body}`;
    g.fillText(k, x + 24, y + 122);
  });
  // driver
  const me = S.profile.callsign || "";
  g.fillStyle = colorFor(S.uid); g.beginPath(); g.arc(110, 1170, 40, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#0d1117"; g.font = `800 44px ${disp}`; g.textAlign = "center"; g.fillText(initial(me), 110, 1146); g.textAlign = "left";
  g.fillStyle = "#e8edf4"; g.font = `800 48px ${disp}`; g.fillText(me.toUpperCase(), 170, 1126);
  g.fillStyle = "#8b97a8"; g.font = `500 28px ${body}`; g.fillText(d.car || "", 172, 1180);
  g.fillStyle = "#5b6676"; g.font = `500 24px ${body}`; g.textAlign = "right";
  g.fillText("Recorded with THE CREW", W - 70, 1260); g.textAlign = "left";
  return c;
}
function roundRect(g, x, y, w, hh, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

/* ---------------- meets: turning up, host arrived, reminders ---------------- */
function meetPresence(fix) {
  if (!S.meets?.length || fix.acc > 60) return;
  const now = Date.now();
  for (const m of S.meets) {
    if (!m.place) continue;
    const dt = now - m.when;
    if (dt < -60 * 60000 || dt > 150 * 60000) continue;
    if (haversine(fix, m.place) > 250) continue;
    if (dt > -45 * 60000 && !lsGet(`att:${m.id}`, false)) { lsSet(`att:${m.id}`, true); bumpStat("meets"); }
    if (m.hostId === S.uid && !lsGet(`arr:${m.id}`, false) && !S.ghost && !S.homeHidden) {
      lsSet(`arr:${m.id}`, true);
      notifyCrew("arrived", { title: `📍 ${S.profile.callsign} is at ${m.title}`, body: `${m.place.label || "The meet spot"} · ${(m.going || []).length} going · tap for directions`, url: `./?meet=${m.id}`, tag: `arr-${m.id}` });
    }
  }
}
async function remindApi(body) {
  if (!NOTIFY_URL || DEMO || !S.crew) return false;
  try {
    const token = await S.store.getToken();
    if (!token) return false;
    const r = await fetch(NOTIFY_URL.replace(/\/$/, "") + "/remind", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ crew: S.crew.id, ...body }), keepalive: true,
    });
    return r.ok;
  } catch { return false; }
}
// Keep my 1-hour-before reminders in step with the meets I'm going to.
let syncingReminders = false;
async function syncReminders() {
  if (!NOTIFY_URL || DEMO || !S.crew || !S.meetsLoaded || syncingReminders) return;
  syncingReminders = true;
  try {
    const sub = await currentSub().catch(() => null);
    const on = !!sub && pushPrefs.meet !== false;
    const key = `reminders:${S.crew.id}:${S.uid}`;
    const done = lsGet(key, {});
    const now = Date.now();
    for (const m of S.meets) {
      const want = on && (m.going || []).includes(S.uid) && m.when > now + 65 * 60000; // too close for an "in 1 hour" reminder
      const sig = `${m.when}|${m.title}|${m.place?.label || ""}|${sub?.endpoint || ""}`;
      if (want && done[m.id] !== sig) {
        if (await remindApi({ op: "set", meet: m.id, when: m.when, title: m.title, place: m.place?.label || "", sub: JSON.stringify(sub) })) done[m.id] = sig;
      } else if (!want && done[m.id]) {
        if (await remindApi({ op: "unset", meet: m.id })) delete done[m.id];
      }
    }
    for (const id of Object.keys(done)) if (!S.meets.some((m) => m.id === id)) { await remindApi({ op: "unset", meet: id }); delete done[id]; }
    lsSet(key, done);
  } finally { syncingReminders = false; }
}

/* ---------------- crew ---------------- */
function renderCrew() {
  renderMerchCard();
  renderFounders();
  renderBans();
  const maker = S.members.get(S.crew.ownerId)?.callsign;
  $("#app-credit").textContent = maker ? `THE CREW app · built by ${S.crew.ownerId === S.uid ? "you" : maker} 🛠️` : "";
  renderHome();
  renderPush();
  const ul = $("#crew-list");
  const list = [...S.members.values()].sort((a, b) => (a.id === S.uid ? -1 : b.id === S.uid ? 1 : (b.updatedAt || 0) - (a.updatedAt || 0)));
  ul.replaceChildren(...list.map((m) => {
    const st = m.id === S.uid ? (S.ghost ? "ghost" : S.pos ? "live" : "off") : memberState(m);
    const label = { live: "Live", stale: m.updatedAt ? fmtAgo(m.updatedAt) : "Away", seen: fmtAgo(m.updatedAt), ghost: "Ghost", off: m.updatedAt ? fmtAgo(m.updatedAt) : "Offline" }[st];
    const dist = m.id !== S.uid && S.pos && ["live", "stale"].includes(st) ? fmtKm(haversine(S.pos, m)) + " away" : "";
    const role = roleTag(m.id);
    return h("li", { onclick: () => openMember(m.id) }, avatar(m.id, m.callsign),
      h("div", { class: "grow" }, h("div", { class: "n" }, m.id === S.uid ? `${m.callsign} (you)` : m.callsign, ...tagEls(m.id)),
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
  await S.store.updateMember(S.crew.id, S.uid, { callsign: c, phone, phoneKey: phoneKey(phone) });
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
$("#btn-signout").addEventListener("click", async () => { await flushExplored(); teardown(); S.store.signOut(); });

// member sheet
const dlgMember = $("#dlg-member");
$("#btn-member-close").addEventListener("click", () => dlgMember.close());
async function openMember(id) {
  const m = S.members.get(id);
  if (!m) return;
  const st = id === S.uid ? (S.ghost ? "ghost" : "live") : memberState(m);
  const where = id === S.uid ? S.pos : ["live", "stale", "seen"].includes(st) ? m : null;
  const body = $("#member-body");
  body.replaceChildren(
    h("div", { style: "display:flex;gap:12px;align-items:center;margin-bottom:12px" }, avatar(id, m.callsign),
      h("div", { class: "grow" }, h("div", { class: "car-name" }, m.callsign, ...tagEls(id, true)),
        h("div", { class: "s", style: "color:var(--muted)" },
          st === "ghost" ? "Ghost mode" : st === "live" ? (m.speed > 1.5 ? `Driving · ${kmh(m.speed)} km/h` : "Live · stopped") : m.updatedAt ? `Last seen ${fmtAgo(m.updatedAt)}${st === "seen" ? " (pin shows where)" : ""}` : "Hasn't shared a location yet",
          where && id !== S.uid && S.pos ? ` · ${fmtKm(haversine(S.pos, where))} away` : ""))),
    where && id !== S.uid ? h("div", { class: "btn-row", style: "margin-bottom:14px" },
      h("button", { class: "btn primary sm", onclick: () => { dlgMember.close(); setView("map"); S.map.flyTo([where.lat, where.lng], 15); } }, "Show on map"),
      h("a", { class: "btn ghost sm", href: `https://www.google.com/maps/dir/?api=1&destination=${where.lat},${where.lng}`, target: "_blank", rel: "noopener" }, st === "seen" ? "Drive there" : "Drive to them")) : null,
    m.phone && id !== S.uid ? h("div", { class: "phone-row" },
      h("div", { class: "grow" }, h("div", { class: "lbl" }, "Phone"), h("div", { class: "n", style: "margin-top:4px;user-select:all" }, m.phone)),
      h("a", { class: "btn ghost sm", href: `tel:${intlPhone(m.phone)}` }, "Call"),
      h("a", { class: "btn ghost sm", href: `https://wa.me/${intlPhone(m.phone).slice(1)}`, target: "_blank", rel: "noopener" }, "WhatsApp")) : null,
    (() => { const got = BADGES.filter((b) => badgeEarned(b, id)); return got.length ? h("div", { class: "mini-badges" }, ...got.map((b) => h("span", { title: b.desc }, b.icon, " ", b.name))) : null; })(),
    S.crew.ownerId === S.uid && id !== S.uid ? h("div", { class: "remove-box" },
      h("label", { class: "check" }, h("input", { type: "checkbox", id: "in-block", checked: true }), "Block from rejoining with the invite code"),
      h("button", { class: "btn danger sm", onclick: (e) => removeMember(id, e.currentTarget) }, "Remove from crew")) : null,
    h("div", { class: "lbl", style: "margin:4px 0 10px" }, "Garage"),
    h("div", { class: "cars", id: "member-cars" }, h("div", { class: "s", style: "color:var(--muted)" }, "Loading…")));
  dlgMember.showModal();
  const cars = await S.store.getVehicles(id).catch(() => []);
  const box = $("#member-cars");
  if (!box) return;
  box.replaceChildren(...(cars.length ? cars.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0)).map((v) => carCard(v, null, id)) : [h("div", { class: "s", style: "color:var(--muted)" }, "No cars in the garage yet.")]));
}

// refresh "x min ago" labels and stale markers
setInterval(() => { if (S.crew) { checkDriveEnd(); renderLiveStrip(); renderSos(); renderMeetPins(); if (S.view === "convoy" && S.seg === "meets") renderMeets(); renderMembers(); if (S.view === "crew") renderCrew(); } }, 30000);

boot();
