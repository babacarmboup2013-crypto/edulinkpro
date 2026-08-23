/* ============================================================
   SYGENOP — Gestionnaire de synchro hors-ligne (IndexedDB)
   ------------------------------------------------------------
   Fournit l'API utilisée par SygenopApp :
     - initOfflineSync({ pingUrl })    → démarre la détection réseau
     - subscribeSyncStatus(cb)          → abonne un callback au statut
     - queueSave(schoolId, draft, opts) → écrit en local puis syncro Supabase
     - getInstantCache(schoolId)        → lecture instantanée du cache local
     - primeCacheFromServer(schoolId, state) → met à jour le cache depuis le serveur
   ============================================================ */
const DB_NAME = 'sygenop_offline';
const DB_VERSION = 1;
const STORE = 'school_state';

let dbPromise = null;
const listeners = new Set();
let status = { online: typeof navigator !== 'undefined' ? navigator.onLine : true, pendingCount: 0, syncing: false, lastError: '' };

/* ---------- Base IndexedDB ---------- */
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB non disponible'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'schoolId' });
      }
      if (!db.objectStoreNames.contains('queue')) {
        const q = db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        q.createIndex('schoolId', 'schoolId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Convertit un IDBRequest en Promise résolue avec sa vraie valeur (request.result),
// et non l'objet IDBRequest lui-même (qui n'est disponible que de façon async).
function requestToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  const t = db.transaction(storeName, mode);
  const store = t.objectStore(storeName);
  // fn(store) renvoie un IDBRequest (get/getAll/put/add/delete) : on attend
  // sa vraie résolution AVANT de considérer la transaction terminée.
  const req = fn(store);
  const value = await requestToPromise(req);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error);
    // La transaction peut déjà être terminée si onsuccess a tout déclenché avant
    // que ce bloc ne s'exécute — dans ce cas oncomplete est déjà passé.
    if (t.commit) { try { t.commit(); } catch (_) {} }
  });
}

function readCache(schoolId) {
  return tx(STORE, 'readonly', (store) => store.get(schoolId)).then((r) => (r ? r.payload : null));
}
function writeCache(schoolId, payload) {
  return tx(STORE, 'readwrite', (store) => store.put({ schoolId, payload, ts: Date.now() }));
}
function listQueue() {
  return tx('queue', 'readonly', (store) => store.getAll()).then((r) => r || []);
}
function pushQueue(item) {
  return tx('queue', 'readwrite', (store) => store.add(item));
}
function removeQueue(id) {
  return tx('queue', 'readwrite', (store) => store.delete(id));
}

/* ---------- Politique de rejet des éléments impossibles à synchroniser ----------
   Sans elle, un élément de la file dont les codes d'accès sont introuvables
   (session expirée, snapshot absent des anciennes versions…) était retenté
   TOUTES LES 15 SECONDES à l'infini : la bannière « données non encore
   synchronisées » avec « Erreur : Code d'accès absent pour cette école »
   réapparaissait sans fin. Désormais :
   - erreur DÉFINITIVE (accès refusé par le serveur, 401/403…) → abandon
     immédiat de l'élément ;
   - autre erreur (« Code d'accès absent », réseau…) → nouvelles tentatives,
     puis abandon après MAX_SYNC_ATTEMPTS échecs consécutifs (laisse le temps
     d'une reconnexion qui fournirait de nouveaux codes valides).
   Dans les deux cas l'élément SORT de la file et l'application est prévenue
   UNE SEULE FOIS via l'événement « offline-sync-rejected ». Les saisies
   restent dans le cache local de l'appareil : rien n'est perdu côté client,
   et la prochaine écriture réussie renvoie l'état complet de l'école. */
const MAX_SYNC_ATTEMPTS = 20;

