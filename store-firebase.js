// Live backend: Firebase Auth + Firestore.
const V = "10.12.2";
const base = `https://www.gstatic.com/firebasejs/${V}`;

export async function createFirebaseStore(config) {
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const {
    getAuth, onAuthStateChanged, signInAnonymously, signInWithPopup,
    GoogleAuthProvider, signOut,
  } = await import(`${base}/firebase-auth.js`);
  const {
    initializeFirestore, persistentLocalCache, doc, getDoc, setDoc, updateDoc,
    deleteDoc, collection, onSnapshot, query, where, getDocs, addDoc,
    arrayUnion, arrayRemove,
  } = await import(`${base}/firebase-firestore.js`);

  const app = initializeApp(config);
  const auth = getAuth(app);
  let db;
  try { db = initializeFirestore(app, { localCache: persistentLocalCache() }); }
  catch { db = initializeFirestore(app, {}); }

  const list = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");

  return {
    mode: "live",
    onAuth(cb) { return onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, anon: u.isAnonymous } : null)); },
    signInAnon: () => signInAnonymously(auth),
    signInGoogle: () => signInWithPopup(auth, new GoogleAuthProvider()),
    signOut: () => signOut(auth),

    async getProfile(uid) { const s = await getDoc(doc(db, "users", uid)); return s.exists() ? s.data() : null; },
    saveProfile: (uid, data) => setDoc(doc(db, "users", uid), data, { merge: true }),

    async createCrew(name, uid) {
      for (let i = 0; i < 6; i++) {
        const code = newCode();
        const ref = doc(db, "crews", code);
        if ((await getDoc(ref)).exists()) continue;
        await setDoc(ref, { name, ownerId: uid, createdAt: Date.now() });
        return code;
      }
      throw new Error("Couldn't make an invite code. Try again.");
    },
    async getCrew(code) { const s = await getDoc(doc(db, "crews", code)); return s.exists() ? { id: code, ...s.data() } : null; },
    joinCrew: (code, uid, data) => setDoc(doc(db, "crews", code, "members", uid), data, { merge: true }),
    leaveCrew: (code, uid) => deleteDoc(doc(db, "crews", code, "members", uid)),
    updateMember: (code, uid, data) => setDoc(doc(db, "crews", code, "members", uid), data, { merge: true }),
    onMembers: (code, cb, err) => onSnapshot(collection(db, "crews", code, "members"), (s) => cb(list(s)), err),

    onConvoys: (code, cb, err) => onSnapshot(query(collection(db, "crews", code, "convoys"), where("active", "==", true)), (s) => cb(list(s)), err),
    async createConvoy(code, data) { const r = await addDoc(collection(db, "crews", code, "convoys"), data); return r.id; },
    joinConvoy: (code, id, uid) => updateDoc(doc(db, "crews", code, "convoys", id), { memberIds: arrayUnion(uid) }),
    leaveConvoy: (code, id, uid) => updateDoc(doc(db, "crews", code, "convoys", id), { memberIds: arrayRemove(uid) }),
    endConvoy: (code, id) => updateDoc(doc(db, "crews", code, "convoys", id), { active: false, endedAt: Date.now() }),

    // meets & events (only ones that haven't long finished)
    onMeets: (code, cb, err) => onSnapshot(query(collection(db, "crews", code, "meets"), where("when", ">", Date.now() - 6 * 3600000)), (s) => cb(list(s)), err),
    async createMeet(code, data) { const r = await addDoc(collection(db, "crews", code, "meets"), data); return r.id; },
    updateMeet: (code, id, data) => updateDoc(doc(db, "crews", code, "meets", id), data),
    rsvpMeet: (code, id, uid, going) => updateDoc(doc(db, "crews", code, "meets", id), { going: going ? arrayUnion(uid) : arrayRemove(uid) }),
    deleteMeet: (code, id) => deleteDoc(doc(db, "crews", code, "meets", id)),

    // leaderboards: coll is "bass" or "speed"
    onBoard: (code, coll, cb, err) => onSnapshot(collection(db, "crews", code, coll), (s) => cb(list(s)), err),
    async addBoard(code, coll, data) { const r = await addDoc(collection(db, "crews", code, coll), data); return r.id; },
    witnessBoard: (code, coll, id, uid) => updateDoc(doc(db, "crews", code, coll, id), { witnesses: arrayUnion(uid) }),
    deleteBoard: (code, coll, id) => deleteDoc(doc(db, "crews", code, coll, id)),

    onVehicles: (uid, cb, err) => onSnapshot(collection(db, "users", uid, "vehicles"), (s) => cb(list(s)), err),
    async getVehicles(uid) { return list(await getDocs(collection(db, "users", uid, "vehicles"))); },
    saveVehicle: (uid, v) => { const { id, ...rest } = v; return setDoc(doc(db, "users", uid, "vehicles", id), rest); },
    deleteVehicle: (uid, id) => deleteDoc(doc(db, "users", uid, "vehicles", id)),

    // big pictures (360° frames) each get their own document so they can stay sharp
    saveMedia: (uid, id, data) => setDoc(doc(db, "users", uid, "media", id), { d: data }),
    async getMedia(uid, id) { const s = await getDoc(doc(db, "users", uid, "media", id)); return s.exists() ? s.data().d : null; },
    deleteMedia: (uid, id) => deleteDoc(doc(db, "users", uid, "media", id)),

    // drive-to-reveal map: roads you've driven, stored privately per person
    async loadExplored(uid) {
      const out = new Set();
      for (const d of (await getDocs(collection(db, "users", uid, "explored"))).docs) (d.data().cells || []).forEach((c) => out.add(c));
      return out;
    },
    async addExplored(uid, byPrefix) {
      await Promise.all(Object.entries(byPrefix).map(([p, cells]) =>
        setDoc(doc(db, "users", uid, "explored", p), { cells: arrayUnion(...cells) }, { merge: true })));
    },
  };
}
