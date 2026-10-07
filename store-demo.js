// Demo backend: everything in memory, with a pretend crew driving around Pretoria.
import { densify } from "./geo.js";

const P = (lat, lng) => ({ lat, lng });
const ROUTES = {
  ruan: [P(-25.7795, 28.2766), P(-25.8023, 28.3013), P(-25.836, 28.292), P(-25.8558, 28.217), P(-25.829, 28.19), P(-25.7795, 28.2766)],
  lize: [P(-25.7826, 28.2757), P(-25.77, 28.3), P(-25.752, 28.285), P(-25.76, 28.255), P(-25.7826, 28.2757)],
  dewald: [P(-25.74, 28.12), P(-25.73, 28.05), P(-25.735, 27.95), P(-25.729, 27.87), P(-25.735, 27.95), P(-25.73, 28.05), P(-25.74, 28.12)],
  me: [P(-25.86, 28.189), P(-25.84, 28.22), P(-25.81, 28.24), P(-25.79, 28.23), P(-25.8, 28.2), P(-25.86, 28.189)],
};
export const DEMO_ME_ROUTE = densify(ROUTES.me, 30);

export function createDemoStore() {
  const uid = "me";
  const crew = { id: "KNV8X2", name: "Pretoria Night Runners", ownerId: uid };
  const paths = Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [k, densify(v, 30)]));
  const tick = { ruan: 40, lize: 10, dewald: 0 };
  const now = Date.now();
  const members = {
    ruan: { callsign: "Ruan", phone: "082 555 0101", car: { name: "Golf 7 GTI", desc: "2016 VW Golf GTI Performance" }, ghost: false, stats: { cells: 1840, km: 612 } },
    lize: { callsign: "Lize", phone: "072 555 0102", car: { name: "Rooi Gevaar", desc: "2019 VW Polo GTI" }, ghost: false, stats: { cells: 960, km: 344 } },
    dewald: { callsign: "Dewald", phone: "083 555 0103", car: { name: "Big Grunt", desc: "2021 Ford Ranger Raptor" }, ghost: false, stats: { cells: 2410, km: 1290 } },
    thabo: { callsign: "Thabo", phone: "061 555 0104", car: { name: "Pocket Rocket", desc: "2018 Ford Fiesta ST200" }, ghost: true, lat: null, lng: null, updatedAt: now - 600000, stats: { cells: 520, km: 180 } },
  };
  const vehicles = {
    me: [{ id: "v1", name: "Hellux", make: "Toyota", model: "Hilux single cab", year: "2007", colour: "White", engine: "V8", power: "", mods: ["Straight-through exhaust"], active: true, photo: "" }],
    ruan: [{ id: "r1", name: "Golf 7 GTI", make: "VW", model: "Golf GTI Performance", year: "2016", colour: "Tornado Red", engine: "2.0 TSI", power: "169", mods: ["Stage 1 remap", "Cup 2 tyres"], active: true }],
    lize: [{ id: "l1", name: "Rooi Gevaar", make: "VW", model: "Polo GTI", year: "2019", colour: "Red", engine: "2.0 TSI", power: "147", mods: ["Lowering springs"], active: true }],
    dewald: [{ id: "d1", name: "Big Grunt", make: "Ford", model: "Ranger Raptor", year: "2021", colour: "Grey", engine: "2.0 biturbo diesel", power: "157", mods: ["Rooftop tent", "Snorkel"], active: true }],
    thabo: [{ id: "t1", name: "Pocket Rocket", make: "Ford", model: "Fiesta ST200", year: "2018", colour: "Storm Grey", engine: "1.6 EcoBoost", power: "149", mods: ["Track pads"], active: true }],
  };
  let convoys = [{ id: "c1", name: "Sunday run to Hartbeespoort", dest: { lat: -25.7247, lng: 27.8486, label: "Dam wall" }, leaderId: "dewald", memberIds: ["dewald", "ruan"], active: true, createdAt: now - 1800000 }];
  const H = 3600000;
  const boards = { bass: [
    { id: "b1", uid: "dewald", db: 151.3, hz: 41, cls: "Extreme", car: "Big Grunt", setup: "4x 15\" subs, 5000 W", venue: "Menlyn Maine meet", witnesses: ["ruan", "lize"], createdAt: now - 26 * H },
    { id: "b2", uid: "ruan", db: 138.7, hz: 48, cls: "Street", car: "Golf 7 GTI", setup: "2x 12\" subs, 1500 W", venue: "Menlyn Maine meet", witnesses: ["dewald"], createdAt: now - 25 * H },
    { id: "b3", uid: "lize", db: 132.4, hz: 52, cls: "Daily", car: "Rooi Gevaar", setup: "1x 10\" sub, 600 W", venue: "Centurion Mall lot", witnesses: [], createdAt: now - 5 * H },
    { id: "b4", uid: "ruan", db: 141.9, hz: 46, cls: "Street", car: "Golf 7 GTI", setup: "2x 12\" subs, 2000 W", venue: "Zwartkops raceway", witnesses: ["lize", "thabo"], createdAt: now - 2 * H },
    { id: "b5", uid: "thabo", db: 129.5, hz: 55, cls: "Daily", car: "Pocket Rocket", setup: "Factory + 8\" under-seat", venue: "Zwartkops raceway", witnesses: ["ruan"], createdAt: now - 90 * 60000 },
  ], speed: [
    { id: "s1", uid: "ruan", kmh: 218, cls: "Track", car: "Golf 7 GTI", method: "GPS (auto)", venue: "Zwartkops", witnesses: ["lize"], createdAt: now - 30 * H },
    { id: "s2", uid: "thabo", kmh: 204, cls: "Track", car: "Pocket Rocket", method: "Dragy", venue: "Zwartkops", witnesses: ["ruan", "dewald"], createdAt: now - 30 * H },
    { id: "s3", uid: "dewald", kmh: 171, cls: "Drag strip", car: "Big Grunt", method: "GPS (auto)", venue: "Tarlton", witnesses: [], createdAt: now - 6 * H },
    { id: "s4", uid: "lize", kmh: 186, cls: "Track", car: "Rooi Gevaar", method: "GPS (auto)", venue: "Red Star Raceway", witnesses: ["thabo"], createdAt: now - 3 * H },
  ] };

  const subs = { members: new Set(), convoys: new Set(), vehicles: new Map(), boards: { bass: new Set(), speed: new Set() } };
  const emitBoard = (c) => { const l = boards[c].map((b) => ({ ...b, witnesses: [...b.witnesses] })); subs.boards[c].forEach((cb) => cb(l)); };
  const emitMembers = () => { const l = Object.entries(members).map(([id, m]) => ({ id, ...m })); subs.members.forEach((cb) => cb(l)); };
  const emitConvoys = () => { const l = convoys.filter((c) => c.active).map((c) => ({ ...c, memberIds: [...c.memberIds] })); subs.convoys.forEach((cb) => cb(l)); };
  const emitVehicles = (u) => (subs.vehicles.get(u) || new Set()).forEach((cb) => cb((vehicles[u] || []).map((v) => ({ ...v }))));

  function step() {
    for (const k of Object.keys(tick)) {
      const path = paths[k];
      tick[k] = (tick[k] + 1) % path.length;
      const a = path[tick[k]], b = path[(tick[k] + 1) % path.length];
      Object.assign(members[k], { lat: a.lat, lng: a.lng, speed: k === "lize" ? 14 : 22, heading: Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180 / Math.PI, updatedAt: Date.now() });
    }
    emitMembers();
  }
  step();
  setInterval(step, 1500);

  const ok = (v) => Promise.resolve(v);
  let profile = { callsign: "Me", phone: "082 555 0100", crewId: crew.id };
  return {
    mode: "demo",
    onAuth(cb) { setTimeout(() => cb({ uid, anon: true }), 0); return () => {}; },
    signInAnon: () => ok(), signInGoogle: () => ok(), signOut: () => { location.reload(); return ok(); },
    getProfile: () => ok({ ...profile }),
    saveProfile: (_u, d) => { profile = { ...profile, ...d }; return ok(); },
    createCrew: () => ok(crew.id),
    getCrew: () => ok({ ...crew }),
    joinCrew: (_c, u, d) => { members[u] = { ...(members[u] || {}), ...d }; emitMembers(); return ok(); },
    leaveCrew: () => ok(),
    updateMember: (_c, u, d) => { members[u] = { ...(members[u] || {}), ...d }; emitMembers(); return ok(); },
    onMembers: (_c, cb) => { subs.members.add(cb); emitMembers(); return () => subs.members.delete(cb); },
    onConvoys: (_c, cb) => { subs.convoys.add(cb); emitConvoys(); return () => subs.convoys.delete(cb); },
    createConvoy: (_c, d) => { const id = "c" + Date.now(); convoys.push({ id, ...d }); emitConvoys(); return ok(id); },
    joinConvoy: (_c, id, u) => { const c = convoys.find((x) => x.id === id); if (c && !c.memberIds.includes(u)) c.memberIds.push(u); emitConvoys(); return ok(); },
    leaveConvoy: (_c, id, u) => { const c = convoys.find((x) => x.id === id); if (c) c.memberIds = c.memberIds.filter((x) => x !== u); emitConvoys(); return ok(); },
    endConvoy: (_c, id) => { const c = convoys.find((x) => x.id === id); if (c) c.active = false; emitConvoys(); return ok(); },
    onBoard: (_c, coll, cb) => { subs.boards[coll].add(cb); emitBoard(coll); return () => subs.boards[coll].delete(cb); },
    addBoard: (_c, coll, data) => { const id = coll[0] + Date.now(); boards[coll].push({ id, ...data }); emitBoard(coll); return ok(id); },
    witnessBoard: (_c, coll, id, u) => { const b = boards[coll].find((x) => x.id === id); if (b && !b.witnesses.includes(u)) b.witnesses.push(u); emitBoard(coll); return ok(); },
    deleteBoard: (_c, coll, id) => { boards[coll] = boards[coll].filter((x) => x.id !== id); emitBoard(coll); return ok(); },
    onVehicles: (u, cb) => { if (!subs.vehicles.has(u)) subs.vehicles.set(u, new Set()); subs.vehicles.get(u).add(cb); emitVehicles(u); return () => subs.vehicles.get(u).delete(cb); },
    getVehicles: (u) => ok((vehicles[u] || []).map((v) => ({ ...v }))),
    saveVehicle: (u, v) => { const l = vehicles[u] || (vehicles[u] = []); const i = l.findIndex((x) => x.id === v.id); if (i >= 0) l[i] = { ...v }; else l.push({ ...v }); emitVehicles(u); return ok(); },
    deleteVehicle: (u, id) => { vehicles[u] = (vehicles[u] || []).filter((x) => x.id !== id); emitVehicles(u); return ok(); },
  };
}