function isDefinitiveSyncError(message) {
  const m = String(message || '');
  // Les pannes réseau (« Failed to fetch », timeout, « connexion refusée »…)
  // sont toujours transitoires : le serveur sera peut-être joignable au
  // prochain cycle, on ne doit pas abandonner l'élément.
  if (/failed to fetch|network|aborted|timeout|r[ée]seau|connection refused/i.test(m)) return false;
  return (
    /refus/i.test(m) ||                       // « Accès refusé », « Enregistrement … refusé »…
    /\b40[13]\b/.test(m) ||                   // codes HTTP 401/403 dans les erreurs REST
    /permission denied|row-level security|unauthorized|forbidden|invalid api key|\bjwt\b/i.test(m)
  );
}

function reportRejected(schoolId, message) {
  try {
    window.dispatchEvent(new CustomEvent('offline-sync-rejected', { detail: { schoolId, message: String(message || '') } }));
  } catch (_) {}
}

/* ---------- Statut & abonnés ---------- */
function emit() {
  listeners.forEach((cb) => { try { cb({ ...status }); } catch (_) {} });
}
export function subscribeSyncStatus(cb) {
  listeners.add(cb);
  cb({ ...status });
  return () => listeners.delete(cb);
}
function setStatus(patch) {
  status = { ...status, ...patch };
  emit();
}

/* ---------- Référence à la fonction de sauvegarde serveur ----------
   Une fonction JS n'est pas sérialisable dans IndexedDB (DataCloneError).
   On la garde donc uniquement en mémoire (module scope) plutôt que dans
   la queue persistée — seules les données (schoolId, draft) sont stockées. */
let saveFnRef = null;
export function setSaveHandler(fn) {
  saveFnRef = typeof fn === 'function' ? fn : null;
}

/* ---------- Détection réseau ---------- */
let stopPing = null;
export function initOfflineSync({ pingUrl, pingHeaders, saveSchoolData } = {}) {
  if (saveSchoolData) setSaveHandler(saveSchoolData);
  if (stopPing) return stopPing;
  const updateOnline = () => {
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    setStatus({ online });
  };
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();
  countPending().then((pendingCount) => setStatus({ pendingCount })).catch(() => {});

  let stopped = false;
  const ping = async () => {
    if (!status.online || status.syncing) return;
    try {
      if (pingUrl) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        await fetch(pingUrl, { method: 'HEAD', headers: pingHeaders || {}, signal: ctrl.signal });
        clearTimeout(t);
      }
      if (!stopped) {
        setStatus({ online: true });
        await drainQueue();
      }
    } catch (_) {
      if (!stopped) setStatus({ online: false });
    }
  };
  stopPing = setInterval(ping, 15000);
  ping();

  return () => {
    stopped = true;
    clearInterval(stopPing);
    stopPing = null;
    window.removeEventListener('online', updateOnline);
    window.removeEventListener('offline', updateOnline);
  };
}

/* ---------- File d'attente (queue) ---------- */
async function countPending() {
  try {
    const q = await listQueue();
    return new Set(q.map((i) => i.schoolId)).size;
  } catch (_) { return 0; }
}

async function drainQueue() {
  setStatus({ syncing: true });
  try {
    const q = await listQueue();
    if (!saveFnRef) {
      setStatus({ syncing: false, pendingCount: q.length ? new Set(q.map((item) => item.schoolId)).size : 0 });
      return;
    }
    for (const item of q) {
      try {
        await saveFnRef(item.schoolId, item.draft, item.access);
        await removeQueue(item.id);
        setStatus({ lastError: '' });
      } catch (e) {
        const message = e?.message || 'Erreur de synchronisation serveur';
        console.error('queueSave sync failed:', e);
        const attempts = (item.attempts || 0) + 1;
        if (isDefinitiveSyncError(message) || attempts >= MAX_SYNC_ATTEMPTS) {
          // Abandon définitif : on sort l'élément de la file au lieu de le
          // retenter à l'infini, et on prévient l'application une seule fois.
          await removeQueue(item.id).catch(() => {});
          reportRejected(item.schoolId, message);
        } else {
          // Échec passager : on mémorise le nombre de tentatives (persisté
          // avec l'élément pour survivre à un rechargement de la page).
          try { await tx('queue', 'readwrite', (store) => store.put({ ...item, attempts })); } catch (_) {}
          setStatus({ lastError: message });
        }
      }
    }
  } catch (e) {
    console.error('drainQueue error:', e);
  }
  const pendingCount = await countPending();
  // File vide → plus d'erreur résiduelle : la bannière disparaît net.
  if (pendingCount === 0) setStatus({ syncing: false, pendingCount, lastError: '' });
  else setStatus({ syncing: false, pendingCount });
}

