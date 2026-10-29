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
let status = { online: typeof navigator !== 'undefined' ? navigator.onLine : true, pendingCount: 0, syncing: false, suspended: false, lastError: '', storagePersistent: null };

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

// Remplace ou crée l'élément de la file pour UNE école donnée (une seule entrée
// par école, gardée à jour avec le DERNIER brouillon). Évite d'empiler des
// doublons (chaque modification hors-ligne produirait sinon une entrée) et
// garantit qu'aucune saisie n'est perdue : l'élément existant est simplement
// recouvert par le brouillon plus récent, jamais effacé.
async function upsertQueueForSchool(schoolId, draft, access, patch) {
  const q = await listQueue().catch(() => []);
  const existing = q.find((i) => i && i.schoolId === schoolId);
  const entry = { ...(existing || {}), schoolId, draft, access, ts: Date.now(), ...(patch || {}) };
  if (existing) await tx('queue', 'readwrite', (store) => store.put(entry));
  else await pushQueue(entry);
}

/* ---------- Politique de synchronisation : on n'abandonne JAMAIS une saisie ----------
   Une saisie qui n'a pas pu partir vers le serveur ne sort jamais de la file,
   sauf action explicite de l'utilisateur (clearQueue via « Abandonner la
   synchro ») ou succès de l'envoi. Deux comportements selon la nature de
   l'erreur :
   - erreur DÉFINITIVE (accès refusé, 401/403, code d'accès introuvable) →
     l'élément est conservé mais SUSPENDU : plus de recyclage automatique
     toutes les 15 s (cela faisait spammer la bannière à l'infini), il ne
     repart que sur action manuelle (« Réessayer ») ou après une reconnexion
     (handleLogin → retrySync). La saisie reste donc conservée — sur l'appareil
     ET dans la file — jusqu'à ce qu'un compte valide la renvoie,
   - erreur PASSAGÈRE (réseau, timeout…) → nouvelles tentatives à chaque cycle,
     sans limite d'abandon.
   Dans tous les cas l'application est prévenue via « offline-sync-rejected »
   (une fois par épisode) et l'école est « bloquée » : l'écran local est
   conservé au lieu d'être écrasé par la version serveur périmée. */
function reportRejected(schoolId, message) {
  try {
    blockSchool(schoolId);
    window.dispatchEvent(new CustomEvent('offline-sync-rejected', { detail: { schoolId, message: String(message || '') } }));
  } catch (_) {}
}

// Écoles dont des éléments en file sont bloqués (rejet définitif du serveur,
// ou code d'accès introuvable) : leur version locale est restée NON
// synchronisée et la version serveur est périmée. L'app garde alors
// l'affichage local (ne le fait pas écraser par le serveur) tant que
// l'élément n'a pas été ré-synchronisé avec succès après reconnexion.
const blockedSchoolsSet = new Set();
const BLOCKED_LS_KEY = 'sygenop_blocked_schools';

// Restaure l'état « bloqué » persistant (survit à un rechargement de la page),
// afin qu'une école dont des saisies locales sont restées non synchronisées
// ne soit jamais écrasée par l'ancienne version serveur après une actualisation.
try {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(BLOCKED_LS_KEY) : null;
  if (saved) {
    const arr = JSON.parse(saved);
    if (Array.isArray(arr)) arr.forEach((id) => { if (id) blockedSchoolsSet.add(id); });
  }
} catch (_) {}

function persistBlocked() {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(BLOCKED_LS_KEY, JSON.stringify([...blockedSchoolsSet]));
    }
  } catch (_) {}
}

function blockSchool(schoolId) {
  if (schoolId) { blockedSchoolsSet.add(schoolId); persistBlocked(); }
}
function unblockSchool(schoolId) {
  if (schoolId) { blockedSchoolsSet.delete(schoolId); persistBlocked(); }
}
export async function blockedSchools() {
  return new Set(blockedSchoolsSet);
}

function isDefinitiveSyncError(message) {
  const m = String(message || '');
  // Les pannes réseau (« Failed to fetch », timeout, « connexion refusée »…)
  // sont toujours transitoires : le serveur sera peut-être joignable au
  // prochain cycle, on ne doit pas abandonner l'élément.
  if (/failed to fetch|network|aborted|timeout|r[ée]seau|connection refused/i.test(m)) return false;
  // « Conflit de version » n'est PAS (plus) définitif : saveSchoolData s'en
  // récupère côté client en rechargeant la version fraîche, en fusionnant les
  // données (aucune perte) puis en resauvegardant sans verrou. Abandonner le
  // brouillon à ce stade perdait silencieusement les saisies (données qui
  // « disparaissent » le lendemain, invisibles pour le Super Admin).
  return (
    /refus/i.test(m) ||                       // « Accès refusé », « Enregistrement … refusé »…
    /\b40[13]\b/.test(m) ||                   // codes HTTP 401/403 dans les erreurs REST
    /permission denied|row-level security|unauthorized|forbidden|invalid api key|\bjwt\b/i.test(m)
  );
}

// Décision de synchronisation d'un élément de la file après un échec :
//   - « suspended » → rejet définitif (accès refusé, 401/403, code introuvable) :
//     l'élément est conservé MAIS non recyclé automatiquement (relancé sur
//     « Réessayer » ou après reconnexion) ;
//   - sinon → échec passager : retenté à chaque cycle, sans limite d'abandon.
// Fonction pure, exposée pour les tests.
export function classifySyncFailure(message) {
  const m = String(message || '');
  return { suspended: isDefinitiveSyncError(m) || isCodeAbsentError(m) };
}

// Conflit de verrouillage optimiste (voir save_school_data côté serveur) :
// quelqu'un d'autre a sauvegardé entretemps. Retenter avec le même
// brouillon ne peut QUE re-échouer — il faut recharger les données fraîches
// avant de pouvoir rejouer la modification.
function isVersionConflictError(message) {
  return /conflit de version/i.test(String(message || ''));
}

// « Code d'accès absent pour cette école » : l'élément n'a AUCUNE credential
// exploitable (session expirée/absente, snapshot sans code, école inconnue).
// Ce n'est ni définitif (l'utilisateur peut se reconnecter avec le bon compte)
// ni passager (les retries ne font rien) : re-tenter en boucle est inutile et
// maintenait la bande d'alerte « Code d'accès absent » de façon permanente.
// L'élément est conservé mais SUSPENDU — relancé sur « Réessayer » ou après
// reconnexion (handleLogin → retrySync) — et l'utilisateur prévenu une seule fois.
function isCodeAbsentError(message) {
  const m = String(message || '');
  return /Code d’accès absent pour cette école|Code d'accès absent pour cette école/i.test(m);
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

/* ---------- Stockage persistant ----------
   Par défaut, le navigateur peut ÉVINCER (supprimer) la base IndexedDB sans
   prévenir quand l'espace manque — ce qui perdrait les saisies hors-ligne.
   navigator.storage.persist() demande un stockage persistant (non évincable) :
   selon les navigateurs, la demande est accordée sans interaction ou refusée
   (l'app ne fait alors rien de bloquant). On enrichit en plus le statut pour
   que l'app puisse informer l'utilisateur si la couche hors-ligne n'est pas
   pérenne sur cet appareil. */
let persistentResolved = false;
export function requestPersistentStorage() {
  if (persistentResolved) return;
  persistentResolved = true;
  try {
    if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persist !== 'function') {
      setStatus({ storagePersistent: false });
      return;
    }
    navigator.storage.persist()
      .then((granted) => {
        setStatus({ storagePersistent: granted });
        console.info('[sygenop] stockage persistant', granted ? 'accordé ✓' : 'refusé');
      })
      .catch(() => setStatus({ storagePersistent: false }));
  } catch (_) {
    setStatus({ storagePersistent: false });
  }
}