/* ---------- API publique ---------- */
export async function retrySync() {
  if (!status.online || status.syncing) return;
  await drainQueue();
}

// Échappatoire pour un élément de la file définitivement bloqué (ex. mis en
// attente avant une correction, ou dont la session d'origine a expiré sans
// snapshot d'accès valable). Supprime tout ce qui est en attente pour CETTE
// école : la donnée reste dans le cache local (writeCache déjà appelé), donc
// rien n'est perdu tant que l'appareil n'est pas réinitialisé — seule la
// synchronisation vers le serveur est abandonnée pour ces éléments précis.
export async function clearQueue(schoolId) {
  try {
    const q = await listQueue();
    const toRemove = schoolId ? q.filter((item) => item.schoolId === schoolId) : q;
    for (const item of toRemove) { await removeQueue(item.id); }
  } catch (_) {}
  setStatus({ lastError: '', pendingCount: await countPending() });
}

export async function getInstantCache(schoolId) {
  try {
    return await readCache(schoolId);
  } catch (_) { return null; }
}

export async function primeCacheFromServer(schoolId, state) {
  try {
    await writeCache(schoolId, state);
  } catch (_) {}
}

export async function queueSave(schoolId, draft, opts) {
  // Écrit toujours le cache local (optimiste)
  try { await writeCache(schoolId, draft); } catch (_) {}

  // Mémorise le handler de sauvegarde pour ce/ces prochains drainQueue
  // (jamais persisté en IndexedDB : une fonction n'est pas sérialisable).
  if (opts && opts.saveSchoolData) setSaveHandler(opts.saveSchoolData);

  // Le « snapshot » des codes d'accès (école/personnel/admin), lui, est
  // sérialisable : on le persiste avec chaque élément de la file pour que
  // la synchronisation différée reste possible même si la session en cours
  // a changé ou expiré d'ici là (ex. reconnexion sur une autre école).
  const access = opts && opts.access ? opts.access : null;

  const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
  if (online && opts && opts.saveSchoolData) {
    setStatus({ syncing: true });
    try {
      await opts.saveSchoolData(schoolId, draft, access);
    } catch (e) {
      console.error('save failed, queueing:', e);
      const message = e?.message || 'Erreur de synchronisation serveur';
      if (isDefinitiveSyncError(message)) {
        // Rejet définitif du serveur : inutile d'encombrer la file avec un
        // élément qui ne partira jamais. Prévention unique + cache local
        // conservé (writeCache a déjà été appelé plus haut).
        reportRejected(schoolId, message);
      } else {
        // « Code d'accès absent », réseau instable… : on met en file — une
        // reconnexion ou un changement de session peut fournir des codes
        // valides ; drainQueue plafonnera les tentatives si rien ne change.
        try { await pushQueue({ schoolId, draft, access, ts: Date.now(), attempts: 1 }); } catch (_) {}
      }
    }
    setStatus({ syncing: false, pendingCount: await countPending() });
  } else {
    // Hors ligne → mise en file d'attente (données uniquement, sérialisables)
    try {
      await pushQueue({ schoolId, draft, access, ts: Date.now(), attempts: 0 });
    } catch (_) {}
    setStatus({ online, pendingCount: await countPending() });
  }
}

/* ---------- Export helpers ---------- */
export default {
  initOfflineSync,
  subscribeSyncStatus,
  queueSave,
  getInstantCache,
  primeCacheFromServer,
  setSaveHandler,
  retrySync,
  clearQueue,
};