/* ---------- Détection réseau ---------- */
let stopPing = null;
export function initOfflineSync({ pingUrl, pingHeaders, saveSchoolData } = {}) {
  if (saveSchoolData) setSaveHandler(saveSchoolData);
  if (stopPing) return stopPing;
  // Demande un stockage persistant (non évincable) pour la base IndexedDB :
  // protège les saisies hors-ligne contre la suppression automatique par le
  // navigateur quand l'espace disque vient à manquer.
  requestPersistentStorage();
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
// Élément « dormant » : suspendu uniquement faute de code d'accès pour cette
// école (ex. brouillon resté d'une ancienne session). Il est CONSERVÉ dans la
// file et rejoué dès qu'une session valide pour cette école existe (reconnexion),
// mais il n'affiche JAMAIS de bandeau d'alerte ni ne compte comme « en attente » :
// l'utilisateur ne peut rien y faire tant qu'il n'ouvre pas cette école.
export function isDormantItem(item) {
  return !!(item && item.suspended && isCodeAbsentError(item.lastError));
}

async function countPending() {
  try {
    const q = await listQueue();
    return new Set(q.filter((i) => !isDormantItem(i)).map((i) => i.schoolId)).size;
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
      // Élément suspendu (rejet définitif / code d'accès introuvable) : on ne
      // recycle pas automatiquement — rien ne changerait — mais la saisie est
      // CONSERVÉE dans la file. Elle ne repart que sur action manuelle
      // (« Réessayer ») ou après reconnexion (handleLogin → retrySync).
      if (item.suspended) continue;
      try {
        const newVersion = await saveFnRef(item.schoolId, item.draft, item.access);
        // Propage la nouvelle version aux autres éléments encore en attente
        // pour LA MÊME école : chaque brouillon hors-ligne porte le numéro
        // de version d'AVANT la coupure réseau, donc sans cette propagation,
        // le 2e élément d'une même école serait rejeté comme « en conflit »
        // avec la sauvegarde précédente… qui vient pourtant du même
        // utilisateur, dans la même session hors-ligne.
        if (newVersion != null) {
          for (const other of q) {
            if (other !== item && other.schoolId === item.schoolId && other.draft) {
              other.draft = { ...other.draft, __version: newVersion };
            }
          }
        }
        await removeQueue(item.id);
        unblockSchool(item.schoolId);
        setStatus({ lastError: '' });
      } catch (e) {
        const message = e?.message || 'Erreur de synchronisation serveur';
        console.error('queueSave sync failed:', e);
        if (isCodeAbsentError(message) || isDefinitiveSyncError(message)) {
          // Rejet définitif (accès refusé, 401/403, code introuvable) : on
          // SUSPEND l'élément au lieu de l'abandonner — la saisie n'est
          // JAMAIS perdue. Il ne sera retenté que sur « Réessayer » ou après
          // reconnexion, avec des credentials éventuellement valides. Pas de
          // recyclage automatique (cela spammerait la bannière toutes les 15 s).
          const reported = !!(item && item.reported);
          try { await tx('queue', 'readwrite', (store) => store.put({ ...item, suspended: true, attempts: (item.attempts || 0) + 1, lastError: message, reported: true })); } catch (_) {}
          if (isCodeAbsentError(message)) {
            // Dormant : conservé, rejoué à la prochaine connexion à cette école, sans alerte.
            blockSchool(item.schoolId);
          } else {
            if (!reported) reportRejected(item.schoolId, message);
            setStatus({ lastError: message });
          }
        } else {
          // Échec passager (réseau, timeout…) : nouvelle tentative au prochain
          // cycle, SANS limite d'abandon — la saisie reste dans la file tant
          // qu'elle n'est pas réellement partie.
          try { await tx('queue', 'readwrite', (store) => store.put({ ...item, attempts: (item.attempts || 0) + 1, lastError: message })); } catch (_) {}
          setStatus({ lastError: message });
        }
      }
    }
  } catch (e) {
    console.error('drainQueue error:', e);
  }
  const pendingCount = await countPending();
  const hasSuspended = (await listQueue().catch(() => [])).some((i) => i && i.suspended && !isDormantItem(i));
  // File vide → plus d'erreur résiduelle : la bannière disparaît net. Sinon on
  // distingue « en attente » (réseau) de « rejet » (suspendu, à relancer).
  if (pendingCount === 0) setStatus({ syncing: false, pendingCount, lastError: '', suspended: false });
  else setStatus({ syncing: false, pendingCount, suspended: hasSuspended });
}

/* ---------- API publique ---------- */
// Réessaye la synchronisation : lève la suspension des éléments en attente
// (rejets définitifs / code introuvable) puis rejoue la file. Appelé par le
// bouton « Réessayer » et automatiquement à chaque reconnexion (handleLogin),
// qui peut fournir des credentials valides pour des éléments suspendus.
export async function retrySync(opts) {
  if (!status.online || status.syncing) return;
  try {
    const q = await listQueue();
    for (const item of q) {
      if (item && item.suspended && (!(opts && opts.onlyDormant) || isDormantItem(item))) {
        const { suspended, lastError, reported, ...rest } = item;
        void suspended; void lastError; void reported;
        try { await tx('queue', 'readwrite', (store) => store.put(rest)); } catch (_) {}
      }
    }
  } catch (_) {}
  await drainQueue();
}

// Échappatoire explicite pour une école dont la synchronisation semble
// impossible (session d'origine expirée sans snapshot valable, accès refusé…).
// Supprime tout ce qui est en attente pour CETTE école : la donnée reste dans
// le cache local de l'appareil, mais la synchronisation vers le serveur est
// abandonnée pour ces éléments précis. L'utilisateur confirme avant tout appel.
export async function clearQueue(schoolId) {
  try {
    const q = await listQueue();
    const toRemove = schoolId ? q.filter((item) => item.schoolId === schoolId) : q;
    for (const item of toRemove) { await removeQueue(item.id); }
    // L'utilisateur a explicitement choisi d'abandonner la synchronisation :
    // l'école n'est plus « bloquée » — le serveur redevient la source de vérité.
    if (schoolId) unblockSchool(schoolId);
  } catch (_) {}
  setStatus({ lastError: '', pendingCount: await countPending(), suspended: false });
}

export async function getInstantCache(schoolId) {
  try {
    return await readCache(schoolId);
  } catch (_) { return null; }
}

// Retourne l'ensemble des identifiants d'écoles ayant des données NON encore
// synchronisées dans la file d'attente. Utile à l'app pour ne PAS écraser un
// cache local plus récent (saisies en attente) par une vieille version serveur.
export async function pendingSchools() {
  try {
    const q = await listQueue();
    return new Set(q.map((i) => i && i.schoolId));
  } catch (_) { return new Set(); }
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
      const newVersion = await opts.saveSchoolData(schoolId, draft, access);
      // Sauvegarde directe réussie : l'école n'est plus « bloquée » (elle a pu
      // se re-synchroniser avec le serveur).
      unblockSchool(schoolId);
      // Renvoie la nouvelle version au composant appelant : sans ça, la
      // prochaine modification locale enverrait encore l'ANCIEN numéro de
      // version et se ferait rejeter à tort comme un conflit avec sa propre
      // sauvegarde qui vient pourtant de réussir (voir verrouillage
      // optimiste de save_school_data côté serveur).
      if (typeof opts.onSaved === 'function' && newVersion != null) opts.onSaved(newVersion);
    } catch (e) {
      console.error('save failed, queueing:', e);
      const message = e?.message || 'Erreur de synchronisation serveur';
      const reportedBefore = (await listQueue().catch(() => [])).some((i) => i && i.schoolId === schoolId && i.reported);
      const codeAbsent = isCodeAbsentError(message);
      const suspended = isDefinitiveSyncError(message) || codeAbsent;
      // On met TOUJOURS en file (une seule entrée par école, dernier brouillon
      // conservé) y compris sur rejet définitif : la saisie ne disparaît pas.
      // Sur rejet définitif l'élément est suspendu — relancé sur « Réessayer »
      // ou après reconnexion — et l'utilisateur prévenu une seule fois.
      try {
        await upsertQueueForSchool(schoolId, draft, access, {
          attempts: 1,
          lastError: message,
          suspended: !!suspended,
          reported: reportedBefore,
        });
      } catch (_) {}
      if (codeAbsent) {
        // Aucun code d'accès pour cette école : saisie conservée (dormante), sans alerte.
        blockSchool(schoolId);
        setStatus({ lastError: '', suspended: false });
      } else {
        if (suspended && !reportedBefore) reportRejected(schoolId, message);
        setStatus({ lastError: message, suspended });
      }
    }
    setStatus({ syncing: false, pendingCount: await countPending() });
  } else {
    // Hors ligne → file d'attente (données uniquement, sérialisables). Une
    // seule entrée par école : le DERNIER brouillon recouvre le précédent.
    const reportedBefore = (await listQueue().catch(() => [])).some((i) => i && i.schoolId === schoolId && i.reported);
    try { await upsertQueueForSchool(schoolId, draft, access, { attempts: 0, reported: reportedBefore }); } catch (_) {}
    const pendingSuspended = (await listQueue().catch(() => [])).some((i) => i && i.suspended && !isDormantItem(i));
    setStatus({ online, pendingCount: await countPending(), suspended: pendingSuspended });
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
  pendingSchools,
  blockedSchools,
  requestPersistentStorage,
};

