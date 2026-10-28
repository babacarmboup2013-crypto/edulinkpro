import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';

import {
  LayoutDashboard, Users, GraduationCap, CalendarDays, CreditCard, Settings,
  Database, ChevronRight, ChevronDown, Sun, Moon, LogOut, Eye, EyeOff,
  Menu, X, School, ShieldCheck, UserCog, KeyRound, Loader2, TrendingUp,
  CheckCircle2, AlertTriangle, BookOpen, Wrench, Plus, Pencil, Trash2,
  Phone, Wallet, Clock, Search, Download, ChevronLeft, UserRound,
  MessageCircle, Receipt, History, Trophy, Building2, Printer, FileSpreadsheet,
  Upload, Save, RotateCcw, AlertCircle, Globe, TrendingDown, ArrowUpCircle,
  ArrowDownCircle, Scale, Package, ScanLine, FileText, Award, ClipboardCheck,
  CalendarX, Layers
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, LineChart, Line
} from 'recharts';
import {
  initOfflineSync, subscribeSyncStatus, queueSave,
  getInstantCache, primeCacheFromServer, retrySync, clearQueue, pendingSchools, blockedSchools,
} from './offline/syncManager';
import ChesterWidget from './components/Chester';
import flagSenegal from './assets/flag-senegal.webp';

/* ============================================================
   SUPABASE — mêmes identifiants que SYGENOP_V1.html (clé "anon")
   ============================================================ */
const SB_KEY = import.meta.env.VITE_SUPABASE_KEY;
const SB_URL = import.meta.env.VITE_SUPABASE_URL;
const SB_H = {
  'Content-Type': 'application/json',
  apikey: SB_KEY,
  Authorization: 'Bearer ' + SB_KEY,
  Prefer: 'return=representation',
};

// Tables sensibles : jamais d'accès direct depuis le client. Toute lecture
// passe par l'Edge Function read-schools (lecture seule, service_role côté
// serveur) ; toute écriture passe par admin-write, qui vérifie côté serveur
// soit le code Super Admin racine (admin_code), soit le code de l'école
// ciblée (school_code) — jamais la clé anon seule.
const SECURED_TABLES = new Set(['schools', 'school_data']);
// Ces trois tables n'ont plus AUCUN accès anon direct (RLS activé, zéro
// policy) : lecture ET écriture passent systématiquement par admin-write,
// qui vérifie le code (admin_code / ief_admin_code) et applique le
// périmètre côté serveur avant toute requête.
const ADMIN_SECURED_TABLES = new Set(['admins', 'iefs', 'ief_config', 'groupes_scolaires']);
const SB_REQUEST_TIMEOUT_MS = 20000;
async function fetchWithTimeout(url, options = {}, timeoutMs = SB_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

// Les rafraîchissements automatiques (toutes les X secondes) ne tournent QUE
// quand l'onglet est visible : un onglet laissé ouvert en arrière-plan (nuit,
// week-end) ne doit pas solliciter la base en continu. La base Supabase est
// sur l'offre gratuite (peu de CPU / connexions) : chaque appel compte.
// Télécharge les données des écoles PAR PETITS LOTS (au lieu d'une seule
// requête de plusieurs dizaines de Mo qui dépasse le délai de 20 s et surcharge
// la base) : un lot en échec n'empêche pas d'afficher les autres.
async function fetchSchoolPayloads(ids, chunk = 10) {
  const byId = {};
  let lastError = null;
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    try {
      const datas = (await sb('GET', 'school_data', `select=school_id,payload&school_id=in.(${part.join(',')})`)) || [];
      datas.forEach((d) => { byId[d.school_id] = d.payload; });
    } catch (e) { lastError = e; }
  }
  if (lastError && !Object.keys(byId).length) throw lastError;
  return byId;
}
const pageIsVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

// Lit une image choisie par l'utilisateur et la RÉDUIT avant stockage : une
// photo/logo brut (plusieurs Mo en base64) est enregistré dans les données de
// l'école et rechargé à CHAQUE connexion — d'où des chargements très lents.
// Logo : 400 px max (PNG, transparence conservée). Photo : 480 px max (JPEG).
// Repli sur le fichier d'origine si le navigateur ne sait pas le redimensionner.
function readImageCompressed(file, { maxSize = 480, type = 'image/jpeg', quality = 0.82 } = {}) {
  return new Promise((resolve) => {
    const raw = () => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    };
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const ratio = Math.min(1, maxSize / Math.max(img.width, img.height, 1));
          const w = Math.max(1, Math.round(img.width * ratio));
          const h = Math.max(1, Math.round(img.height * ratio));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
          ctx.drawImage(img, 0, 0, w, h);
          const out = canvas.toDataURL(type, quality);
          URL.revokeObjectURL(url);
          if (out && out.length > 20) resolve(out); else raw();
        } catch (_) { URL.revokeObjectURL(url); raw(); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); raw(); };
      img.src = url;
    } catch (_) { raw(); }
  });
}
async function sb(method, table, params = '', body = null) {
  if (ADMIN_SECURED_TABLES.has(table)) {
    // admins / iefs / ief_config : GET compris, tout passe par admin-write
    // (auth + périmètre serveur), jamais d'appel REST anon direct.
    const session = loadSessionJSON(LS_SESSION, null);
    const isRootAdmin = session && session.role === 'admin' && !session.iefId;
    const isIefAdmin = session && session.role === 'admin' && !!session.iefId;
    const adminCode = isRootAdmin ? (session.adminCode || '') : '';
    const iefAdminCode = isIefAdmin ? (session.iefAdminCode || '') : '';
    const iefId = isIefAdmin ? session.iefId : null;
    const res = await fetchWithTimeout(`${SB_URL}/functions/v1/admin-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
      body: JSON.stringify({ method, table, params, body, admin_code: adminCode, ief_id: iefId, ief_admin_code: iefAdminCode }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `Erreur ${res.status}`);
    return text ? JSON.parse(text) : null;
  }
  if (SECURED_TABLES.has(table)) {
    if (method === 'GET') {
      const res = await fetchWithTimeout(`${SB_URL}/functions/v1/read-schools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
        body: JSON.stringify({ table, params }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text || `Erreur ${res.status}`);
      return text ? JSON.parse(text) : null;
    }
    // POST / PATCH / DELETE — écriture protégée.
    // Le Super Admin racine (role: 'admin', iefId: null) envoie admin_code ;
    // un admin IEF décentralisé (role: 'admin', iefId: <id>) envoie
    // ief_id + ief_admin_code ; un admin d'école envoie school_id + school_code.
    // Les trois sont vérifiés côté serveur (jamais fait confiance à la
    // session côté client seule).
    const session = loadSessionJSON(LS_SESSION, null);
    const isRootAdmin = session && session.role === 'admin' && !session.iefId;
    const isIefAdmin = session && session.role === 'admin' && !!session.iefId;
    const adminCode = isRootAdmin ? (session.adminCode || '') : '';
    const iefAdminCode = isIefAdmin ? (session.iefAdminCode || '') : '';
    const iefId = isIefAdmin ? session.iefId : null;
    const schoolCode = getActiveSchoolCode();
    const schoolId = (loadJSON(LS_SCHOOL_ID, '') || '').trim() || null;
    const res = await fetchWithTimeout(`${SB_URL}/functions/v1/admin-write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY },
      body: JSON.stringify({ method, table, params, body, school_id: schoolId, school_code: schoolCode, admin_code: adminCode, ief_id: iefId, ief_admin_code: iefAdminCode }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || `Erreur ${res.status}`);
    return text ? JSON.parse(text) : null;
  }

  const url = `${SB_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const res = await fetchWithTimeout(url, {
    method,
    headers: SB_H,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Erreur ${res.status}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
function sbErrMsg(e) {
  try {
    const j = JSON.parse(e.message);
    return j.message || j.hint || j.details || e.message;
  } catch (_) {
    return (e && e.message ? e.message : 'Erreur inconnue').slice(0, 160);
  }
}
const LS_SESSION = 'sygenop_session';
const LS_SCHOOL_ID = 'sygenop_active_school_id';
const LS_SCHOOL_NAME = 'sygenop_active_school_name';
const LS_SCHOOLS = 'sygenop_schools_cache';
const LS_SCHOOL_CODE = 'sygenop_school_code';
const LS_THEME = 'sygenop_theme';
const LS_LOGIN_ATTEMPTS = 'sygenop_login_attempts';
const LS_ACTIVE = 'sygenop_active_page';

// Code d'accès de l'école active — stocké en mémoire + localStorage (persistance
// de session). Il est utilisé par les RPC sécurisés get_school_data /
// save_school_data pour autoriser la lecture/écriture du payload de l'école.
let _activeSchoolCode = null;
function getActiveSchoolCode() {
  if (_activeSchoolCode) return _activeSchoolCode;
  const saved = (loadJSON(LS_SCHOOL_CODE, '') || '').trim();
  return saved || null;
}
function setActiveSchoolCode(code) {
  _activeSchoolCode = (code || '').trim() || null;
  if (_activeSchoolCode) saveJSON(LS_SCHOOL_CODE, _activeSchoolCode);
  else clearJSON(LS_SCHOOL_CODE);
}

// Sécurité des sessions.
// SESSION_ABS_TIMEOUT_MS : expiration absolue de la session (24 h) — au-delà,
//   l'utilisateur doit se reconnecter, même s'il était actif.
// SESSION_IDLE_TIMEOUT_MS : durée maximale d'inactivité (30 min) — sans
//   interaction, la session est fermée automatiquement.
const SESSION_ABS_TIMEOUT_MS = 24 * 60 * 60 * 1000;   // 24 heures
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;        // 30 minutes

// Verrouillage anti brute-force : après MAX_LOGIN_ATTEMPTS échecs consécutifs
// sur le même identifiant, la connexion est bloquée pendant
// LOGIN_BLOCK_MS avant de pouvoir réessayer.
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;                 // 15 minutes

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}
function clearJSON(key) {
  try { localStorage.removeItem(key); } catch (_) {}
}

// ---- Stockage dédié à la session active (sessionStorage, pas localStorage) ----
// La session peut contenir des codes d'accès sensibles (adminCode, iefCode,
// iefAdminCode) dont la portée dépasse une seule école — un code IEF ou
// Admin fuité donne accès en lecture (IEF) ou en écriture (Admin) à
// plusieurs écoles, voire à tout le système. sessionStorage est effacé à la
// fermeture de l'onglet/navigateur et n'est jamais partagé entre onglets,
// ce qui réduit fortement la fenêtre d'exposition sur un appareil partagé
// par rapport à localStorage (qui persiste indéfiniment jusqu'à
// déconnexion manuelle). Un rechargement de page dans le même onglet reste
// inchangé pour l'utilisateur.
function loadSessionJSON(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) { return fallback; }
}
function saveSessionJSON(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}
function clearSessionJSON(key) {
  try { sessionStorage.removeItem(key); } catch (_) {}
}

/* ---- Durée restante d'une session ---- */
function sessionRemaining(sessionData) {
  if (!sessionData || !sessionData.expiresAt) return 0;
  return (new Date(sessionData.expiresAt).getTime() - Date.now());
}
function isSessionExpired(sessionData) {
  return sessionRemaining(sessionData) <= 0;
}

/* ---- Suivi des tentatives de connexion (anti brute-force) ----
   Enregistre dans localStorage, par identifiant (school id, staff id, code IEF,
   code admin), le nombre d'échecs consécutifs et l'horodatage du blocage. */
function getLoginAttempts(identifier) {
  const all = loadJSON(LS_LOGIN_ATTEMPTS, {});
  return all[identifier] || { fails: 0, lockedUntil: 0 };
}
function recordLoginFailure(identifier) {
  const all = loadJSON(LS_LOGIN_ATTEMPTS, {});
  const cur = all[identifier] || { fails: 0, lockedUntil: 0 };
  const next = {
    fails: cur.fails + 1,
    lockedUntil: cur.fails + 1 >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOGIN_BLOCK_MS : (cur.lockedUntil || 0),
  };
  all[identifier] = next;
  saveJSON(LS_LOGIN_ATTEMPTS, all);
  return next;
}
function recordLoginSuccess(identifier) {
  const all = loadJSON(LS_LOGIN_ATTEMPTS, {});
  delete all[identifier];
  saveJSON(LS_LOGIN_ATTEMPTS, all);
}
function loginLockInfo(identifier) {
  const cur = getLoginAttempts(identifier);
  const now = Date.now();
  if (cur.lockedUntil > now) {
    return { locked: true, remainingMs: cur.lockedUntil - now };
  }
  // Le blocage a expiré : on remet le compteur à zéro pour laisser une nouvelle chance.
  if (cur.fails >= MAX_LOGIN_ATTEMPTS) {
    const all = loadJSON(LS_LOGIN_ATTEMPTS, {});
    delete all[identifier];
    saveJSON(LS_LOGIN_ATTEMPTS, all);
    return { locked: false, remainingMs: 0 };
  }
  return { locked: false, remainingMs: 0 };
}

/* ---- Repli hors-ligne pour le personnel ----
   Mémorise sur l'appareil les couples (école, membre, code) qui se sont
   déjà connectés avec succès ici. En cas de réseau indisponible — la
   vérification serveur étant alors impossible — seule une personne ayant
   déjà utilisé CE code sur CET appareil peut se reconnecter. Le stockage
   local reste du même niveau de sensibilité que session.staffCode, déjà
   persisté par ailleurs. */
const LS_OFFLINE_CREDENTIALS = 'sygenop_offline_credentials';
function rememberOfflineCredential({ schoolId, staffId, code }) {
  try {
    if (!schoolId || !staffId || !code) return;
    const all = loadJSON(LS_OFFLINE_CREDENTIALS, []);
    const next = all.filter((c) => !(c && c.schoolId === schoolId && c.staffId === staffId));
    next.push({ schoolId, staffId, code });
    saveJSON(LS_OFFLINE_CREDENTIALS, next.slice(-50));
  } catch (_) {}
}
function matchOfflineCredential({ schoolId, staffId, code }) {
  const all = loadJSON(LS_OFFLINE_CREDENTIALS, []);
  return (Array.isArray(all) ? all : []).some((c) =>
    c && c.schoolId === schoolId && c.staffId === staffId &&
    String(c.code || '') === String(code || '')
  );
}

/* ============================================================
   MODÈLE DE DONNÉES — même forme que SYGENOP_V1.html
   ============================================================ */
// Tous les niveaux pris en charge par l'application. Les libellés sont aussi
// utilisés dans les classes, les frais, les bulletins et les exports : ne pas
// les renommer après la création de données sans prévoir une migration.
const LEVEL_GROUPS = [
  { id: 'petite_enfance', label: 'Petite Enfance', levels: ['Crèche', 'Toute Petite Section'] },
  { id: 'prescolaire', label: 'Préscolaire', levels: ['Petite Section', 'Moyenne Section', 'Grande Section'] },
  { id: 'elementaire', label: 'Élémentaire', levels: ['CI', 'CP', 'CE1', 'CE2', 'CM1', 'CM2'] },
  { id: 'moyen', label: 'Moyen', levels: ['6e', '5e', '4e', '3e'] },
  { id: 'secondaire', label: 'Secondaire', levels: ['Seconde', 'Première', 'Terminale'] },
];
const LEVELS = LEVEL_GROUPS.flatMap((group) => group.levels);
const CYCLE_OPTIONS = LEVEL_GROUPS.map(({ id, label }) => ({ value: id, label }));
// Les écoles créées avant l'ajout des cycles appartenaient toutes à l'élémentaire.
// On les rend immédiatement visibles et on conserve cette valeur lors de la prochaine sauvegarde.
const LEGACY_DEFAULT_CYCLE = 'elementaire';
// « Daara Classique » était l'ancienne dénomination du cycle « Petite Enfance ».
// Les écoles enregistrées ainsi sont automatiquement traitées comme Petite Enfance.
const LEGACY_DAARA_CLASSIC_CYCLE = 'daara_classique';
function resolveCycleId(cycle) {
  return cycle === LEGACY_DAARA_CLASSIC_CYCLE ? 'petite_enfance' : cycle;
}
function resolvedSchoolCycle(school, payload) {
  return resolveCycleId(school?.cycle || payload?.header?.cycle || LEGACY_DEFAULT_CYCLE);
}
function cycleLabel(cycle) {
  return CYCLE_OPTIONS.find((option) => option.value === resolveCycleId(cycle))?.label || 'Non défini';
}
function cycleTerminology(cycle) {
  const c = resolveCycleId(cycle);
  if (c === 'petite_enfance') return { teacher: 'Éducateur(trice)', head: 'Directeur / Directrice' };
  if (c === 'moyen') return { teacher: 'Professeur', head: 'Principal' };
  if (c === 'secondaire') return { teacher: 'Professeur', head: 'Censeur et Proviseur' };
  return { teacher: 'Enseignant(e)', head: 'Directeur / Directrice' };
}
function displayStaffRole(role, cycle) {
  const terminology = cycleTerminology(cycle);
  if (role === 'Enseignant(e)') return terminology.teacher;
  if (role === 'Directeur/Directrice') return terminology.head;
  return role;
}
function supportsWeightedAssessments(state) {
  return ['moyen', 'secondaire'].includes(state?.header?.cycle);
}
// Les anciennes écoles sans cycle sont des écoles élémentaires.
function levelsForSchool(state) {
  const cycle = resolveCycleId(state?.header?.cycle) || LEGACY_DEFAULT_CYCLE;
  return LEVEL_GROUPS.find((group) => group.id === cycle)?.levels || LEVEL_GROUPS.find((group) => group.id === LEGACY_DEFAULT_CYCLE).levels;
}
// Cycle (petite enfance/préscolaire/élémentaire/moyen/secondaire) auquel
// appartient un niveau donné (ex. '6e' -> 'moyen'). Utilisé pour retrouver la
// bonne terminologie (« Professeur » vs « Enseignant(e) ») et pour savoir si
// les classes de ce niveau fonctionnent par matière (Moyen/Secondaire) ou par
// titulaire unique (Petite Enfance/Préscolaire/Élémentaire).
function cycleForLevel(level) {
  return LEVEL_GROUPS.find((group) => group.levels.includes(level))?.id || LEGACY_DEFAULT_CYCLE;
}
// Plusieurs enseignants dans une même classe : uniquement au cycle élémentaire.
// Modèle de données rétro-compatible : `teacher` reste le titulaire (chaîne,
// utilisée partout depuis toujours) et `coTeachers` (tableau de noms complets)
// liste les enseignants supplémentaires. Les anciennes classes, sans
// `coTeachers`, continuent de fonctionner à l'identique.
function supportsMultiTeachers(level) {
  return cycleForLevel(level) === 'elementaire';
}
function classTeacherNames(cls) {
  const extra = Array.isArray(cls?.coTeachers) ? cls.coTeachers : [];
  return [...new Set([cls?.teacher, ...extra].map((name) => String(name || '').trim()).filter(Boolean))];
}
function classHasTeacher(cls, teacherName) {
  return !!teacherName && classTeacherNames(cls).includes(teacherName);
}

/* ---- Barème officiel par niveau — repris tel quel de SYGENOP_V1.html ---- */
const BAREME_SCHEMA = {
  CI: {
    domains: [
      { name: 'LANGUE ET COMMUNICATION', disciplines: [
        { label: 'Écriture', max: 10 }, { label: 'Copie', max: 10 },
        { label: "Production d'écrits", max: 0 }, { label: 'Auto Dictée', max: 10 },
        { label: 'Lecture', max: 10 }, { label: 'Compréhension', max: 6 },
        { label: "Production d'écrits (lecture)", max: 10 }, { label: 'Fluidité', max: 5 },
      ] },
      { name: 'MATHEMATIQUES', disciplines: [
        { label: 'Activités Numériques', max: 16 }, { label: 'Activités Géométriques', max: 8 },
        { label: 'Activités de Mesure', max: 12 }, { label: 'Résolution de Problèmes', max: 4 },
      ] },
      { name: 'ESVS', disciplines: [
        { label: 'Histoire', max: 4 }, { label: 'Géographie', max: 4 }, { label: 'IST', max: 4 },
        { label: 'Compétence (Hist/Géo/IST)', max: 8 }, { label: 'Vivre Ensemble', max: 6 },
        { label: 'Vivre dans son Milieu', max: 6 }, { label: 'Compétence (Vivre)', max: 8 },
      ] },
      { name: 'EPSA/Arabe', disciplines: [
        { label: 'Arts Plastiques', max: 10 }, { label: 'Arabe/Ed.Religieuse', max: 10 },
      ] },
    ],
  },
  CP: {
    domains: [
      { name: 'LANGUE ET COMMUNICATION', disciplines: [
        { label: 'Écriture', max: 10 }, { label: 'Copie', max: 10 },
        { label: 'Lecture', max: 20 }, { label: "Production d'écrits", max: 10 },
      ] },
      { name: 'MATHEMATIQUES', disciplines: [
        { label: 'Activités Numériques', max: 16 }, { label: 'Activités Géométriques', max: 8 },
        { label: 'Activités de Mesure', max: 12 }, { label: 'Résolution de Problèmes', max: 4 },
        { label: 'Contrôle de la compétence', max: 10 },
      ] },
      { name: 'ESVS', disciplines: [
        { label: 'Histoire', max: 4 }, { label: 'Géographie', max: 4 }, { label: 'IST', max: 4 },
        { label: 'Compétence (Hist/Géo/IST)', max: 8 }, { label: 'Vivre Ensemble', max: 6 },
        { label: 'Vivre dans son Milieu', max: 6 }, { label: 'Compétence (Vivre)', max: 8 },
      ] },
      { name: 'EPSA/Arabe', disciplines: [
        { label: 'Arts Plastiques', max: 10 }, { label: 'Arabe/Ed.Religieuse', max: 10 },
      ] },
    ],
  },
  CE1: {
    domains: [
      { name: 'LANGUE ET COMMUNICATION', disciplines: [
        { label: 'Ressources', max: 40 }, { label: 'Compétence', max: 20 },
      ] },
      { name: 'MATHEMATIQUES', disciplines: [
        { label: 'Activités Numériques', max: 10 }, { label: 'Activités de Mesure', max: 10 },
        { label: 'Activités Géométriques', max: 10 }, { label: 'Résolution de Problèmes', max: 10 },
        { label: 'Contrôle de la compétence', max: 20 },
      ] },
      { name: 'ESVS', disciplines: [
        { label: 'Histoire', max: 4 }, { label: 'Géographie', max: 4 }, { label: 'IST', max: 4 },
        { label: 'Compétence (Hist/Géo/IST)', max: 8 }, { label: 'Vivre Ensemble', max: 6 },
        { label: 'Vivre dans son Milieu', max: 6 }, { label: 'Compétence (Vivre)', max: 8 },
      ] },
      { name: 'EPSA/Arabe', disciplines: [
        { label: 'Arts Plastiques', max: 10 }, { label: 'Arabe/Ed.Religieuse', max: 10 },
      ] },
    ],
  },
  CM1: {
    domains: [
      { name: 'LANGUE ET COMMUNICATION', disciplines: [
        { label: 'Compétence', max: 60 }, { label: 'Ressources', max: 40 },
      ] },
      { name: 'MATHEMATIQUES', disciplines: [
        { label: 'Ressources', max: 40 }, { label: 'Compétence', max: 60 },
      ] },
      { name: 'ESVS', disciplines: [
        { label: 'Découverte du monde - Ressources', max: 24 }, { label: 'Découverte du monde - Compétence', max: 16 },
        { label: 'Dév. durable - Ressources', max: 24 }, { label: 'Dév. durable - Compétence', max: 16 },
      ] },
      { name: 'EPSA/Arabe', disciplines: [
        { label: 'Arts Plastiques', max: 10 }, { label: 'Arabe/Ed.Religieuse', max: 10 },
      ] },
    ],
  },
};
BAREME_SCHEMA.CE2 = JSON.parse(JSON.stringify(BAREME_SCHEMA.CE1));
BAREME_SCHEMA.CM2 = JSON.parse(JSON.stringify(BAREME_SCHEMA.CM1));

/* ---- Barèmes de départ des nouveaux cycles. Ils permettent à chaque écran
   (notes, bulletins, synthèses) de fonctionner dès l'ajout d'une classe. Ils
   restent entièrement adaptables, par niveau, dans Administration > Barème. ---- */
const PRESCHOOL_BAREME = {
  domains: [
    { name: 'LANGAGE ET COMMUNICATION', disciplines: [{ label: 'Langage oral', max: 20 }, { label: 'Éveil à l’écrit', max: 20 }] },
    { name: 'ACTIVITÉS MATHÉMATIQUES', disciplines: [{ label: 'Nombre et quantité', max: 20 }, { label: 'Formes et repérage', max: 20 }] },
    { name: 'ÉVEIL AU MONDE', disciplines: [{ label: 'Découverte du monde', max: 20 }, { label: 'Vie en société', max: 20 }] },
    { name: 'MOTRICITÉ ET ARTS', disciplines: [{ label: 'Psychomotricité', max: 20 }, { label: 'Expression artistique', max: 20 }] },
  ],
};
const MIDDLE_SCHOOL_BAREME = {
  domains: [
    { name: 'LANGUES ET COMMUNICATION', disciplines: [{ label: 'Français', max: 20 }, { label: 'Anglais', max: 20 }] },
    { name: 'MATHÉMATIQUES ET SCIENCES', disciplines: [{ label: 'Mathématiques', max: 20 }, { label: 'Sciences physiques', max: 20 }, { label: 'SVT', max: 20 }] },
    { name: 'SCIENCES HUMAINES', disciplines: [{ label: 'Histoire-Géographie', max: 20 }, { label: 'Éducation civique', max: 20 }] },
    { name: 'ARTS ET EPS', disciplines: [{ label: 'EPS', max: 20 }, { label: 'Arts', max: 20 }] },
  ],
};
const HIGH_SCHOOL_BAREME = {
  domains: [
    { name: 'LANGUES ET LITTÉRATURE', disciplines: [{ label: 'Français', max: 20 }, { label: 'Anglais', max: 20 }, { label: 'Philosophie', max: 20 }] },
    { name: 'MATHÉMATIQUES ET SCIENCES', disciplines: [{ label: 'Mathématiques', max: 20 }, { label: 'Sciences physiques', max: 20 }, { label: 'SVT', max: 20 }] },
    { name: 'SCIENCES HUMAINES ET ÉCONOMIE', disciplines: [{ label: 'Histoire-Géographie', max: 20 }, { label: 'Économie', max: 20 }] },
    { name: 'ARTS ET EPS', disciplines: [{ label: 'EPS', max: 20 }, { label: 'Arts', max: 20 }] },
  ],
};
// Liste des spécialités (matières) qu'un Professeur du Moyen ou du Secondaire
// peut cocher lors de son ajout. Dérivée du barème officiel du cycle, pour
// rester cohérente avec les matières réellement enseignées (Français,
// Anglais, Mathématiques, Sciences physiques, etc.). Retourne [] pour les
// cycles Préscolaire/Élémentaire, où un(e) Enseignant(e) prend en charge une
// classe entière plutôt qu'une matière précise.
function specialitesForCycle(cycle) {
  const baremeParCycle = { moyen: MIDDLE_SCHOOL_BAREME, secondaire: HIGH_SCHOOL_BAREME };
  const bareme = baremeParCycle[cycle];
  if (!bareme) return [];
  const labels = bareme.domains.flatMap((domaine) => domaine.disciplines.map((d) => d.label));
  return [...new Set(labels)];
}
['Crèche', 'Toute Petite Section', 'Petite Section', 'Moyenne Section', 'Grande Section'].forEach((level) => {
  BAREME_SCHEMA[level] = JSON.parse(JSON.stringify(PRESCHOOL_BAREME));
});
['6e', '5e', '4e', '3e'].forEach((level) => {
  BAREME_SCHEMA[level] = JSON.parse(JSON.stringify(MIDDLE_SCHOOL_BAREME));
});
['Seconde', 'Première', 'Terminale'].forEach((level) => {
  BAREME_SCHEMA[level] = JSON.parse(JSON.stringify(HIGH_SCHOOL_BAREME));
});

/* ---- Domaine additionnel « Langue Nationale » propre aux écoles MOHEBS
   (Modèle Harmonisé d'Enseignement Bilingue en langues nationales et Savoirs).
   Ce domaine s'ajoute au barème public standard pour former le barème MOHEBS
   par niveau. Les libellés/barèmes restent 100% modifiables ensuite depuis
   Administration → Barème par niveau (ajout/suppression/renommage de matières). ---- */
const MOHEBS_EXTRA_DOMAIN = {
  CI: { name: 'LANGUE NATIONALE', disciplines: [
    { label: 'Oral (Langue nationale)', max: 10 },
    { label: 'Lecture (Langue nationale)', max: 10 },
    { label: 'Écriture (Langue nationale)', max: 10 },
  ] },
  CP: { name: 'LANGUE NATIONALE', disciplines: [
    { label: 'Oral (Langue nationale)', max: 10 },
    { label: 'Lecture (Langue nationale)', max: 10 },
    { label: "Production d'écrits (Langue nationale)", max: 10 },
  ] },
  CE1: { name: 'LANGUE NATIONALE', disciplines: [
    { label: 'Ressources (Langue nationale)', max: 20 },
    { label: 'Compétence (Langue nationale)', max: 10 },
  ] },
  CM1: { name: 'LANGUE NATIONALE', disciplines: [
    { label: 'Ressources (Langue nationale)', max: 20 },
    { label: 'Compétence (Langue nationale)', max: 30 },
  ] },
};
MOHEBS_EXTRA_DOMAIN.CE2 = MOHEBS_EXTRA_DOMAIN.CE1;
MOHEBS_EXTRA_DOMAIN.CM2 = MOHEBS_EXTRA_DOMAIN.CM1;

/* ---- Barème MOHEBS par niveau = barème public standard + domaine « Langue
   Nationale ». Sert de point de départ par défaut pour les écoles marquées
   MOHEBS (state.mohebs === true) tant qu'aucun barème personnalisé n'a été
   enregistré pour ce niveau. ---- */
const MOHEBS_BAREME_SCHEMA = {};
LEVELS.forEach((l) => {
  const extraDomain = MOHEBS_EXTRA_DOMAIN[l];
  MOHEBS_BAREME_SCHEMA[l] = {
    domains: [
      ...JSON.parse(JSON.stringify(BAREME_SCHEMA[l].domains)),
      ...(extraDomain ? [JSON.parse(JSON.stringify(extraDomain))] : []),
    ],
  };
});

function buildConfigForLevels() {
  const out = {};
  LEVELS.forEach((l) => {
    out[l] = {
      domains: BAREME_SCHEMA[l].domains.map((d, di) => ({
        name: d.name,
        disciplines: d.disciplines.map((x, xi) => ({ id: `${l}_${di}_${xi}`, label: x.label, max: x.max, coefficient: Number(x.coefficient) || 1 })),
      })),
    };
  });
  return out;
}

/* ---- Périodes de l'année scolaire ---- */
const TRIMESTRES = [
  { key: 'T1', label: '1er Trimestre' },
  { key: 'T2', label: '2e Trimestre' },
  { key: 'T3', label: '3e Trimestre' },
];
const SEMESTRES = [
  { key: 'S1', label: '1er Semestre' },
  { key: 'S2', label: '2e Semestre' },
];
const ALL_PERIODS = [...TRIMESTRES, ...SEMESTRES];
const EVALUATION_TYPES = [
  { key: 'pretest', label: 'Pré-test' },
  { key: 'standardisee', label: 'Évaluations standardisées' },
  { key: 'essai', label: 'Essais' },
  { key: 'controle', label: 'Contrôles' },
  { key: 'posttest', label: 'Post-test' },
];
function evaluationKey(period, type) { return `${period}::${type || 'controle'}`; }
function evaluationTypeLabel(type) { return EVALUATION_TYPES.find((item) => item.key === type)?.label || type; }
function splitEvaluationKey(key) {
  const [period, type] = String(key || '').split('::');
  return { period, type: type || 'controle' };
}
function periodsForSchool(state) {
  return ['moyen', 'secondaire'].includes(state?.header?.cycle) ? SEMESTRES : TRIMESTRES;
}
function periodLabel(state, key) {
  if (String(key).includes('::')) {
    const e = splitEvaluationKey(key);
    return `${periodLabel(state, e.period)} — ${evaluationTypeLabel(e.type)}`;
  }
  return periodsForSchool(state).find((period) => period.key === key)?.label
    || ALL_PERIODS.find((period) => period.key === key)?.label
    || key;
}

/* ---- Barème officiel (brut, non enregistré) pour un niveau — barème public
   standard, ou barème MOHEBS (+ Langue Nationale) si `mohebs` est vrai. ---- */
function officialDomainsForLevel(level, mohebs) {
  const schema = (mohebs && MOHEBS_BAREME_SCHEMA[level]) ? MOHEBS_BAREME_SCHEMA[level] : BAREME_SCHEMA[level];
  return schema.domains.map((d, di) => ({
    name: d.name,
    disciplines: d.disciplines.map((x, xi) => ({ id: `${level}_${di}_${xi}`, label: x.label, max: x.max, coefficient: Number(x.coefficient) || 1 })),
  }));
}

/* ---- Config effective d'un niveau : celle enregistrée dans l'école si elle
   existe déjà (édition future via Administration), sinon le barème officiel
   — MOHEBS (langues nationales) si l'école est marquée comme telle, sinon
   le barème public standard. ---- */
function cfgForLevel(state, level) {
  const stored = state && state.config && state.config[level];
  if (stored && Array.isArray(stored.domains) && stored.domains.length) return { ...stored, weightedAssessments: stored.weightedAssessments ?? supportsWeightedAssessments(state), domains: stored.domains.map((d) => ({ ...d, disciplines: (d.disciplines || []).map((x) => ({ ...x, coefficient: Number(x.coefficient) || 1 })) })) };
  return { domains: officialDomainsForLevel(level, state && state.mohebs), weightedAssessments: supportsWeightedAssessments(state) };
}

/* ============================================================
   MOTEUR DE BARÈME — calcul des scores, moyennes et rangs
   ============================================================ */
function isAbs(v) { if (v == null) return false; return String(v).trim().toLowerCase().startsWith('abs'); }
function toNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s.startsWith('abs')) return 0;
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) ? 0 : n;
}
function domBareme(domain) { return (domain.disciplines || []).reduce((s, x) => s + (Number(x.max) || 0), 0); }
function genBareme(cfg) { return (cfg && cfg.domains ? cfg.domains : []).reduce((s, d) => s + domBareme(d), 0); }
// Devoirs pris en compte pour une discipline à coefficient (Moyen/Secondaire) :
// trois devoirs (D1, D2, D3), en plus de la composition.
const DEVOIR_KEYS = ['d1', 'd2', 'd3'];
const DEVOIR_LABELS = { d1: 'D1', d2: 'D2', d3: 'D3' };
// Moyenne des devoirs renseignés (D1/D2/D3) pour une discipline :
// somme des devoirs renseignés ÷ nombre de devoirs renseignés.
// Retourne null si aucun devoir n'est renseigné (distinct de 0, pour ne pas
// pénaliser un devoir pas encore donné).
function devoirsMoyenne(devoirs) {
  if (devoirs != null && typeof devoirs !== 'object') {
    // Ancien format (une seule note « Devoirs », avant l'introduction de
    // D1/D2/D3) : conservé pour ne pas perdre les notes déjà saisies.
    const legacy = String(devoirs).trim();
    return legacy === '' || isAbs(devoirs) ? null : toNum(devoirs);
  }
  const filled = DEVOIR_KEYS
    .map((k) => devoirs?.[k])
    .filter((value) => value != null && String(value).trim() !== '' && !isAbs(value));
  if (!filled.length) return null;
  return filled.reduce((sum, value) => sum + toNum(value), 0) / filled.length;
}
// Moyenne d'une matière à coefficient (Moyen/Secondaire) :
// (Moyenne des devoirs + Composition) ÷ 2. Retourne null si ni devoir ni
// composition n'ont été renseignés (affichage « — »), sinon la valeur
// manquante compte pour 0 dans la moyenne.
function moyenneMatiereAvecDevoirs(compositionRaw, devoirs) {
  const devMoy = devoirsMoyenne(devoirs);
  const hasComposition = compositionRaw != null && String(compositionRaw).trim() !== '' && !isAbs(compositionRaw);
  if (devMoy == null && !hasComposition) return null;
  const compositionValue = hasComposition ? toNum(compositionRaw) : 0;
  return ((devMoy || 0) + compositionValue) / 2;
}
function scoresFor(student, periodKey) {
  const scores = student?.scores || {};
  if (scores[periodKey]) return scores[periodKey];
  const parsed = splitEvaluationKey(periodKey);
  if (parsed.type !== 'controle') return {};
  if (scores[parsed.period]) return scores[parsed.period];
  const firstTypedKey = Object.keys(scores).find((key) => key.startsWith(`${parsed.period}::`));
  return firstTypedKey ? scores[firstTypedKey] : {};
}
function computeStudentScores(cfg, sc) {
  const scores = sc || {};
  const weighted = !!cfg?.weightedAssessments;
  const res = { domains: [], total: 0, coefficientTotal: 0 };
  (cfg.domains || []).forEach((d) => {
    let t = 0;
    let domainCoefficient = 0;
    const bar = domBareme(d);
    d.disciplines.forEach((x) => {
      const coefficient = Math.max(1, Number(x.coefficient) || 1);
      const compositionRaw = scores[x.id];
      const devoirsRaw = weighted ? scores.devoirs?.[x.id] : null;
      const composition = toNum(compositionRaw);
      const note = weighted ? (moyenneMatiereAvecDevoirs(compositionRaw, devoirsRaw) ?? 0) : composition;
      if (weighted) {
        // Moyen/Secondaire : Moy = (moyenne des devoirs + composition) ÷ 2,
        // sur 20 — pas de normalisation par le barème de la matière.
        // Points de la matière = Moy × coefficient.
        t += note * coefficient;
        domainCoefficient += coefficient;
      } else {
        t += composition;
      }
    });
    const effectiveBareme = weighted ? domainCoefficient * 20 : bar;
    res.domains.push({
      name: d.name, total: t, bareme: effectiveBareme, coefficient: domainCoefficient,
      moy: weighted ? (domainCoefficient > 0 ? t / domainCoefficient : 0) : (bar > 0 ? (t * 10) / bar : 0),
      pct: weighted ? (domainCoefficient > 0 ? t / (domainCoefficient * 20) : 0) : (bar > 0 ? t / bar : 0),
      pass: weighted ? (domainCoefficient > 0 ? t >= domainCoefficient * 10 : false) : (bar > 0 ? t >= bar / 2 : false),
    });
    res.total += t;
    res.coefficientTotal += weighted ? domainCoefficient : 0;
  });
  // Moyenne générale (Moyen/Secondaire) = total des points de toutes les
  // matières ÷ total des coefficients — résultat sur 20 (pas de rescale /10).
  res.bareme = weighted ? res.coefficientTotal * 20 : genBareme(cfg);
  res.moy = weighted ? (res.coefficientTotal > 0 ? res.total / res.coefficientTotal : 0) : (res.bareme > 0 ? (res.total * 10) / res.bareme : 0);
  res.pct = res.bareme > 0 ? res.total / res.bareme : 0;
  res.pass = weighted ? (res.coefficientTotal > 0 ? res.total >= res.coefficientTotal * 10 : false) : (res.bareme > 0 ? res.total >= res.bareme / 2 : false);
  return res;
}
function computeRanks(cfg, students, periodKey) {
  const moyennes = students.map((s) => computeStudentScores(cfg, scoresFor(s, periodKey)).moy);
  return moyennes.map((x) => 1 + moyennes.filter((y) => y > x + 1e-9).length);
}
// Rang par matière (Moyen/Secondaire) : classe les élèves d'après leur
// Moy = (moyenne des devoirs + composition) ÷ 2 pour la discipline donnée.
// Retourne null pour un élève sans note dans cette matière (pas de rang).
function computeDisciplineRanks(cfg, students, periodKey, disciplineId) {
  const weighted = !!cfg?.weightedAssessments;
  const values = students.map((s) => {
    const sc = scoresFor(s, periodKey);
    const v = sc[disciplineId];
    if (weighted) return moyenneMatiereAvecDevoirs(v, sc.devoirs?.[disciplineId]);
    return v == null || v === '' || isAbs(v) ? null : toNum(v);
  });
  return values.map((x) => (x == null ? null : 1 + values.filter((y) => y != null && y > x + 1e-9).length));
}
function fmtNote(n, d = 2) {
  if (!isFinite(n)) return '0';
  const f = Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
  return String(f).replace('.', ',');
}
function fmtPctVal(n) { return `${Math.round(n * 100)}%`; }
function mention(moy, weighted) {
  if (weighted) {
    if (moy >= 16) return 'Très Bien';
    if (moy >= 14) return 'Bien';
    if (moy >= 12) return 'Assez Bien';
    if (moy >= 10) return 'Passable';
    return 'Insuffisant';
  }
  if (moy >= 8) return 'Très Bien';
  if (moy >= 7) return 'Bien';
  if (moy >= 6) return 'Assez Bien';
  if (moy >= 5) return 'Passable';
  return 'Insuffisant';
}
function noteAppreciation(pct) {
  if (pct >= 0.8) return 'Excellent';
  if (pct >= 0.7) return 'Très Bien';
  if (pct >= 0.6) return 'Bien';
  if (pct >= 0.5) return 'Assez Bien';
  if (pct >= 0.4) return 'Passable';
  if (pct >= 0.25) return 'Insuffisant';
  return 'Très Insuffisant';
}
function domTotalVal(sc, d) { return (d.disciplines || []).reduce((s, x) => s + toNum(sc[x.id]), 0); }
function classesOfLevel(state, level) {
  return Object.entries((state && state.classes) || {})
    .filter(([, c]) => c.level === level)
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
}
function classAvgForPeriod(cfg, students, periodKey) {
  const withData = students.filter((s) => Object.keys(scoresFor(s, periodKey)).length > 0);
  if (!withData.length) return null;
  const sum = withData.reduce((a, s) => a + computeStudentScores(cfg, scoresFor(s, periodKey)).moy, 0);
  return sum / withData.length;
}
function DOMSHORT(name) {
  const m = { 'LANGUE ET COMMUNICATION': 'LC', MATHEMATIQUES: 'Maths', ESVS: 'ESVS', 'EPSA/Arabe': 'EPSA' };
  return m[name] || name;
}

/* ============================================================
   PAIEMENTS — frais de scolarité, reçus, recouvrement
   ============================================================ */
const MODES_PAIEMENT = {
  especes: 'Espèces', wave: 'Wave', om: 'Orange Money', cheque: 'Chèque', virement: 'Virement bancaire',
};
const PAYMENT_TYPES = {
  inscription: { id: 'inscription', label: 'Inscription / Réinscription', description: "Frais d'entrée à l'inscription", icon: 'ClipboardCheck' },
  mensualite: { id: 'mensualite', label: 'Mensualité / Scolarité', description: 'Paiement mensuel de la scolarité', icon: 'CalendarDays' },
};
const PAYMENT_RUBRIQUE_DEFAULTS = [
  { id: 'inscription', label: "Frais d'inscription", nature: 'entree' },
  { id: 'scolarite', label: 'Scolarité', nature: 'annuel' },
  { id: 'cantine', label: 'Cantine', nature: 'annuel' },
  { id: 'car', label: 'Car / transport scolaire', nature: 'annuel' },
  { id: 'tenue', label: 'Tenue scolaire', nature: 'entree' },
  { id: 'bibliotheque', label: 'Bibliothèque', nature: 'annuel' },
  { id: 'informatique', label: 'Informatique', nature: 'annuel' },
];
function normalizePaymentRubriques(f = {}) {
  const existing = Array.isArray(f.rubriques) ? f.rubriques : [
    { id: 'inscription', label: "Frais d'inscription", montant: Number(f.inscription) || 0, nature: 'entree' },
    { id: 'scolarite', label: 'Scolarité', montant: Number(f.scolarite) || 0, nature: 'annuel' },
  ];
  const byId = new Map(existing.map((item) => [String(item.id || '').toLowerCase(), item]));
  const byLabel = new Map(existing.map((item) => [String(item.label || '').trim().toLowerCase(), item]));
  const used = new Set();
  const normalized = PAYMENT_RUBRIQUE_DEFAULTS.map((defaultItem) => {
    const found = byId.get(defaultItem.id) || byLabel.get(defaultItem.label.toLowerCase());
    if (found) used.add(found);
    return { ...defaultItem, ...(found || {}), id: defaultItem.id, label: found?.label || defaultItem.label, nature: found?.nature || defaultItem.nature, montant: Number(found?.montant) || 0, actif: found?.actif !== false };
  });
  existing.filter((item) => !used.has(item) && !PAYMENT_RUBRIQUE_DEFAULTS.some((d) => d.id === item.id)).forEach((item) => normalized.push({ ...item, id: item.id || uid('fee'), montant: Number(item.montant) || 0, actif: item.actif !== false }));
  return normalized;
}
function feeForLevel(state, level) {
  const f = (state && state.fees && state.fees[level]) || {};
  const rubriques = normalizePaymentRubriques(f);
  return { rubriques: rubriques.filter((r) => r.actif !== false).map((r) => ({ ...r, montant: Number(r.montant) || 0 })), mensualites: Math.max(1, Number(f.mensualites) || 10) };
}
// Frais spécifiques d'un élève :
//  - « cas social » : réduction en % appliquée au montant de chaque rubrique ;
//  - « rubriquesMois » : { rubriqueId: [YYYY-MM] } l'ensemble des mois où
//    l'élève est abonné à la rubrique. Absent = abonné tous les mois de
//    l'année scolaire. Liste vide = jamais abonné.
// « Cas social » : réduction en % (0-100) appliquée au montant de chaque rubrique.
// Les anciennes fiches stockaient une chaîne « Oui »/« Non » : on les convertit
// (« Oui » → 50 % par défaut, « Non »/vide → 0). Modèle unique pour tous les cycles.
function normalizeCasSocial(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (value === 'Oui') return 50;
  if (value === 'Non') return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function studentFeesFor(state, level, student) {
  const f = feeForLevel(state, level);
  const remise = normalizeCasSocial(student && student.casSocial);
  const coef = remise > 0 ? (100 - remise) / 100 : 1;
  const rubriquesMois = (student && student.rubriquesMois) || {};
  const yearMonths = schoolYearMonths(state);
  const rubriques = f.rubriques.map((r) => {
    const months = rubriquesMois[r.id];
    return {
      ...r,
      montant: coef < 1 ? Math.round((Number(r.montant) || 0) * coef) : (Number(r.montant) || 0),
      activeMonths: months === undefined ? yearMonths : (Array.isArray(months) ? months.slice() : []),
    };
  });
  return { rubriques, mensualites: f.mensualites, remise, coef, rubriquesMois, yearMonths };
}
// Dû d'inscription : total des rubriques « À l'entrée » auxquelles l'élève
// est abonné (il y est abonné un mois au moins dans l'année).
function studentInscriptionDue(state, level, student) {
  const fe = student ? studentFeesFor(state, level, student) : feeForLevel(state, level);
  return fe.rubriques.filter((r) => r.nature === 'entree' && (student ? r.activeMonths.length > 0 : true)).reduce((sum, r) => sum + r.montant, 0);
}
// Dû mensuel d'un élève pour un mois donné : somme des rubriques (hors
// « À l'entrée ») auxquelles il est abonné ce mois-là, étalée sur le nombre
// de mensualités. Sans mois précisé → référence (tous les mois actifs).
function studentMonthlyDue(state, level, student, month) {
  const fe = student ? studentFeesFor(state, level, student) : feeForLevel(state, level);
  return fe.rubriques.filter((r) => r.nature !== 'entree' && (student ? (month ? r.activeMonths.includes(month) : true) : true)).reduce((sum, r) => sum + Math.round((Number(r.montant) || 0) / fe.mensualites), 0);
}
// Dû « mensualité » sur toute l'année : cumul du dû mensuel de chaque mois
// de l'année scolaire. Les rubriques « À l'entrée » sont réglées à
// l'inscription et ne font l'objet d'aucune mensualité.
function studentAnnualDue(state, level, student) {
  if (!student) return feeForLevel(state, level).rubriques.filter((r) => r.nature !== 'entree').reduce((sum, r) => sum + r.montant, 0);
  const fe = studentFeesFor(state, level, student);
  // Somme les montants bruts des rubriques actives (hors « À l'entrée »).
  // NE PAS sommer studentMonthlyDue sur les mois — cela diviserait par
  // mensualites puis re-multiplierait par 12, gonflant le dû de 12/mensualites.
  return fe.rubriques.filter((r) => r.nature !== 'entree' && r.activeMonths.length > 0).reduce((sum, r) => sum + r.montant, 0);
}
function studentTotalDue(state, level, student) {
  if (student) return studentInscriptionDue(state, level, student) + studentAnnualDue(state, level, student);
  return feeForLevel(state, level).rubriques.reduce((sum, rubrique) => sum + rubrique.montant, 0);
}
function studentPaiements(student) {
  return (student && student.paiements) || [];
}
function studentTotalPaid(student) {
  return studentPaiements(student).reduce((s, p) => s + (Number(p.montant) || 0), 0);
}
// Paiements hérités (avant l'ajout du champ type_paiement) : on déduit la
// nature à partir des lignes cochées du reçu (rubriques « À l'entrée »), sinon
// on considère qu'il s'agit d'une mensualité (caisse mensuelle).
const INSCRIPTION_LINE_KEYS = ["frais d'inscription", 'inscription', 'tenue scolaire', 'tenu scolaire', 'ass', 'ape'];
function paymentTypeKey(p) {
  if (p && (p.type_paiement === 'inscription' || p.type_paiement === 'mensualite')) return p.type_paiement;
  const lignes = Array.isArray(p && p.lignes) ? p.lignes.filter((l) => l && l.checked) : [];
  const text = lignes.map((l) => `${l.label || ''} ${l.id || ''}`).join(' ').toLowerCase();
  if (text && INSCRIPTION_LINE_KEYS.some((k) => text.includes(k))) return 'inscription';
  return 'mensualite';
}
function studentPaidByType(student, type) {
  return studentPaiements(student).reduce((s, p) => s + (paymentTypeKey(p) === type ? (Number(p.montant) || 0) : 0), 0);
}
function studentDueByType(state, level, student) {
  const inscriptionDue = studentInscriptionDue(state, level, student);
  const mensualiteDue = studentAnnualDue(state, level, student);
  return { inscription: inscriptionDue, mensualite: mensualiteDue, total: inscriptionDue + mensualiteDue };
}
function studentReliquatByType(state, level, student) {
  const due = studentDueByType(state, level, student);
  const paid = {
    inscription: studentPaidByType(student, 'inscription'),
    mensualite: studentPaidByType(student, 'mensualite'),
  };
  const paidTotal = paid.inscription + paid.mensualite;
  // Trop-perçus croisés : un excédent d'inscription s'impute sur la
  // scolarité (et réciproquement) avant d'apparaître en reliquat.
  const excessInscription = Math.max(0, paid.inscription - due.inscription);
  const excessMensualite = Math.max(0, paid.mensualite - due.mensualite);
  const inscription = Math.max(0, due.inscription - paid.inscription - excessMensualite);
  const mensualite = Math.max(0, due.mensualite - paid.mensualite - excessInscription);
  const total = Math.max(0, due.total - paidTotal);
  return { inscription, mensualite, total, due, paid };
}
function paymentStatus(due, paid) {
  if (due <= 0) return { key: 'sans_frais', label: 'Frais non définis', tone: 'muted' };
  if (paid <= 0) return { key: 'retard', label: 'Aucun versement', tone: 'red' };
  if (paid >= due) return { key: 'a_jour', label: 'À jour', tone: 'green' };
  return { key: 'partiel', label: 'Partiel', tone: 'gold' };
}
const MOIS_COURTS = ['Janv.', 'Févr.', 'Mars', 'Avr.', 'Mai', 'Juin', 'Juil.', 'Août', 'Sept.', 'Oct.', 'Nov.', 'Déc.'];
function monthLabel(ym) {
  const parts = String(ym || '').split('-');
  const idx = (Number(parts[1]) || 1) - 1;
  return `${MOIS_COURTS[idx] || parts[1] || '?'} ${String(parts[0] || '').slice(2)}`.trim();
}
function paymentMonthKey(p) {
  return p.mois || String(p.date || '').slice(0, 7);
}
function studentPaidInMonth(student, month) {
  return studentPaiements(student).reduce((s, p) => s + (paymentMonthKey(p) === month ? (Number(p.montant) || 0) : 0), 0);
}
function studentPaidInMonthByType(student, month, type) {
  return studentPaiements(student).reduce((s, p) => s + (paymentMonthKey(p) === month && paymentTypeKey(p) === type ? (Number(p.montant) || 0) : 0), 0);
}
function schoolYearMonths(state) {
  const annee = String((state && state.header && state.header.annee) || '');
  const years = (annee.match(/\d{4}/g) || []).map(Number);
  const startYear = years[0] || new Date().getFullYear();
  const endYear = years[1] || startYear + 1;
  const months = [];
  let y = startYear;
  let m = 10;
  for (let i = 0; i < 12; i += 1) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    if (y === endYear && m === 7) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return months;
}
function nextRecuNumero(state) {
  const seq = (Number(state && state.recuSeq) || 0) + 1;
  const annee = (state && state.header && state.header.annee) || String(new Date().getFullYear());
  const anneeShort = String(annee).replace(/\D/g, '').slice(0, 4) || new Date().getFullYear();
  return { numero: `REC-${anneeShort}-${String(seq).padStart(4, '0')}`, seq };
}
function montantEnLettres(n) {
  // Écriture simplifiée du montant en toutes lettres (français), suffisante pour un reçu.
  const unites = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'];
  const dix19 = ['dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
  const dizaines = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante-dix', 'quatre-vingt', 'quatre-vingt-dix'];
  function trois(n) {
    n = Math.floor(n);
    let s = '';
    const c = Math.floor(n / 100), r = n % 100;
    if (c > 0) s += (c > 1 ? unites[c] + ' cent' : 'cent') + (c > 1 && r === 0 ? 's' : '') + (r > 0 ? ' ' : '');
    if (r >= 10 && r < 20) s += dix19[r - 10];
    else if (r >= 20) {
      const d = Math.floor(r / 10), u = r % 10;
      s += dizaines[d] + (u > 0 ? (d === 7 || d === 9 ? '-' + dix19[u] : '-' + unites[u]) : (d === 8 ? 's' : ''));
    } else if (r > 0) s += unites[r];
    return s.trim();
  }
  n = Math.round(Number(n) || 0);
  if (n === 0) return 'zéro';
  let reste = n, parts = [];
  const millions = Math.floor(reste / 1000000); reste %= 1000000;
  const milliers = Math.floor(reste / 1000); reste %= 1000;
  if (millions) parts.push(trois(millions) + (millions > 1 ? ' millions' : ' million'));
  if (milliers) parts.push((milliers === 1 ? 'mille' : trois(milliers) + ' mille'));
  if (reste || !parts.length) parts.push(trois(reste));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
// Résumé des paiements pour une école entière (utilisé par le tableau de bord
// et le classement inter-écoles) — parcourt toutes les classes de tous les niveaux.
function schoolPaymentsSummary(state) {
  let totalDue = 0, totalPaid = 0, effectif = 0, aJour = 0;
  Object.values((state && state.classes) || {}).forEach((cls) => {
    (cls.students || []).forEach((st) => {
      const due = studentTotalDue(state, cls.level, st);
      effectif++;
      totalDue += due;
      const paid = studentTotalPaid(st);
      totalPaid += paid;
      if (due > 0 && paid >= due) aJour++;
    });
  });
  const taux = totalDue > 0 ? totalPaid / totalDue : 0;
  return { totalDue, totalPaid, effectif, aJour, taux };
}
/* ---- Dépenses de l'école (sorties) ---- */
function schoolDepenses(state) { return (state && Array.isArray(state.depenses)) ? state.depenses : []; }
function schoolTotalOut(state) { return schoolDepenses(state).reduce((s, d) => s + (Number(d.montant) || 0), 0); }
// Solde de trésorerie = total encaissé (entrées) − total dépenses (sorties)
function schoolBalance(state) { return schoolPaymentsSummary(state).totalPaid - schoolTotalOut(state); }

function emptySchoolState() {
  return {
    header: { ia: 'DAKAR', ief: 'GRAND DAKAR', ecole: '', type: 'École Publique', directeur: '', tel: '', annee: '2026/2027', periodeActif: 'T1' },
    config: {},
    classes: {},
    personnel: [],
    studentTransferRequests: [],
    staffAbsenceRequests: [],
    staffAttestRequests: [],
    staffCertCounter: 0,
    pointage: {},
    fees: {},
    recuSeq: 0,
    mohebs: false,
    category: 'public',
    depenses: [],
    auditLog: [],
    actualites: [],
  };
}

/* ============================================================
   MARQUE ÉCOLE — logo & en-tête des documents imprimables
   Le logo est optionnel et stocké en base64 (data URL) dans
   header.logo. Toutes les fonctions de rendu ci-dessous sont
   partagées par les documents PDF (bulletins, cartes, reçus…).
   ============================================================ */
function escHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function schoolLogoData(state) {
  return (state && state.header && state.header.logo) || '';
}
// CSS commun aux fenêtres d'impression (popup) : en-tête document avec logo.
const PRINT_DOC_CSS = `.doc-head{display:flex;align-items:center;gap:14px;border-bottom:2px solid #176b49;padding-bottom:10px;margin-bottom:14px}.doc-head .doc-logo{width:auto;max-height:56px;max-width:90px;object-fit:contain;flex-shrink:0}.doc-head .doc-head-txt{flex:1}.doc-head .doc-school{font-size:13px;font-weight:bold;color:#176b49}.doc-head .doc-title{font-size:20px;font-weight:bold;color:#17251d;margin-top:2px}`;
// En-tête HTML complet pour les documents ouverts dans une popup d'impression.
function docHeadHtml(state, title) {
  const logo = schoolLogoData(state);
  const school = escHtml((state && state.header && state.header.ecole) || 'Établissement scolaire');
  return `<div class="doc-head">${logo ? `<img class="doc-logo" src="${escHtml(logo)}" alt="Logo" />` : ''}<div class="doc-head-txt"><div class="doc-school">${school}</div><div class="doc-title">${escHtml(title)}</div></div></div>`;
}
// Logo de l'école affiché sur les documents imprimés à l'écran (bulletins,
// cartes, certificats, reçus…). Rend null si aucun logo n'est configuré.
function SchoolLogoMark({ state, width = 48, style }) {
  const logo = schoolLogoData(state);
  if (!logo) return null;
  return <img className="school-logo" src={logo} alt="Logo de l'école" style={{ width, height: 'auto', maxHeight: 80, objectFit: 'contain', flexShrink: 0, ...style }} />;
}

/* ============================================================
   STATISTIQUES CONSOLIDÉES — présences du personnel & score trimestriel
   (utilisées par le tableau de bord École/Directeur et par la vue
   d'ensemble IEF / Super Admin)
   ============================================================ */
// Taux de présence du personnel d'une école sur un mois donné.
// Le taux est calculé sur les jours effectivement pointés (statut renseigné),
// pour rester cohérent avec le récapitulatif mensuel des heures.
function schoolPresenceSummary(state, mois) {
  const personnel = (state && state.personnel) || [];
  const pointage = (state && state.pointage) || {};
  const jours = joursDuMois(mois || currentMonthISO());
  const settings = attendanceSettings(state);
  const heuresPrevuesParAgent = heuresAttenduesMois(mois || currentMonthISO(), settings);
  let joursPointes = 0, joursPresents = 0, totalHeures = 0;
  personnel.forEach((p) => {
    jours.forEach((iso) => {
      const rec = getPointageRecord(pointage, iso, p.id);
      if (!rec || !rec.statut) return;
      joursPointes++;
      if (rec.statut === 'P' || rec.statut === 'R') {
        joursPresents++;
        totalHeures += Number(rec.heures) || 0;
      }
    });
  });
  return {
    personnelTotal: personnel.length,
    joursPointes,
    joursPresents,
    totalHeures,
    tauxPresence: joursPointes > 0 ? joursPresents / joursPointes : null,
    heuresPrevuesParAgent,
    heuresPrevues: heuresPrevuesParAgent * personnel.length,
    tauxExecution: heuresPrevuesParAgent > 0 && personnel.length > 0 ? totalHeures / (heuresPrevuesParAgent * personnel.length) : null,
    moyenneHeures: personnel.length > 0 ? totalHeures / personnel.length : 0,
  };
}
function teacherAttendanceSummary(state, staffId, mois) {
  const settings = attendanceSettings(state);
  const pointage = state?.pointage || {};
  const target = heuresAttenduesMois(mois, settings);
  let heures = 0, presents = 0, absences = 0, retards = 0, conges = 0;
  joursDuMois(mois).forEach((date) => {
    const rec = getPointageRecord(pointage, date, staffId);
    if (!rec) return;
    if (rec.statut === 'P') { presents++; heures += Number(rec.heures) || 0; }
    if (rec.statut === 'R') { retards++; heures += Number(rec.heures) || 0; }
    if (rec.statut === 'A') absences++;
    if (rec.statut === 'C') conges++;
  });
  return { heures, target, presents, absences, retards, conges, execution: target > 0 ? heures / target : 0 };
}
// Combine les résumés de présence de plusieurs écoles (vue IEF / Super Admin).
// La moyenne IEF est la moyenne simple des taux des écoles qui ont renseigné
// au moins un pointage pour le mois sélectionné. Une grande école ne pèse donc
// pas davantage qu'une petite école dans l'indicateur de l'IEF.
function combinePresenceSummaries(list) {
  const acc = list.reduce((a, s) => ({
    personnelTotal: a.personnelTotal + s.personnelTotal,
    joursPointes: a.joursPointes + s.joursPointes,
    joursPresents: a.joursPresents + s.joursPresents,
    totalHeures: a.totalHeures + s.totalHeures,
    heuresPrevues: a.heuresPrevues + s.heuresPrevues,
  }), { personnelTotal: 0, joursPointes: 0, joursPresents: 0, totalHeures: 0, heuresPrevues: 0 });
  const reportingSchools = list.filter((s) => s.joursPointes > 0 && s.tauxPresence != null);
  const tauxPresence = reportingSchools.length
    ? reportingSchools.reduce((sum, s) => sum + s.tauxPresence, 0) / reportingSchools.length
    : null;
  const moyenneHeures = reportingSchools.length
    ? reportingSchools.reduce((sum, s) => sum + s.moyenneHeures, 0) / reportingSchools.length
    : 0;
  const objectifMoyen = reportingSchools.length
    ? reportingSchools.reduce((sum, s) => sum + s.heuresPrevuesParAgent, 0) / reportingSchools.length
    : 0;
  return {
    ...acc,
    schoolsWithData: reportingSchools.length,
    tauxPresence,
    moyenneHeures,
    objectifMoyen,
    tauxExecution: objectifMoyen > 0 ? moyenneHeures / objectifMoyen : null,
  };
}
// Moyenne générale (/10) et taux de réussite d'une école pour un trimestre donné —
// reprend le même mode de calcul que la Synthèse (computeStudentScores).
function schoolAcademicSummary(state, period) {
  let effectifNote = 0, sumMoy = 0, reussite = 0;
  levelsForSchool(state).forEach((level) => {
    const cfg = cfgForLevel(state, level);
    classesOfLevel(state, level).forEach(([, cls]) => {
      (cls.students || []).forEach((st) => {
        const sc = scoresFor(st, period);
        if (!Object.keys(sc).length) return;
        const cs = computeStudentScores(cfg, sc);
        effectifNote++;
        sumMoy += cs.moy;
        if (cs.pass) reussite++;
      });
    });
  });
  return {
    effectifNote,
    moyenne: effectifNote > 0 ? sumMoy / effectifNote : null,
    tauxReussite: effectifNote > 0 ? reussite / effectifNote : null,
  };
}
function combineAcademicSummaries(list) {
  const acc = list.reduce((a, s) => ({
    effectifNote: a.effectifNote + s.effectifNote,
    sumMoy: a.sumMoy + (s.moyenne != null ? s.moyenne * s.effectifNote : 0),
    reussite: a.reussite + (s.tauxReussite != null ? s.tauxReussite * s.effectifNote : 0),
  }), { effectifNote: 0, sumMoy: 0, reussite: 0 });
  return {
    effectifNote: acc.effectifNote,
    moyenne: acc.effectifNote > 0 ? acc.sumMoy / acc.effectifNote : null,
    tauxReussite: acc.effectifNote > 0 ? acc.reussite / acc.effectifNote : null,
  };
}

/* ============================================================
   ACTUALITÉS — publications par école
   ============================================================ */
function sortActualites(list) {
  return [...(list || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}
function addActualite(state, { titre, contenu, auteur, important }) {
  const item = {
    id: uid('news'),
    titre: (titre || '').trim(),
    contenu: (contenu || '').trim(),
    auteur: auteur || '',
    important: !!important,
    date: new Date().toISOString(),
  };
  return { ...state, actualites: [item, ...((state && state.actualites) || [])] };
}
function removeActualite(state, id) {
  return { ...state, actualites: ((state && state.actualites) || []).filter((a) => a.id !== id) };
}

// Dernier recours : code d'une école encore présent dans l'ancien cache local
// des écoles (installations antérieures à la sécurisation, où la liste
// contenait la colonne "code"). Les codes n'ont pas été invalidés côté base,
// ils restent donc valides ; si le cache ne les contient plus, renvoie ''.
function cachedSchoolCode(id) {
  try {
    const row = (loadJSON(LS_SCHOOLS, []) || []).find((s) => s && s.id === id);
    return String((row && row.code) || '').trim();
  } catch (_) { return ''; }
}

async function loadSchoolData(id) {
  const session = loadSessionJSON(LS_SESSION, null);
  const ownsSchool = session?.schoolId === id;
  const staffRole = ['teacher', 'guard', 'accountant', 'secretary'].includes(session?.role);
  // Le rôle « IEF » (ief) ne dispose QUE du code IEF saisi au
  // login (session.iefCode) : il passe TOUJOURS par la lecture READ-ONLY
  // get_school_data_ief. On neutralise ici tout éventuel code école traînant
  // en localStorage (LS_SCHOOL_CODE) : jamais de lecture via get_school_data
  // (qui renvoie les codes du personnel) ni d'écriture via save_school_data.
  const isIefRole = session?.role === 'ief';
  let schoolCode = (!isIefRole && ownsSchool ? (session.schoolCode || getActiveSchoolCode()) : '') || null;
  const staffCode = staffRole && ownsSchool ? (session.staffCode || '') : '';
  const adminCode = session?.role === 'admin' ? (session.adminCode || session.iefAdminCode || '') : '';
  // Si aucun code n'est trouvé via la session (session expirée / rechargement
  // de page), on tente le code persisté dans localStorage : c'est le seul
  // moyen de garder l'accès aux données après fermeture du navigateur.
  if (!isIefRole && !schoolCode && !staffCode && !adminCode) {
    schoolCode = getActiveSchoolCode() || null;
  }
  try {
    let payload = null;
    let serverVersion = null;
    if (schoolCode) {
      const result = await sb('POST', 'rpc/get_school_data', '', { p_school_id: id, p_code: schoolCode });
      if (result?.ok === false) throw new Error(result.error || 'Accès refusé');
      payload = result?.data || result;
      serverVersion = result?.version ?? null;
    } else if (staffCode) {
      const result = await sb('POST', 'rpc/get_school_data_staff', '', { p_school_id: id, p_staff_id: session.staffId, p_code: staffCode });
      if (result?.ok === false) throw new Error(result.error || 'Accès refusé');
      payload = result?.data || result;
      serverVersion = result?.version ?? null;
    } else if (adminCode) {
      const result = await sb('POST', 'rpc/get_school_data_admin', '', { p_school_id: id, p_admin_code: adminCode });
      if (result?.ok === false) throw new Error(result.error || 'Accès refusé');
      payload = result?.data || result;
      serverVersion = result?.version ?? null;
    } else if (session?.role === 'ief') {
      const iefCode = session.iefCode || '';
      if (iefCode) {
        // La RPC get_school_data_ief gère aussi les codes de Groupe scolaire (lecture seule).
        const result = await sb('POST', 'rpc/get_school_data_ief', '', { p_school_id: id, p_code: iefCode });
        if (result?.ok === false) throw new Error(result.error || 'Accès refusé');
        payload = result?.data || result;
        serverVersion = result?.version ?? null;
      } else {
        throw new Error('Code IEF absent — reconnectez-vous pour accéder aux données.');
      }
    } else {
      throw new Error('Code d’accès absent pour cette école');
    }
    if (payload && payload.classes) {
      // Numéro de version renvoyé par le serveur (verrouillage optimiste) :
      // renvoyé à la prochaine sauvegarde pour détecter si quelqu'un
      // d'autre a modifié ces données entretemps (voir saveSchoolData).
      // IEF étant en lecture seule, l'absence de version pour son ancien
      // repli est sans conséquence (aucune sauvegarde n'est jamais tentée).
      payload.__version = serverVersion ?? payload.__version ?? 1;
      // Migration année scolaire : les écoles encore sur l'ancien millésime passent en 2026/2027
      if (payload.header && payload.header.annee === '2025/2026') payload.header.annee = '2026/2027';
      primeCacheFromServer(id, payload).catch(() => {});
      return payload;
    }
    throw new Error('Aucune donnée scolaire disponible');
  } catch (e) {
    const cached = await getInstantCache(id);
    if (cached) return cached;
    console.error('loadSchoolData error:', e);
    throw e;
  }
}

// Snapshot sérialisable des codes d'accès de la session courante. Capturé au
// moment de la saisie et persisté avec chaque élément de la file hors-ligne,
// il permet la synchronisation différée même si la session a changé ou expiré
// d'ici là (autre école, autre rôle, timeout).
function buildAccessSnapshot() {
  const s = loadSessionJSON(LS_SESSION, null);
  if (!s) return null;
  return {
    schoolId: s.schoolId ?? null,
    role: s.role || '',
    schoolCode: s.schoolCode || getActiveSchoolCode() || '',
    staffId: s.staffId ?? null,
    staffCode: s.staffCode || '',
    adminCode: s.adminCode || s.iefAdminCode || '',
  };
}

// Réunit deux versions d'un même payload quand la sauvegarde d'un membre du
// personnel entre en « conflit de version » : on garde la version serveur
// (la plus à jour) et on y réinjecte UNIQUEMENT les demandes d'absence /
// attestation de service présentes localement et absentes côté serveur
// (ajouts purs — aucune donnée ne peut être écrasée).
function mergeStaffRequestArrays(serverData, localData) {
  const out = { ...serverData };
  const serverAbs = Array.isArray(serverData.staffAbsenceRequests) ? serverData.staffAbsenceRequests : [];
  const serverAtt = Array.isArray(serverData.staffAttestRequests) ? serverData.staffAttestRequests : [];
  const localAbs = Array.isArray(localData.staffAbsenceRequests) ? localData.staffAbsenceRequests : [];
  const localAtt = Array.isArray(localData.staffAttestRequests) ? localData.staffAttestRequests : [];
  const missAbs = localAbs.filter((r) => r && r.id && !serverAbs.some((x) => x && x.id === r.id));
  const missAtt = localAtt.filter((r) => r && r.id && !serverAtt.some((x) => x && x.id === r.id));
  if (missAbs.length) out.staffAbsenceRequests = [...serverAbs, ...missAbs];
  if (missAtt.length) out.staffAttestRequests = [...serverAtt, ...missAtt];
  return out;
}

// Réunit deux versions d'un même payload en CAS DE CONFLIT DE VERSION
// (deux auteurs sur la même école, ou une version serveur « fantôme » car une
// lecture n'a pas renvoyé la colonne version). Stratégie sûre : on garde la
// version serveur fraîche comme base (source de vérité la plus à jour) et on y
// réapplique le brouillon local pour ses DEUX natures de contenu :
//   - éléments présents uniquement dans le brouillon local (ajouts purs) ;
//   - valeurs locales pour les objets/scalaires (l'auteur actif ne perd pas
//     sa saisie), à condition que la base serveur ne les contienne pas déjà.
// On ne supprime JAMAIS un enregistrement qui n'existe que côté serveur.
function mergePayloadAdditive(serverData, localData) {
  if (Array.isArray(serverData)) {
    const map = new Map();
    const nonId = (arr) => (arr || []).filter((el) => !(el && typeof el === 'object' && el.id != null));
    (serverData || []).forEach((el) => { if (el && typeof el === 'object' && el.id != null) map.set(el.id, el); });
    (localData || []).forEach((el) => { if (el && typeof el === 'object' && el.id != null) map.set(el.id, el); });
    return [...map.values(), ...nonId(serverData), ...nonId(localData)];
  }
  if (serverData && typeof serverData === 'object' && localData && typeof localData === 'object') {
    const out = { ...serverData };
    for (const k of Object.keys(localData || {})) {
      out[k] = (k in serverData) ? mergePayloadAdditive(serverData[k], localData[k]) : localData[k];
    }
    return out;
  }
  return localData !== undefined ? localData : serverData;
}

async function saveSchoolData(id, state, access) {
  const session = loadSessionJSON(LS_SESSION, null);
  // Le compte « IEF » (role ief) est STRICTEMENT en lecture seule.
  // Aucune écriture ne doit partir vers save_school_data / *admin* / *staff*,
  // même si un code école traîne en localStorage (LS_SCHOOL_CODE) : on refuse
  // dès l'entrée et on laisse reportRejected abandonner l'élément proprement.
  if (session && session.role === 'ief') {
    throw new Error('Accès refusé : compte « IEF » en lecture seule, aucune modification autorisée');
  }
  // Le snapshot capturé à la saisie ne vaut que pour l'école d'origine pour
  // les codes ÉCOLE et PERSONNEL (vérifiés contre cette école précise).
  // Les codes ADMIN, eux, ne sont pas liés à une école côté client : leur
  // validité ET leur périmètre sont vérifiés côté serveur. On les accepte
  // donc même si le snapshot n'a pas de schoolId (les sessions admin n'en
  // ont PAS) — sans cela, toute écriture admin mise en file échouait avec
  // « Code d'accès absent » dès que la session changeait ou expirait.
  const snap = access || null;
  const snapMatchesSchool = !!(snap && snap.schoolId === id);
  const snapIsStaff = snapMatchesSchool && ['teacher', 'guard', 'accountant', 'secretary'].includes(snap.role);
  const ownsSchool = session?.schoolId === id;
  let schoolCode = (ownsSchool ? (session.schoolCode || getActiveSchoolCode()) : '')
    || (snapMatchesSchool ? (snap.schoolCode || '') : '')
    || getActiveSchoolCode() || null;
  const staffRole = ['teacher', 'guard', 'accountant', 'secretary'].includes(session?.role);
  const staffId = (staffRole && ownsSchool) ? session.staffId : (snapIsStaff ? snap.staffId : null);
  const staffCode = (staffRole && ownsSchool) ? (session.staffCode || '')
    : (snapIsStaff ? (snap.staffCode || '') : '');
  const adminCode = session?.role === 'admin'
    ? (session.adminCode || session.iefAdminCode || (snap ? snap.adminCode : '') || '')
    : ((snap && snap.adminCode) || '');
  // Dernier recours : ancien cache local contenant encore le code de l'école
  // — mais JAMAIS si une autre credential existe, afin de ne pas court-circuiter
  // une voie valide avec un code potentiellement périmé.
  if (!schoolCode && !staffCode && !adminCode) schoolCode = cachedSchoolCode(id) || null;
  const clean = { ...state };
  delete clean.__version;
  const expectedVersion = state.__version ?? null;
  let result;
  let savedPayload = clean;
    if (schoolCode) {
      result = await sb('POST', 'rpc/save_school_data', '', { p_school_id: id, p_code: schoolCode, p_payload: clean, p_expected_version: expectedVersion });
      // Conflit de version (souvent « fantôme » : tant que get_school_data ne
      // renvoie pas la version réelle, le client croit être en v1 et part avec
      // un p_expected_version périmé → l'écriture est REFUSÉE bien qu'elle
      // soit légitime). On recharge la version FRAÎCHE du serveur, on y
      // réinjecte les données locales (aucune perte), puis on RENVOIE la
      // sauvegarde sans verrou optimiste — la saisie n'est ainsi jamais
      // abandonnée silencieusement.
      if (result && result.ok === false && result.conflict) {
        const fresh = await sb('POST', 'rpc/get_school_data', '', { p_school_id: id, p_code: schoolCode });
        const freshData = fresh && fresh.data;
        if (!freshData) throw new Error(result.error || 'Enregistrement refusé');
        const mergedClean = { ...mergePayloadAdditive(freshData, clean) };
        delete mergedClean.__version;
        savedPayload = mergedClean;
        result = await sb('POST', 'rpc/save_school_data', '', { p_school_id: id, p_code: schoolCode, p_payload: mergedClean, p_expected_version: null });
      }
    } else if (staffId != null && staffCode) {
      // Credentials personnel issues de la session OU du snapshot : la
      // condition ne doit PAS exiger que la session courante soit encore
      // « staff » (elle peut avoir expiré ou changé depuis la saisie).
      result = await sb('POST', 'rpc/save_school_data_staff', '', { p_school_id: id, p_staff_id: staffId, p_code: staffCode, p_payload: clean, p_expected_version: expectedVersion });
      // Conflit de version (souvent « fantôme » : tant que
      // get_school_data_staff ne renvoie pas la version réelle, le client
      // croit être en v1 et part avec un p_expected_version périmé) :
      // on recharge la version FRAÎCHE du serveur, on réinjecte les demandes
      // d'absence / attestation locales manquantes (ajouts purs, rien ne peut
      // être écrasé), puis on RENVOIE la sauvegarde sans verrou optimiste —
      // la soumission n'est ainsi jamais perdue silencieusement.
      if (result && result.ok === false && result.conflict) {
        const fresh = await sb('POST', 'rpc/get_school_data_staff', '', { p_school_id: id, p_staff_id: staffId, p_code: staffCode });
        const freshData = fresh && fresh.data;
        if (!freshData) throw new Error(result.error || 'Enregistrement refusé');
        const mergedClean = { ...mergeStaffRequestArrays(freshData, clean) };
        delete mergedClean.__version;
        savedPayload = mergedClean;
        result = await sb('POST', 'rpc/save_school_data_staff', '', { p_school_id: id, p_staff_id: staffId, p_code: staffCode, p_payload: mergedClean, p_expected_version: null });
      }
    } else if (adminCode) {
      result = await sb('POST', 'rpc/save_school_data_admin', '', { p_school_id: id, p_admin_code: adminCode, p_payload: clean, p_expected_version: expectedVersion });
      // Même mécanisme de récupération que l'école : sur conflit (souvent
      // fantôme dû à une lecture sans version), on recharge la version fraîche,
      // on fusionne sans perte puis on resauvegarde sans verrou optimiste.
      if (result && result.ok === false && result.conflict) {
        const fresh = await sb('POST', 'rpc/get_school_data_admin', '', { p_school_id: id, p_admin_code: adminCode });
        const freshData = fresh && fresh.data;
        if (!freshData) throw new Error(result.error || 'Enregistrement administrateur refusé');
        const mergedClean = { ...mergePayloadAdditive(freshData, clean) };
        delete mergedClean.__version;
        savedPayload = mergedClean;
        result = await sb('POST', 'rpc/save_school_data_admin', '', { p_school_id: id, p_admin_code: adminCode, p_payload: mergedClean, p_expected_version: null });
      }
    } else {
    throw new Error('Code d’accès absent pour cette école');
  }
  if (result?.ok === false) {
    const err = new Error(result.error || 'Enregistrement refusé');
    if (result.conflict) { err.isVersionConflict = true; err.serverVersion = result.server_version; }
    throw err;
  }
  const version = result?.version || ((state.__version || 1) + 1);
  await primeCacheFromServer(id, { ...savedPayload, __version: version }).catch(() => {});
  return version;
}

// Écrit une ligne dans "schools" ; si une colonne récente (directeur/cycle)
// n'existe pas encore dans la base, réessaie sans elle. La valeur reste alors
// enregistrée dans school_data.header, ce qui préserve le fonctionnement en
// attendant l'exécution de la migration SQL.
async function upsertSchoolRow(method, params, body) {
   try {
     const data = await sb(method, 'schools', params, body);
     return { data, directeurSaved: true, cycleSaved: true, cyclesSaved: true };
   } catch (e) {
     const msg = sbErrMsg(e);
     const missingColumn = /does not exist|could not find|schema cache/i.test(msg);
     const rest = { ...body };
     const hasCyclesError = /\bcycles\b/i.test(msg) && missingColumn;
     const hasCycleError = !hasCyclesError && /\bcycle\b/i.test(msg) && missingColumn;
     const hasDirecteurError = !hasCyclesError && !hasCycleError && /directeur/i.test(msg) && missingColumn;
     const directeurSaved = !(hasDirecteurError && 'directeur' in rest);
     const cycleSaved = !(hasCycleError && 'cycle' in rest);
     const cyclesSaved = !(hasCyclesError && 'cycles' in rest);
     if (!directeurSaved) delete rest.directeur;
     if (!cycleSaved) delete rest.cycle;
     if (!cyclesSaved) delete rest.cycles;
     if (!directeurSaved || !cycleSaved || !cyclesSaved) {
       const data = await sb(method, 'schools', params, rest);
       return { data, directeurSaved, cycleSaved, cyclesSaved };
     }
     throw e;
   }
 }

/* ============================================================
   UTILITAIRES — dates, identifiants, formatage FCFA
   ============================================================ */
function generateAccessCode(length = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères ambigus (0/O, 1/I…)
  let out = '';
  try {
    // Générateur cryptographique (plus robuste que Math.random — évite la
    // prédiction et les collisions prévisibles lors de la création de codes).
    const values = new Uint32Array(length);
    crypto.getRandomValues(values);
    for (let i = 0; i < length; i++) out += chars[values[i] % chars.length];
  } catch (_) {
    // Repli si l'API crypto n'est pas disponible (ancien navigateur).
    for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}
async function copyToClipboard(text, notify) {
  try {
    await navigator.clipboard.writeText(String(text));
    if (notify) notify('Copié dans le presse-papiers');
  } catch (_) {
    if (notify) notify('Impossible de copier automatiquement', true);
  }
}
function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function fmtDateFr(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}
function fmtFCFA(n) {
  const v = Number(n) || 0;
  return new Intl.NumberFormat('fr-FR').format(v) + ' FCFA';
}
function currentMonthISO() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}
function monthLabelFr(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1, 1);
  const label = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function shiftDay(iso, delta) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}
function lastDayISO(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 0);
  return `${y}-${String(m).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Jours ouvrés du mois selon les jours de la semaine travaillés par
// l'établissement (défaut : lundi à vendredi ; hors jours fériés, gérés
// séparément via config.pointage.joursNonOuvres).
function joursOuvresDuMois(ym, joursOuvres = [1, 2, 3, 4, 5]) {
  const [y, m] = ym.split('-').map(Number);
  const nbJours = new Date(y, m, 0).getDate();
  const ouverts = Array.isArray(joursOuvres) && joursOuvres.length ? joursOuvres.map(Number) : [1, 2, 3, 4, 5];
  let count = 0;
  for (let j = 1; j <= nbJours; j++) {
    const dow = new Date(y, m - 1, j).getDay(); // 0=dim, 6=sam
    if (ouverts.includes(dow)) count++;
  }
  return count;
}
function joursDuMois(ym) {
  const [y, m] = ym.split('-').map(Number);
  const nbJours = new Date(y, m, 0).getDate();
  const out = [];
  for (let j = 1; j <= nbJours; j++) {
    out.push(`${y}-${String(m).padStart(2, '0')}-${String(j).padStart(2, '0')}`);
  }
  return out;
}
function downloadCSV(filename, rows) {
  const csv = rows.map((r) => r.map((cell) => {
    const s = String(cell ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(';')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}
const STAFF_ROLES = ["Directeur/Directrice", "Directeur Pédagogique", "Enseignant(e)", "Assistant(e) Pédagogique", "Surveillant(e)", "Vigile", "Comptable/Gestionnaire", "Secrétaire", "Femme de Charge", "Jardinier", "Gardien", "Planton", "Personnel administratif", "Personnel d'appui"];
const STAFF_LOGIN_ROLES = new Set(['Enseignant(e)', 'Vigile', 'Comptable/Gestionnaire', 'Secrétaire', 'Directeur Pédagogique', 'Assistant(e) Pédagogique']);
function staffAccessRole(role) {
  if (role === 'Comptable/Gestionnaire') return 'accountant';
  if (role === 'Secrétaire' || role === 'Directeur Pédagogique' || role === 'Assistant(e) Pédagogique') return 'secretary';
  if (String(role || '').toLowerCase().startsWith('enseignant')) return 'teacher';
  if (String(role || '').toLowerCase() === 'vigile') return 'guard';
  return null;
}
const SCHOOL_TYPES = [
  { value: 'publique', label: 'École Publique' },
  { value: 'privee', label: 'École Privée' },
  { value: 'daara_moderne', label: 'Daara Moderne' },
  { value: 'petite_enfance', label: 'Petite Enfance' },
];
// Normalise un type d'école (identifiant ou label, ancien ou nouveau) vers son
// identifiant canonique. « Daara Classique » (magistralement remplacée par le
// type « Petite Enfance ») reste gérée pour les écoles déjà enregistrées.
function normalizeSchoolType(value) {
  const aliases = { 'daara classique': 'petite_enfance', 'ecole publique': 'publique', 'ecole privee': 'privee', 'daara moderne': 'daara_moderne' };
  const v = String(value || '').trim().toLowerCase().replace(/[_ ]+/g, ' ');
  return aliases[v] || v.replace(/ /g, '_');
}
function schoolTypeLabel(value) {
  const t = SCHOOL_TYPES.find((x) => x.value === value || x.label === value);
  if (t) return t.label;
  const n = normalizeSchoolType(value);
  const t2 = SCHOOL_TYPES.find((x) => x.value === n);
  return t2 ? t2.label : (value || 'École Publique');
}
const POINTAGE_STATUTS = {
  P: { label: 'Présent', short: 'P', tone: 'green' },
  A: { label: 'Absent', short: 'A', tone: 'red' },
  R: { label: 'Retard', short: 'R', tone: 'gold' },
  C: { label: 'Congé', short: 'C', tone: 'muted' },
};
const DEFAULT_HEURES_JOUR = 8; // heures de service standard pour une journée présente/retard
const JOURS_SEMAINE_POINTAGE = [
  { key: 1, label: 'Lundi' }, { key: 2, label: 'Mardi' }, { key: 3, label: 'Mercredi' },
  { key: 4, label: 'Jeudi' }, { key: 5, label: 'Vendredi' },
];
// Semaine complète (key = Date.getDay()) pour le paramétrage libre des jours
// ouvrés : certaines écoles travaillent le samedi, d'autres pas le mercredi…
const JOURS_SEMAINE = [
  ...JOURS_SEMAINE_POINTAGE,
  { key: 6, label: 'Samedi' }, { key: 0, label: 'Dimanche' },
];
const JOURS_COURTS = { 0: 'dim.', 1: 'lun.', 2: 'mar.', 3: 'mer.', 4: 'jeu.', 5: 'ven.', 6: 'sam.' };
function libelleJoursOuvres(joursOuvres) {
  const days = [...new Set((joursOuvres || [1, 2, 3, 4, 5]).map(Number))].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  if (!days.length) return '—';
  // Contigu sans boucle dim→sam (ex. ven., sam., dim. n'est pas un intervalle lisible).
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1) && !(days.includes(0) && days.includes(6));
  if (!contiguous) return days.map((d) => JOURS_COURTS[d]).join(' ');
  return days.length === 1 ? JOURS_COURTS[days[0]] : `${JOURS_COURTS[days[0]]}–${JOURS_COURTS[days[days.length - 1]]}`;
}
function normaliseCycle(cycle) {
  return String(cycle || LEGACY_DEFAULT_CYCLE).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function estEcolePublique(type) {
  return String(type || '').toLowerCase().includes('publique');
}
function horairesParDefaut(stateOrSchool) {
  const cycle = normaliseCycle(stateOrSchool?.header?.cycle || stateOrSchool?.cycle);
  const type = stateOrSchool?.header?.type || stateOrSchool?.type;
  if (estEcolePublique(type)) {
    if (cycle === 'prescolaire' || cycle === 'petite_enfance') return { 1: 5, 2: 5, 3: 5, 4: 5, 5: 5 };
    if (cycle === 'elementaire') return { 1: 5, 2: 7, 3: 5, 4: 7, 5: 5 };
  }
  return { 1: DEFAULT_HEURES_JOUR, 2: DEFAULT_HEURES_JOUR, 3: DEFAULT_HEURES_JOUR, 4: DEFAULT_HEURES_JOUR, 5: DEFAULT_HEURES_JOUR };
}
function attendanceSettings(state) {
  const raw = state?.config?.pointage || {};
  const defaults = horairesParDefaut(state);
  const saved = raw.heuresParJour || {};
  const cycle = normaliseCycle(state?.header?.cycle || state?.cycle);
  const type = state?.header?.type || state?.type;
  const hasPublicSchedule = estEcolePublique(type) && ['prescolaire', 'petite_enfance', 'elementaire'].includes(cycle);
  // Jours ouvrés hebdomadaires paramétrés par l'établissement (key = getDay()).
  // Absent → semaine standard lundi–vendredi (compatibilité anciens données).
  const joursOuvres = Array.isArray(raw.joursOuvres) && raw.joursOuvres.length
    ? [...new Set(raw.joursOuvres.map(Number))].filter((d) => d >= 0 && d <= 6)
    : [1, 2, 3, 4, 5];
  return {
    heuresJour: Number(raw.heuresJour) > 0 ? Number(raw.heuresJour) : DEFAULT_HEURES_JOUR,
    heuresParJour: Object.fromEntries(JOURS_SEMAINE.map(({ key }) => {
      const fallback = Number(raw.heuresJour) > 0 ? Number(raw.heuresJour) : (defaults[key] ?? DEFAULT_HEURES_JOUR);
      const value = hasPublicSchedule && raw.planningVersion !== 2
        ? (defaults[key] ?? fallback)
        : (Number(saved[key]) || fallback);
      return [key, Math.max(0, Math.min(24, value))];
    })),
    joursNonOuvres: Array.isArray(raw.joursNonOuvres) ? raw.joursNonOuvres : [],
    joursOuvres,
  };
}
function nonWorkingDayReason(date, settings) {
  const day = new Date(`${date}T00:00:00`).getDay();
  if (!settings.joursOuvres.includes(day)) return 'Repos hebdomadaire';
  if (settings.joursNonOuvres.includes(date)) return 'Jour non ouvré ou férié';
  return null;
}
function heuresAttenduesDate(date, settings) {
  if (nonWorkingDayReason(date, settings)) return 0;
  const day = new Date(`${date}T00:00:00`).getDay();
  return Number(settings.heuresParJour?.[day] ?? settings.heuresJour) || 0;
}
function heuresAttenduesMois(mois, settings) {
  return joursDuMois(mois).reduce((total, date) => total + heuresAttenduesDate(date, settings), 0);
}
function schoolSupportsAttendanceSettings(school) {
  return estEcolePublique(school?.type) && ['prescolaire', 'petite_enfance', 'elementaire'].includes(normaliseCycle(school?.cycle));
}
function AttendanceSettingsModal({ school, onSave, onClose }) {
  const [heuresParJour, setHeuresParJour] = useState(() => ({ ...horairesParDefaut(school), ...(school.pointageSettings?.heuresParJour || {}) }));
  const [jours, setJours] = useState((school.pointageSettings?.joursNonOuvres || []).join('\n'));
  function submit(e) {
    e.preventDefault();
    const joursNonOuvres = [...new Set(jours.split(/[\n,;]+/).map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    onSave({ planningVersion: 2, heuresParJour: Object.fromEntries(JOURS_SEMAINE_POINTAGE.map(({ key }) => [key, Math.max(0, Math.min(24, Number(heuresParJour[key]) || 0))])), joursNonOuvres });
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
    <form onSubmit={submit} className="sygenop-card p-6 max-w-md w-full space-y-4">
      <div className="flex items-center justify-between"><div className="font-bold text-ink">Règles de pointage — {school.name}</div><button type="button" onClick={onClose}><X size={18} /></button></div>
      <p className="text-xs text-muted">Réservé aux écoles publiques petite enfance, préscolaires et élémentaires.</p>
      <div><div className="text-sm font-semibold mb-2">Heures à servir par jour</div><div className="grid grid-cols-2 gap-2">{JOURS_SEMAINE_POINTAGE.map(({ key, label }) => <label key={key} className="text-xs font-semibold">{label}<input type="number" min="0" max="24" step="0.5" value={heuresParJour[key]} onChange={(e) => setHeuresParJour((prev) => ({ ...prev, [key]: e.target.value }))} className="mt-1 w-full px-3 py-2 rounded-lg border" /></label>)}</div></div>
      <label className="block text-sm font-semibold">Jours non ouvrés et fériés<textarea value={jours} onChange={(e) => setJours(e.target.value)} placeholder={'2026-12-25\n2027-01-01'} className="mt-1 w-full px-3 py-2 rounded-lg border min-h-28" /><span className="text-xs font-normal text-muted">Une date par ligne, au format AAAA-MM-JJ. Les week-ends sont automatiquement bloqués.</span></label>
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="px-3 py-2">Annuler</button><button className="px-3 py-2 rounded-lg text-white font-semibold" style={{ background: 'var(--green-d)' }}>Enregistrer</button></div>
    </form>
  </div>;
}

/* ---- Modale « Jours non ouvrés et fériés » GLOBAUX (Super Admin) ----
   Définit en une seule fois les jours non ouvrés/fériés pour TOUTES les
   écoles actives, tous types et cycles confondus — remplace le paramétrage
   école par école, fastidieux quand le nombre d'établissements grandit.
   Les autres règles de chaque école (heures/jours de semaine) sont conservées. */
function JoursFeriesGlobauxModal({ isRacine, nbEcoles, applying, onApply, onClose }) {
  const [jours, setJours] = useState('');
  function submit(e) {
    e.preventDefault();
    const dates = [...new Set(jours.split(/[\n,;]+/).map((d) => d.trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    onApply(dates);
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
    <form onSubmit={submit} className="sygenop-card p-6 max-w-md w-full space-y-4">
      <div className="flex items-center justify-between"><div className="font-bold text-ink">Jours non ouvrés et fériés — toutes les écoles</div><button type="button" onClick={onClose}><X size={18} /></button></div>
      <p className="text-xs text-muted">
        {isRacine
          ? <>Applique la même liste à <b>toutes les écoles actives du système</b>, tous types et cycles confondus, même si une IEF est sélectionnée dans le filtre.</>
          : <>Applique la même liste aux <b>{nbEcoles} école(s) active(s)</b> de votre IEF, tous types confondus.</>}
        {' '}Les horaires hebdomadaires propres à chaque école sont conservés ; sa liste de jours non ouvrés est remplacée par celle-ci.
      </p>
      <label className="block text-sm font-semibold">Jours non ouvrés et fériés<textarea value={jours} onChange={(e) => setJours(e.target.value)} placeholder={'2026-12-25\n2027-01-01'} className="mt-1 w-full px-3 py-2 rounded-lg border min-h-28" /><span className="text-xs font-normal text-muted">Une date par ligne, au format AAAA-MM-JJ. Laisser vide efface les listes existantes de toutes les écoles.</span></label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-2">Annuler</button>
        <button disabled={!!applying} className="px-3 py-2 rounded-lg text-white font-semibold flex items-center gap-2 disabled:opacity-60" style={{ background: 'var(--green-d)' }}>
          {applying ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
          {applying ? `Application… ${applying.done}/${applying.total}` : 'Appliquer à toutes'}
        </button>
      </div>
    </form>
  </div>;
}

// Lecture d'un enregistrement de pointage — { statut, heures }.
// Compatible avec l'ancien format (simple chaîne 'P'/'A'/'R'/'C').
function getPointageRecord(pointage, date, staffId) {
  const raw = pointage?.[date]?.[staffId];
  if (raw == null) return null;
  if (typeof raw === 'string') {
    return { statut: raw, heures: (raw === 'P' || raw === 'R') ? DEFAULT_HEURES_JOUR : 0 };
  }
  return raw;
}

/* ============================================================
   PRÉSENCE DES ÉLÈVES (pointage par carte QR)
   ------------------------------------------------------------
   state.presenceEleves = {
     "<date AAAA-MM-JJ>": {
       "<studentId>": {
         "<slotId>": { statut: 'P'|'R'|'A', heure: 'HH:MM', source: 'portail'|'classe'|'manuel', par?: staffId }
       }
     }
   }
   slotId vaut soit 'PORTAIL' (scan unique à l'entrée, une fois par jour —
   utilisé quand l'école n'a pas d'emploi du temps pour la classe ce
   jour-là), soit l'identifiant d'un créneau de state.emploiDuTemps (scan
   par l'enseignant, présence rattachée à une séance précise).
   Absence d'entrée ≠ absence : le statut est calculé à la volée (voir
   studentDayStatus) tant qu'aucun scan ni correction manuelle n'a eu
   lieu, pour ne jamais écraser silencieusement les données.
   ============================================================ */
const PORTAIL_SLOT_ID = 'PORTAIL';

function studentAttendanceConfig(state) {
  const raw = state?.config?.presenceEleves || {};
  return { heureLimite: /^\d{2}:\d{2}$/.test(raw.heureLimite || '') ? raw.heureLimite : '08:00' };
}
function getStudentPresenceRecord(presenceEleves, date, studentId, slotId) {
  return presenceEleves?.[date]?.[studentId]?.[slotId] || null;
}
// Écriture immuable d'un enregistrement de présence élève — à utiliser dans
// un updateState(prev => ...). Ne supprime jamais les autres créneaux/élèves
// du même jour.
function withStudentPresenceRecord(prev, date, studentId, slotId, record) {
  const presenceEleves = { ...(prev.presenceEleves || {}) };
  const dayRec = { ...(presenceEleves[date] || {}) };
  const studentRec = { ...(dayRec[studentId] || {}) };
  studentRec[slotId] = record;
  dayRec[studentId] = studentRec;
  presenceEleves[date] = dayRec;
  return { ...prev, presenceEleves };
}
// Créneaux de l'emploi du temps d'une classe pour une date donnée, triés
// par heure de début. Tableau vide = pas d'emploi du temps saisi (ou cycle
// Préscolaire/Élémentaire, où le pointage se fait uniquement par jour, sans
// séance — seuls le Moyen et le Secondaire pointent séance par séance).
function seancesForClassDay(state, classId, date) {
  if (!classId) return [];
  const level = state?.classes?.[classId]?.level;
  const cycle = level ? cycleForLevel(level) : null;
  if (cycle === 'prescolaire' || cycle === 'petite_enfance' || cycle === 'elementaire') return [];
  // getDay() : 0=dimanche..6=samedi → aligné sur TIMETABLE_DAYS (Lundi..Samedi).
  const dayLabel = TIMETABLE_DAYS[(new Date(`${date}T00:00:00`).getDay() + 6) % 7];
  if (!dayLabel) return []; // dimanche : pas de créneau
  return (state?.emploiDuTemps || [])
    .filter((slot) => slot.classId === classId && slot.day === dayLabel)
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
}
// Séance en cours à l'heure donnée pour une classe (utilisée lors d'un scan
// au portail pour rattacher automatiquement la présence à un cours, si
// l'emploi du temps de la classe est renseigné pour ce jour).
function currentSeanceForClass(state, classId, date, heureHHMM) {
  return seancesForClassDay(state, classId, date)
    .find((s) => heureHHMM >= (s.start || '00:00') && heureHHMM <= (s.end || '23:59')) || null;
}
// Statut du jour pour un élève : statut global (P/R/A/attente/non-ouvre) et
// détail par séance quand l'emploi du temps de sa classe est renseigné.
// Un statut non enregistré est déduit (pas encore arrivé / absent) plutôt
// qu'écrit automatiquement, pour laisser la correction manuelle possible
// à tout moment sans conflit d'écriture.
function studentDayStatus(state, date, studentId, classId, nowHHMM) {
  const settings = attendanceSettings(state);
  const reason = nonWorkingDayReason(date, settings);
  if (reason) return { statut: 'non-ouvre', label: reason, seances: [] };
  const presence = state?.presenceEleves || {};
  const seances = seancesForClassDay(state, classId, date);
  const isToday = date === todayISO();
  const heure = nowHHMM || new Date().toTimeString().slice(0, 5);
  if (seances.length) {
    const detail = seances.map((s) => {
      const rec = getStudentPresenceRecord(presence, date, studentId, s.id);
      let statut = rec?.statut || null;
      if (!statut) statut = (!isToday || heure > (s.end || '23:59')) ? 'A' : 'attente';
      return { seanceId: s.id, matiere: s.subject, start: s.start, end: s.end, statut, source: rec?.source };
    });
    const global = detail.some((d) => d.statut === 'P' || d.statut === 'R') ? 'P'
      : detail.some((d) => d.statut === 'attente') ? 'attente' : 'A';
    return { statut: global, seances: detail };
  }
  const cfg = studentAttendanceConfig(state);
  const rec = getStudentPresenceRecord(presence, date, studentId, PORTAIL_SLOT_ID);
  if (rec) return { statut: rec.statut, seances: [], source: rec.source };
  return { statut: (!isToday || heure > cfg.heureLimite) ? 'A' : 'attente', seances: [] };
}
const STUDENT_PRESENCE_LABELS = { P: ['Présent', 'green'], R: ['Retard', 'gold'], A: ['Absent', 'red'], attente: ['Non arrivé', 'gold'], 'non-ouvre': ['Jour non ouvré', 'gold'] };

// Ouvre WhatsApp (wa.me) avec un message d'absence pré-rempli à destination
// du tuteur — même principe que les rappels de paiement déjà existants
// (sendWhatsappReminder / sendWhatsappReceipt) : c'est un lien qui ouvre
// WhatsApp avec le message prêt, l'envoi final reste un clic humain (aucun
// envoi automatique/silencieux n'est possible sans l'API payante WhatsApp
// Business).
function sendAbsenceWhatsapp(state, student, className, date, notify, seanceLabel) {
  const tel = phoneDigits(student.tuteurTel);
  if (!tel) { notify && notify('Renseignez le téléphone du tuteur pour cet élève.', true); return; }
  const ecole = (state.header && state.header.ecole) || "l'école";
  const quand = seanceLabel ? `à la séance de ${seanceLabel} du ${fmtDateFr(date)}` : `aujourd'hui ${fmtDateFr(date)}`;
  const msg = `Bonjour${student.tuteurNom ? ' ' + student.tuteurNom : ''}, ${ecole} vous informe que ${student.prenom || ''} ${student.nom || ''} (${className}) est absent(e) ${quand}. Merci de nous contacter en cas de besoin.`;
  window.open('https://wa.me/' + encodeURIComponent(tel) + '?text=' + encodeURIComponent(msg), '_blank');
}

// Liste des dates ISO (AAAA-MM-JJ) entre deux bornes incluses, ordre chronologique.
function listDatesBetween(startISO, endISO) {
  const out = [];
  let d = new Date(`${startISO}T00:00:00`);
  const end = new Date(`${endISO}T00:00:00`);
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); }
  return out;
}
// Statistiques de présence agrégées sur une période, pour un ensemble de
// classes. Les jours non ouvrés sont exclus du décompte. Un jour « en
// attente » (aujourd'hui, avant l'heure limite/fin de séance) n'est compté
// ni présent ni absent, pour ne jamais afficher une fausse absence en cours
// de journée.
function computeAttendanceStats(state, classIds, startISO, endISO) {
  const dates = listDatesBetween(startISO, endISO);
  const settings = attendanceSettings(state);
  const nowHHMM = new Date().toTimeString().slice(0, 5);
  const perClassDaily = {};
  const perClassTotals = {};
  const perStudentTotals = {};
  let joursComptabilises = 0;
  dates.forEach((date) => {
    if (nonWorkingDayReason(date, settings)) return;
    joursComptabilises++;
    classIds.forEach((classId) => {
      const cls = state.classes?.[classId];
      if (!cls) return;
      let dPresent = 0, dAbsent = 0, dRetard = 0;
      (cls.students || []).forEach((student) => {
        const statut = studentDayStatus(state, date, student.id, classId, nowHHMM).statut;
        if (statut === 'attente' || statut === 'non-ouvre') return;
        const key = student.id;
        if (!perStudentTotals[key]) perStudentTotals[key] = { nom: `${student.prenom || ''} ${student.nom || ''}`.trim(), classId, className: cls.name, present: 0, absent: 0, retard: 0, jours: 0 };
        perStudentTotals[key].jours++;
        if (statut === 'A') { dAbsent++; perStudentTotals[key].absent++; }
        else { dPresent++; perStudentTotals[key].present++; if (statut === 'R') { dRetard++; perStudentTotals[key].retard++; } }
      });
      (perClassDaily[classId] || (perClassDaily[classId] = [])).push({ date, present: dPresent, absent: dAbsent, retard: dRetard });
      const ct = perClassTotals[classId] || (perClassTotals[classId] = { className: cls.name, present: 0, absent: 0, retard: 0 });
      ct.present += dPresent; ct.absent += dAbsent; ct.retard += dRetard;
    });
  });
  return { perClassDaily, perClassTotals, perStudentTotals, joursComptabilises };
}

/* ============================================================
   THÈME — palette Bleu Nuit / Cyan / Or, clair + sombre
   ============================================================ */
const THEME_VARS_LIGHT = {
  '--ink': '#172033', '--green': '#0a1e3d', '--green-d': '#0a1e3d', '--green-l': '#dde6f2',
  '--green-hover': '#07152b',
  '--gold': '#ffd100', '--gold-l': '#fff8cf', '--gold-hover': '#e6bc00',
  '--red': '#d64b55', '--red-l': '#ffedef',
  '--success': '#159a70', '--success-l': '#e8f8f1',
  '--warning': '#b7791f', '--warning-l': '#fff6df',
  '--info': '#2a5a94', '--info-l': '#e4edf9',
  '--bg': '#ffffff', '--panel': '#ffffff', '--line': '#e5e9f1', '--muted': '#6d778b',
  '--sidebar': '#0a1e3d', '--sidebar-muted': '#8fa8c9',
  '--modal-overlay': 'rgba(10,30,61,.5)', '--modal-card': 'rgba(255,255,255,.92)', '--modal-line': 'rgba(229,233,241,.85)',
};
const THEME_VARS_DARK = {
  '--ink': '#e2e8f0', '--green': '#0a1e3d', '--green-d': '#dde6f2', '--green-l': '#1e293b',
  '--green-hover': '#07152b',
  '--gold': '#ffd100', '--gold-l': '#422006', '--gold-hover': '#e6bc00',
  '--red': '#f87171', '--red-l': '#450a0a',
  '--success': '#34d399', '--success-l': '#064e3b',
  '--warning': '#fbbf24', '--warning-l': '#422006',
  '--info': '#60a5fa', '--info-l': '#1e3a5f',
  '--bg': '#0f172a', '--panel': '#1e293b', '--line': '#334155', '--muted': '#94a3b8',
  '--sidebar': '#0a1e3d', '--sidebar-muted': '#8fa8c9',
  '--modal-overlay': 'rgba(10,30,61,.62)', '--modal-card': 'rgba(15,23,42,.84)', '--modal-line': 'rgba(51,65,85,.5)',
};

function GlobalStyles({ dark }) {
  const vars = dark ? THEME_VARS_DARK : THEME_VARS_LIGHT;
  const cssVars = Object.entries(vars).map(([k, v]) => `${k}:${v};`).join('');
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
      .sygenop-root{ ${cssVars} font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; background:var(--bg); color:var(--ink); min-height:100vh; -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
      .sygenop-card{ background:var(--panel); border:1px solid var(--line); border-radius:16px; box-shadow:0 1px 2px rgba(2,6,23,.04),0 12px 30px -8px rgba(2,6,23,.10); transition:transform .25s cubic-bezier(.22,1,.36,1), box-shadow .25s, border-color .25s; will-change:transform; }
      .sygenop-card:hover{ transform:translateY(-3px); box-shadow:0 4px 10px rgba(2,6,23,.06),0 22px 45px -14px rgba(10,30,61,.28); border-color:rgba(10,30,61,.15); }

      /* ---------- Modales : verre dépoli, opacité régulée + scroll sûr ---------- */
      .sygenop-root .fixed.inset-0.z-50{
        max-height:100vh; overflow-y:auto; overscroll-behavior:contain;
        background: var(--modal-overlay);
        backdrop-filter: blur(16px) saturate(150%);
        -webkit-backdrop-filter: blur(16px) saturate(150%);
      }
      .sygenop-root .fixed.inset-0.z-50 > *{ margin-top:auto; margin-bottom:auto; }
      .sygenop-root .fixed.inset-0.z-50 > .sygenop-card,
      .sygenop-root .fixed.inset-0.z-50 > form.sygenop-card{
        background: var(--panel);
        background: var(--modal-card);
        border:1px solid var(--modal-line);
        border-radius:22px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 30px 70px -20px rgba(0,0,0,.5), 0 10px 30px -14px rgba(0,0,0,.35);
        backdrop-filter: blur(28px) saturate(160%);
        -webkit-backdrop-filter: blur(28px) saturate(160%);
      }
      .sygenop-root .fixed.inset-0.z-50 > .sygenop-card .sygenop-input,
      .sygenop-root .fixed.inset-0.z-50 > .sygenop-card select,
      .sygenop-root .fixed.inset-0.z-50 > .sygenop-card input,
      .sygenop-root .fixed.inset-0.z-50 > .sygenop-card textarea{ background: var(--panel); }

      /* ---------- Accessibilité clavier ---------- */
      .sygenop-root button:focus-visible, .sygenop-root input:focus-visible, .sygenop-root select:focus-visible, .sygenop-root textarea:focus-visible, .sygenop-root a:focus-visible{ outline:2px solid var(--gold); outline-offset:2px; border-radius:6px; box-shadow:0 0 0 4px rgba(255,209,0,.18); }
      .sygenop-root input:focus, .sygenop-root select:focus, .sygenop-root textarea:focus{ border-color:var(--green); box-shadow:0 0 0 3px rgba(10,30,61,.12); }

      /* ---------- Scrollbar (clair + sombre) ---------- */
      .sygenop-root ::-webkit-scrollbar{ width:10px; height:10px; }
      .sygenop-root ::-webkit-scrollbar-track{ background:var(--bg); }
      .sygenop-root ::-webkit-scrollbar-thumb{ background:var(--line); border-radius:999px; border:2px solid var(--bg); }
      .sygenop-root ::-webkit-scrollbar-thumb:hover{ background:var(--green); }
      .sygenop-root ::selection{ background:rgba(10,30,61,.18); }

      /* ---------- Boutons & inputs cohérents ---------- */
      .sygenop-btn{ display:inline-flex; align-items:center; justify-content:center; gap:.5rem; border:none; cursor:pointer; font-weight:600; font-size:.85rem; border-radius:.65rem; padding:.6rem 1rem; color:#fff; background:var(--green-d); transition:transform .15s ease, box-shadow .2s ease, background .2s ease; white-space:nowrap; }
      .sygenop-btn:hover{ transform:translateY(-1px); box-shadow:0 8px 18px -6px rgba(10,30,61,.5); background:var(--green-hover); }
      .sygenop-btn:active{ transform:translateY(0); }
      .sygenop-btn:disabled{ opacity:.5; cursor:not-allowed; transform:none; box-shadow:none; filter:none; }
      .sygenop-btn--ghost{ background:var(--bg); color:var(--ink); border:1px solid var(--line); }
      .sygenop-btn--ghost:hover{ box-shadow:0 6px 14px -6px rgba(2,6,23,.25); filter:none; }
      .sygenop-btn--danger{ background:var(--red); }
      .sygenop-btn--danger:hover{ box-shadow:0 8px 18px -6px rgba(214,75,85,.5); }
      .sygenop-btn--sm{ padding:.4rem .7rem; font-size:.78rem; border-radius:.5rem; }
      .sygenop-btn--gold{ background:var(--gold); color:#172033; transition:transform .15s ease, box-shadow .2s ease, background .2s ease; }
      .sygenop-btn--gold:hover{ box-shadow:0 8px 18px -6px rgba(255,209,0,.5); background:var(--gold-hover); }
      .sygenop-input{ width:100%; padding:.65rem .9rem; border-radius:.65rem; border:1px solid var(--line); background:var(--panel); color:var(--ink); font-size:.9rem; transition:border-color .2s, box-shadow .2s; }

      /* ---------- Tableaux : lisibilité + lignes alternées + survol ---------- */
      .sygenop-root table{ width:100%; border-collapse:separate; border-spacing:0; }
      .sygenop-root thead th{ background:var(--green-l); color:var(--green-d); }
      .sygenop-root tbody tr{ transition:background .15s ease; }
      .sygenop-root tbody tr:nth-child(even):not(.total):not(.grand){ background:rgba(10,30,61,.02); }
      .sygenop-root tbody tr:hover{ background:rgba(255,209,0,.06); }
      .sygenop-root tbody tr:last-child td{ border-bottom:none; }
      .sygenop-table{ overflow-x:auto; border:1px solid var(--line); border-radius:12px; }
      .sygenop-table table{ min-width:640px; }
      .sygenop-root th, .sygenop-root td{ text-align:left; }
      .sygenop-root thead th{ position:sticky; top:0; z-index:1; }
      @keyframes sygenopFade{ from{opacity:0; transform:translateY(4px);} to{opacity:1; transform:translateY(0);} }
      .sygenop-fade{ animation: sygenopFade .25s ease-out; }

      /* ---------- Bandeau Actualités défilant ---------- */
      @keyframes sygenopTickerSweep{ from{ left:100%; } to{ left:-100%; } }
      .sygenop-ticker-sweep{ position:absolute; animation-name:sygenopTickerSweep; animation-timing-function:linear; }
      @media (prefers-reduced-motion: reduce){ *{ transition:none!important; animation:none!important; } }

      /* ---------- Utility classes ---------- */
      .text-muted{ color:var(--muted); }
      .text-ink{ color:var(--ink); }
      .text-green{ color:var(--green-d); }
      .bg-panel{ background:var(--panel); }
      .bg-bg{ background:var(--bg); }
      .border-line{ border-color:var(--line); }

      /* ---------- Filigrane logo ---------- */
      #sygenop-print-area{ position:relative; }
      #sygenop-print-area::before{
        content:"";
        position:fixed;
        top:50%; left:50%;
        transform:translate(-50%,-50%);
        width:min(520px,70vw); height:min(520px,70vw);
        background:url('${import.meta.env.BASE_URL}edulink-logo-light.png') center/contain no-repeat;
        opacity:.04;
        pointer-events:none;
        z-index:0;
      }
      /* Le filigrane (::before, z-index 0) reste sous le contenu grâce à l'ordre
         du DOM. IMPORTANT : ne PAS donner de z-index aux vues (z-index:1 créait
         un contexte d'empilement qui enfermait les modales z-50 SOUS la barre
         du haut et le menu latéral : en-tête de la modale masqué/tronqué). */
      #sygenop-print-area > *{ position:relative; }
      /* Une carte qui contient une modale ne doit jamais devenir son bloc
         conteneur (will-change/transform piègent les éléments fixed). */
      .sygenop-root .sygenop-card:has(.fixed.inset-0.z-50){ will-change:auto; transform:none; }
      .dark #sygenop-print-area::before{
        background:url('${import.meta.env.BASE_URL}edulink-logo-dark.png') center/contain no-repeat;
        opacity:.06;
      }
      @media print{
        #sygenop-print-area::before{ display:none !important; }
      }

      /* ---------- Synthèse / Bulletins ---------- */
      .synth-table{ width:100%; border-collapse:collapse; font-size:11.5px; }
      .synth-table th, .synth-table td{ border:1px solid var(--line); padding:5px 7px; text-align:center; }
      .synth-table thead th{ background:var(--green-l); color:var(--green-d); font-weight:700; }
      .synth-table td.cl, .synth-table td.gf{ text-align:left; font-weight:600; }
      .synth-table tr.total td{ background:rgba(212,160,23,.08); font-weight:700; }
      .synth-table tr.grand td{ background:var(--gold-l); font-weight:800; color:#92710c; }
      .synth-rate-good{ color:var(--green-d); font-weight:700; }
      .synth-rate-bad{ color:var(--red); font-weight:700; }
      .synth-rate-n{ font-size:10px; opacity:.75; display:block; }

      .bull-sheet{ background:#fff; color:#172033; width:210mm; min-height:297mm; margin:0 auto; padding:14mm 12mm; box-sizing:border-box; font-size:11.5px; }
      .bull-sheet table{ width:100%; border-collapse:collapse; }
      .bull-sheet th, .bull-sheet td{ border:1px solid var(--line); padding:4px 6px; }
      .bull-sheet .domrow td{ background:#dde6f2; font-weight:700; color:#0a1e3d; text-align:left; }
      .bull-sheet tr.tot td{ background:#fff8cf; font-weight:800; }

      /* ---------- Carte d’identité élève ---------- */
      .student-id-card-sheet{ display:flex; flex-direction:column; align-items:center; gap:16px; }
      .student-id-card-front, .student-id-card-back{ width:620px; height:390px; min-height:390px; max-width:100%; box-sizing:border-box; overflow:hidden; }
      .student-id-card-back{ display:flex; flex-direction:column; align-items:center; justify-content:center; }

      /* ---------- Reçu de paiement ---------- */
      .recu-sheet{ background:#fff; color:#172033; width:148mm; min-height:auto; margin:0 auto 14px; padding:10mm; box-sizing:border-box; font-size:12px; border:1px dashed #ffd100; }
      .recu-sheet table{ width:100%; border-collapse:collapse; }
      .recu-sheet th, .recu-sheet td{ border:1px solid #cbd5e1; padding:5px 7px; }
      .recu-sheet .recu-total td{ background:#fff8cf; font-weight:800; }
      .recu-sheet .recu-stub{ border-top:1px dashed #ffd100; margin-top:10px; padding-top:8px; font-size:10px; color:#64748b; }

      @media print{
        .no-print{ display:none !important; }
        body *{ visibility:hidden; }
        #sygenop-print-area, #sygenop-print-area *{ visibility:visible; }
        #sygenop-print-area{ position:absolute; left:0; top:0; width:100%; padding:0 !important; max-width:none !important; margin:0 !important; }
        #student-card-print, #staff-card-print, #student-card-print *, #staff-card-print *{ visibility:visible; }
        #student-card-print, #staff-card-print{ position:absolute !important; left:0 !important; top:0 !important; width:100% !important; height:auto !important; padding:0 !important; margin:0 !important; overflow:visible !important; background:#fff !important; }
        #student-card-print > div, #staff-card-print > div{ margin:0 auto !important; max-width:none !important; }
        #student-card-print .student-id-card-sheet, #staff-card-print .student-id-card-sheet{ display:flex !important; flex-direction:column !important; align-items:center !important; justify-content:flex-start !important; width:170mm !important; padding-top:20mm !important; margin:0 auto !important; gap:12mm !important; }
        #student-card-print .student-id-card-front, #student-card-print .student-id-card-back, #staff-card-print .student-id-card-front, #staff-card-print .student-id-card-back{ flex:0 0 auto !important; width:170mm !important; height:auto !important; min-height:112mm !important; max-height:none !important; max-width:170mm !important; box-sizing:border-box !important; padding:8mm !important; overflow:visible !important; border:0.5mm solid #176b49 !important; border-radius:3mm !important; margin:0 !important; page-break-before:auto !important; page-break-after:auto !important; }
        #student-card-print .student-id-card-sheet > * + *, #staff-card-print .student-id-card-sheet > * + *{ margin-top:12mm !important; }
        #student-card-print .student-id-card-front .grid, #staff-card-print .student-id-card-front .grid{ gap:4mm !important; }
        #student-card-print .student-id-card-front .space-y-2 > * + *, #staff-card-print .student-id-card-front .space-y-2 > * + *{ margin-top:2mm !important; }
        #student-card-print .student-id-card-front .text-lg, #student-card-print .student-id-card-back .text-lg, #staff-card-print .student-id-card-front .text-lg, #staff-card-print .student-id-card-back .text-lg{ font-size:15pt !important; }
        #student-card-print .student-id-card-front .text-sm, #staff-card-print .student-id-card-front .text-sm{ font-size:10pt !important; }
        #student-card-print .student-id-card-front .text-xs, #student-card-print .student-id-card-back .text-xs, #staff-card-print .student-id-card-front .text-xs, #staff-card-print .student-id-card-back .text-xs{ font-size:9pt !important; }
        #student-card-print .student-id-card-front img, #staff-card-print .student-id-card-front img{ max-height:38mm !important; }
        #student-card-print .school-logo, #staff-card-print .school-logo, #student-cert-print .school-logo, #staff-cert-print .school-logo{ max-height:15mm !important; width:auto !important; height:auto !important; }
        #student-card-print .student-id-card-back svg, #staff-card-print .student-id-card-back svg{ width:58mm !important; height:58mm !important; }
        #student-cert-print, #student-cert-print *{ visibility:visible; }
        #student-cert-print{ position:absolute !important; left:0 !important; top:0 !important; width:100% !important; height:auto !important; padding:0 !important; margin:0 !important; overflow:visible !important; background:#fff !important; }
        #student-cert-print > div{ margin:0 auto !important; max-width:none !important; }
        #staff-cert-print, #staff-cert-print *{ visibility:visible; }
        #staff-cert-print{ position:absolute !important; left:0 !important; top:0 !important; width:100% !important; height:auto !important; padding:0 !important; margin:0 !important; overflow:visible !important; background:#fff !important; }
        #staff-cert-print > div{ margin:0 auto !important; max-width:none !important; }
        @page{ margin:0; size:A4 portrait; }
      }
    `}</style>
  );
}

/* ============================================================
   PETITS UTILITAIRES UI
   ============================================================ */
function AppLoader({ label = 'Chargement des données…', compact = false }) {
  return (
    <div className={compact ? 'flex items-center gap-2' : 'flex flex-col items-center justify-center py-24 text-center'} style={{ color: 'var(--muted)' }} role="status" aria-live="polite">
      <div className="relative flex items-center justify-center">
        <Loader2 className="animate-spin" size={compact ? 18 : 42} style={{ color: 'var(--gold)' }} />
        {!compact && <School className="absolute" size={18} style={{ color: 'var(--green-d)' }} />}
      </div>
      <span className={compact ? 'text-sm' : 'mt-3 text-sm font-semibold'}>{label}</span>
    </div>
  );
}
function StatCard({ icon: Icon, label, value, sub, tone = 'green' }) {
  const toneMap = {
    green: { bg: 'var(--green-l)', fg: 'var(--green-d)' },
    gold: { bg: 'var(--gold-l)', fg: 'var(--gold)' },
    red: { bg: 'var(--red-l)', fg: 'var(--red)' },
  };
  const t = toneMap[tone] || toneMap.green;
  return (
    <div className="sygenop-card p-5 flex items-start justify-between">
      <div>
        <div className="text-xs font-semibold text-muted">{label}</div>
        <div className="text-2xl font-extrabold mt-1 text-ink">{value}</div>
        {sub && <div className="text-xs mt-1 text-muted">{sub}</div>}
      </div>
      <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: t.bg, color: t.fg }}>
        <Icon size={20} />
      </div>
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div
      className="fixed bottom-6 right-6 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium sygenop-fade"
      style={{
        background: toast.err ? 'var(--red)' : 'var(--green-d)',
        color: '#fff',
      }}
    >
      {toast.msg}
    </div>
  );
}

/* ============================================================
   BANDEAU ACTUALITÉS DÉFILANT (topbar vert clair, opacité faible)
   Affiche les dernières actualités de l'école en défilement continu,
   les informations entrant par la droite et défilant vers la gauche.
   ============================================================ */
/* ============================================================
   BANDEAU ACTUALITÉS DÉFILANT (topbar vert clair, opacité très faible)
   Affiche les actualités de l'école UNE PAR UNE : chaque information
   défile entièrement de droite à gauche, jusqu'à être lue en entier,
   avant que la suivante ne démarre (déclenchée par la fin de l'animation
   de la précédente — pas de minuteur qui pourrait couper une info).
   ============================================================ */
function ActualitesTicker({ actualites, onOpen }) {
  const list = useMemo(() => sortActualites(actualites || []).slice(0, 12), [actualites]);
  // `cycle` s'incrémente à chaque fin d'animation : il sert de `key` au texte
  // défilant pour que l'animation redémarre TOUJOURS — même lorsqu'il n'y a
  // qu'une seule annonce (sinon, le texte disparaît après le premier passage).
  const [cycle, setCycle] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => { setCycle(0); }, [list.length]);

  if (!list.length) return null;

  const safeIndex = cycle % list.length;
  const item = list[safeIndex];
  const contenu = (item.contenu || '').replace(/\s+/g, ' ').trim();
  // Affiche le titre + le texte de l'annonce (limité en longueur pour un défilement lisible).
  const label = (item.important ? '\u26A0 ' : '') + item.titre + (contenu ? ' — ' + contenu.slice(0, 160) : '');
  // Durée proportionnelle à la longueur du texte : le temps que l'information
  // traverse tout le bandeau, pour qu'elle soit lisible en entier avant la suivante.
  const duration = Math.max(9, Math.round(label.length / 4.5));

  function handleEnd() {
    setCycle((c) => c + 1);
  }

  return (
    <div
      className="no-print w-full overflow-hidden flex items-center gap-2 px-3 md:px-5 py-1.5"
      style={{ background: 'rgba(16,185,129,.045)', borderBottom: '1px solid rgba(16,185,129,.12)' }}
      title="Actualités de l'école"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <button
        onClick={onOpen}
        className="flex-shrink-0 flex items-center gap-1.5 text-[11px] font-bold px-2 py-0.5 rounded-full sygenop-btn"
      >
        <MessageCircle size={12} /> Actualités
      </button>
      <div className="flex-1 overflow-hidden relative" style={{ height: 20 }}>
        <div
          key={cycle}
          className="sygenop-ticker-sweep whitespace-nowrap text-xs font-semibold"
          style={{
            color: 'var(--green-d)',
            animationDuration: `${duration}s`,
            animationPlayState: paused ? 'paused' : 'running',
          }}
          onAnimationEnd={handleEnd}
        >
          {label}
        </div>
      </div>
      {list.length > 1 && (
        <div className="flex-shrink-0 hidden sm:flex items-center gap-1">
          {list.map((_, i) => (
            <span
              key={i}
              style={{
                width: 4, height: 4, borderRadius: 999,
                background: i === safeIndex ? 'var(--green-d)' : 'rgba(16,185,129,.25)',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   ÉCRAN DE CONNEXION — 4 rôles (École / Enseignant / IEF / Super Admin)
   ============================================================ */
function LoginScreen({ onLogin, dark, setDark, notify, onBack }) {
  // Onglets publics : école | personnel | groupe (Groupe scolaire). Les accès
  // « IEF » et « Super Admin » restent discrets : lien en bas de l'écran ou
  // adresse #ief / #superadmin.
  const tabFromHash = () => {
    try {
      const h = String(window.location.hash || '').replace('#', '').toLowerCase();
      if (h === 'ief') return 'ief';
      if (h === 'superadmin' || h === 'admin') return 'admin';
      if (h === 'groupe' || h === 'groupe-scolaire') return 'groupe';
    } catch (_) { /* hors navigateur */ }
    return 'school';
  };
  const [tab, setTab] = useState(tabFromHash); // school | personnel | groupe | ief | admin
  useEffect(() => {
    const onHash = () => { setTab(tabFromHash()); setCode(''); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [code, setCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [busy, setBusy] = useState(false);

  // Cache en mémoire des recherches d'école récentes : réaffiche les résultats
  // instantanément pour une requête déjà effectuée (moins d'allers-retours
  // serveur, écran de connexion plus réactif).
  const schoolSearchCacheRef = useRef(new Map());

  // ---- Recherche d'école (remplace le menu déroulant listant tout) ----
  const [schoolQuery, setSchoolQuery] = useState('');
  const [schoolResults, setSchoolResults] = useState([]);
  const [schoolSearching, setSchoolSearching] = useState(false);
  const [selectedSchool, setSelectedSchool] = useState(null);
  const schoolId = selectedSchool?.id || '';

  useEffect(() => {
    const q = schoolQuery.trim();
    if (q.length < 2) { setSchoolResults([]); return; }
    let cancelled = false;
    setSchoolSearching(true);
    const t = setTimeout(async () => {
      const cache = schoolSearchCacheRef.current;
      const cacheKey = 'q:' + q.toLowerCase();
      const hit = cache.get(cacheKey);
      if (hit) {
        if (!cancelled) { setSchoolResults(hit); setSchoolSearching(false); }
        return;
      }
      try {
        const rows = (await sb('POST', 'rpc/search_public_schools', '', { p_query: q })) || [];
        if (rows && rows.length) {
          if (cache.size >= 24) cache.delete(cache.keys().next().value);
          cache.set(cacheKey, rows);
        }
        if (!cancelled) {
          setSchoolResults(rows);
          // Cache local incrémental (uniquement ce qui a été explicitement
          // recherché), pour permettre une reconnexion hors-ligne ultérieure
          // — jamais un dump complet de l'annuaire.
          const cache = loadJSON(LS_SCHOOLS, []);
          const merged = [...rows, ...cache.filter((c) => !rows.some((r) => r.id === c.id))].slice(0, 30);
          saveJSON(LS_SCHOOLS, merged);
        }
      } catch (_) {
        // Hors-ligne : on retombe sur le cache local (déjà limité aux
        // écoles précédemment recherchées sur CET appareil).
        if (!cancelled) {
          const cache = loadJSON(LS_SCHOOLS, []);
          setSchoolResults(cache.filter((s) => (s.name || '').toLowerCase().includes(q.toLowerCase())).slice(0, 8));
        }
      } finally {
        if (!cancelled) setSchoolSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [schoolQuery]);

  function pickSchool(s) {
    setSelectedSchool(s);
    setSchoolQuery('');
    setSchoolResults([]);
    clearStaffSelection();
  }
  function clearSchoolSelection() {
    setSelectedSchool(null);
    clearStaffSelection();
  }

  // ---- Recherche de personnel (remplace le menu déroulant listant tout) ----
  const [staffQuery, setStaffQuery] = useState('');
  const [staffResults, setStaffResults] = useState([]);
  const [staffSearching, setStaffSearching] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState(null);
  const staffId = selectedStaff?.id || '';

  function clearStaffSelection() {
    setSelectedStaff(null);
    setStaffQuery('');
    setStaffResults([]);
  }

  useEffect(() => {
    const q = staffQuery.trim();
    if (tab !== 'personnel' || !schoolId || q.length < 2) { setStaffResults([]); return; }
    let cancelled = false;
    setStaffSearching(true);
    const t = setTimeout(async () => {
      try {
        const res = await sb('POST', 'rpc/search_school_personnel', '', { p_school_id: schoolId, p_query: q });
        if (!cancelled) setStaffResults(res?.personnel || []);
      } catch (_) {
        // Hors-ligne : dernier recours, données scolaires déjà en cache
        // localement (ne fonctionne que si CET appareil s'est déjà
        // connecté à cette école auparavant).
        try {
          const st = await loadSchoolData(schoolId);
          const list = (st.personnel || []).filter((p) =>
            `${p.prenom || ''} ${p.nom || ''}`.toLowerCase().includes(q.toLowerCase())
          ).slice(0, 8);
          if (!cancelled) setStaffResults(list);
        } catch (_e) {
          if (!cancelled) notify('Impossible de charger le personnel (hors-ligne ?). Réessayez avec une connexion internet.', true);
        }
      } finally {
        if (!cancelled) setStaffSearching(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [tab, schoolId, staffQuery]);

  async function submitSchool(e) {
    e.preventDefault();
    const s = selectedSchool;
    if (!s) { notify('Sélectionnez une école', true); return; }
    if (s.actif === false) { notify('Cette école est désactivée. Contactez l\u2019administration (Super Admin).', true); return; }
    const lock = loginLockInfo('school:' + s.id);
    if (lock.locked) {
      const min = Math.ceil(lock.remainingMs / 60000);
      notify(`Trop de tentatives. Réessayez dans ${min} min.`, true); return;
    }
    let ok = false;
    try {
      const res = await sb('POST', 'rpc/check_school_code', '', { p_school_id: s.id, p_code: String(code).trim() });
      ok = res === true;
    } catch (e2) {
      // Verrou serveur (rate limiting) : affiché tel quel, sans repli
      // local ni comptage supplémentaire.
      const m = sbErrMsg(e2);
      if (/trop de tentatives/i.test(m)) { notify(m, true); return; }
      // Repli hors-ligne : la liste en cache contient encore le code pour les anciennes sessions.
      ok = (String(code).trim() === String(s.code));
    }
    if (!ok) {
      recordLoginFailure('school:' + s.id);
      const next = getLoginAttempts('school:' + s.id);
      if (next.lockedUntil > Date.now()) {
        notify(`Code incorrect. Accès bloqué 15 min après ${MAX_LOGIN_ATTEMPTS} échecs.`, true);
      } else {
        notify(`Code d\u2019accès incorrect (${next.fails}/${MAX_LOGIN_ATTEMPTS} essais).`, true);
      }
      return;
    }
recordLoginSuccess('school:' + s.id);
    // Conserve le code d'accès dans la session : les lectures/écritures des
    // données de l'école passent désormais par des RPC sécurisés qui vérifient
    // ce code (voir get_school_data / save_school_data côté Supabase).
    onLogin({ role: 'school', schoolId: s.id, schoolCode: String(code).trim() });
  }
async function submitTeacher(e) {
    e.preventDefault();
    if (!schoolId) { notify('Sélectionnez une école', true); return; }
    const school = selectedSchool;
    if (school && school.actif === false) { notify('Cette école est désactivée. Contactez l\u2019administration (Super Admin).', true); return; }
    if (!staffId) { notify('Sélectionnez votre nom', true); return; }
    const p = selectedStaff;
    if (!p) { notify('Personnel introuvable', true); return; }
    const accessRole = staffAccessRole(p.role);
    if (!accessRole) { notify('Cet agent n’a pas encore de profil de connexion. Configurez son accès dans Personnel.', true); return; }
    const lock = loginLockInfo('staff:' + staffId);
    if (lock.locked) {
      const min = Math.ceil(lock.remainingMs / 60000);
      notify(`Trop de tentatives. Réessayez dans ${min} min.`, true); return;
    }
    // Vérification SERVEUR du code personnel (RPC check_staff_code,
    // rate-limitée côté base). La liste du personnel ne contient jamais
    // les codes : toute comparaison côté client est une faille.
    const enteredCode = String(code || '').trim();
    if (!enteredCode) { notify('Saisissez votre code d\u2019accès', true); return; }
    try {
      const okServer = await sb('POST', 'rpc/check_staff_code', '', { p_school_id: schoolId, p_staff_id: staffId, p_code: enteredCode });
      if (okServer === true) {
        recordLoginSuccess('staff:' + staffId);
        rememberOfflineCredential({ schoolId, staffId, code: enteredCode });
        onLogin({ role: accessRole, schoolId, staffId, staffCode: enteredCode });
        return;
      }
      recordLoginFailure('staff:' + staffId);
      const nxt = getLoginAttempts('staff:' + staffId);
      if (nxt.lockedUntil > Date.now()) {
        notify(`Code enseignant incorrect. Accès bloqué 15 min après ${MAX_LOGIN_ATTEMPTS} échecs.`, true);
      } else {
        notify(`Code enseignant incorrect (${nxt.fails}/${MAX_LOGIN_ATTEMPTS} essais).`, true);
      }
      return;
    } catch (e2) {
      const m = sbErrMsg(e2);
      if (/trop de tentatives/i.test(m)) { notify(m, true); return; }
      // Hors-ligne : autorise UNIQUEMENT une personne déjà connectée sur
      // CET appareil avec CETTE école et CE code (repli local restreint).
      if (matchOfflineCredential({ schoolId, staffId, code: enteredCode })) {
        notify('Hors-ligne : connexion locale vérifiée.');
        recordLoginSuccess('staff:' + staffId);
        onLogin({ role: accessRole, schoolId, staffId, staffCode: enteredCode });
        return;
      }
      notify('Vérification impossible (hors-ligne ?). Reconnectez-vous à internet.', true);
      return;
    }
  }
// Connexion par code de Groupe scolaire (kind 'groupe') ou, accès discret, par
  // code IEF (kind 'ief') : même RPC check_groupe_code, session en lecture seule.
  const submitGroupe = (e) => submitCodeLecture(e, 'groupe');
  const submitIEF = (e) => submitCodeLecture(e, 'ief');
  async function submitCodeLecture(e, kind) {
    e.preventDefault();
    setBusy(true);
    const entered = String(code).trim();
    const labelCode = kind === 'groupe' ? 'du groupe scolaire' : 'IEF';
    const lock = loginLockInfo('ief:' + entered);
    if (lock.locked) {
      const min = Math.ceil(lock.remainingMs / 60000);
      notify(`Trop de tentatives. Réessayez dans ${min} min.`, true); setBusy(false); return;
    }
    let ok = false;
    let iefName = null;
    let groupeId = null;
    try {
      const res = await sb('POST', 'rpc/check_groupe_code', '', { p_code: entered });
      if (res && res.ok) { ok = true; iefName = res.nom || null; groupeId = res.groupe_id || null; }
      else if (res && res.locked) {
        notify(`Trop de tentatives (serveur). Réessayez dans ${res.retry_after_min || 15} min.`, true);
        setBusy(false); return;
      }
    } catch (e2) { notify('Erreur : ' + sbErrMsg(e2), true); setBusy(false); return; }
    if (ok) { recordLoginSuccess('ief:' + entered); onLogin({ role: 'ief', kind, groupeId, iefName, iefCode: entered }); }
    else {
      recordLoginFailure('ief:' + entered);
      const nxt = getLoginAttempts('ief:' + entered);
      if (nxt.lockedUntil > Date.now()) {
        notify(`Code ${labelCode} incorrect. Accès bloqué 15 min après ${MAX_LOGIN_ATTEMPTS} échecs.`, true);
      } else {
        notify(`Code ${labelCode} incorrect (${nxt.fails}/${MAX_LOGIN_ATTEMPTS} essais).`, true);
      }
    }
    setBusy(false);
  }
  async function submitAdmin(e) {
    e.preventDefault();
    setBusy(true);
const entered = String(code).trim();
    const lock = loginLockInfo('admin:' + entered);
    if (lock.locked) {
      const min = Math.ceil(lock.remainingMs / 60000);
      notify(`Trop de tentatives. Réessayez dans ${min} min.`, true); setBusy(false); return;
    }
    try {
      // Vérification via la RPC sécurisée check_admin_code (couvre le code
      // maître partagé, les IEF décentralisées et les comptes admins — les
      // codes ne sont plus lisibles directement par anon).
      const res = await sb('POST', 'rpc/check_admin_code', '', { p_code: entered });
      if (res && res.ok) {
        recordLoginSuccess('admin:' + entered);
        onLogin({ role: 'admin', iefId: res.ief_id || null, iefName: res.ief_name || null, adminCode: entered, iefAdminCode: entered });
        setBusy(false);
        return;
      }
      if (res && res.locked) {
        notify(`Trop de tentatives (serveur). Réessayez dans ${res.retry_after_min || 15} min.`, true);
        setBusy(false);
        return;
      }
    } catch (e2) { notify('Erreur : ' + sbErrMsg(e2), true); setBusy(false); return; }
    recordLoginFailure('admin:' + entered);
    const nxt = getLoginAttempts('admin:' + entered);
    if (nxt.lockedUntil > Date.now()) {
      notify(`Code administrateur incorrect. Accès bloqué 15 min après ${MAX_LOGIN_ATTEMPTS} échecs.`, true);
    } else {
      notify(`Code administrateur incorrect (${nxt.fails}/${MAX_LOGIN_ATTEMPTS} essais).`, true);
    }
    setBusy(false);
  }

  const tabs = [
    { id: 'school', label: 'École', icon: School },
    { id: 'personnel', label: 'Personnel', icon: Users },
    { id: 'groupe', label: 'Groupe scolaire', icon: Layers },
    // Accès discrets : affichés seulement une fois ouverts (lien ou #ief / #superadmin).
    ...(tab === 'ief' ? [{ id: 'ief', label: 'IEF', icon: Building2 }] : []),
    ...(tab === 'admin' ? [{ id: 'admin', label: 'Super Admin', icon: UserCog }] : []),
  ];

  return (
    <div className="sygenop-root relative flex items-center justify-center p-6 pb-10" style={{
      backgroundImage: `radial-gradient(circle at 12% 8%, rgba(10,30,61,.10), transparent 42%), radial-gradient(circle at 92% 4%, rgba(255,209,0,.10), transparent 38%)`,
    }}>
      <GlobalStyles dark={dark} />
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          title="Retour à l'accueil"
          className="absolute"
          style={{
            top: 18, left: 18, zIndex: 70, cursor: 'pointer',
            width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: '50%', border: '2px solid var(--green-d, #0a1e3d)',
            background: 'rgba(255,255,255,.92)', backdropFilter: 'blur(6px)',
            boxShadow: '0 6px 16px -6px rgba(10,79,58,.35)', color: 'var(--green-d, #0a1e3d)',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h5v-6h4v6h5V9.5" /></svg>
        </button>
      )}
      <div aria-hidden="true" style={{
        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        pointerEvents: 'none', overflow: 'hidden', zIndex: 0, opacity: dark ? 0.05 : 0.06,
      }}>
        <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" style={{ width: 760, maxWidth: '92vw', height: 'auto' }} />
      </div>
      <div className="w-full max-w-6xl flex flex-col lg:flex-row items-center justify-center lg:justify-center gap-10 lg:gap-24" style={{ position: 'relative', zIndex: 1 }}>

        {/* Bloc de présentation — grand écran uniquement */}
        <div className="hidden lg:flex flex-col w-full max-w-md space-y-4">
          <h2 className="text-[32px] font-extrabold leading-tight text-ink">
            La gestion scolaire,<br />
            <span style={{ color: 'var(--green-d)' }}>simple et intelligente.</span>
          </h2>
          <p className="text-sm leading-relaxed text-muted">
            EduLink Pro réunit dans une seule application la vie entière de votre
            établissement : élèves, notes, finances, personnel et communication —
            avec des comptes sécurisés pour chaque acteur de l'école.
          </p>
        </div>

        {/* Formulaire de connexion — poussé à droite */}
        <div className="w-full max-w-lg">
        <div className="flex flex-col items-center mb-8">
          <img
            src={`${import.meta.env.BASE_URL}edulink-favicon.svg`}
            alt="EduLink Pro"
            className="h-12 w-12 mb-2"
          />
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-extrabold text-ink">
              EduLink Pro
            </h1>
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'var(--gold, #ffd100)', color: '#fff' }}>V1</span>
          </div>
          <p className="text-xs mt-1 text-center text-muted">
            La plateforme intelligente de gestion scolaire
          </p>
        </div>

        <div className="sygenop-card px-8 py-10" style={{ position: 'relative', overflow: 'hidden' }}>
          <div aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', opacity: 0.06, zIndex: 0 }}>
            <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" style={{ width: 300, maxWidth: '80%', height: 'auto' }} />
          </div>
          <div className="relative" style={{ position: 'relative', zIndex: 1 }}>
          <div className="grid gap-1 mb-6 p-1 rounded-xl bg-bg" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => { setTab(t.id); setCode(''); }}
                className="flex flex-col items-center gap-1 py-2 rounded-lg text-[11px] font-semibold transition-colors"
                style={tab === t.id ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
              >
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'school' && (
            <form onSubmit={submitSchool} className="space-y-4">
              <SearchPicker
                label="École"
                placeholder="Tapez le nom de l'école…"
                query={schoolQuery}
                setQuery={setSchoolQuery}
                results={schoolResults}
                loading={schoolSearching}
                selected={selectedSchool}
                onSelect={pickSchool}
                onClear={clearSchoolSelection}
                getKey={(s) => s.id}
                renderOption={(s) => `${s.name}${s.actif === false ? ' (désactivée)' : ''}`}
              />
              <CodeField code={code} setCode={setCode} show={showCode} setShow={setShowCode} label="Code d'accès" />
              <SubmitBtn busy={busy}>Se connecter</SubmitBtn>
            </form>
          )}

          {tab === 'personnel' && (
            <form onSubmit={submitTeacher} className="space-y-4">
              <SearchPicker
                label="École"
                placeholder="Tapez le nom de l'école…"
                query={schoolQuery}
                setQuery={setSchoolQuery}
                results={schoolResults}
                loading={schoolSearching}
                selected={selectedSchool}
                onSelect={pickSchool}
                onClear={clearSchoolSelection}
                getKey={(s) => s.id}
                renderOption={(s) => `${s.name}${s.actif === false ? ' (désactivée)' : ''}`}
              />
              <SearchPicker
                label="Votre nom"
                placeholder="Tapez votre nom de famille…"
                query={staffQuery}
                setQuery={setStaffQuery}
                results={staffResults}
                loading={staffSearching}
                selected={selectedStaff}
                onSelect={setSelectedStaff}
                onClear={() => { setSelectedStaff(null); setStaffQuery(''); }}
                disabled={!schoolId}
                emptyHint="Choisissez d'abord une école"
                getKey={(p) => p.id}
                renderOption={(p) => `${personFullName(p) || p.nom} — ${displayStaffRole(p.role)}`}
              />
              <CodeField code={code} setCode={setCode} show={showCode} setShow={setShowCode} label="Code d'accès personnel" />
              <SubmitBtn busy={busy}>Se connecter</SubmitBtn>
            </form>
          )}

          {tab === 'groupe' && (
            <form onSubmit={submitGroupe} className="space-y-4">
              <p className="text-xs leading-relaxed text-muted">
                Saisissez le code d'accès de votre <b style={{ color: 'var(--green-d)' }}>Groupe scolaire</b>
                {' '}pour consulter en <b>lecture seule</b> les écoles qui le composent :
                élèves, notes, personnel, finances. Aucune modification n'est possible.
              </p>
              <CodeField code={code} setCode={setCode} show={showCode} setShow={setShowCode} label="Code d'accès du groupe scolaire" />
              <SubmitBtn busy={busy}>Se connecter</SubmitBtn>
            </form>
          )}

          {tab === 'ief' && (
            <form onSubmit={submitIEF} className="space-y-4">
              <p className="text-xs leading-relaxed text-muted">
                Saisissez le code d'accès d'une <b style={{ color: 'var(--green-d)' }}>IEF</b> (circonscription)
                pour consulter en <b>lecture seule</b> les écoles qui y sont rattachées :
                élèves, notes, personnel, finances. Aucune modification n'est possible.
              </p>
              <CodeField code={code} setCode={setCode} show={showCode} setShow={setShowCode} label="Code d'accès de l'IEF" />
              <SubmitBtn busy={busy}>Se connecter</SubmitBtn>
            </form>
          )}

          {tab === 'admin' && (
            <form onSubmit={submitAdmin} className="space-y-4">
              <CodeField code={code} setCode={setCode} show={showCode} setShow={setShowCode} label="Code Super Administrateur" />
              <SubmitBtn busy={busy}>Accéder en Super Admin</SubmitBtn>
            </form>
          )}
          </div>
        </div>

        <div className="mt-4 flex items-center justify-center gap-4 text-[11px] text-muted">
          {(tab === 'ief' || tab === 'admin') ? (
            <button type="button" onClick={() => { setTab('school'); setCode(''); }} className="underline opacity-80 hover:opacity-100">← Retour à la connexion</button>
          ) : (
            <>
              <button type="button" onClick={() => { setTab('ief'); setCode(''); }} className="underline opacity-60 hover:opacity-100">Accès IEF</button>
              <button type="button" onClick={() => { setTab('admin'); setCode(''); }} className="underline opacity-60 hover:opacity-100">Administration</button>
            </>
          )}
        </div>
        <button
          onClick={() => setDark(!dark)}
          className="mx-auto mt-3 flex items-center gap-2 text-xs font-medium text-muted"
        >
          {dark ? <Sun size={14} /> : <Moon size={14} />} {dark ? 'Thème clair' : 'Thème sombre'}
        </button>
      </div>
      </div>

      <div style={{ position: 'absolute', bottom: 3, left: 14 }} className="text-[11px] font-medium tracking-wide">
        <span style={{ color: dark ? '#9ca3af' : '#6b7280' }}>
          © {new Date().getFullYear()} EduLink Pro — Built by <b>InTechSoft Enterprises</b>
        </span>
      </div>
    </div>
  );
}

function CodeField({ code, setCode, show, setShow, label }) {
  return (
    <div>
      <label className="text-xs font-semibold block mb-1 text-muted">{label}</label>
      <div className="relative">
        <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type={show ? 'text' : 'password'}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full pl-9 pr-9 py-3 rounded-lg border text-sm sygenop-input"
          placeholder="••••••"
        />
        <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
}

/* ---- Champ de recherche "à la frappe" (min. 2 caractères) ----
   Remplace les anciens menus déroulants qui affichaient la liste
   complète des écoles / du personnel à un visiteur non authentifié
   (fuite de données). Ici, aucune suggestion n'apparaît tant que
   l'utilisateur n'a pas tapé au moins 2 caractères, et le nombre de
   résultats renvoyés par le serveur est plafonné (voir
   search_public_schools / search_school_personnel côté Supabase). */
function SearchPicker({ label, placeholder, query, setQuery, results, loading, selected, onSelect, onClear, disabled, emptyHint, getKey, renderOption }) {
  return (
    <div>
      <label className="text-xs font-semibold block mb-1 text-muted">{label}</label>
      {selected ? (
        <div
          className="w-full px-3 py-3 rounded-lg border text-sm flex items-center justify-between gap-2 sygenop-input"
        >
          <span className="truncate">{renderOption(selected)}</span>
          <button type="button" onClick={onClear} className="text-xs font-semibold flex-shrink-0" style={{ color: 'var(--green-d)' }}>
            Changer
          </button>
        </div>
      ) : (
        <div className="relative">
          <input
            type="text"
            value={query}
            disabled={disabled}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full px-3 py-3 rounded-lg border text-sm disabled:opacity-50 sygenop-input"
            placeholder={disabled ? emptyHint : placeholder}
            autoComplete="off"
          />
          {!disabled && query.trim().length >= 2 && (
            <div
              className="absolute left-0 right-0 mt-1 rounded-lg border shadow-lg z-10 max-h-56 overflow-auto sygenop-input"
            >
              {loading ? (
                <div className="px-3 py-2 text-xs text-muted">Recherche…</div>
              ) : results.length ? (
                results.map((opt) => (
                  <button
                    type="button"
                    key={getKey(opt)}
                    onClick={() => onSelect(opt)}
                    className="w-full text-left px-3 py-2 text-sm hover:opacity-80 text-ink"
                  >
                    {renderOption(opt)}
                  </button>
                ))
              ) : (
                <div className="px-3 py-2 text-xs text-muted">Aucun résultat</div>
              )}
            </div>
          )}
          {!disabled && query.trim().length > 0 && query.trim().length < 2 && (
            <div className="text-[11px] mt-1 text-muted">Continuez à taper (2 caractères min.)</div>
          )}
        </div>
      )}
    </div>
  );
}
function SubmitBtn({ children, busy }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full py-3 rounded-lg font-semibold text-sm text-white flex items-center justify-center gap-2 disabled:opacity-60"
      style={{ background: 'linear-gradient(135deg,#ffd100,#0a1e3d)' }}
    >
      {busy && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  );
}

/* ============================================================
   NAVIGATION
   ============================================================ */
// Page d'accueil par défaut selon le rôle (logo cliquable + connexion).
function homePageFor(role) {
  if (role === 'guard') return 'gate';
  if (['school', 'teacher', 'accountant', 'secretary'].includes(role)) return 'dash';
  // Le Super Admin arrive sur la liste légère des écoles : le tableau de bord
  // consolidé télécharge les données de TOUTES les écoles (plus de 10 Mo).
  if (role === 'admin') return 'superadmin';
  return 'ief';
}

// Toutes les rubriques accessibles à une session (utilisée pour valider la
// page restaurée après actualisation — jamais de page hors périmètre).
function allowedPagesFor(session) {
  const ids = new Set();
  NAV_ITEMS(session || { role: '' }).forEach((item) => {
    ids.add(item.id);
    (item.children || []).forEach((c) => ids.add(c.id));
  });
  return ids;
}

const NAV_ITEMS = (session) => {
  const items = [];
  // La consultation de circonscription (« Vue d'ensemble IEF »)
  // est réservée au Super Admin (role admin). Depuis la refonte, le login
  // « IEF » (role ief) authentifie avec le code d'un Groupe scolaire
  // et ouvre LECTURE SEULE sur les écoles de ce groupe : ses rubriques sont donc
  // celles de l'école (le bloc final items.push), pas la vue circonscription.
  if (session.role === 'ief' || session.role === 'admin') {
    items.push({ id: 'ief', label: 'Vue d\u2019ensemble (IEF)', icon: LayoutDashboard });
  }
  if (session.role === 'admin') {
    items.push({ id: 'superadmin', label: 'Gestion des écoles', icon: Building2 });
  }
  if (session.role === 'teacher') {
    items.push(
      { id: 'dash', label: 'Tableau de bord', icon: LayoutDashboard, needsSchool: true },
      { id: 'actualites', label: 'Actualités', icon: MessageCircle, needsSchool: true },
      { id: 'mesdemandes', label: 'Mes demandes', icon: ClipboardCheck, needsSchool: true },
      {
        id: 'eleves', label: 'Élèves', icon: GraduationCap, needsSchool: true, expandable: true,
        children: [
          { id: 'classes', label: 'Classes et élèves' },
        ],
      },
    );
    return items;
  }
  if (session.role === 'guard') {
    return [{ id: 'gate', label: 'Contrôle portail', icon: ScanLine, needsSchool: true }, { id: 'mesdemandes', label: 'Mes demandes', icon: ClipboardCheck, needsSchool: true }];
  }
  if (session.role === 'accountant') {
    return [
      { id: 'dash', label: 'Tableau de bord', icon: LayoutDashboard, needsSchool: true },
      { id: 'paiements', label: 'Comptabilité', icon: CreditCard, needsSchool: true },
      { id: 'mesdemandes', label: 'Mes demandes', icon: ClipboardCheck, needsSchool: true },
      { id: 'data', label: 'Données', icon: Database, needsSchool: true },
    ];
  }
  if (session.role === 'secretary') {
    return [
      { id: 'dash', label: 'Tableau de bord', icon: LayoutDashboard, needsSchool: true },
      { id: 'actualites', label: 'Actualités', icon: MessageCircle, needsSchool: true },
      { id: 'mesdemandes', label: 'Mes demandes', icon: ClipboardCheck, needsSchool: true },
      { id: 'personnel', label: 'Personnel', icon: Users, needsSchool: true },
      { id: 'eleves', label: 'Élèves', icon: GraduationCap, needsSchool: true, expandable: true, children: [{ id: 'classes', label: 'Classes et élèves' }] },
      { id: 'admin', label: 'Administration', icon: Settings, needsSchool: true },
      { id: 'data', label: 'Données', icon: Database, needsSchool: true },
    ];
  }
  items.push(
    { id: 'dash', label: 'Tableau de bord', icon: LayoutDashboard, needsSchool: true },
    { id: 'actualites', label: 'Actualités', icon: MessageCircle, needsSchool: true },
    { id: 'personnel', label: 'Personnel', icon: Users, needsSchool: true },
    {
      id: 'eleves', label: 'Élèves', icon: GraduationCap, needsSchool: true, expandable: true,
      children: [
        { id: 'classes', label: 'Classes et élèves' },
      ],
    },
    { id: 'paiements', label: 'Comptabilité', icon: CreditCard, needsSchool: true },
    { id: 'admin', label: 'Administration', icon: Settings, needsSchool: true },
    { id: 'data', label: 'Données', icon: Database, needsSchool: true },
  );
  return items;
};

const PAGE_TITLES = {
  ief: ['Vue d\u2019ensemble (IEF)', 'Tous les cycles de l\u2019établissement — statistiques consolidées'],
  superadmin: ['Gestion des écoles', 'Créer, modifier, supprimer des écoles et des administrateurs'],
  dash: ['Tableau de bord', 'Vue d\u2019ensemble de l\u2019établissement'],
  personnel: ['Personnel', 'Gestion du personnel et pointage'],
  mesdemandes: ['Mes demandes', 'Autorisation d\u2019absence et demande d\u2019attestation de service'],
  actualites: ['Actualités', 'Publications et informations de l\u2019école'],
  classes: ['Classes et élèves', 'Gestion des classes et des élèves'],
  saisie: ['Saisie des notes', 'Élèves — Saisie des notes'],
  synth: ['Synthèse', 'Élèves — Synthèse'],
  bull: ['Bulletins', 'Élèves — Bulletins'],
  gate: ['Contrôle portail', 'Vérification des cartes à l’entrée'],
  admin: ['Administration', 'Configuration de l\u2019établissement'],
  paiements: ['Comptabilité', 'Finance, dépenses et matériel de l’établissement'],
  data: ['Données', 'Import / export'],
};

function Sidebar({ session, active, setActive, mobileOpen, setMobileOpen, hasActiveSchool }) {
  const [evalOpen, setEvalOpen] = useState(['classes', 'saisie', 'synth', 'bull'].includes(active));
  const items = NAV_ITEMS(session);

  return (
    <>
      {mobileOpen && <div className="fixed inset-0 bg-black/40 z-30 md:hidden" onClick={() => setMobileOpen(false)} />}
      <aside
        className={`no-print fixed md:sticky top-0 z-40 h-screen w-60 flex-shrink-0 flex flex-col text-white transition-transform duration-300 ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}
        style={{ background: 'linear-gradient(160deg,#0a1e3d 0%,#0d2448 60%,#132d55 100%)' }}
      >
        <div className="px-4 pt-5 pb-4 border-b border-white/10">
          <button
            onClick={() => { setActive(homePageFor(session.role)); setMobileOpen(false); }}
            title="Retour à l'accueil"
            className="flex items-center gap-2 w-full text-left rounded-lg hover:bg-white/10 transition-colors px-1 py-1 -mx-1"
          >
            <img
              src={`${import.meta.env.BASE_URL}edulink-favicon.svg`}
              alt="EduLink Pro"
              className="h-8 w-8"
            />
            <div className="flex items-center gap-1.5">
              <h1 className="text-lg font-bold">EduLink Pro</h1>
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'var(--gold, #ffd100)', color: '#fff' }}>V1</span>
            </div>
          </button>
          <p className="text-[11px] mt-1 text-[#94a3b8] font-medium leading-tight">
            La plateforme intelligente de gestion scolaire
          </p>
        </div>
        <nav className="flex-1 overflow-auto p-2.5">
          {items.map((item) => {
            const disabled = item.needsSchool && !hasActiveSchool;
            if (item.expandable) {
              const isActiveGroup = item.children.some((c) => c.id === active);
              return (
                <div key={item.id}>
                  <button
                    disabled={disabled}
                    onClick={() => setEvalOpen((o) => !o)}
                    className={`w-full text-left px-3 py-2.5 rounded-lg text-[13.5px] font-medium flex items-center gap-2.5 mb-0.5 transition-colors ${disabled ? 'opacity-35 cursor-not-allowed' : 'hover:bg-white/10 hover:text-white'}`}
                    style={isActiveGroup ? { background: 'rgba(255,255,255,.1)', boxShadow: 'inset 3px 0 0 var(--gold, #ffd100)', color: '#fff', fontWeight: 700 } : { color: '#cbe0d3' }}
                  >
                    <item.icon size={16} className="w-[18px]" />
                    {item.label}
                    <ChevronRight size={11} className={`ml-auto transition-transform ${evalOpen ? 'rotate-90' : ''}`} />
                  </button>
                  {evalOpen && !disabled && (
                    <div className="border-l-2 border-white/10 ml-[19px] pl-2">
                      {item.children.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => { setActive(c.id); setMobileOpen(false); }}
                          className="w-full text-left px-3 py-2 rounded-lg text-[13px] font-medium mb-0.5 transition-colors"
                          style={active === c.id ? { background: 'rgba(255,255,255,.1)', boxShadow: 'inset 3px 0 0 var(--gold, #ffd100)', color: '#fff', fontWeight: 700 } : { color: '#cbe0d3' }}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            }
            return (
              <button
                key={item.id}
                disabled={disabled}
                onClick={() => { setActive(item.id); setMobileOpen(false); }}
                className={`w-full text-left px-3 py-2.5 rounded-lg text-[13.5px] font-medium flex items-center gap-2.5 mb-0.5 transition-colors ${disabled ? 'opacity-35 cursor-not-allowed' : 'hover:bg-white/10 hover:text-white hover:translate-x-0.5'}`}
                style={active === item.id ? { background: 'rgba(255,255,255,.1)', boxShadow: 'inset 3px 0 0 var(--gold, #ffd100)', color: '#fff', fontWeight: 700 } : { color: '#cbe0d3' }}
              >
                <item.icon size={16} className="w-[18px]" />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="px-4 py-3.5 text-[11px] text-[#86b79d] border-t border-white/10">
          <b className="text-[#cbe0d3] font-semibold">EduLink Pro</b> — V1
          <div className="mt-1.5 pt-1.5 border-t border-white/10 text-[9.5px] text-[#6f9d84]">
            © {new Date().getFullYear()} Groupe InTechSoft Enterprises
          </div>
        </div>
      </aside>
    </>
  );
}

function Topbar({ title, sub, session, schoolName, dark, setDark, onLogout, setMobileOpen, countdownMs, annee, periodeKey, periodeLabel, periodeOptions = [], canEditPeriode, onPeriodeChange }) {
  const roleLabel = {
    ief: session.kind === 'groupe' ? (session.iefName ? `Groupe scolaire — ${session.iefName}` : 'Groupe scolaire (lecture seule)') : (session.iefName ? `IEF — ${session.iefName}` : 'IEF (lecture seule)'), admin: 'Super Administrateur', teacher: 'Enseignant(e)', accountant: 'Comptable/Gestionnaire', secretary: 'Secrétaire', school: schoolName || 'Compte école',
  }[session.role];
  function fmtCountdown(ms) {
    if (ms == null || ms <= 0) return null;
    const total = Math.ceil(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }
  const cd = fmtCountdown(countdownMs);
  return (
    <div
      className="no-print sticky top-0 z-20 px-4 md:px-7 py-2.5 shadow-lg"
      style={{ background: 'linear-gradient(120deg,#0a1e3d 0%,#0d2448 55%,#132d55 100%)' }}
    >
      <div className="flex items-center justify-between gap-4">
      <button className="md:hidden text-white" onClick={() => setMobileOpen(true)}><Menu size={22} /></button>
      <div>
        <div className="text-white font-bold text-[17px] md:text-[19px]">{title}</div>
        <div className="text-white/75 text-xs font-medium mt-0.5 hidden sm:block">{sub}</div>
      </div>
      <div className="flex items-center gap-3 ml-auto">
        {cd && (
          <span className="hidden sm:flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg bg-white/10 text-white/90" title="Déconnexion automatique dans">
            <Clock size={14} /> {cd}
          </span>
        )}
        <button onClick={() => setDark(!dark)} className="text-white/90 hover:text-white">
          {dark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <div className="hidden md:block text-right text-white text-xs">
          <b className="font-bold">{roleLabel}</b>
        </div>
        <button onClick={onLogout} className="text-white/90 hover:text-white flex items-center gap-1.5 text-xs font-semibold bg-white/10 hover:bg-white/20 px-2.5 py-1.5 rounded-lg">
          <LogOut size={14} /> <span className="hidden sm:inline">Déconnexion</span>
        </button>
      </div>
      </div>
      {(annee || periodeKey) && (
        <div className="hidden md:flex items-center gap-2 justify-end mt-1.5 flex-wrap">
          {annee && (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-md bg-white/15 text-white whitespace-nowrap">
              <CalendarDays size={12} /> Année scolaire {annee}
            </span>
          )}
          {canEditPeriode && periodeOptions.length ? (
            <select
              value={periodeKey || ''}
              onChange={(e) => onPeriodeChange && onPeriodeChange(e.target.value)}
              title="Période activée pour toute l'école (trimestres ou semestres selon le cycle)"
              className="text-[11px] font-bold px-2 py-0.5 rounded-md border-0 outline-none cursor-pointer whitespace-nowrap"
              style={{ background: 'rgba(255,255,255,.15)', color: '#fff' }}
            >
              {periodeOptions.map((p) => <option key={p.key} value={p.key} style={{ color: '#0a1e3d' }}>{p.label}</option>)}
            </select>
          ) : periodeKey ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-md bg-white/15 text-white whitespace-nowrap">
              {periodeLabel || periodeKey}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   ACTUALITÉS — composants d'affichage et de saisie
   ============================================================ */
function NewsItemCard({ item, schoolName, onDelete }) {
  const d = item.date ? new Date(item.date) : null;
  const dateLabel = d ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
  return (
    <div className="p-3.5 rounded-xl" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {item.important && <Pill tone="red">Important</Pill>}
          {schoolName && <Pill tone="gold">{schoolName}</Pill>}
          <span className="text-[11px] font-semibold text-muted">{dateLabel}</span>
        </div>
        {onDelete && (
          <button onClick={() => onDelete(item.id)} title="Supprimer" style={{ color: 'var(--muted)' }}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div className="font-bold text-sm mt-1.5 text-ink">{item.titre}</div>
      <p className="text-sm mt-1 whitespace-pre-wrap text-muted">{item.contenu}</p>
      {item.auteur && <div className="text-[11px] mt-2 font-medium text-muted">— {item.auteur}</div>}
    </div>
  );
}

// Fil d'actualités d'une seule école (utilisé dans le tableau de bord et l'onglet dédié).
// Si `onAdd`/`onDelete` sont fournis, un formulaire de publication est proposé (Directeur / Super Admin).
function ActualitesPanel({ actualites, onAdd, onDelete, limit, title = 'Actualités de l\u2019école', authorName }) {
  const [open, setOpen] = useState(false);
  const [titre, setTitre] = useState('');
  const [contenu, setContenu] = useState('');
  const [important, setImportant] = useState(false);
  const list = sortActualites(actualites);
  const shown = limit ? list.slice(0, limit) : list;

  function submit(e) {
    e.preventDefault();
    if (!titre.trim() || !contenu.trim()) return;
    onAdd({ titre, contenu, important, auteur: authorName });
    setTitre(''); setContenu(''); setImportant(false); setOpen(false);
  }

  return (
    <div className="sygenop-card p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="font-bold text-sm flex items-center gap-2 text-ink">
          <MessageCircle size={16} /> {title}
        </div>
        {onAdd && (
          <button
            onClick={() => setOpen((o) => !o)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white flex items-center gap-1.5"
            style={{ background: 'var(--green-d)' }}
          >
            <Plus size={13} /> Publier
          </button>
        )}
      </div>
      {open && onAdd && (
        <form onSubmit={submit} className="p-3.5 rounded-xl space-y-2.5" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
          <input
            autoFocus
            value={titre}
            onChange={(e) => setTitre(e.target.value)}
            placeholder="Titre de l'actualité"
            className="w-full px-3 py-2 rounded-lg border text-sm sygenop-input"
          />
          <textarea
            value={contenu}
            onChange={(e) => setContenu(e.target.value)}
            placeholder="Contenu…"
            rows={3}
            className="w-full px-3 py-2 rounded-lg border text-sm sygenop-input"
          />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-muted">
              <input type="checkbox" checked={important} onChange={(e) => setImportant(e.target.checked)} /> Marquer comme important
            </label>
            <button type="submit" className="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-white" style={{ background: 'var(--green-d)' }}>
              Publier
            </button>
          </div>
        </form>
      )}
      {shown.length === 0 ? (
        <div className="text-center text-sm py-6 text-muted">Aucune actualité publiée pour le moment.</div>
      ) : (
        <div className="space-y-2.5">
          {shown.map((item) => <NewsItemCard key={item.id} item={item} schoolName={item.__school} onDelete={onDelete} />)}
        </div>
      )}
    </div>
  );
}

// Onglet « Actualités » dédié à l'école ouverte (Directeur / Super Admin / IEF en lecture seule).
function ActualitesView({ state, loading, updateState, notify, readOnly, authorName }) {
  if (loading || !state) {
    return (
      <div className="flex items-center justify-center py-24 text-muted">
        <Loader2 className="animate-spin mr-2" size={18} /> Chargement des données…
      </div>
    );
  }
  function handleAdd(payload) {
    updateState((prev) => addActualite(prev, payload));
    notify('Actualité publiée');
  }
  function handleDelete(id) {
    updateState((prev) => removeActualite(prev, id));
    notify('Actualité supprimée');
  }
  return (
    <div className="space-y-4 sygenop-fade">
      <ActualitesPanel
        actualites={state.actualites}
        onAdd={readOnly ? null : handleAdd}
        onDelete={readOnly ? null : handleDelete}
        authorName={authorName}
        title={`Actualités — ${state.header?.ecole || 'l\u2019école'}`}
      />
    </div>
  );
}

/* ============================================================
   TABLEAUX DE BORD PAR RÔLE
   ============================================================ */
function StaffRoleDashboard({ state, loading, role, setActive, authorName }) {
  if (loading || !state) return <AppLoader />;
  const classes = Object.values(state.classes || {});
  const students = classes.flatMap((cls) => cls.students || []);
  const payments = students.flatMap((student) => studentPaiements(student));
  const totalPayments = payments.reduce((sum, payment) => sum + (Number(payment.montant) || 0), 0);
  const expenses = state.depenses || [];
  const totalExpenses = expenses.reduce((sum, expense) => sum + (Number(expense.montant) || 0), 0);
  const personnel = state.personnel || [];
  const pendingTransfers = (state.studentTransferRequests || []).filter((request) => request.status === 'pending').length;
  const isAccountant = role === 'accountant';
  const formatMoney = (value) => `${new Intl.NumberFormat('fr-FR').format(value)} FCFA`;
  const open = (target) => setActive(target);

  return (
    <div className="space-y-6 sygenop-fade">
      <div className="sygenop-card p-5" style={{ background: 'linear-gradient(135deg, var(--green-l), var(--panel))' }}>
        <div className="text-xs font-semibold uppercase tracking-wide text-muted">Espace professionnel</div>
        <h2 className="text-xl font-extrabold mt-1 text-ink">{isAccountant ? 'Tableau de bord Comptabilité' : 'Tableau de bord Secrétariat'}</h2>
        <div className="text-sm font-semibold mt-2" style={{ color: 'var(--green-d)' }}>Connecté : {authorName || (isAccountant ? 'Comptable/Gestionnaire' : 'Secrétaire')}</div>
        <p className="text-sm mt-1 text-muted">{isAccountant ? 'Suivi des paiements, dépenses, matériel et échanges de données.' : 'Suivi du personnel, des élèves, des actualités, de l’administration et des données.'}</p>
      </div>

      {isAccountant ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon={Wallet} label="Paiements enregistrés" value={formatMoney(totalPayments)} sub={`${payments.length} opération(s)`} tone="green" />
            <StatCard icon={TrendingDown} label="Dépenses" value={formatMoney(totalExpenses)} sub={`${expenses.length} dépense(s)`} tone="gold" />
            <StatCard icon={Scale} label="Solde suivi" value={formatMoney(totalPayments - totalExpenses)} sub="Entrées moins dépenses" tone="green" />
            <StatCard icon={Package} label="Matériel" value={state.materiel?.length || 0} sub="article(s) enregistré(s)" tone="gold" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => open('paiements')} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--green-d)' }}><Wallet size={15} className="inline mr-1.5" /> Ouvrir la comptabilité</button>
            <button onClick={() => open('data')} className="px-4 py-2.5 rounded-lg text-sm font-semibold" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}><Database size={15} className="inline mr-1.5" /> Importer / exporter les données</button>
          </div>
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon={Users} label="Personnel" value={personnel.length} sub={`${personnel.filter((person) => person.statut === 'Actif').length} actif(s)`} tone="green" />
            <StatCard icon={GraduationCap} label="Élèves" value={students.length} sub={`${classes.length} classe(s)`} tone="gold" />
            <StatCard icon={MessageCircle} label="Actualités" value={state.actualites?.length || 0} sub="publication(s)" tone="green" />
            <StatCard icon={ArrowUpCircle} label="Demandes de transfert" value={pendingTransfers} sub="en attente" tone="gold" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => open('personnel')} className="px-4 py-2.5 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--green-d)' }}><Users size={15} className="inline mr-1.5" /> Gérer le personnel</button>
            <button onClick={() => open('classes')} className="px-4 py-2.5 rounded-lg text-sm font-semibold" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}><GraduationCap size={15} className="inline mr-1.5" /> Gérer les élèves</button>
            <button onClick={() => open('actualites')} className="px-4 py-2.5 rounded-lg text-sm font-semibold" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}><MessageCircle size={15} className="inline mr-1.5" /> Actualités</button>
            <button onClick={() => open('admin')} className="px-4 py-2.5 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}><Settings size={15} className="inline mr-1.5" /> Administration</button>
            <button onClick={() => open('data')} className="px-4 py-2.5 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}><Database size={15} className="inline mr-1.5" /> Données</button>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================
   ERROR BOUNDARY — évite l'écran blanc total si une vue plante
   au rendu : affiche un message récupérable avec réessai/recharge.
   ============================================================ */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    console.error('Erreur de rendu :', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="sygenop-card p-8 max-w-xl mx-auto mt-10 text-center text-ink">
        <AlertCircle size={34} className="mx-auto mb-3" style={{ color: 'var(--red)' }} />
        <h2 className="font-bold mb-2">Une erreur est survenue dans cette page</h2>
        <p className="text-sm mb-4 text-muted">{String((this.state.error && this.state.error.message) || this.state.error)}</p>
        <div className="flex justify-center gap-2">
          <button type="button" onClick={() => this.setState({ error: null })} className="px-4 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--green-d)' }}>Réessayer</button>
          <button type="button" onClick={() => window.location.reload()} className="px-4 py-2 rounded-lg text-sm font-semibold" style={{ border: '1px solid var(--line)', color: 'var(--ink)', background: 'var(--panel)' }}>Recharger la page</button>
        </div>
      </div>
    );
  }
}

/* ============================================================
   TABLEAU DE BORD (école)
   ============================================================ */
function DashboardView({ state, loading, teacherName, teacherStaffId, role, updateState, notify, setActive, authorName }) {
  const isTeacherScoped = !!teacherName;
  const [presMois, setPresMois] = useState(currentMonthISO());
  const [notePeriod, setNotePeriod] = useState('T1');
  const schoolPeriods = periodsForSchool(state);
  useEffect(() => {
    if (schoolPeriods.length && !schoolPeriods.some((period) => period.key === notePeriod)) setNotePeriod(schoolPeriods[0].key);
  }, [schoolPeriods.map((period) => period.key).join(','), notePeriod]);
  // Suit la période activée globalement (barre du haut) quand elle change
  const globalPeriode = state && state.header && state.header.periodeActif;
  useEffect(() => {
    if (globalPeriode && globalPeriode !== notePeriod && schoolPeriods.some((p) => p.key === globalPeriode)) setNotePeriod(globalPeriode);
  }, [globalPeriode]);
  const presence = useMemo(() => (state ? schoolPresenceSummary(state, presMois) : null), [state, presMois]);
  const teacherAttendance = useMemo(() => (state && teacherStaffId ? teacherAttendanceSummary(state, teacherStaffId, presMois) : null), [state, teacherStaffId, presMois]);
  const academic = useMemo(() => (state ? schoolAcademicSummary(state, notePeriod) : null), [state, notePeriod]);
  const stats = useMemo(() => {
    if (!state) return null;
    const allEntries = Object.entries(state.classes || {});
    const classEntries = isTeacherScoped ? allEntries.filter(([, c]) => classHasTeacher(c, teacherName)) : allEntries;
    const schoolLevels = levelsForSchool(state);
    let total = 0, garcons = 0, filles = 0;
    const byLevel = schoolLevels.map((lvl) => ({ niveau: lvl, effectif: 0 }));
    classEntries.forEach(([, c]) => {
      const n = (c.students || []).length;
      total += n;
      (c.students || []).forEach((s) => {
        if (String(s.genre).toUpperCase() === 'M') garcons++;
        else if (String(s.genre).toUpperCase() === 'F') filles++;
      });
      const row = byLevel.find((r) => r.niveau === c.level);
      if (row) row.effectif += n;
    });
    const activeClasses = classEntries.filter(([, c]) => (c.students || []).length > 0).length;
    const personnel = state.personnel || [];
    const personnelActif = personnel.filter((p) => p.statut !== 'Absent').length;
    const personnelGender = staffGenderSummary(personnel);
    const myClasses = classEntries.map(([, c]) => ({ name: c.name, level: c.level }));
    return {
      total, garcons, filles, byLevel, activeClasses, totalClasses: classEntries.length,
      personnelActif, personnelTotal: personnelGender.total, personnelMale: personnelGender.male, personnelFemale: personnelGender.female, personnelUnknown: personnelGender.unknown, myClasses,
    };
  }, [state, isTeacherScoped, teacherName]);

  if (loading || !stats) {
    return <AppLoader />;
  }

  const genderData = [
    { name: 'Garçons', value: stats.garcons },
    { name: 'Filles', value: stats.filles },
  ];
  const GENDER_COLORS = ['#0a1e3d', '#ffd100'];
  const personnelGenderData = [
    { name: 'Hommes', value: stats.personnelMale || 0 },
    { name: 'Femmes', value: stats.personnelFemale || 0 },
    ...(stats.personnelUnknown ? [{ name: 'Non renseigné', value: stats.personnelUnknown }] : []),
  ];
  const PERSONNEL_GENDER_COLORS = ['#0a1e3d', '#ffd100', '#94a3b8'];
  const visibleClassIds = Object.entries(state.classes || {}).filter(([, cls]) => !isTeacherScoped || classHasTeacher(cls, teacherName)).map(([id]) => id);
  const visibleAssignments = (state.affectationsMateriel || []).filter((a) => visibleClassIds.includes(a.classId));

  if (role === 'accountant' || role === 'secretary') {
    return <StaffRoleDashboard state={state} loading={loading} role={role} setActive={setActive} authorName={authorName} />;
  }

  if (isTeacherScoped) {
    const classLabel = stats.myClasses.length
      ? stats.myClasses.map((c) => `${c.name} (${c.level})`).join(', ')
      : '— aucune classe assignée —';
    return (
      <div className="space-y-6 sygenop-fade">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard icon={GraduationCap} label="Élèves inscrits" value={stats.total} sub={`${stats.garcons} garçons · ${stats.filles} filles`} tone="green" />
          <StatCard icon={School} label="Ma classe" value={classLabel} sub={stats.myClasses.length > 1 ? `${stats.myClasses.length} classes assignées` : 'Assignée par la direction'} tone="gold" />
          <StatCard icon={CheckCircle2} label={cycleTerminology(state.header?.cycle).teacher} value={teacherName} sub="Compte connecté" tone="green" />
        </div>
        <div className="sygenop-card p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="font-bold text-sm flex items-center gap-2 text-ink"><Clock size={16} /> Mon pointage et mes objectifs</div>
            <input type="month" value={presMois} onChange={(e) => setPresMois(e.target.value)} className="px-2.5 py-1.5 rounded-lg border text-xs sygenop-input" />
          </div>
          {teacherAttendance ? (
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
              <div><div className="text-xs text-muted">Objectif mensuel</div><div className="font-bold">{teacherAttendance.target} h</div></div>
              <div><div className="text-xs text-muted">Heures servies</div><div className="font-bold" style={{ color: 'var(--green-d)' }}>{teacherAttendance.heures} h</div></div>
              <div><div className="text-xs text-muted">Exécution</div><div className="font-bold" style={{ color: 'var(--gold)' }}>{Math.round(teacherAttendance.execution * 100)}%</div></div>
              <div><div className="text-xs text-muted">Absences</div><div className="font-bold" style={{ color: 'var(--red)' }}>{teacherAttendance.absences} jour(s)</div></div>
              <div><div className="text-xs text-muted">Présences / retards</div><div className="font-bold">{teacherAttendance.presents} / {teacherAttendance.retards}</div></div>
            </div>
          ) : <div className="text-sm text-muted">Votre fiche de personnel n’est pas encore associée à ce compte.</div>}
        </div>
        <div className="sygenop-card p-5">
          <div className="font-bold text-sm mb-3 flex items-center gap-2 text-ink"><Package size={16} /> Matériel affecté à mes classes</div>
          {visibleAssignments.length ? <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">{visibleAssignments.map((a) => <div key={a.id} className="rounded-lg px-3 py-2 bg-bg"><b>{(state.materiel || []).find((m) => m.id === a.materielId)?.nom || 'Matériel'}</b> — {a.quantite} unité(s) <span className="text-muted">· {(state.classes || {})[a.classId]?.name}</span></div>)}</div> : <div className="text-sm text-muted">Aucun matériel n’est encore affecté à votre classe.</div>}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="sygenop-card p-5 lg:col-span-2 flex flex-col items-center justify-center text-center py-10 text-muted">
            <div className="text-sm">Ce tableau de bord affiche uniquement les données de votre classe. Retrouvez la saisie des notes, la synthèse et les bulletins dans le menu « Évaluation ».</div>
          </div>
          <div className="sygenop-card p-5">
            <div className="font-bold text-sm mb-4 text-ink">Répartition par genre</div>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={genderData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
                  {genderData.map((_, i) => <Cell key={i} fill={GENDER_COLORS[i]} />)}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 text-xs mt-2">
              <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: GENDER_COLORS[0] }} /> Garçons</span>
              <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: GENDER_COLORS[1] }} /> Filles</span>
            </div>
            
          </div>
        </div>
        <ActualitesPanel
          actualites={state.actualites}
          limit={4}
          title="Actualités de l'école"
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 sygenop-fade">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={GraduationCap} label="Élèves inscrits" value={stats.total} sub={`${stats.garcons} garçons · ${stats.filles} filles`} tone="green" />
        <StatCard icon={School} label="Classes actives" value={`${stats.activeClasses} / ${stats.totalClasses}`} sub="avec élèves inscrits" tone="gold" />
        <StatCard icon={Users} label="Personnel" value={stats.personnelTotal} sub={`${stats.personnelMale} hommes · ${stats.personnelFemale} femmes${stats.personnelUnknown ? ` · ${stats.personnelUnknown} non renseigné(s)` : ''}`} tone="green" />
        <StatCard icon={CheckCircle2} label="Niveaux couverts" value={stats.byLevel.filter((l) => l.effectif > 0).length + ' / ' + stats.byLevel.length} sub={cycleLabel(state.header?.cycle)} tone="gold" />
      </div>
      <div className="sygenop-card p-5">
        <div className="font-bold text-sm mb-3 flex items-center gap-2 text-ink"><Package size={16} /> Matériel de l’école</div>
        {visibleAssignments.length ? <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-sm">{visibleAssignments.map((a) => <div key={a.id} className="rounded-lg px-3 py-2 bg-bg"><b>{(state.materiel || []).find((m) => m.id === a.materielId)?.nom || 'Matériel'}</b> — {a.quantite} unité(s) <span className="text-muted">· {(state.classes || {})[a.classId]?.name}</span></div>)}</div> : <div className="text-sm text-muted">Aucun matériel n’est encore affecté aux classes.</div>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="sygenop-card p-5 lg:col-span-2">
          <div className="font-bold text-sm mb-4 text-ink">Effectifs par niveau</div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={stats.byLevel}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
              <XAxis dataKey="niveau" tick={{ fontSize: 12, fill: 'var(--muted)' }} />
              <YAxis tick={{ fontSize: 12, fill: 'var(--muted)' }} />
              <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
              <Bar dataKey="effectif" fill="#0a1e3d" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="sygenop-card p-5">
          <div className="font-bold text-sm mb-4 text-ink">Répartition par genre</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={genderData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
                {genderData.map((_, i) => <Cell key={i} fill={GENDER_COLORS[i]} />)}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex justify-center gap-4 text-xs mt-2">
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: GENDER_COLORS[0] }} /> Garçons</span>
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: GENDER_COLORS[1] }} /> Filles</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="sygenop-card p-5">
          <div className="font-bold text-sm mb-4 text-ink">Personnel — Répartition Homme / Femme</div>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={personnelGenderData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
                {personnelGenderData.map((_, i) => <Cell key={i} fill={PERSONNEL_GENDER_COLORS[i]} />)}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex justify-center gap-4 text-xs mt-2">
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: PERSONNEL_GENDER_COLORS[0] }} /> Hommes</span>
            <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: PERSONNEL_GENDER_COLORS[1] }} /> Femmes</span>
            {stats.personnelUnknown > 0 && <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: PERSONNEL_GENDER_COLORS[2] }} /> Non renseigné</span>}
          </div>
          <div className="text-xs text-center mt-2 text-muted">Hommes : {stats.personnelMale} · Femmes : {stats.personnelFemale}{stats.personnelUnknown ? ` · Non renseigné : ${stats.personnelUnknown}` : ''}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="sygenop-card p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-bold text-sm flex items-center gap-2 text-ink">
              <Clock size={16} /> Présences du personnel
            </div>
            <input
              type="month"
              value={presMois}
              onChange={(e) => setPresMois(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border text-xs sygenop-input"
            />
          </div>
          {presence && presence.personnelTotal > 0 ? (
            <>
              <div className="flex items-end gap-2">
                <span className="text-3xl font-extrabold" style={{ color: 'var(--green-d)' }}>{presence.tauxExecution == null ? '—' : `${Math.round(presence.tauxExecution * 100)}%`}</span>
                <span className="text-xs mb-1 text-muted">score d’exécution des heures — {monthLabelFr(presMois)}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span>{stats.personnelTotal} agent(s) au total</span>
                <span>Moyenne des agents : {presence.moyenneHeures.toFixed(1)} h</span>
                <span>Objectif par agent : {presence.heuresPrevuesParAgent} h</span>
                <span>{presence.totalHeures} h servies / {presence.heuresPrevues} h attendues</span>
                <span>{presence.joursPresents} / {presence.joursPointes} pointages présents</span>
              </div>
            </>
          ) : (
            <div className="text-sm py-4 text-muted">Ajoutez des agents pour calculer le score mensuel de l’école.</div>
          )}
        </div>

        <div className="sygenop-card p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-bold text-sm flex items-center gap-2 text-ink">
              <Trophy size={16} /> Score de la période
            </div>
            <div className="flex gap-1 p-1 rounded-lg bg-bg">
              {schoolPeriods.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setNotePeriod(t.key)}
                  className="px-2.5 py-1 rounded-md text-xs font-semibold transition-colors"
                  style={notePeriod === t.key ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
                >
                  {t.key}
                </button>
              ))}
            </div>
          </div>
          {academic && academic.effectifNote > 0 ? (
            <>
              <div className="flex items-end gap-2">
                <span className="text-3xl font-extrabold" style={{ color: 'var(--gold)' }}>{fmtNote(academic.moyenne)}{supportsWeightedAssessments(state) ? '/20' : '/10'}</span>
                <span className="text-xs mb-1 text-muted">moyenne générale — {periodLabel(state, notePeriod)}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span>{fmtPctVal(academic.tauxReussite)} de taux de réussite</span>
                <span>{academic.effectifNote} élève(s) noté(s)</span>
              </div>
            </>
          ) : (
            <div className="text-sm py-4 text-muted">Aucune note saisie pour cette période.</div>
          )}
        </div>
      </div>

      <ActualitesPanel
        actualites={state.actualites}
        onAdd={(role === 'school' || role === 'admin') && updateState
          ? (payload) => { updateState((prev) => addActualite(prev, payload)); notify && notify('Actualité publiée'); }
          : null}
        onDelete={(role === 'school' || role === 'admin') && updateState
          ? (id) => { updateState((prev) => removeActualite(prev, id)); notify && notify('Actualité supprimée'); }
          : null}
        authorName={authorName}
        limit={4}
        title={`Actualités — ${state.header?.ecole || 'l\u2019école'}`}
      />
    </div>
  );
}

/* ============================================================
   PERSONNEL + POINTAGE
   ============================================================ */
function Pill({ tone = 'muted', children }) {
  const toneMap = {
    green: { bg: 'var(--green-l)', fg: 'var(--green-d)' },
    gold: { bg: 'var(--gold-l)', fg: 'var(--gold)' },
    red: { bg: 'var(--red-l)', fg: 'var(--red)' },
    muted: { bg: 'var(--bg)', fg: 'var(--muted)' },
  };
  const t = toneMap[tone] || toneMap.muted;
  return (
    <span className="text-[11px] font-bold px-2 py-0.5 rounded-full inline-block" style={{ background: t.bg, color: t.fg }}>
      {children}
    </span>
  );
}

function ConfirmModal({ title, message, onConfirm, onCancel, danger }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="sygenop-card p-6 max-w-sm w-full sygenop-fade">
        <div className="font-bold mb-2 text-ink">{title}</div>
        <p className="text-sm mb-5 text-muted">{message}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button
            onClick={onConfirm}
            className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white"
            style={{ background: danger ? 'var(--red)' : 'var(--green-d)' }}
          >
            Confirmer
          </button>
        </div>
      </div>
    </div>
  );
}

function PersonnelModal({ person, onSave, onClose, cycle }) {
  const [form, setForm] = useState(() => person || {
    id: uid('staff'), prenom: '', nom: '', role: STAFF_ROLES[1], telephone: '', salaireBase: '', dateEmbauche: todayISO(), statut: 'Actif', code: generateAccessCode(), genre: 'Homme', specialites: [],
  });
  const [showCode, setShowCode] = useState(true);
  const isEdit = !!person;

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function submit(e) {
    e.preventDefault();
    if (!form.nom.trim() && !form.prenom.trim()) return;
    const accessCode = STAFF_LOGIN_ROLES.has(form.role)
      ? (String(form.code || '').trim().toUpperCase() || generateAccessCode())
      : (form.code || '');
    const applySpecialites = ['moyen', 'secondaire'].includes(cycle) && form.role === 'Enseignant(e)';
    onSave({
      ...form,
      prenom: form.prenom.trim(),
      nom: form.nom.trim(),
      role: form.role,
      code: accessCode,
      specialites: applySpecialites ? (form.specialites || []) : [],
    });
  }

return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card w-full max-w-lg max-h-[92vh] flex flex-col overflow-hidden sygenop-fade">
        <div className="flex items-center justify-between gap-3 px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--modal-line)' }}>
          <div>
            <div className="font-bold text-[15px] text-ink">{isEdit ? 'Modifier le membre du personnel' : 'Ajouter un membre du personnel'}</div>
            <div className="text-[11px] text-muted">{isEdit ? 'Mise à jour de la fiche agent' : 'Création dʼune nouvelle fiche agent'}</div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--muted)', background: 'var(--bg)' }}><X size={17} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3 overscroll-contain">
          <div className="flex items-center gap-2">
            <span className="w-1 h-3.5 rounded-full" style={{ background: 'var(--green-d)' }} />
            <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--green-d)' }}>Identité</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Prénom(s) *</label>
              <input
                autoFocus
                value={form.prenom}
                onChange={(e) => set('prenom', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm sygenop-input"
                placeholder="Ex : Aïssatou"
              />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Nom *</label>
              <input
                value={form.nom}
                onChange={(e) => set('nom', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm sygenop-input"
                placeholder="Ex : Diop"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Genre</label>
              <select
                value={form.genre}
                onChange={(e) => set('genre', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm sygenop-input"
              >
                {[{ value: 'Homme', label: 'Homme' }, { value: 'Femme', label: 'Femme' }].map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Fonction</label>
              <select
                value={form.role}
                onChange={(e) => set('role', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm sygenop-input"
              >
                {STAFF_ROLES.map((r) => <option key={r} value={r}>{displayStaffRole(r, cycle)}</option>)}
              </select>
            </div>
          </div>
          {['moyen', 'secondaire'].includes(cycle) && form.role === 'Enseignant(e)' && (
            <div className="rounded-xl p-3" style={{ border: '1px solid var(--line)', background: 'var(--bg)' }}>
              <label className="text-xs font-semibold block mb-1.5 text-muted">
                Spécialités enseignées {form.specialites?.length ? `(${form.specialites.length})` : ''}
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                {specialitesForCycle(cycle).map((matiere) => {
                  const checked = (form.specialites || []).includes(matiere);
                  return (
                    <label key={matiere} className="flex items-center gap-1.5 text-xs cursor-pointer text-ink">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const current = form.specialites || [];
                          const next = e.target.checked
                            ? [...current, matiere]
                            : current.filter((m) => m !== matiere);
                          set('specialites', next);
                        }}
                      />
                      {matiere}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-3" style={{ borderTop: '1px dashed var(--line)' }}>
            <span className="w-1 h-3.5 rounded-full" style={{ background: 'var(--gold)' }} />
            <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--gold)' }}>Informations</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Statut</label>
              <select
                value={form.statut}
                onChange={(e) => set('statut', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm sygenop-input"
              >
                {['Actif', 'Congé', 'Suspendu', 'Absent'].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Téléphone</label>
              <input
                value={form.telephone}
                onChange={(e) => set('telephone', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm sygenop-input"
                placeholder="77 000 00 00"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Salaire de base (FCFA)</label>
              <input
                type="number" min="0" step="1000"
                value={form.salaireBase}
                onChange={(e) => set('salaireBase', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm sygenop-input"
                placeholder="0"
              />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Date d'embauche</label>
              <input
                type="date"
                value={form.dateEmbauche}
                onChange={(e) => set('dateEmbauche', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm sygenop-input"
              />
            </div>
          </div>
          {STAFF_LOGIN_ROLES.has(form.role) && (
            <div className="rounded-xl p-3.5" style={{ background: 'var(--green-l)', border: '1px solid rgba(10,30,61,.25)' }}>
              <div className="flex items-center gap-2 pt-1 pb-2">
                <span className="w-1 h-3.5 rounded-full" style={{ background: 'var(--green-d)' }} />
                <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--green-d)' }}>Accès personnel</span>
              </div>
              <label className="text-xs font-semibold block mb-1" style={{ color: 'var(--green-d)' }}>
                Code d'accès
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--green-d)' }} />
                  <input
                    type={showCode ? 'text' : 'password'}
                    value={form.code}
                    onChange={(e) => set('code', e.target.value.toUpperCase())}
                    className="w-full pl-9 pr-3 py-2 rounded-lg border text-sm font-mono tracking-widest sygenop-input"
                  />
                  <button type="button" onClick={() => setShowCode((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
                    {showCode ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => set('code', generateAccessCode())}
                  className="px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap sygenop-btn sygenop-btn--ghost"
                >
                  Générer
                </button>
              </div>
              <p className="text-[11px] mt-1.5" style={{ color: 'var(--green-d)' }}>
                Ce code permettra à ce membre du personnel d'ouvrir son espace selon les droits de son rôle. À lui communiquer confidentiellement.
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 flex-shrink-0" style={{ borderTop: '1px solid var(--modal-line)' }}>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button type="submit" className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors" style={{ background: 'var(--green-d)' }}>
            {isEdit ? <><Save size={14} className="inline -mt-0.5 mr-1" /> Enregistrer</> : <><Plus size={14} className="inline -mt-0.5 mr-1" /> Ajouter</>}
          </button>
        </div>
      </form>
    </div>
  );
}

function ClassModal({ cls, level, personnel, materiel = [], affectations = [], cfg, onSave, onClose }) {
  const [form, setForm] = useState(() => cls || { name: '', teacher: '', matieres: [] });
  const isEdit = !!cls;
  const cycle = cycleForLevel(level);
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  // Matières configurées pour ce niveau (barème effectif de l'école — public
  // ou personnalisé via Administration > Barème), tous domaines confondus.
  const matieresConfigurees = useMemo(() => {
    if (!['moyen', 'secondaire'].includes(cycle)) return [];
    const labels = (cfg?.domains || []).flatMap((d) => (d.disciplines || []).map((x) => x.label));
    return [...new Set(labels)];
  }, [cfg, cycle]);

  const selectedProf = form.teacher ? (personnel || []).find((p) => personFullName(p) === form.teacher) : null;

  // Spécialités du professeur choisi qui correspondent à une matière
  // effectivement configurée dans cette classe : seules celles-ci sont
  // proposées à la coche, pour éviter d'affecter un professeur à une
  // matière qui n'existe pas dans le barème de la classe.
  const matieresDisponibles = useMemo(() => {
    if (!selectedProf) return [];
    const specialites = selectedProf.specialites || [];
    return matieresConfigurees.filter((m) => specialites.includes(m));
  }, [selectedProf, matieresConfigurees]);

  // Quand le professeur change, on réinitialise les matières cochées sur
  // celles disponibles pour ce nouveau professeur (l'utilisateur peut
  // ensuite décocher celles qu'il ne tient pas dans cette classe).
  const prevTeacherRef = useRef(form.teacher);
  useEffect(() => {
    if (prevTeacherRef.current === form.teacher) return;
    prevTeacherRef.current = form.teacher;
    set('matieres', matieresDisponibles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.teacher, matieresDisponibles.join('|')]);

  function toggleMatiere(matiere) {
    setForm((f) => {
      const current = f.matieres || [];
      const next = current.includes(matiere) ? current.filter((m) => m !== matiere) : [...current, matiere];
      return { ...f, matieres: next };
    });
  }

  // Enseignants supplémentaires (élémentaire uniquement) : tout le personnel
  // « Enseignant(e) » sauf le titulaire déjà choisi.
  const multiTeachers = supportsMultiTeachers(level);
  const coTeacherCandidates = useMemo(
    () => (personnel || []).filter((p) => p.role === 'Enseignant(e)' && personFullName(p) !== form.teacher),
    [personnel, form.teacher]
  );
  function toggleCoTeacher(name) {
    setForm((f) => {
      const current = Array.isArray(f.coTeachers) ? f.coTeachers : [];
      return { ...f, coTeachers: current.includes(name) ? current.filter((n) => n !== name) : [...current, name] };
    });
  }

  function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    const coTeachers = multiTeachers
      ? [...new Set((Array.isArray(form.coTeachers) ? form.coTeachers : []).filter((n) => n && n !== form.teacher))]
      : [];
    onSave({ ...form, coTeachers });
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card p-6 max-w-sm w-full sygenop-fade">
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-ink">{isEdit ? 'Modifier la classe' : `Ajouter une classe (${level})`}</div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Nom de la classe *</label>
            <input
              autoFocus
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border text-sm sygenop-input"
              placeholder={`Ex : ${level} A`}
            />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">{multiTeachers ? `${cycleTerminology(cycle).teacher} titulaire` : cycleTerminology(cycle).teacher}</label>
            <select
              value={form.teacher || ''}
              onChange={(e) => set('teacher', e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border text-sm sygenop-input"
            >
              <option value="">— Aucun —</option>
              {(personnel || []).map((p) => <option key={p.id} value={personFullName(p)}>{personFullName(p)}</option>)}
            </select>
          </div>
          {multiTeachers && (
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}>
              <div className="text-xs font-semibold text-ink">Autres enseignants de cette classe</div>
              <p className="text-[11px] mt-1 text-muted">
                Ils voient et saisissent les élèves, notes et présences de la classe au même titre que le titulaire.
              </p>
              {coTeacherCandidates.length ? (
                <div className="flex flex-col gap-2 mt-2.5 max-h-40 overflow-y-auto">
                  {coTeacherCandidates.map((p) => {
                    const name = personFullName(p);
                    const checked = (form.coTeachers || []).includes(name);
                    return (
                      <label key={p.id} className="flex items-center gap-1.5 text-sm cursor-pointer text-ink">
                        <input type="checkbox" checked={checked} onChange={() => toggleCoTeacher(name)} className="rounded" style={{ accentColor: 'var(--green-d)' }} />
                        {name}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[11px] mt-2 text-muted">Aucun autre enseignant disponible. Ajoutez-les d'abord dans Personnel.</p>
              )}
            </div>
          )}
          {selectedProf && ['moyen', 'secondaire'].includes(cycle) && (
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}>
              <div className="text-xs font-semibold text-ink">Matière(s) tenue(s) par ce professeur dans {level}</div>
              <p className="text-[11px] mt-1 text-muted">
                Seules les spécialités présentes dans les matières configurées de cette classe sont proposées.
              </p>
              {matieresDisponibles.length ? (
                <div className="flex flex-wrap gap-x-4 gap-y-2 mt-2.5">
                  {matieresDisponibles.map((matiere) => {
                    const checked = (form.matieres || []).includes(matiere);
                    return (
                      <label key={matiere} className="flex items-center gap-1.5 text-sm cursor-pointer text-ink">
                        <input type="checkbox" checked={checked} onChange={() => toggleMatiere(matiere)} className="rounded" style={{ accentColor: 'var(--green-d)' }} />
                        {matiere}
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[11px] mt-2" style={{ color: 'var(--red)' }}>
                  Aucune spécialité de {personFullName(selectedProf)} ne correspond aux matières configurées pour {level}. Vérifiez ses spécialités dans Personnel, ou le barème dans Administration.
                </p>
              )}
            </div>
          )}
          <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}>
            <div className="text-xs font-semibold text-muted">Matériel affecté à cette classe</div>
            {cls ? (() => {
              const rows = affectations.filter((a) => a.classId === cls.id);
              return rows.length ? <ul className="mt-2 space-y-1 text-sm">{rows.map((a) => <li key={a.id}>{materiel.find((m) => m.id === a.materielId)?.nom || 'Matériel'} <span className="text-muted">— {a.quantite} unité(s)</span></li>)}</ul> : <p className="mt-1 text-xs text-muted">Aucun matériel affecté. L'affectation se fait uniquement dans Comptabilité → Matériel.</p>;
            })() : <p className="mt-1 text-xs text-muted">Après la création, le comptable affectera le matériel dans Comptabilité → Matériel.</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button type="submit" className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--green-d)' }}>
            {isEdit ? 'Enregistrer' : 'Ajouter'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PersonnelListTab({ personnel, onAdd, onEdit, onDelete, onCard, onAttest, onProfile, readOnly, cycle }) {
  const [q, setQ] = useState('');
  const [revealed, setRevealed] = useState({});
  const filtered = personnel.filter((p) => {
    const full = personFullName(p).toLowerCase();
    const query = q.toLowerCase();
    return full.includes(query) || p.role.toLowerCase().includes(query);
  });
  return (
    <div className="space-y-4">
      <div className="sygenop-card p-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un nom ou une fonction…"
            className="w-full pl-9 pr-3 py-2.5 rounded-lg border text-sm"
            style={{ borderColor: 'var(--line)', background: 'var(--bg)', color: 'var(--ink)' }}
          />
        </div>
        {!readOnly && (
          <button
            onClick={onAdd}
            className="px-3.5 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 whitespace-nowrap"
            style={{ background: 'var(--green-d)' }}
          >
            <Plus size={16} /> Ajouter
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          {personnel.length === 0 ? 'Aucun membre du personnel enregistré pour le moment.' : 'Aucun résultat pour cette recherche.'}
        </div>
      ) : (
        <div className="sygenop-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ borderBottom: '1px solid var(--line)' }}>
                {['Nom', 'Fonction', 'Téléphone', 'Salaire de base', 'Statut', ''].map((h) => (
                  <th key={h} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td className="px-4 py-3">
                    <button type="button" onClick={() => onProfile(p)} className="flex items-center gap-3 text-left w-full hover:opacity-80" title="Voir la fiche">
                      <span style={{ lineHeight: 0 }}>
                        {isFemale(p.genre) ? <AvatarGirl size={36} /> : <AvatarBoy size={36} />}
                      </span>
                      <div>
                        <div className="font-semibold text-ink">{p.prenom || ''} {p.nom || ''}</div>
                        <div className="text-[11px] text-muted text-muted">
                          {p.genre || 'Homme'}
                        </div>
                        {STAFF_LOGIN_ROLES.has(p.role) && p.code && (
                          <div className="text-[11px] flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--green-d)' }}>
                            <KeyRound size={11} /> Code : <span className="font-mono font-semibold tracking-widest">{revealed[p.id] ? p.code : '••••••'}</span>
                            <button onClick={(e) => { e.stopPropagation(); setRevealed((r) => ({ ...r, [p.id]: !r[p.id] })); }} style={{ color: 'var(--muted)' }} title={revealed[p.id] ? 'Masquer le code' : 'Afficher le code'}>{revealed[p.id] ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                            <button onClick={(e) => { e.stopPropagation(); copyToClipboard(p.code, () => {}); }} style={{ color: 'var(--muted)' }} title="Copier le code"><FileSpreadsheet size={12} /></button>
                          </div>
                        )}
                      </div>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {displayStaffRole(p.role, cycle)}
                    {p.specialites?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {p.specialites.map((matiere) => (
                          <span key={matiere} className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>{matiere}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted">{p.telephone || '—'}</td>
                  <td className="px-4 py-3 text-ink">{fmtFCFA(p.salaireBase)}</td>
                  <td className="px-4 py-3">
                    <Pill tone={p.statut === 'Actif' ? 'green' : p.statut === 'Absent' ? 'red' : 'gold'}>{p.statut}</Pill>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => onProfile(p)} className="p-1.5 rounded-lg hover:bg-black/5" style={{ color: 'var(--green-d)' }} title="Fiche du personnel">
                        <UserRound size={15} />
                      </button>
                      {!readOnly && (
                        <>
                          <button onClick={() => onEdit(p)} className="p-1.5 rounded-lg hover:bg-black/5 text-muted" title="Modifier">
                            <Pencil size={15} />
                          </button>
                          <button onClick={() => onDelete(p)} className="p-1.5 rounded-lg hover:bg-black/5" style={{ color: 'var(--red)' }} title="Supprimer">
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PointageTab({ personnel, pointage, onSetStatut, onSetHeures, readOnly, settings, cycle }) {
  const [date, setDate] = useState(todayISO());
  const blockedReason = nonWorkingDayReason(date, settings);
  const heuresPrevuesJour = heuresAttenduesDate(date, settings);
  const heuresPrevuesMois = heuresAttenduesMois(date.slice(0, 7), settings);
  const counts = { P: 0, A: 0, R: 0, C: 0 };
  let heuresJour = 0;
  personnel.forEach((p) => {
    const rec = getPointageRecord(pointage, date, p.id);
    if (rec) {
      counts[rec.statut] = (counts[rec.statut] || 0) + 1;
      heuresJour += Number(rec.heures) || 0;
    }
  });

  return (
    <div className="space-y-6">
      <div className="sygenop-card p-4 flex flex-wrap items-center gap-3">
        <button onClick={() => setDate((d) => shiftDay(d, -1))} className="p-2 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
          <ChevronLeft size={16} />
        </button>
        <div className="flex items-center gap-2">
          <CalendarDays size={16} style={{ color: 'var(--muted)' }} />
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="px-3 py-2 rounded-lg border text-sm sygenop-input"
          />
        </div>
        <button onClick={() => setDate((d) => shiftDay(d, 1))} className="p-2 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
          <ChevronRight size={16} />
        </button>
        <button onClick={() => setDate(todayISO())} className="text-xs font-semibold px-2.5 py-2 rounded-lg" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
          Aujourd'hui
        </button>
        <div className="ml-auto flex flex-wrap gap-2 text-xs">
          {Object.entries(POINTAGE_STATUTS).map(([k, v]) => (
            <span key={k} className="flex items-center gap-1 font-semibold text-muted">
              <Pill tone={v.tone}>{v.short}</Pill> {v.label} : {counts[k]}
            </span>
          ))}
          <span className="flex items-center gap-1 font-semibold text-muted">
            <Clock size={13} /> {heuresJour} h servies ce jour
          </span>
          <span className="flex items-center gap-1 font-semibold" style={{ color: 'var(--gold)' }}>
            Objectif : {heuresPrevuesJour} h/jour · {heuresPrevuesMois} h/mois/agent
          </span>
        </div>
      </div>
      <div className="text-xs font-medium capitalize px-1 -mt-2 text-muted">{fmtDateFr(date)}</div>
      {blockedReason && <div className="rounded-xl px-4 py-3 text-sm font-semibold" style={{ background: '#fff5e8', color: '#8a5a14' }}>{blockedReason} : le pointage est fermé pour cette date.</div>}

      {personnel.length === 0 ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          Ajoutez d'abord des membres du personnel dans l'onglet « Liste » pour pouvoir effectuer le pointage.
        </div>
      ) : (
        <div className="sygenop-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ borderBottom: '1px solid var(--line)' }}>
                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">Nom</th>
                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">Fonction</th>
                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">Pointage</th>
                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">Heures servies / objectif</th>
              </tr>
            </thead>
            <tbody>
              {personnel.map((p) => {
                const rec = getPointageRecord(pointage, date, p.id);
                const current = rec?.statut || null;
                const heuresActives = current === 'P' || current === 'R';
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td className="px-4 py-3 font-semibold text-ink">{personFullName(p) || p.nom}</td>
                    <td className="px-4 py-3 text-muted">{displayStaffRole(p.role, cycle)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1.5">
                        {Object.entries(POINTAGE_STATUTS).map(([k, v]) => {
                          const active = current === k;
                          const toneMap = {
                            green: { bg: 'var(--green-d)', bgOff: 'var(--green-l)', fg: 'var(--green-d)' },
                            red: { bg: 'var(--red)', bgOff: 'var(--red-l)', fg: 'var(--red)' },
                            gold: { bg: 'var(--gold)', bgOff: 'var(--gold-l)', fg: 'var(--gold)' },
                            muted: { bg: 'var(--muted)', bgOff: 'var(--bg)', fg: 'var(--muted)' },
                          }[v.tone];
                          return (
                            <button
                              key={k}
                              onClick={() => !readOnly && !blockedReason && onSetStatut(date, p.id, active ? null : k)}
                              disabled={readOnly || !!blockedReason}
                              title={v.label}
                              className="w-8 h-8 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              style={active ? { background: toneMap.bg, color: '#fff' } : { background: toneMap.bgOff, color: toneMap.fg }}
                            >
                              {v.short}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number" min="0" max="24" step="0.5"
                          disabled={!heuresActives || readOnly || !!blockedReason}
                          value={heuresActives ? (rec?.heures ?? heuresPrevuesJour) : 0}
                          onChange={(e) => onSetHeures(date, p.id, e.target.value)}
                          className="w-20 px-2.5 py-1.5 rounded-lg border text-sm disabled:opacity-40 sygenop-input"
                        />
                        <span className="text-xs text-muted">h</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <HeuresRecapPanel personnel={personnel} pointage={pointage} defaultMois={date.slice(0, 7)} settings={settings} />
    </div>
  );
}

/* Tableau récapitulatif mensuel des heures pointées + moyenne de l'école */
function HeuresRecapPanel({ personnel, pointage, defaultMois, settings }) {
  const [mois, setMois] = useState(defaultMois || currentMonthISO());
  const joursDuMoisArr = joursDuMois(mois);
  const heuresPrevuesParAgent = heuresAttenduesMois(mois, settings);

  const rows = useMemo(() => {
    return personnel.map((p) => {
      let heures = 0, joursPresence = 0;
      joursDuMoisArr.forEach((iso) => {
        const rec = getPointageRecord(pointage, iso, p.id);
        if (rec && (rec.statut === 'P' || rec.statut === 'R')) {
          heures += Number(rec.heures) || 0;
          joursPresence += 1;
        }
      });
      const moyenneJour = joursPresence > 0 ? heures / joursPresence : 0;
      const execution = heuresPrevuesParAgent > 0 ? heures / heuresPrevuesParAgent : 0;
      return { ...p, heures, joursPresence, moyenneJour, execution };
    });
  }, [personnel, pointage, mois, heuresPrevuesParAgent]);

  const totalHeuresEcole = rows.reduce((s, r) => s + r.heures, 0);
  const moyenneMensuelleEcole = personnel.length > 0 ? totalHeuresEcole / personnel.length : 0;

  return (
    <div className="sygenop-card p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="font-bold text-sm flex items-center gap-2 text-ink">
          <Clock size={16} /> Récapitulatif mensuel des heures
        </div>
        <div className="flex items-center gap-1.5 ml-1">
          <button onClick={() => setMois((m) => shiftMonth(m, -1))} className="p-1.5 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
            <ChevronLeft size={14} />
          </button>
          <input
            type="month"
            value={mois}
            onChange={(e) => setMois(e.target.value)}
            className="px-2.5 py-1.5 rounded-lg border text-xs sygenop-input"
          />
          <button onClick={() => setMois((m) => shiftMonth(m, 1))} className="p-1.5 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
            <ChevronRight size={14} />
          </button>
        </div>
        <span className="text-xs font-semibold capitalize text-muted">{monthLabelFr(mois)}</span>
        <div className="ml-auto flex items-center gap-2">
          <Pill tone="green">Moyenne mensuelle de l'école : {moyenneMensuelleEcole.toFixed(1)} h / agent</Pill>
          <Pill tone="gold">Objectif individuel : {heuresPrevuesParAgent} h</Pill>
        </div>
      </div>

      {personnel.length === 0 ? (
        <div className="text-center text-sm py-8 text-muted">
          Aucun membre du personnel à récapituler.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ borderBottom: '1px solid var(--line)' }}>
                {['Nom', 'Fonction', 'Jours pointés', 'Total heures servies', 'Objectif individuel', 'Exécution', 'Moyenne h / jour'].map((h) => (
                  <th key={h} className="px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td className="px-4 py-2.5 font-semibold whitespace-nowrap text-ink">{personFullName(r) || r.nom}</td>
                  <td className="px-4 py-2.5 text-muted">{r.role}</td>
                  <td className="px-4 py-2.5"><Pill tone="green">{r.joursPresence}</Pill></td>
                  <td className="px-4 py-2.5 font-bold text-ink">{r.heures} h</td>
                  <td className="px-4 py-2.5 text-muted">{heuresPrevuesParAgent} h</td>
                  <td className="px-4 py-2.5"><Pill tone={r.execution >= 1 ? 'green' : 'gold'}>{Math.round(r.execution * 100)}%</Pill></td>
                  <td className="px-4 py-2.5 text-muted">{r.moyenneJour.toFixed(1)} h</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="px-4 py-2.5 font-bold text-ink">École (objectif cumulé)</td>
                <td></td>
                <td className="px-4 py-2.5 font-bold text-ink">{rows.reduce((s, r) => s + r.joursPresence, 0)}</td>
                <td className="px-4 py-2.5 font-bold" style={{ color: 'var(--green-d)' }}>{totalHeuresEcole} h</td>
                <td className="px-4 py-2.5 font-bold" style={{ color: 'var(--gold)' }}>{heuresPrevuesParAgent * personnel.length} h</td>
                <td className="px-4 py-2.5 font-bold" style={{ color: 'var(--green-d)' }}>{heuresPrevuesParAgent > 0 && personnel.length > 0 ? Math.round((totalHeuresEcole / (heuresPrevuesParAgent * personnel.length)) * 100) : 0}%</td>
                <td className="px-4 py-2.5 font-bold" style={{ color: 'var(--green-d)' }}>{moyenneMensuelleEcole.toFixed(1)} h</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">
        L’objectif individuel est calculé uniquement sur les jours ouvrés du mois, hors jours fériés et non ouvrés. L’objectif cumulé de l’école est cet objectif multiplié par le nombre d’agents.
      </p>
    </div>
  );
}

function PaieTab({ personnel, pointage, state, updateState, readOnly }) {
  const [mois, setMois] = useState(currentMonthISO());
  const horaires = attendanceSettings(state);
  const joursOuvres = joursOuvresDuMois(mois, horaires.joursOuvres);
  const joursDuMoisArr = joursDuMois(mois);
  const isPrivateSchool = String(state?.header?.type || state?.type || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('privee');
  const retenuesManuelles = state?.retenuesPaie?.[mois] || {};

  const rows = useMemo(() => {
    return personnel.map((p) => {
      let present = 0, absent = 0, retard = 0, conge = 0, heures = 0;
      joursDuMoisArr.forEach((iso) => {
        const rec = getPointageRecord(pointage, iso, p.id);
        const s = rec?.statut;
        if (s === 'P') present++;
        else if (s === 'A') absent++;
        else if (s === 'R') retard++;
        else if (s === 'C') conge++;
        if (rec && (s === 'P' || s === 'R')) heures += Number(rec.heures) || 0;
      });
      const tauxJournalier = joursOuvres > 0 ? p.salaireBase / joursOuvres : 0;
      const retenueCalculee = Math.round(absent * tauxJournalier + retard * tauxJournalier * 0.25);
      const retenue = isPrivateSchool && absent > 0
        ? (retenuesManuelles[p.id] != null ? Math.max(0, Number(retenuesManuelles[p.id]) || 0) : null)
        : retenueCalculee;
      const net = Math.max(0, Math.round(p.salaireBase - (retenue || 0)));
      return { ...p, present, absent, retard, conge, heures, tauxJournalier, retenue, retenueCalculee, net };
    });
  }, [personnel, pointage, mois, joursOuvres, isPrivateSchool, retenuesManuelles]);

  const totalBase = rows.reduce((s, r) => s + (Number(r.salaireBase) || 0), 0);
  const totalRetenue = rows.reduce((s, r) => s + (r.retenue || 0), 0);
  const totalNet = rows.reduce((s, r) => s + r.net, 0);

  function exportCSV() {
    const header = ['Nom', 'Prénom(s)', 'Fonction', 'Salaire de base', 'Jours présents', 'Jours absents', 'Retards', 'Congés', 'Heures servies', 'Retenue', 'Salaire net'];
    const data = rows.map((r) => [r.nom, r.prenom, r.role, r.salaireBase, r.present, r.absent, r.retard, r.conge, r.heures, r.retenue, r.net]);
    data.push(['TOTAL', '', '', totalBase, '', '', '', '', '', totalRetenue, totalNet]);
    downloadCSV(`paie_${mois}.csv`, [header, ...data]);
  }

  function setRetenueManuelle(staffId, value) {
    if (readOnly || !isPrivateSchool) return;
    updateState((prev) => {
      const all = { ...(prev.retenuesPaie || {}) };
      const month = { ...(all[mois] || {}) };
      const amount = Math.max(0, Number(value) || 0);
      month[staffId] = amount;
      all[mois] = month;
      return { ...prev, retenuesPaie: all };
    });
  }

  return (
    <div className="space-y-4">
      <div className="sygenop-card p-4 flex flex-wrap items-center gap-3">
        <button onClick={() => setMois((m) => shiftMonth(m, -1))} className="p-2 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
          <ChevronLeft size={16} />
        </button>
        <input
          type="month"
          value={mois}
          onChange={(e) => setMois(e.target.value)}
          className="px-3 py-2 rounded-lg border text-sm sygenop-input"
        />
        <button onClick={() => setMois((m) => shiftMonth(m, 1))} className="p-2 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
          <ChevronRight size={16} />
        </button>
        <span className="text-xs font-semibold capitalize text-muted">{monthLabelFr(mois)} · {joursOuvres} jours ouvrés ({libelleJoursOuvres(horaires.joursOuvres)})</span>
        <button
          onClick={exportCSV}
          className="ml-auto px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5"
          style={{ background: 'var(--green-d)' }}
        >
          <Download size={15} /> Exporter CSV
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard icon={Wallet} label="Masse salariale (base)" value={fmtFCFA(totalBase)} tone="green" />
        <StatCard icon={AlertTriangle} label="Total retenues" value={fmtFCFA(totalRetenue)} tone="red" />
        <StatCard icon={CheckCircle2} label="Total net à payer" value={fmtFCFA(totalNet)} tone="gold" />
      </div>

      {isPrivateSchool && (
        <div className="sygenop-card px-4 py-3 text-xs" style={{ background: 'var(--gold-l)', color: 'var(--ink)' }}>
          <b>École privée :</b> lorsqu’un agent est absent sans justificatif, sa retenue est laissée vide et doit être renseignée manuellement ci-dessous.
        </div>
      )}

      {personnel.length === 0 ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          Aucun membre du personnel. Le calcul de la paie sera disponible une fois le personnel ajouté.
        </div>
      ) : (
        <div className="sygenop-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ borderBottom: '1px solid var(--line)' }}>
                {['Nom', 'Salaire de base', 'Présents', 'Absents', 'Retards', 'Congés', 'Heures', 'Retenue', 'Salaire net'].map((h) => (
                  <th key={h} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td className="px-4 py-3 font-semibold whitespace-nowrap text-ink">{personFullName(r) || r.nom}</td>
                  <td className="px-4 py-3 whitespace-nowrap text-muted">{fmtFCFA(r.salaireBase)}</td>
                  <td className="px-4 py-3"><Pill tone="green">{r.present}</Pill></td>
                  <td className="px-4 py-3"><Pill tone="red">{r.absent}</Pill></td>
                  <td className="px-4 py-3"><Pill tone="gold">{r.retard}</Pill></td>
                  <td className="px-4 py-3"><Pill tone="muted">{r.conge}</Pill></td>
                  <td className="px-4 py-3 whitespace-nowrap text-ink">{r.heures} h</td>
                  <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--red)' }}>
                    {isPrivateSchool && r.absent > 0 && !readOnly ? (
                      <input
                        type="number" min="0" step="1" value={r.retenue ?? ''}
                        onChange={(e) => setRetenueManuelle(r.id, e.target.value)}
                        title={`Calcul automatique : ${fmtFCFA(r.retenueCalculee)}`}
                        className="w-28 px-2 py-1 rounded border text-sm"
                        style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--red)' }}
                      />
                    ) : <>− {fmtFCFA(r.retenue || 0)}</>}
                  </td>
                  <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: 'var(--green-d)' }}>{fmtFCFA(r.net)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="px-4 py-3 font-bold text-ink">Total</td>
                <td className="px-4 py-3 font-bold text-ink">{fmtFCFA(totalBase)}</td>
                <td colSpan={5}></td>
                <td className="px-4 py-3 font-bold" style={{ color: 'var(--red)' }}>− {fmtFCFA(totalRetenue)}</td>
                <td className="px-4 py-3 font-bold" style={{ color: 'var(--green-d)' }}>{fmtFCFA(totalNet)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="text-xs px-1 text-muted">
        Calcul indicatif : taux journalier = salaire de base ÷ jours ouvrés du mois. Une absence retire un jour complet, un retard un quart de jour. {isPrivateSchool ? 'Les retenues peuvent être ajustées directement dans le tableau.' : 'Les jours fériés ne sont pas encore pris en compte.'}
      </p>
    </div>
  );
}

/* ============================================================
   TRANSFERT D'ÉLÈVE — demande enseignant / validation direction
   ============================================================ */
function StudentTransferRequestsPanel({ state, updateState, notify, mode, teacherName, teacherStaffId }) {
  const classes = state?.classes || {};
  const personnel = state?.personnel || [];
  const requests = Array.isArray(state?.studentTransferRequests) ? state.studentTransferRequests : [];
  const [sourceId, setSourceId] = useState('');
  const [studentId, setStudentId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');

  const teacherClasses = Object.entries(classes)
    .filter(([, cls]) => classHasTeacher(cls, teacherName) || cls.teacherId === teacherStaffId)
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
  const effectiveSourceId = sourceId || teacherClasses[0]?.[0] || '';
  const sourceClass = classes[effectiveSourceId] || null;
  const students = sourceClass?.students || [];
  const selectedStudent = students.find((student) => student.id === studentId) || null;
  const targetClasses = sourceClass
    ? Object.entries(classes)
      .filter(([id, cls]) => id !== effectiveSourceId && cls.level === sourceClass.level)
      .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''))
    : [];
  const myRequests = requests.filter((request) => request.fromTeacherId === teacherStaffId || request.fromTeacher === teacherName);
  const pendingRequests = requests.filter((request) => request.status === 'pending');

  function submitRequest(event) {
    event.preventDefault();
    const target = classes[targetId];
    if (!sourceClass || !selectedStudent || !target || sourceClass.level !== target.level || targetId === effectiveSourceId) {
      notify('Choisissez un élève et deux classes différentes du même niveau.', true);
      return;
    }
    const duplicate = requests.some((request) => request.status === 'pending' && request.studentId === selectedStudent.id);
    if (duplicate) {
      notify('Une demande de transfert est déjà en attente pour cet élève.', true);
      return;
    }
    const request = {
      id: uid('student-transfer'),
      status: 'pending',
      studentId: selectedStudent.id,
      studentName: personFullName(selectedStudent) || [selectedStudent.prenom || '', selectedStudent.nom || ''].join(' ').trim(),
      fromClassId: effectiveSourceId,
      fromClassName: sourceClass.name,
      fromLevel: sourceClass.level,
      fromTeacher: teacherName || sourceClass.teacher || '',
      fromTeacherId: sourceClass.teacherId || teacherStaffId || '',
      toClassId: targetId,
      toClassName: target.name,
      toLevel: target.level,
      toTeacher: target.teacher || '',
      toTeacherId: target.teacherId || (personnel.find((person) => personFullName(person) === target.teacher)?.id || ''),
      reason: reason.trim(),
      createdAt: new Date().toISOString(),
    };
    updateState((prev) => ({ ...prev, studentTransferRequests: [...(prev.studentTransferRequests || []), request] }));
    setStudentId('');
    setTargetId('');
    setReason('');
    notify('Demande de transfert envoyée à la direction. Aucun déplacement ne sera effectué avant validation.');
  }

  function decideRequest(request, decision) {
    if (request.status !== 'pending') return;
    const currentClasses = { ...(state.classes || {}) };
    const source = currentClasses[request.fromClassId];
    const target = currentClasses[request.toClassId];
    const student = source?.students?.find((item) => item.id === request.studentId);
    const sameLevel = source && target && source.level === target.level && source.level === request.fromLevel;
    if (!sameLevel || !student) {
      notify('Cette demande est devenue obsolète : la classe ou l’élève a changé.', true);
      return;
    }
    const maxStudents = state?.header?.max_students_per_class;
    if (decision === 'approved' && maxStudents && (target.students || []).length >= maxStudents) {
      notify('Transfert impossible : la classe cible a atteint sa limite de ' + maxStudents + ' élèves.', true);
      return;
    }
    updateState((prev) => {
      const nextClasses = { ...(prev.classes || {}) };
      const currentSource = nextClasses[request.fromClassId];
      const currentTarget = nextClasses[request.toClassId];
      const currentStudent = currentSource?.students?.find((item) => item.id === request.studentId);
      if (!currentSource || !currentTarget || !currentStudent || currentSource.level !== currentTarget.level) return prev;
      const nextRequests = (prev.studentTransferRequests || []).map((item) => item.id === request.id
        ? { ...item, status: decision, decidedAt: new Date().toISOString() }
        : item);
      if (decision === 'approved') {
        nextClasses[request.fromClassId] = { ...currentSource, students: (currentSource.students || []).filter((item) => item.id !== request.studentId) };
        nextClasses[request.toClassId] = { ...currentTarget, students: [...(currentTarget.students || []), currentStudent] };
      }
      const action = decision === 'approved' ? 'Validation d’un transfert d’élève' : 'Refus d’un transfert d’élève';
      const details = request.studentName + ' : ' + request.fromClassName + ' → ' + request.toClassName;
      return {
        ...prev,
        classes: nextClasses,
        studentTransferRequests: nextRequests,
        auditLog: pushAuditEntry(prev.auditLog, { actor: prev.header?.directeur || 'La direction', role: 'school', action, details }),
      };
    });
    notify(decision === 'approved' ? 'Transfert de l’élève validé et appliqué.' : 'Demande de transfert refusée.');
  }

  if (mode === 'teacher') {
    return (
      <div className="sygenop-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <RotateCcw size={16} style={{ color: 'var(--gold)' }} />
          <div>
            <div className="font-bold text-sm">Demander le transfert d’un élève</div>
            <p className="text-xs text-muted">Le transfert concerne deux classes du même niveau et reste soumis à la validation du directeur.</p>
          </div>
        </div>
        {!teacherClasses.length ? (
          <p className="text-xs text-muted">Aucune classe ne vous est actuellement affectée.</p>
        ) : (
          <form onSubmit={submitRequest} className="grid grid-cols-1 md:grid-cols-4 gap-2 items-end">
            <label className="text-xs font-semibold">Ma classe
              <select value={effectiveSourceId} onChange={(event) => { setSourceId(event.target.value); setStudentId(''); setTargetId(''); }} className="sygenop-input mt-1">
                {teacherClasses.map(([id, cls]) => <option key={id} value={id}>{cls.name} — {cls.level}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold">Élève à transférer
              <select value={studentId} onChange={(event) => setStudentId(event.target.value)} className="sygenop-input mt-1" required>
                <option value="">— Choisir —</option>
                {students.map((student) => <option key={student.id} value={student.id}>{student.prenom || ''} {student.nom || ''}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold">Classe cible
              <select value={targetId} onChange={(event) => setTargetId(event.target.value)} className="sygenop-input mt-1" required>
                <option value="">— Choisir —</option>
                {targetClasses.map(([id, cls]) => <option key={id} value={id}>{cls.name} — {classTeacherNames(cls).join(', ') || 'Enseignant non affecté'}</option>)}
              </select>
            </label>
            <button type="submit" className="sygenop-btn sygenop-btn--gold text-sm"><RotateCcw size={14} /> Soumettre</button>
            <input value={reason} onChange={(event) => setReason(event.target.value)} className="sygenop-input md:col-span-4" placeholder="Motif facultatif" maxLength={240} />
          </form>
        )}
        {myRequests.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-xs font-bold">Mes demandes de transfert</div>
            {myRequests.slice().reverse().map((request) => <StudentTransferStatus key={request.id} request={request} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="sygenop-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-bold text-sm">Demandes de transfert d’élèves</div>
          <p className="text-xs text-muted">Aucun élève n’est déplacé sans validation explicite de la direction.</p>
        </div>
        <Pill tone={pendingRequests.length ? 'gold' : 'green'}>{pendingRequests.length} en attente</Pill>
      </div>
      {pendingRequests.length === 0 ? <p className="text-sm text-muted">Aucune demande en attente.</p> : (
        <div className="space-y-2">
          {pendingRequests.map((request) => (
            <div key={request.id} className="rounded-lg border p-3 flex flex-col lg:flex-row lg:items-center gap-3" style={{ borderColor: 'var(--line)' }}>
              <div className="flex-1 text-sm">
                <div className="font-semibold">{request.studentName}</div>
                <div className="text-muted">{request.fromClassName} → {request.toClassName} · niveau {request.fromLevel}</div>
                {request.fromTeacher && <div className="text-xs">Enseignant demandeur : {request.fromTeacher}</div>}
                {request.reason && <div className="text-xs mt-1">Motif : {request.reason}</div>}
              </div>
              <div className="flex gap-2">
                <button onClick={() => decideRequest(request, 'approved')} className="sygenop-btn text-sm sygenop-btn"><CheckCircle2 size={14} /> Valider</button>
                <button onClick={() => decideRequest(request, 'rejected')} className="sygenop-btn sygenop-btn--danger text-sm"><X size={14} /> Refuser</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StudentTransferStatus({ request }) {
  const labels = { pending: 'En attente de validation', approved: 'Validée et appliquée', rejected: 'Refusée' };
  const tones = { pending: 'gold', approved: 'green', rejected: 'red' };
  return <div className="flex flex-wrap items-center gap-2 text-xs"><span>{request.studentName} : {request.fromClassName} → {request.toClassName}</span><Pill tone={tones[request.status] || 'muted'}>{labels[request.status] || request.status}</Pill></div>;
}

/* ============================================================
   AUTORISATION D'ABSENCE DU PERSONNEL
   Demande par un agent (motif + dates) ; validation par le
   directeur, le censeur/proviseur ou un directeur pédagogique.
   ============================================================ */
const ABSENCE_STATUS = {
  pending: { label: 'En attente de validation', tone: 'gold' },
  approved: { label: 'Validée', tone: 'green' },
  rejected: { label: 'Refusée', tone: 'red' },
};
const ABSENCE_MOTIFS = ['Maladie (avec justificatif)', 'Convocation administrative', 'Formation / stage', 'Deuil', 'Déplacement personnel', 'Autre (préciser dans le motif)'];
// Un membre de la direction (directeur, censeur/proviseur, directeur
// pédagogique, assistant pédagogique) peut valider les demandes d'absence.
function isAbsenceValidator(session, state) {
  if (!session || typeof session !== 'object') return false;
  if (['school', 'admin', 'ief'].includes(session.role)) return true;
  if (!session.staffId) return false;
  const person = ((state && state.personnel) || []).find((item) => item.id === session.staffId);
  if (!person) return false;
  return /directeur|directrice|censeur|proviseur|principal|pédagogique|pedagogique|assistant/i.test(person.role || '');
}
function StaffAbsencesView({ state, loading, updateState, notify, session, readOnly }) {
  const [motif, setMotif] = useState('');
  const [dateDebut, setDateDebut] = useState(todayISO());
  const [dateFin, setDateFin] = useState('');
  const [commentaire, setCommentaire] = useState('');
  const [noteDeco, setNoteDeco] = useState({});

  if (loading || !state) return <AppLoader />;

  const personnel = state.personnel || [];
  const me = session && session.staffId ? personnel.find((item) => item.id === session.staffId) : null;
  const requesterId = me ? me.id : (session && session.role === 'school' ? 'direction' : 'agent-session');
  const requesterLabel = me ? personFullName(me) : ((state.header && state.header.directeur) || 'La direction');
  const canValidate = isAbsenceValidator(session, state);
  const allRequests = Array.isArray(state.staffAbsenceRequests) ? state.staffAbsenceRequests : [];
  const myRequests = allRequests.filter((request) => request.requesterId === requesterId);
  const pendingRequests = allRequests.filter((request) => request.statut === 'pending');
  const handleDocument = (request, mode) => {
    if (mode === 'download') downloadAbsenceDocument(state, request, notify);
    else openAbsenceDocument(state, request, notify);
  };
  const finDate = dateFin || dateDebut;
  const nbJours = dateDebut && finDate ? Math.max(1, Math.round((new Date(finDate + 'T00:00:00').getTime() - new Date(dateDebut + 'T00:00:00').getTime()) / 86400000) + 1) : 0;

  function submitRequest(event) {
    event.preventDefault();
    if (readOnly) return;
    const motifClean = String(motif || '').trim();
    if (!motifClean) { notify('Indiquez le motif de l’absence.', true); return; }
    if (!dateDebut) { notify('Indiquez la date de début.', true); return; }
    const fin = dateFin || dateDebut;
    if (fin < dateDebut) { notify('La date de fin ne peut pas précéder la date de début.', true); return; }
    const request = {
      id: uid('absence'),
      requesterId,
      requesterLabel,
      motif: motifClean,
      dateDebut,
      dateFin: fin,
      commentaire: String(commentaire || '').trim(),
      statut: 'pending',
      createdAt: new Date().toISOString(),
    };
    updateState((prev) => ({
      ...prev,
      staffAbsenceRequests: [...(prev.staffAbsenceRequests || []), request],
      auditLog: pushAuditEntry(prev.auditLog, { actor: requesterLabel, role: (session && session.role) || '', action: 'Demande d’autorisation d’absence', details: `${motifClean} (${dateDebut}${fin ? ' → ' + fin : ''})` }),
    }));
    setMotif(''); setDateDebut(todayISO()); setDateFin(''); setCommentaire('');
    notify('Demande d’autorisation d’absence envoyée, en attente de validation.');
  }

  function decideRequest(request, decision) {
    if (readOnly || request.statut !== 'pending') return;
    const note = String(noteDeco[request.id] || '').trim();
    updateState((prev) => ({
      ...prev,
      staffAbsenceRequests: (prev.staffAbsenceRequests || []).map((item) => item.id === request.id
        ? { ...item, statut: decision, decisionNote: note, decidedBy: requesterLabel, decidedAt: new Date().toISOString() }
        : item),
      auditLog: pushAuditEntry(prev.auditLog, { actor: requesterLabel, role: (session && session.role) || '', action: decision === 'approved' ? 'Autorisation d’absence validée' : 'Autorisation d’absence refusée', details: `${request.requesterLabel} — ${request.motif} (${request.dateDebut}${request.dateFin ? ' → ' + request.dateFin : ''})` }),
    }));
    notify(decision === 'approved' ? 'Absence autorisée.' : 'Demande d’absence refusée.');
  }

  const decidedRequests = allRequests.filter((request) => request.statut !== 'pending').slice().reverse();

  return (
    <div className="space-y-4 sygenop-fade">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="sygenop-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CalendarX size={16} style={{ color: 'var(--gold)' }} />
            <div>
              <div className="font-bold text-sm">Demander une autorisation d’absence</div>
              <p className="text-xs text-muted">La demande est transmise à la direction (directeur, censeur ou proviseur) qui seule décide.</p>
            </div>
          </div>
          {readOnly ? (
            <p className="text-xs text-muted">Lecture seule : aucune demande ne peut être soumise.</p>
          ) : (
            <form onSubmit={submitRequest} className="space-y-3">
              <label className="block text-xs font-semibold">Motif de l'absence
                <input value={motif} onChange={(event) => setMotif(event.target.value)} className="sygenop-input mt-1" placeholder="Ex : maladie, convocation, deuil…" maxLength={160} />
              </label>
              <div className="flex flex-wrap gap-1.5">
                {ABSENCE_MOTIFS.map((item) => <button key={item} type="button" onClick={() => setMotif(item)} className="px-2 py-1 rounded-lg text-[11px] font-semibold" style={motif === item ? { background: 'var(--green-d)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' }}>{item}</button>)}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-semibold">Du
                  <input type="date" value={dateDebut} onChange={(event) => setDateDebut(event.target.value)} className="sygenop-input mt-1" />
                </label>
                <label className="block text-xs font-semibold">Au
                  <input type="date" value={dateFin} onChange={(event) => setDateFin(event.target.value)} className="sygenop-input mt-1" />
                </label>
              </div>
              <label className="block text-xs font-semibold">Commentaire (facultatif)
                <textarea value={commentaire} onChange={(event) => setCommentaire(event.target.value)} className="sygenop-input mt-1" rows={2} placeholder="Justificatif, précisions, remplacement prévu…" maxLength={500} />
              </label>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-muted">{dateDebut ? (nbJours > 1 ? `${nbJours} jour(s) d'absence` : '1 jour') : ''}</div>
                <button type="submit" className="sygenop-btn sygenop-btn--gold text-sm"><ClipboardCheck size={14} /> Envoyer la demande</button>
              </div>
            </form>
          )}
          <div className="space-y-1.5">
            <div className="text-xs font-bold">Mes demandes ({myRequests.length})</div>
            {myRequests.length === 0 ? <p className="text-xs text-muted">Aucune demande pour le moment.</p> : myRequests.slice().reverse().map((request) => <StaffAbsenceStatus key={request.id} request={request} onDocument={handleDocument} />)}
          </div>
        </div>

        {canValidate && (
          <div className="sygenop-card p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="font-bold text-sm">Validations en attente</div>
                <p className="text-xs text-muted">Seuls le directeur, le censeur / proviseur ou un directeur pédagogique peuvent décider.</p>
              </div>
              <Pill tone={pendingRequests.length ? 'gold' : 'green'}>{pendingRequests.length} en attente</Pill>
            </div>
            {pendingRequests.length === 0 ? <p className="text-sm text-muted">Aucune demande en attente.</p> : (
              <div className="space-y-2">
                {pendingRequests.map((request) => (
                  <div key={request.id} className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--line)' }}>
                    <div className="text-sm">
                      <div className="font-semibold">{request.requesterLabel} <span className="text-[11px] font-normal text-muted">{fmtDateFr(request.dateDebut)}{request.dateFin ? ' → ' + fmtDateFr(request.dateFin) : ''}</span></div>
                      <div className="text-xs flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--gold)' }}><CalendarX size={12} /> {request.motif}</div>
                      {request.commentaire && <div className="text-xs mt-1 text-muted">{request.commentaire}</div>}
                    </div>
                    {!readOnly && (
                      <>
                        <input value={noteDeco[request.id] || ''} onChange={(event) => setNoteDeco((notes) => ({ ...notes, [request.id]: event.target.value }))} className="sygenop-input" placeholder="Note de décision (facultatif)" maxLength={240} />
                        <div className="flex gap-2">
                          <button onClick={() => decideRequest(request, 'approved')} className="sygenop-btn text-sm sygenop-btn"><CheckCircle2 size={14} /> Autoriser</button>
                          <button onClick={() => decideRequest(request, 'rejected')} className="sygenop-btn sygenop-btn--danger text-sm"><X size={14} /> Refuser</button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {canValidate && decidedRequests.length > 0 && (
        <div className="sygenop-card p-4 space-y-2">
          <div className="text-xs font-bold">Historique des décisions ({decidedRequests.length})</div>
          <div className="space-y-1.5">
            {decidedRequests.slice(0, 30).map((request) => <StaffAbsenceStatus key={request.id} request={request} showDecider onDocument={handleDocument} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function StaffAbsenceStatus({ request, showDecider, onDocument }) {
  const status = ABSENCE_STATUS[request.statut] || { label: request.statut, tone: 'muted' };
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <CalendarX size={12} style={{ color: 'var(--muted)' }} />
      <span>{request.requesterLabel} — {request.motif}</span>
      <span className="text-muted">{fmtDateFr(request.dateDebut)}{request.dateFin ? ' → ' + fmtDateFr(request.dateFin) : ''}</span>
      <Pill tone={status.tone}>{status.label}</Pill>
      {onDocument && request.statut === 'approved' && (
        <>
          <button type="button" onClick={() => onDocument(request, 'print')} className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold sygenop-btn"><Printer size={11} /> Imprimer</button>
          <button type="button" onClick={() => onDocument(request, 'download')} className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold" style={{ background: '#1d4ed8', color: '#fff' }}><Download size={11} /> Télécharger</button>
        </>
      )}
      {showDecider && request.decidedBy && <span className="text-muted">· décidé(e) par {request.decidedBy}{request.decisionNote ? ` (« ${request.decisionNote} »)` : ''}</span>}
    </div>
  );
}

/* ---- Document officiel : autorisation d'absence (acceptée) ---- */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function absenceDocumentHtml(state, request) {
  const header = state.header || {};
  const cycle = header.cycle || LEGACY_DEFAULT_CYCLE;
  const term = cycleTerminology(cycle);
  const schoolName = escapeHtml(header.ecole || header.nom || 'École');
  const ville = escapeHtml(header.ville || '');
  const annee = escapeHtml(header.annee || header.anneeScolaire || '');
  const decider = escapeHtml(request.decidedBy || header.directeur || 'La direction');
  const fonction = escapeHtml(term.head);
  const agent = escapeHtml(request.requesterLabel || '');
  const agentPerson = (state.personnel || []).find((item) => item.id === request.requesterId);
  const agentRole = escapeHtml(agentPerson && agentPerson.role ? displayStaffRole(agentPerson.role, cycle) : '');
  const motif = escapeHtml(request.motif || '');
  const commentaire = escapeHtml(request.commentaire || '');
  const note = escapeHtml(request.decisionNote || '');
  const debut = fmtDateFr(request.dateDebut);
  const fin = fmtDateFr(request.dateFin || request.dateDebut);
  let nbJours = 1;
  if (request.dateDebut) {
    const finD = request.dateFin || request.dateDebut;
    nbJours = Math.max(1, Math.round((new Date(finD + 'T00:00:00').getTime() - new Date(request.dateDebut + 'T00:00:00').getTime()) / 86400000) + 1);
  }
  const ref = escapeHtml(request.id ? String(request.id).toUpperCase() : 'AUTORISATION');
  const decidedOn = request.decidedAt ? fmtDateFr(request.decidedAt.slice(0, 10)) : fmtDateFr(new Date().toISOString().slice(0, 10));
  const today = fmtDateFr(new Date().toISOString().slice(0, 10));
  const filename = `Autorisation-absence-${(request.requesterLabel || 'agent').replace(/[^a-zA-Z0-9]+/g, '_')}.html`;
  const qrValue = `SYGENOP|ABS|${request.id}`;
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&ecc=M&margin=4&format=png&data=${encodeURIComponent(qrValue)}`;
  const logoImg = schoolLogoData(state);
  const logoHtml = logoImg ? `<img class="logo" src="${escapeHtml(logoImg)}" alt="Logo" />` : `<svg class="logo-fallback" width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#ffd100" strokeWidth="1.5"><circle cx="12" cy="12" r="9"/><path d="M8 7h8M8 12h8M8 17h5"/></svg>`;

  const bodyHtml = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<title>Autorisation d'absence — ${agent}</title>
<style>
  @page { size: A4; margin: 20mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #151515; margin: 0; padding: 26px; }
  .toolbar { font-family: Arial, Helvetica, sans-serif; display: flex; align-items: center; gap: 10px; padding: 10px; margin-bottom: 20px; background: #f1f5f9; border-radius: 10px; position: sticky; top: 0; z-index: 10; }
  .toolbar button { padding: 9px 16px; border: 0; border-radius: 7px; color: #fff; font-weight: 700; font-size: 13px; cursor: pointer; }
  .toolbar .print { background: #15803d; }
  .toolbar .dl { background: #1d4ed8; }
  .toolbar span { margin-left: auto; font-size: 12px; color: #475569; }
  @media print { .toolbar { display: none; } }
  .frame { border: 4px solid #0a1e3d; padding: 6px; }
  .inner { border: 2px solid #0a1e3d; padding: 22px 26px; }
  .head { display: flex; align-items: center; justify-content: space-between; border-bottom: 2px solid #0a1e3d; padding-bottom: 14px; }
  .head .flag { width: 54px; height: auto; flex-shrink: 0; display: block; object-fit: contain; }
  .head .center { text-align: center; flex: 1; padding: 0 12px; }
  .head .school { font-weight: 800; font-size: 19px; text-transform: uppercase; letter-spacing: .5px; color: #0a1e3d; }
  .head .republic { font-size: 11px; color: #4b6a5c; margin-top: 3px; }
  .head .addr { font-size: 10.5px; color: #4b6a5c; margin-top: 2px; }
  .head .logo { max-height: 52px; max-width: 80px; object-fit: contain; flex-shrink: 0; }
  .head .logo-fallback { flex-shrink: 0; }
  .titlebox { text-align: center; margin: 18px 0 6px; }
  .titlebox .t { display: inline-block; padding: 8px 22px; border: 2px solid #0a1e3d; color: #0a1e3d; font-weight: 800; font-size: 21px; letter-spacing: 1px; }
  .bref { text-align: center; font-size: 12px; color: #444; margin-bottom: 26px; }
  .body { font-size: 15px; line-height: 1.9; text-align: justify; }
  table.grid { width: 100%; border-collapse: collapse; margin: 22px 0; font-size: 14px; }
  table.grid th, table.grid td { border: 1px solid #222; padding: 8px 12px; text-align: left; }
  table.grid th { width: 30%; background: #f8fafc; }
  .sig { margin-top: 48px; display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
  .sig .who { font-size: 13px; font-weight: 700; }
  .sig .line { border-top: 1px solid #111; width: 260px; padding-top: 6px; font-size: 12px; text-align: center; margin-top: 6px; }
  .sig-right .qr { width: 90px; height: 90px; background: #fff; padding: 3px; display: block; }
  .sig-right .qr-label { text-align: center; font-size: 9.5px; color: #4b6a5c; margin-top: 4px; }
  .meta { margin-top: 34px; font-size: 11.5px; color: #555; border-top: 1px solid #ccc; padding-top: 8px; text-align: center; }
</style>
</head>
<body>
  <div class="toolbar">
    <button class="print" onclick="window.print()">Imprimer</button>
    <button class="dl" onclick="downloadDoc()">Télécharger (.html)</button>
    <span>Impression : choisissez « Enregistrer en PDF » comme imprimante pour obtenir un PDF.</span>
  </div>

  <div class="frame">
    <div class="inner">
      <div class="head">
        <img class="flag" src="${flagSenegal}" alt="Drapeau officiel du Sénégal" />
        <div class="center">
          <div class="republic">République du Sénégal · Un Peuple, Un But, Une Foi</div>
          <div class="addr">${ville}${annee ? ' · Année scolaire ' + annee : ''}</div>
          <div class="school">${schoolName}</div>
        </div>
        ${logoHtml}
      </div>

      <div class="titlebox">
        <div class="t">AUTORISATION D'ABSENCE</div>
      </div>
      <div class="bref">N° ${ref} — délivrée le ${today}</div>

      <div class="body">
        <p>Je soussigné(e), <b>${decider}</b>, en qualité de <b>${fonction}</b>, autorise <b>${agent}</b>${agentRole ? ` (${agentRole})` : ''} à s'absenter de l'établissement <b>${schoolName}</b> pour la durée suivante :</p>
        <table class="grid">
          <tr><th>Du</th><td>${debut}</td></tr>
          <tr><th>Au</th><td>${fin}</td></tr>
          <tr><th>Durée</th><td>${nbJours} jour(s)</td></tr>
          <tr><th>Motif</th><td>${motif}</td></tr>
        </table>
        ${commentaire ? `<p>Observations du personnel : <i>${commentaire}</i></p>` : ''}
        ${note ? `<p>Note de décision : <i>${note}</i></p>` : ''}
        <p style="margin-top:18px">La présente autorisation d'absence est délivrée pour servir et valoir ce que de droit.</p>
      </div>

      <div class="sig">
        <div>
          <div class="who">Décision : <b>ACCORDÉE</b> — le ${decidedOn}</div>
          <div class="line">Signature et cachet de la direction</div>
        </div>
        <div class="sig-right">
          <img class="qr" src="${qrImg}" alt="QR code de vérification" width="90" height="90" />
          <div class="qr-label">Vérifier l'autorisation</div>
        </div>
      </div>

      <div class="meta">Document généré par EduLink Pro — ${schoolName} — édité le ${today}. Document vérifiable par QR code.</div>
    </div>
  </div>
</body>
</html>`;

  const page = bodyHtml.replace('</body>', `<script>
  window.DOC_HTML = ${JSON.stringify(bodyHtml)};
  function downloadDoc() {
    var b = new Blob([window.DOC_HTML], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = ${JSON.stringify(filename)};
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1500);
  }
<\/script></body>`);
  return page;
}

function openAbsenceDocument(state, request, notify) {
  const win = window.open('', '_blank', 'width=900,height=1040');
  if (!win) { notify('Autorisez les fenêtres (pop-up) pour imprimer le document.', true); return; }
  win.document.write(absenceDocumentHtml(state, request));
  win.document.close();
  win.focus();
}

function downloadAbsenceDocument(state, request, notify) {
  try {
    const blob = new Blob([absenceDocumentHtml(state, request)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Autorisation-absence-${(request.requesterLabel || 'agent').replace(/[^a-zA-Z0-9]+/g, '_')}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (error) {
    notify('Impossible de générer le document.', true);
  }
}

function StaffAttestStatus({ request, showDecider }) {
  const status = ABSENCE_STATUS[request.statut] || { label: request.statut, tone: 'muted' };
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <FileText size={12} style={{ color: 'var(--muted)' }} />
      <span>{request.requesterLabel} — attestation de service</span>
      <span className="text-muted">{request.usage}</span>
      <span className="text-muted">{fmtDateFr(request.dateDebut || (request.createdAt || '').slice(0, 10))}</span>
      <Pill tone={status.tone}>{status.label}</Pill>
      {showDecider && request.decidedBy && <span className="text-muted">· décidé(e) par {request.decidedBy}{request.decisionNote ? ` (« ${request.decisionNote} »)` : ''}</span>}
    </div>
  );
}

const ATTEST_USAGES = ['Dossier administratif', 'Ouverture de compte bancaire', 'Voyage', 'Scolarité des enfants', 'Autre (préciser)'];

/* ---- Espace personnel : chaque agent demande via son compte ---- */
function StaffMyRequestsView({ state, loading, updateState, notify, session, readOnly }) {
  const [motif, setMotif] = useState('');
  const [dateDebut, setDateDebut] = useState(todayISO());
  const [dateFin, setDateFin] = useState('');
  const [commentaire, setCommentaire] = useState('');
  const [usage, setUsage] = useState('');
  const [commentaireAtt, setCommentaireAtt] = useState('');

  if (loading || !state) return <AppLoader />;

  const me = (session && session.staffId) ? (state.personnel || []).find((item) => item.id === session.staffId) : null;
  const requesterId = me ? me.id : 'agent-session';
  const requesterLabel = me ? personFullName(me) : 'Agent';
  const absences = (state.staffAbsenceRequests || []).filter((request) => request.requesterId === requesterId).slice().reverse();
  const attestations = (state.staffAttestRequests || []).filter((request) => request.requesterId === requesterId).slice().reverse();
  const handleDocument = (request, mode) => {
    if (mode === 'download') downloadAbsenceDocument(state, request, notify);
    else openAbsenceDocument(state, request, notify);
  };
  const finDate = dateFin || dateDebut;
  const nbJours = dateDebut && finDate ? Math.max(1, Math.round((new Date(finDate + 'T00:00:00').getTime() - new Date(dateDebut + 'T00:00:00').getTime()) / 86400000) + 1) : 0;

  function submitAbsence(event) {
    event.preventDefault();
    if (readOnly) return;
    const motifClean = String(motif || '').trim();
    if (!motifClean) { notify('Indiquez le motif de l’absence.', true); return; }
    if (!dateDebut) { notify('Indiquez la date de début.', true); return; }
    const fin = dateFin || dateDebut;
    if (fin < dateDebut) { notify('La date de fin ne peut pas précéder la date de début.', true); return; }
    updateState((prev) => ({
      ...prev,
      staffAbsenceRequests: [...(prev.staffAbsenceRequests || []), {
        id: uid('absence'), requesterId, requesterLabel, motif: motifClean, dateDebut, dateFin: fin,
        commentaire: String(commentaire || '').trim(), statut: 'pending', createdAt: new Date().toISOString(),
      }],
      auditLog: pushAuditEntry(prev.auditLog, { actor: requesterLabel, role: (session && session.role) || '', action: 'Demande d’autorisation d’absence', details: `${motifClean} (${dateDebut}${fin ? ' → ' + fin : ''})` }),
    }));
    setMotif(''); setDateDebut(todayISO()); setDateFin(''); setCommentaire('');
    notify('Demande d’autorisation d’absence envoyée, en attente de validation.');
  }

  function submitAttestation(event) {
    event.preventDefault();
    if (readOnly) return;
    const usageClean = String(usage || '').trim();
    if (!usageClean) { notify('Indiquez l’usage prévu de l’attestation.', true); return; }
    updateState((prev) => ({
      ...prev,
      staffAttestRequests: [...(prev.staffAttestRequests || []), {
        id: uid('attest'), requesterId, requesterLabel, usage: usageClean,
        commentaire: String(commentaireAtt || '').trim(), statut: 'pending', createdAt: new Date().toISOString(),
      }],
      auditLog: pushAuditEntry(prev.auditLog, { actor: requesterLabel, role: (session && session.role) || '', action: 'Demande d’attestation de service', details: usageClean }),
    }));
    setUsage(''); setCommentaireAtt('');
    notify('Demande d’attestation de service envoyée, en attente de validation.');
  }

  return (
    <div className="space-y-4 sygenop-fade">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="sygenop-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <CalendarX size={16} style={{ color: 'var(--gold)' }} />
            <div>
              <div className="font-bold text-sm">Autorisation d’absence</div>
              <p className="text-xs text-muted">La demande est transmise à la direction (directeur, censeur ou proviseur) qui seule décide.</p>
            </div>
          </div>
          {readOnly ? (
            <p className="text-xs text-muted">Lecture seule : aucune demande ne peut être soumise.</p>
          ) : (
            <form onSubmit={submitAbsence} className="space-y-3">
              <label className="block text-xs font-semibold">Motif de l'absence
                <input value={motif} onChange={(event) => setMotif(event.target.value)} className="sygenop-input mt-1" placeholder="Ex : maladie, convocation, deuil…" maxLength={160} />
              </label>
              <div className="flex flex-wrap gap-1.5">
                {ABSENCE_MOTIFS.map((item) => <button key={item} type="button" onClick={() => setMotif(item)} className="px-2 py-1 rounded-lg text-[11px] font-semibold" style={motif === item ? { background: 'var(--green-d)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' }}>{item}</button>)}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-semibold">Du
                  <input type="date" value={dateDebut} onChange={(event) => setDateDebut(event.target.value)} className="sygenop-input mt-1" />
                </label>
                <label className="block text-xs font-semibold">Au
                  <input type="date" value={dateFin} onChange={(event) => setDateFin(event.target.value)} className="sygenop-input mt-1" />
                </label>
              </div>
              <label className="block text-xs font-semibold">Commentaire (facultatif)
                <textarea value={commentaire} onChange={(event) => setCommentaire(event.target.value)} className="sygenop-input mt-1" rows={2} placeholder="Justificatif, précisions, remplacement prévu…" maxLength={500} />
              </label>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-muted">{dateDebut ? (nbJours > 1 ? `${nbJours} jour(s) d'absence` : '1 jour') : ''}</div>
                <button type="submit" className="sygenop-btn sygenop-btn--gold text-sm"><ClipboardCheck size={14} /> Envoyer la demande</button>
              </div>
            </form>
          )}
          <div className="space-y-1.5">
            <div className="text-xs font-bold">Mes demandes d'absence ({absences.length})</div>
            {absences.length === 0 ? <p className="text-xs text-muted">Aucune demande pour le moment.</p> : absences.map((request) => <StaffAbsenceStatus key={request.id} request={request} showDecider onDocument={handleDocument} />)}
          </div>
        </div>

        <div className="sygenop-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <FileText size={16} style={{ color: 'var(--green-d)' }} />
            <div>
              <div className="font-bold text-sm">Attestation de service</div>
              <p className="text-xs text-muted">Une fois validée par la direction, l'attestation est délivrée au format officiel imprimable.</p>
            </div>
          </div>
          {readOnly ? (
            <p className="text-xs text-muted">Lecture seule : aucune demande ne peut être soumise.</p>
          ) : (
            <form onSubmit={submitAttestation} className="space-y-3">
              <label className="block text-xs font-semibold">Usage prévu de l'attestation
                <input value={usage} onChange={(event) => setUsage(event.target.value)} className="sygenop-input mt-1" placeholder="Ex : dossier administratif, banque, voyage…" maxLength={160} />
              </label>
              <div className="flex flex-wrap gap-1.5">
                {ATTEST_USAGES.map((item) => <button key={item} type="button" onClick={() => setUsage(item)} className="px-2 py-1 rounded-lg text-[11px] font-semibold" style={usage === item ? { background: 'var(--green-d)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' }}>{item}</button>)}
              </div>
              <label className="block text-xs font-semibold">Précisions (facultatif)
                <textarea value={commentaireAtt} onChange={(event) => setCommentaireAtt(event.target.value)} className="sygenop-input mt-1" rows={2} placeholder="Informations complémentaires…" maxLength={500} />
              </label>
              <div className="flex justify-end">
                <button type="submit" className="sygenop-btn text-sm sygenop-btn"><FileText size={14} /> Envoyer la demande</button>
              </div>
            </form>
          )}
          <div className="space-y-1.5">
            <div className="text-xs font-bold">Mes demandes d'attestation ({attestations.length})</div>
            {attestations.length === 0 ? <p className="text-xs text-muted">Aucune demande pour le moment.</p> : attestations.map((request) => <StaffAttestStatus key={request.id} request={request} showDecider />)}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-muted">Le statut de vos demandes est mis à jour ici dès qu’une décision est prise par la direction.</p>
    </div>
  );
}

/* ---- Validation direction : demandes d'attestation de service ---- */
function StaffAttestRequestsPanel({ state, updateState, notify, session, readOnly }) {
  const [noteDeco, setNoteDeco] = useState({});
  const requests = Array.isArray(state?.staffAttestRequests) ? state.staffAttestRequests : [];
  const pending = requests.filter((request) => request.statut === 'pending');
  const decided = requests.filter((request) => request.statut !== 'pending').slice().reverse();
  const me = (session && session.staffId) ? (state.personnel || []).find((item) => item.id === session.staffId) : null;
  const validatorLabel = me ? personFullName(me) : ((state.header && state.header.directeur) || 'La direction');

  function decideRequest(request, decision) {
    if (readOnly || request.statut !== 'pending') return;
    const note = String(noteDeco[request.id] || '').trim();
    updateState((prev) => ({
      ...prev,
      staffAttestRequests: (prev.staffAttestRequests || []).map((item) => item.id === request.id
        ? { ...item, statut: decision, decisionNote: note, decidedBy: validatorLabel, decidedAt: new Date().toISOString() }
        : item),
      auditLog: pushAuditEntry(prev.auditLog, { actor: validatorLabel, role: (session && session.role) || '', action: decision === 'approved' ? 'Attestation de service validée' : 'Attestation de service refusée', details: `${request.requesterLabel} — ${request.usage}` }),
    }));
    notify(decision === 'approved' ? 'Attestation de service autorisée.' : 'Demande d’attestation refusée.');
  }

  return (
    <div className="sygenop-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="font-bold text-sm">Demandes d'attestation de service</div>
          <p className="text-xs text-muted">Validez pour délivrer l'attestation, ou refusez une demande.</p>
        </div>
        <Pill tone={pending.length ? 'gold' : 'green'}>{pending.length} en attente</Pill>
      </div>
      {pending.length === 0 ? <p className="text-sm text-muted">Aucune demande en attente.</p> : (
        <div className="space-y-2">
          {pending.map((request) => (
            <div key={request.id} className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--line)' }}>
              <div className="text-sm">
                <div className="font-semibold">{request.requesterLabel} <span className="text-[11px] font-normal text-muted">demandé(e) le {fmtDateFr((request.createdAt || '').slice(0, 10))}</span></div>
                <div className="text-xs flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--gold)' }}><FileText size={12} /> {request.usage}</div>
                {request.commentaire && <div className="text-xs mt-1 text-muted">{request.commentaire}</div>}
              </div>
              {!readOnly && (
                <>
                  <input value={noteDeco[request.id] || ''} onChange={(event) => setNoteDeco((notes) => ({ ...notes, [request.id]: event.target.value }))} className="sygenop-input" placeholder="Note de décision (facultatif)" maxLength={240} />
                  <div className="flex gap-2">
                    <button onClick={() => decideRequest(request, 'approved')} className="sygenop-btn text-sm sygenop-btn"><CheckCircle2 size={14} /> Autoriser</button>
                    <button onClick={() => decideRequest(request, 'rejected')} className="sygenop-btn sygenop-btn--danger text-sm"><X size={14} /> Refuser</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {decided.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-bold">Historique des décisions ({decided.length})</div>
          {decided.slice(0, 30).map((request) => <StaffAttestStatus key={request.id} request={request} showDecider />)}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   ATTESTATION DE SERVICE — document imprimable pour le personnel
   ============================================================ */
function StaffServiceAttestation({ state, person }) {
  const school = state.header?.ecole || 'Établissement scolaire';
  const directeur = state.header?.directeur || '';
  const localite = state.header?.localite || state.header?.adresse || 'à Dakar';
  const annee = state.header?.annee || 'année scolaire en cours';
  const today = new Date();
  const dateStr = today.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const code = staffCardCode(person);
  const nomComplet = personFullName(person) || 'l’agent désigné ci-dessous';
  const fonction = person.role ? displayStaffRole(person.role, state.header?.cycle) : '—';
  const embauche = person.dateEmbauche ? fmtDateFr(person.dateEmbauche) : '—';
  const nb = String((state.staffCertCounter || 0) + 1).padStart(4, '0');
  const num = `N° ${nb}/${annee}`;
  return (
    <div className="mx-auto bg-white" style={{ color: '#11231b', width: '210mm', minHeight: '148mm' }}>
      <div className="relative h-full border-4 p-1.5" style={{ borderColor: 'var(--green-d, #0a1e3d)' }}>
        <div className="h-full border-2 px-7 py-6 flex flex-col" style={{ borderColor: 'var(--green-d, #0a1e3d)' }}>
          <div className="flex items-center justify-between border-b-2 pb-3" style={{ borderColor: 'var(--green-d, #0a1e3d)' }}>
            <SenegalFlag className="w-12 h-auto" />
            <div className="text-center">
              <div className="text-[10px]" style={{ color: '#4b6a5c' }}>République du Sénégal · Un Peuple, Un But, Une Foi</div>
              <div className="text-[10px]" style={{ color: '#4b6a5c' }}>Adresse : {localite} — {num}</div>
              <div className="text-base font-extrabold leading-tight" style={{ color: 'var(--green-d, #0a1e3d)' }}>{school}</div>
            </div>
            {schoolLogoData(state) ? <SchoolLogoMark state={state} width={44} /> : <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#ffd100" strokeWidth="1.5"><circle cx="12" cy="12" r="9" /><path d="M8 7h8M8 12h8M8 17h5" /></svg>}
          </div>
          <div className="mt-3 text-center">
            <div className="inline-block px-5 py-1 font-extrabold text-base tracking-wide" style={{ border: '2px solid var(--green-d, #0a1e3d)', color: 'var(--green-d, #0a1e3d)' }}>ATTESTATION DE SERVICE</div>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed">Je soussigné(e), <b>{directeur || 'le Directeur(trice)'}</b>, Directeur(trice) de l’établissement <b>{school}</b>, situé(e) {localite}, atteste que <b>M./Mme {nomComplet}</b>, exerçant la fonction de <b>{fonction}</b> et {person.statut ? `${person.statut.toLowerCase()} dans nos effectifs` : 'appartenant à nos effectifs'}, est bien membre du personnel dudit établissement.</p>
          <div className="mt-3 text-center">
            <div className="font-extrabold text-lg" style={{ color: '#11231b' }}>{nomComplet}</div>
            <div className="text-xs mt-0.5" style={{ color: '#4b6a5c' }}>Matricule : {code} · Entré(e) en service : {embauche} · Année scolaire : {annee}</div>
          </div>
          <p className="text-[13px] leading-relaxed mt-2">La présente attestation est délivrée à la demande de l’intéressé(e) pour tous droits et usages légaux, notamment à caractère administratif.</p>
          <div className="mt-3 flex-1"></div>
          <p className="text-[13px] leading-relaxed">Fait {localite}, le {dateStr}.</p>
          <div className="mt-4 flex items-end justify-between">
            <div>
              <div className="text-[13px] font-semibold">{directeur || 'Le Directeur(trice)'}</div>
              <div className="mt-2 text-[10px]" style={{ color: '#4b6a5c' }}>Le Directeur(trice) — cachet officiel</div>
            </div>
            <QRBadge value={`SYGENOP|SVC|${code}|${person.id}`} size={72} label="Vérifier l'attestation" />
          </div>
        </div>
      </div>
    </div>
  );
}

function PersonnelProfileModal({ person, state, updateState, notify, readOnly, onClose, onCard, onAttest, onEdit, onDelete, cycle }) {
  const [motif, setMotif] = useState('');
  const [dateDebut, setDateDebut] = useState(todayISO());
  const [dateFin, setDateFin] = useState('');
  const [commentaire, setCommentaire] = useState('');
  const [revealed, setRevealed] = useState(false);
  const fullName = personFullName(person);
  const requests = (state?.staffAbsenceRequests || []).filter((request) => request.requesterId === person.id).slice().reverse();
  const statutTone = person.statut === 'Actif' ? 'green' : person.statut === 'Absent' ? 'red' : 'gold';
  const handleDocument = (request, mode) => {
    if (mode === 'download') downloadAbsenceDocument(state, request, notify);
    else openAbsenceDocument(state, request, notify);
  };

  function submitAbsence(event) {
    event.preventDefault();
    if (readOnly) return;
    const motifClean = String(motif || '').trim();
    if (!motifClean) { notify('Indiquez le motif de l’absence.', true); return; }
    if (!dateDebut) { notify('Indiquez la date de début.', true); return; }
    const fin = dateFin || dateDebut;
    if (fin < dateDebut) { notify('La date de fin ne peut pas précéder la date de début.', true); return; }
    updateState((prev) => ({
      ...prev,
      staffAbsenceRequests: [...(prev.staffAbsenceRequests || []), {
        id: uid('absence'),
        requesterId: person.id,
        requesterLabel: fullName,
        motif: motifClean,
        dateDebut,
        dateFin: fin,
        commentaire: String(commentaire || '').trim(),
        statut: 'pending',
        createdAt: new Date().toISOString(),
      }],
      auditLog: pushAuditEntry(prev.auditLog, { actor: fullName, role: 'staff', action: 'Demande d’autorisation d’absence', details: `${motifClean} (${dateDebut}${fin ? ' → ' + fin : ''})` }),
    }));
    setMotif(''); setDateDebut(todayISO()); setDateFin(''); setCommentaire('');
    notify('Demande d’autorisation d’absence envoyée, en attente de validation.');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="sygenop-card p-6 max-w-xl w-full sygenop-fade max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-16 h-16 rounded-xl border overflow-hidden flex items-center justify-center flex-shrink-0" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}>
              {person.photoData ? <img src={person.photoData} alt={`Photo de ${fullName}`} className="w-full h-full object-cover" /> : (isFemale(person.genre) ? <AvatarGirl size={44} /> : <AvatarBoy size={44} />)}
            </div>
            <div>
              <div className="font-bold text-lg leading-tight text-ink">{fullName}</div>
              <div className="text-xs mt-0.5 text-muted">{displayStaffRole(person.role, cycle)}</div>
              <div className="mt-1"><Pill tone={statutTone}>{person.statut || 'Actif'}</Pill></div>
            </div>
          </div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>

        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-1.5 text-sm">
          <div><b className="text-xs text-muted">Téléphone</b><div className="text-ink">{person.telephone || '—'}</div></div>
          <div><b className="text-xs text-muted">Genre</b><div className="text-ink">{person.genre || '—'}</div></div>
          <div><b className="text-xs text-muted">Matricule</b><div className="font-mono text-ink">{staffCardCode(person)}</div></div>
          <div><b className="text-xs text-muted">Date d'embauche</b><div className="text-ink">{person.dateEmbauche ? fmtDateFr(person.dateEmbauche) : '—'}</div></div>
          <div><b className="text-xs text-muted">Salaire de base</b><div className="text-ink">{fmtFCFA(person.salaireBase)}</div></div>
          <div><b className="text-xs text-muted">Statut</b><div className="text-ink">{person.statut || 'Actif'}</div></div>
          {person.specialites?.length > 0 && (
            <div className="sm:col-span-2"><b className="text-xs text-muted">Spécialités</b><div className="flex flex-wrap gap-1 mt-1">{person.specialites.map((specialite) => <span key={specialite} className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>{specialite}</span>)}</div></div>
          )}
          {STAFF_LOGIN_ROLES.has(person.role) && person.code && (
            <div className="sm:col-span-2"><b className="text-xs text-muted">Code de connexion</b><div className="flex items-center gap-1.5 mt-0.5"><span className="font-mono font-semibold tracking-widest text-sm" style={{ color: 'var(--green-d)' }}>{revealed ? person.code : '••••••'}</span><button onClick={() => setRevealed((r) => !r)} style={{ color: 'var(--muted)' }} title={revealed ? 'Masquer le code' : 'Afficher le code'}>{revealed ? <EyeOff size={13} /> : <Eye size={13} />}</button><button onClick={() => copyToClipboard(person.code, () => {})} style={{ color: 'var(--muted)' }} title="Copier le code"><FileSpreadsheet size={13} /></button></div></div>
          )}
        </div>

        <div className="flex flex-wrap gap-2 mt-4 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
          <button type="button" onClick={onCard} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: 'var(--green-d)' }}><CreditCard size={15} /> Carte professionnelle</button>
          <button type="button" onClick={onAttest} className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}><FileText size={15} /> Attestation de service</button>
        </div>

        {!readOnly && (
          <form onSubmit={submitAbsence} className="mt-4 pt-4 space-y-3" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="font-bold text-sm text-ink">Demande d'autorisation d'absence</div>
            <label className="block text-xs font-semibold">Motif de l'absence
              <input value={motif} onChange={(event) => setMotif(event.target.value)} className="sygenop-input mt-1" placeholder="Ex : maladie, convocation, deuil…" maxLength={160} />
            </label>
            <div className="flex flex-wrap gap-1.5">
              {ABSENCE_MOTIFS.map((item) => <button key={item} type="button" onClick={() => setMotif(item)} className="px-2 py-1 rounded-lg text-[11px] font-semibold" style={motif === item ? { background: 'var(--green-d)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' }}>{item}</button>)}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-xs font-semibold">Du
                <input type="date" value={dateDebut} onChange={(event) => setDateDebut(event.target.value)} className="sygenop-input mt-1" />
              </label>
              <label className="block text-xs font-semibold">Au
                <input type="date" value={dateFin} onChange={(event) => setDateFin(event.target.value)} className="sygenop-input mt-1" />
              </label>
            </div>
            <label className="block text-xs font-semibold">Commentaire (facultatif)
              <textarea value={commentaire} onChange={(event) => setCommentaire(event.target.value)} className="sygenop-input mt-1" rows={2} placeholder="Justificatif, précisions, remplacement prévu…" maxLength={500} />
            </label>
            <button type="submit" className="sygenop-btn sygenop-btn--gold text-sm"><ClipboardCheck size={14} /> Envoyer la demande</button>
          </form>
        )}

        {requests.length > 0 && (
          <div className="mt-4 pt-4 space-y-1.5" style={{ borderTop: '1px solid var(--line)' }}>
            <div className="text-xs font-bold">Demandes d'absence ({requests.length})</div>
            {requests.map((request) => <StaffAbsenceStatus key={request.id} request={request} showDecider onDocument={handleDocument} />)}
          </div>
        )}

        {!readOnly && (
          <div className="flex items-center justify-between mt-5 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
            <button type="button" onClick={onDelete} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: 'var(--red)' }}><Trash2 size={15} /> Supprimer</button>
            <button type="button" onClick={onEdit} className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5" style={{ background: 'var(--bg)', color: 'var(--ink)' }}><Pencil size={15} /> Modifier</button>
          </div>
        )}
      </div>
    </div>
  );
}

function PersonnelView({ state, loading, updateState, notify, session, readOnly }) {
  const schoolCycle = state?.header?.cycle || LEGACY_DEFAULT_CYCLE;
  const [tab, setTab] = useState('liste');
  const [modalPerson, setModalPerson] = useState(undefined); // undefined = closed, null = new, obj = edit
  const [toDelete, setToDelete] = useState(null);
  const [cardPerson, setCardPerson] = useState(null);
  const [attestPerson, setAttestPerson] = useState(null);
  const [profilePerson, setProfilePerson] = useState(null);

  function saveStaffPhoto(personId, photoData) {
    updateState((prev) => ({ ...prev, personnel: (prev.personnel || []).map((p) => (p.id === personId ? { ...p, photoData } : p)) }));
    setCardPerson((p) => (p && p.id === personId ? { ...p, photoData } : p));
  }

  if (loading || !state) {
    return <AppLoader />;
  }

  const personnel = state.personnel || [];
  const pointage = state.pointage || {};
  const settings = attendanceSettings(state);

  function savePerson(person) {
    if (readOnly) return;
    const normalizedPerson = { ...person, genre: person.genre ? person.genre : 'Homme' };
    updateState((prev) => {
      const list = prev.personnel || [];
      const exists = list.some((p) => p.id === normalizedPerson.id);
      const next = exists ? list.map((p) => (p.id === normalizedPerson.id ? normalizedPerson : p)) : [...list, normalizedPerson];
      return { ...prev, personnel: next };
    });
    notify(modalPerson && modalPerson.id ? 'Membre du personnel mis à jour' : 'Membre du personnel ajouté');
    setModalPerson(undefined);
  }

  function deletePerson(person) {
    if (readOnly) return;
    updateState((prev) => ({ ...prev, personnel: (prev.personnel || []).filter((p) => p.id !== person.id) }));
    notify('Membre du personnel supprimé');
    setToDelete(null);
  }

  function setStatut(date, staffId, statut) {
    if (readOnly) return;
    if (nonWorkingDayReason(date, settings)) { notify('Le pointage est fermé pour ce jour non ouvré.', true); return; }
    updateState((prev) => {
      const pt = { ...(prev.pointage || {}) };
      const dayRec = { ...(pt[date] || {}) };
      if (statut) {
        const prevRec = getPointageRecord(prev.pointage || {}, date, staffId);
        const heures = (statut === 'P' || statut === 'R')
          ? (prevRec && (prevRec.statut === 'P' || prevRec.statut === 'R') ? prevRec.heures : heuresAttenduesDate(date, settings))
          : 0;
        dayRec[staffId] = { statut, heures };
      } else {
        delete dayRec[staffId];
      }
      if (Object.keys(dayRec).length) pt[date] = dayRec; else delete pt[date];
      return { ...prev, pointage: pt };
    });
  }

  function setHeures(date, staffId, heures) {
    if (readOnly) return;
    updateState((prev) => {
      const rec = getPointageRecord(prev.pointage || {}, date, staffId);
      if (!rec) return prev;
      const pt = { ...(prev.pointage || {}) };
      const dayRec = { ...(pt[date] || {}) };
      dayRec[staffId] = { ...rec, heures: Math.max(0, Math.min(24, Number(heures) || 0)) };
      pt[date] = dayRec;
      return { ...prev, pointage: pt };
    });
  }

  const pendingTransferCount = (state.studentTransferRequests || []).filter((request) => request.status === 'pending').length;
  const pendingAbsenceCount = (state.staffAbsenceRequests || []).filter((request) => request.statut === 'pending').length;
  const tabs = [
    { id: 'liste', label: 'Liste du personnel', icon: Users },
    { id: 'pointage', label: 'Pointage', icon: CalendarDays },
    { id: 'paie', label: 'Paie', icon: Wallet },
    { id: 'absences', label: 'Absences', icon: CalendarX },
    ...(!readOnly ? [{ id: 'demandes', label: 'Demandes de transfert', icon: RotateCcw }] : []),
  ];

  return (
    <div className="space-y-4 sygenop-fade">
      <div className="flex flex-wrap gap-1.5 p-1 rounded-xl w-fit" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={tab === item.id ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
          >
                        <item.icon size={15} /> {item.label}
            {item.id === 'demandes' && pendingTransferCount > 0 && <span className="ml-1 min-w-5 h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center text-white" style={{ background: 'var(--red)' }}>{pendingTransferCount}</span>}
            {item.id === 'absences' && pendingAbsenceCount > 0 && <span className="ml-1 min-w-5 h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center text-white" style={{ background: 'var(--gold)' }}>{pendingAbsenceCount}</span>}

          </button>
        ))}
      </div>
      {tab === 'liste' && (
        <PersonnelListTab
          personnel={personnel}
          onAdd={() => setModalPerson(null)}
          onEdit={(p) => setModalPerson(p)}
          onDelete={(p) => setToDelete(p)}
          onCard={(p) => setCardPerson(p)}
          onAttest={(p) => setAttestPerson(p)}
          onProfile={(p) => setProfilePerson(p)}
          readOnly={readOnly}
          cycle={schoolCycle}
        />
      )}
      {tab === 'pointage' && (
        <div className="space-y-4">
          <div>
            <div className="font-bold text-sm mb-2 text-ink">Pointage automatique (scan badge)</div>
            <StudentCardVerification state={state} updateState={readOnly ? undefined : updateState} notify={notify} />
          </div>
          <div>
            <div className="font-bold text-sm mb-2 text-ink">Pointage manuel</div>
            <PointageTab personnel={personnel} pointage={pointage} onSetStatut={setStatut} onSetHeures={setHeures} readOnly={readOnly} settings={settings} cycle={schoolCycle} />
          </div>
        </div>
      )}
      {tab === 'paie' && <PaieTab personnel={personnel} pointage={pointage} state={state} updateState={updateState} readOnly={readOnly} />}
      {tab === 'absences' && (
        <div className="space-y-4">
          <StaffAbsencesView state={state} updateState={updateState} notify={notify} session={session} readOnly={readOnly} />
          <StaffAttestRequestsPanel state={state} updateState={updateState} notify={notify} session={session} readOnly={readOnly} />
        </div>
      )}
      {tab === 'demandes' && <StudentTransferRequestsPanel state={state} updateState={updateState} notify={notify} mode="director" />}

      {modalPerson !== undefined && (
        <PersonnelModal person={modalPerson} cycle={schoolCycle} onSave={savePerson} onClose={() => setModalPerson(undefined)} />
      )}

      {cardPerson && (
        <div id="staff-card-print" className="fixed inset-0 z-50 overflow-auto p-4"><div className="max-w-2xl mx-auto mt-4"><div className="no-print flex flex-wrap justify-end gap-2 mb-2"><label className="px-3 py-2 rounded-lg text-sm font-semibold cursor-pointer" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}>Ajouter / changer la photo<input type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; readImageCompressed(file).then((data) => { if (data) saveStaffPhoto(cardPerson.id, data); }); }} /></label><button onClick={() => window.print()} className="px-3 py-2 rounded-lg text-white flex items-center gap-1" style={{ background: 'var(--green-d)' }}><Printer size={14} /> Imprimer / PDF</button><button onClick={() => setCardPerson(null)} className="px-3 py-2 rounded-lg bg-panel">Fermer</button></div><StaffIdentityCard state={state} person={cardPerson} /></div></div>
      )}

      {attestPerson && (
        <div id="staff-cert-print" className="fixed inset-0 z-50 overflow-auto p-4"><div className="max-w-[220mm] mx-auto mt-4"><div className="no-print flex flex-wrap justify-end gap-2 mb-2"><button onClick={() => window.print()} className="px-3 py-2 rounded-lg text-white flex items-center gap-1" style={{ background: 'var(--green-d)' }}><Printer size={14} /> Imprimer / PDF</button><button onClick={() => setAttestPerson(null)} className="px-3 py-2 rounded-lg bg-panel">Fermer</button></div><StaffServiceAttestation state={state} person={attestPerson} /></div></div>
      )}

      {profilePerson && (
        <PersonnelProfileModal
          person={profilePerson}
          state={state}
          updateState={updateState}
          notify={notify}
          readOnly={readOnly}
          cycle={schoolCycle}
          onClose={() => setProfilePerson(null)}
          onCard={() => { setProfilePerson(null); setCardPerson(profilePerson); }}
          onAttest={() => { setProfilePerson(null); setAttestPerson(profilePerson); }}
          onEdit={() => { setProfilePerson(null); setModalPerson(profilePerson); }}
          onDelete={() => { setProfilePerson(null); setToDelete(profilePerson); }}
        />
      )}

      {toDelete && (
        <ConfirmModal
          title="Supprimer ce membre du personnel ?"
          message={`« ${personFullName(toDelete)} » sera définitivement retiré de la liste. Son historique de pointage restera enregistré.`}
          danger
          onConfirm={() => deletePerson(toDelete)}
          onCancel={() => setToDelete(null)}
        />
      )}
    </div>
  );
}

/* ---- Nom complet (prénom + nom) d'un membre du personnel ---- */
function personFullName(p) {
  if (!p) return '';
  const parts = [p.prenom, p.nom].filter((x) => x && String(x).trim()).map((x) => String(x).trim());
  return parts.join(' ') || (p.nom || '');
}
/* ---- Nom de l'enseignant(e) connecté(e), déduit du personnel de l'école ---- */
function teacherNameFromSession(state, session) {
  if (!state || !session || session.role !== 'teacher') return null;
  const p = (state.personnel || []).find((x) => x.id === session.staffId);
  return p ? personFullName(p) : null;
}

/* ============================================================
   SAISIE DES NOTES + MOTEUR DE BARÈME
   ============================================================ */
const TIMETABLE_DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

function TimetableView({ state, classId, teacherName, updateState, notify, readOnly = true, mode = 'view' }) {
  const classes = state?.classes || {};
  const personnel = state?.personnel || [];
  const [filterClassId, setFilterClassId] = useState(classId || 'all');
  const [form, setForm] = useState({ day: 'Lundi', start: '08:00', end: '09:00', subject: '', classId: classId || '', teacher: '', room: '' });
  const [importError, setImportError] = useState('');
  const importInputRef = useRef(null);
  const canEdit = mode === 'admin' && !readOnly;

  useEffect(() => {
    if (classId) {
      setFilterClassId(classId);
      setForm((prev) => ({ ...prev, classId }));
    }
  }, [classId]);

  const timetableList = (source) => {
    const list = source?.emploiDuTemps;
    return Array.isArray(list) ? list : Object.values(list || {}).filter(Boolean);
  };

  const entries = timetableList(state)
    .filter((entry) => filterClassId === 'all' || !filterClassId || entry.classId === filterClassId)
    .filter((entry) => !teacherName || !entry.teacher || entry.teacher === teacherName || entry.teacherId === teacherName)
    .sort((a, b) => `${TIMETABLE_DAYS.indexOf(a.day)}-${a.start}`.localeCompare(`${TIMETABLE_DAYS.indexOf(b.day)}-${b.start}`));

  const addEntry = (event) => {
    event.preventDefault();
    const subject = form.subject.trim();
    if (!subject || !form.classId) {
      notify('Indiquez la matière et la classe.', true);
      return;
    }
    if (!form.start || !form.end) {
      notify('Indiquez les heures de début et de fin.', true);
      return;
    }
    if (form.end <= form.start) {
      notify('L’heure de fin doit être après l’heure de début.', true);
      return;
    }
    updateState((prev) => ({
      ...prev,
      emploiDuTemps: [...timetableList(prev), { ...form, id: uid('slot'), subject }],
    }));
    if (filterClassId !== 'all' && filterClassId !== form.classId) setFilterClassId(form.classId);
    notify('Créneau ajouté à l’emploi du temps');
    setForm((prev) => ({ ...prev, subject: '', room: '' }));
  };

  const removeEntry = (entryId) => {
    updateState((prev) => ({ ...prev, emploiDuTemps: timetableList(prev).filter((entry) => entry.id !== entryId) }));
    notify('Créneau supprimé');
  };

  const exportRows = [['Jour', 'Début', 'Fin', 'Matière', 'Classe', 'Identifiant classe', 'Enseignant', 'Salle']];
  entries.forEach((entry) => exportRows.push([entry.day, entry.start, entry.end, entry.subject, classes[entry.classId]?.name || '', entry.classId || '', entry.teacher || '', entry.room || '']));
  const exportCSV = () => downloadCSV(`emploi-du-temps-${state?.header?.annee || 'ecole'}.csv`, exportRows);
  const printPDF = () => {
    const selectedClass = filterClassId !== 'all' ? classes[filterClassId] : null;
    const schoolName = state?.header?.ecole || 'Établissement scolaire';
    const grouped = entries.reduce((acc, entry) => { (acc[entry.classId] ||= []).push(entry); return acc; }, {});
    const classGroups = Object.entries(grouped);
    const emptyNotice = !classGroups.length ? '<p>Aucun créneau renseigné pour cette sélection.</p>' : '';
    if (!classGroups.length && filterClassId === 'all') { notify('Le PDF sera généré avec un planning vide.', false); }
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const dayOrder = Object.fromEntries(TIMETABLE_DAYS.map((day, index) => [day, index]));
    const sections = classGroups.map(([groupClassId, groupEntries]) => {
      const groupClass = classes[groupClassId];
      const rows = [...groupEntries].sort((a, b) => (dayOrder[a.day] - dayOrder[b.day]) || a.start.localeCompare(b.start)).map((entry) => `<tr><td>${esc(entry.day)}</td><td>${esc(entry.start)} – ${esc(entry.end)}</td><td>${esc(entry.subject)}</td><td>${esc(entry.teacher || '')}</td><td>${esc(entry.room || '')}</td></tr>`).join('');
      return `<section><h2>${esc(groupClass?.name || 'Classe')}</h2><table><thead><tr><th>Jour</th><th>Horaire</th><th>Matière</th><th>Enseignant</th><th>Salle</th></tr></thead><tbody>${rows}</tbody></table></section>`;
    }).join('');
    const popup = window.open('', '_blank', 'width=900,height=700,scrollbars=yes');
    if (!popup) { notify('Autorisez les fenêtres pop-up pour générer le PDF.', true); return; }
    popup.document.open();
    popup.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Emploi du temps - ${escHtml(selectedClass?.name || 'semaine')}</title><style>html,body{background:#fff}body{font-family:Arial,sans-serif;color:#17251d;margin:0;padding:15mm}${PRINT_DOC_CSS}h2{font-size:17px;margin:24px 0 8px;color:#176b49}.meta{font-size:12px;color:#637269;margin-bottom:18px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #cfd8d2;padding:8px;text-align:left}th{background:#e8f3ed}section{break-inside:avoid} @media print{body{margin:0;padding:15mm} @page{size:A4 portrait;margin:0}}</style></head><body>${docHeadHtml(state, 'EMPLOI DU TEMPS HEBDOMADAIRE')}<div class="meta"><strong>${escHtml(schoolName)}</strong> · ${escHtml(selectedClass?.name || 'Toutes les classes')} · Année ${escHtml(state?.header?.annee || '')}</div>${sections || emptyNotice}</body></html>`);
    popup.document.close();
    popup.focus();
    setTimeout(() => { try { popup.print(); } catch (_) { popup.focus(); } }, 900);
  };
  const downloadTemplate = () => downloadCSV('modele-emploi-du-temps.csv', [['Jour', 'Début', 'Fin', 'Matière', 'Classe', 'Identifiant classe', 'Enseignant', 'Salle'], ['Lundi', '08:00', '09:00', 'Mathématiques', 'CI A', '', '', 'Salle 1']]);
  const parseCSVLine = (line) => {
    const cells = []; let current = ''; let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"' && quoted) { current += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if ((char === ';' || char === ',') && !quoted) { cells.push(current.trim()); current = ''; }
      else current += char;
    }
    cells.push(current.trim());
    return cells;
  };
  const importCSV = (event) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const lines = String(reader.result || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
        if (lines.length < 2) throw new Error('Le fichier ne contient aucune ligne de données.');
        const headers = parseCSVLine(lines[0]).map((header) => header.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim());
        const indexOf = (...names) => headers.findIndex((header) => names.includes(header));
        const iDay = indexOf('jour'); const iStart = indexOf('debut', 'heure debut'); const iEnd = indexOf('fin', 'heure fin');
        const iSubject = indexOf('matiere', 'cours'); const iClass = indexOf('classe'); const iClassId = indexOf('identifiant classe', 'classe id', 'classid');
        const iTeacher = indexOf('enseignant', 'professeur'); const iRoom = indexOf('salle');
        if (iDay < 0 || iStart < 0 || iEnd < 0 || iSubject < 0 || (iClass < 0 && iClassId < 0)) throw new Error('Colonnes requises absentes : Jour, Début, Fin, Matière et Classe.');
        const classEntries = Object.entries(classes);
        const findClassId = (value, idValue) => {
          const candidate = String(idValue || value || '').trim(); if (!candidate) return '';
          if (classes[candidate]) return candidate;
          const found = classEntries.find(([id, cls]) => id.toLowerCase() === candidate.toLowerCase() || String(cls.name || '').trim().toLowerCase() === candidate.toLowerCase());
          return found ? found[0] : '';
        };
        const imported = lines.slice(1).map((line, rowIndex) => {
          const cells = parseCSVLine(line); const rawDay = cells[iDay] || ''; const day = TIMETABLE_DAYS.find((item) => item.toLowerCase() === rawDay.trim().toLowerCase()); const start = cells[iStart] || ''; const end = cells[iEnd] || '';
          const subject = cells[iSubject] || ''; const targetClassId = findClassId(iClass > -1 ? cells[iClass] : '', iClassId > -1 ? cells[iClassId] : '');
          if (!day || !start || !end || !subject || !targetClassId) throw new Error(`Ligne ${rowIndex + 2} invalide : vérifiez le jour, les horaires, la matière et la classe.`);
          return { id: uid('slot'), day, start, end, subject, classId: targetClassId, teacher: iTeacher > -1 ? cells[iTeacher] || '' : '', room: iRoom > -1 ? cells[iRoom] || '' : '' };
        });
        updateState((prev) => ({ ...prev, emploiDuTemps: [...timetableList(prev), ...imported] }));
        setImportError(''); notify(`${imported.length} créneau(x) importé(s)`);
      } catch (error) { setImportError(error.message || 'Impossible de lire le fichier CSV.'); }
    };
    reader.readAsText(file, 'UTF-8');
  };

  return (
    <div className="space-y-4 sygenop-fade">
      <div className="sygenop-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-xs font-bold uppercase text-muted">Planning scolaire</div>
            <h2 className="text-xl font-extrabold mt-1 text-ink">Emploi du temps</h2>
            <p className="text-sm mt-1 text-muted">Consultez les matières et horaires par classe.</p>
          </div>
          <CalendarDays size={30} style={{ color: 'var(--green-d)' }} />
        </div>
      </div>

      <div className="sygenop-card p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs font-semibold block mb-1 text-muted">Classe</label>
          <select value={filterClassId || 'all'} onChange={(event) => setFilterClassId(event.target.value)} className="px-3 py-2 rounded-lg border text-sm sygenop-input">
            <option value="all">Toutes les classes</option>
            {Object.entries(classes).map(([id, cls]) => <option key={id} value={id}>{cls.name} — {cls.level}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-2 ml-auto">
          <button type="button" onClick={exportCSV} className="px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}><Download size={14} /> Télécharger CSV</button>
          <button type="button" onClick={printPDF} className="px-3 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: 'var(--green-d)' }}><Printer size={14} /> Télécharger PDF</button>
          {canEdit && <>
            <button type="button" onClick={downloadTemplate} className="px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 sygenop-btn sygenop-btn--ghost"><FileSpreadsheet size={14} /> Modèle CSV</button>
            <input ref={importInputRef} type="file" accept=".csv,text/csv" onChange={importCSV} className="hidden" />
            <button type="button" onClick={() => importInputRef.current?.click()} className="px-3 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}><Upload size={14} /> Importer CSV</button>
          </>}
        </div>
        {importError && <div className="w-full text-xs" style={{ color: 'var(--red)' }}><AlertCircle size={13} className="inline mr-1" />{importError}</div>}
      </div>

      {canEdit && (
        <form onSubmit={addEntry} className="sygenop-card p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <select value={form.day} onChange={(event) => setForm((prev) => ({ ...prev, day: event.target.value }))} className="px-3 py-2 rounded-lg border text-sm sygenop-input">{TIMETABLE_DAYS.map((day) => <option key={day}>{day}</option>)}</select>
          <input type="time" value={form.start} onChange={(event) => setForm((prev) => ({ ...prev, start: event.target.value }))} className="px-3 py-2 rounded-lg border text-sm sygenop-input" />
          <input type="time" value={form.end} onChange={(event) => setForm((prev) => ({ ...prev, end: event.target.value }))} className="px-3 py-2 rounded-lg border text-sm sygenop-input" />
          <input value={form.subject} onChange={(event) => setForm((prev) => ({ ...prev, subject: event.target.value }))} placeholder="Matière" className="px-3 py-2 rounded-lg border text-sm sygenop-input" />
          <select value={form.classId} onChange={(event) => setForm((prev) => ({ ...prev, classId: event.target.value }))} className="px-3 py-2 rounded-lg border text-sm sygenop-input"><option value="">Classe</option>{Object.entries(classes).map(([id, cls]) => <option key={id} value={id}>{cls.name}</option>)}</select>
          <select value={form.teacher} onChange={(event) => setForm((prev) => ({ ...prev, teacher: event.target.value }))} className="px-3 py-2 rounded-lg border text-sm sygenop-input"><option value="">{cycleTerminology(state?.header?.cycle || LEGACY_DEFAULT_CYCLE).teacher}</option>{personnel.filter((person) => person.role === 'Enseignant(e)').map((person) => <option key={person.id} value={personFullName(person)}>{personFullName(person)}</option>)}</select>
          <input value={form.room} onChange={(event) => setForm((prev) => ({ ...prev, room: event.target.value }))} placeholder="Salle (facultatif)" className="px-3 py-2 rounded-lg border text-sm sygenop-input" />
          <button type="submit" className="px-4 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--green-d)' }}><Plus size={15} className="inline mr-1" /> Ajouter le créneau</button>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {TIMETABLE_DAYS.map((day) => {
          const dayEntries = entries.filter((entry) => entry.day === day);
          return <div key={day} className="sygenop-card p-4 min-h-[150px]">
            <div className="font-bold mb-3" style={{ color: 'var(--green-d)' }}>{day}</div>
            {dayEntries.length ? <div className="space-y-2">{dayEntries.map((entry) => <div key={entry.id} className="rounded-lg p-3" style={{ background: 'var(--green-l)' }}><div className="flex items-start justify-between gap-2"><div><div className="font-semibold text-sm text-ink">{entry.subject}</div><div className="text-xs mt-1 text-muted">{entry.start} – {entry.end} · {classes[entry.classId]?.name || 'Classe'}{entry.room ? ` · Salle ${entry.room}` : ''}</div>{entry.teacher && <div className="text-xs mt-1 text-muted">{entry.teacher}</div>}</div>{canEdit && <button type="button" onClick={() => removeEntry(entry.id)} style={{ color: 'var(--red)' }} title="Supprimer"><Trash2 size={14} /></button>}</div></div>)}</div> : <div className="text-xs text-muted">Aucun cours programmé.</div>}
          </div>;
        })}
      </div>
    </div>
  );
}

function StudentSectionNav({ section, onChange }) {
  return (
    <div className="no-print flex flex-wrap gap-1.5 p-1 rounded-xl w-fit" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
      {[['classes', 'Classes et élèves'], ['appel', 'Faire l\u2019appel'], ['rapport', 'Statistiques'], ['timetable', 'Emploi du temps'], ['synth', 'Synthèse'], ['bull', 'Bulletins']].map(([id, label]) => (
        <button key={id} onClick={() => onChange(id)} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={section === id ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}>
          {label}
        </button>
      ))}
    </div>
  );
}

function SaisieView({ state, loading, updateState, notify, teacherName, teacherStaffId, readOnly, initialSection = 'classes' }) {
  const [studentSection, setStudentSection] = useState(initialSection);
  const [level, setLevel] = useState('CI');
  const [classId, setClassId] = useState(null);
  const [period, setPeriod] = useState('T1');
  const [evaluationType, setEvaluationType] = useState('controle');
  const [classModal, setClassModal] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [classToDelete, setClassToDelete] = useState(null);

const classes = (state && state.classes) || {};
  const personnel = (state && state.personnel) || [];
  const schoolLevels = levelsForSchool(state);
  const schoolPeriods = periodsForSchool(state);
  const isTeacherScoped = !!teacherName;
  // Limite « 2 classes par niveau » réservée aux écoles privées (par défaut, sauf modification du Super Admin).
  // La même logique de détection que dans PaieTab est utilisée.
  const isPrivateSchool = String(state?.header?.type || state?.type || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('privee');
  const maxClassesPerLevel = state?.header?.max_classes_per_level ?? (isPrivateSchool ? 2 : null);
  const classCountForLevel = (Object.values(classes) || []).filter((c) => c.level === level).length;
  const privateLevelFull = maxClassesPerLevel && classCountForLevel >= maxClassesPerLevel;
  useEffect(() => {
    if (schoolLevels.length && !schoolLevels.includes(level)) setLevel(schoolLevels[0]);
  }, [schoolLevels.join(','), level]);
  useEffect(() => {
    if (schoolPeriods.length && !schoolPeriods.some((item) => item.key === period)) setPeriod(schoolPeriods[0].key);
  }, [schoolPeriods.map((item) => item.key).join(','), period]);
  // Suit la période activée globalement (barre du haut) quand elle change
  const globalPeriode = state && state.header && state.header.periodeActif;
  useEffect(() => {
    if (globalPeriode && globalPeriode !== period && schoolPeriods.some((p) => p.key === globalPeriode)) setPeriod(globalPeriode);
  }, [globalPeriode]);
  const availableLevels = isTeacherScoped
    ? schoolLevels.filter((l) => Object.values(classes).some((c) => c.level === l && classHasTeacher(c, teacherName)))
    : schoolLevels;
  const classEntries = Object.entries(classes)
    .filter(([, c]) => c.level === level && (!isTeacherScoped || classHasTeacher(c, teacherName)))
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));

  useEffect(() => {
    if (isTeacherScoped && availableLevels.length && !availableLevels.includes(level)) {
      setLevel(availableLevels[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacherScoped, availableLevels.join(','), level]);

  useEffect(() => {
    if (!classEntries.some(([id]) => id === classId)) {
      setClassId(classEntries.length ? classEntries[0][0] : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, classEntries.map(([id]) => id).join(',')]);

function saveClass(form) {
    // École privée : blocage de la création d'une nouvelle classe au-delà de
    // la limite définie (par défaut 2, modifiable par le Super Admin).
    // L'édition d'une classe existante reste autorisée.
    if (!(classModal && classModal.__key) && privateLevelFull) {
      notify(`Limite atteinte : cette école privée ne peut compter que ${maxClassesPerLevel} classes par niveau.`, true);
      return;
    }
    updateState((prev) => {
      const next = { ...prev, classes: { ...(prev.classes || {}) } };
      if (classModal && classModal.__key) {
        next.classes[classModal.__key] = { ...next.classes[classModal.__key], name: form.name.trim(), teacher: form.teacher || '', coTeachers: supportsMultiTeachers(next.classes[classModal.__key].level) ? (form.coTeachers || []) : [], matieres: form.teacher ? (form.matieres || []) : [] };
      } else {
        const id = uid('cls');
        next.classes[id] = { id, name: form.name.trim(), level, teacher: form.teacher || '', coTeachers: supportsMultiTeachers(level) ? (form.coTeachers || []) : [], matieres: form.teacher ? (form.matieres || []) : [], students: [] };
        setClassId(id);
      }
      return next;
    });
    notify(classModal && classModal.__key ? 'Classe mise à jour' : 'Classe ajoutée');
    setClassModal(undefined);
  }

  function deleteClass(key) {
    updateState((prev) => {
      const next = { ...prev, classes: { ...(prev.classes || {}) } };
      delete next.classes[key];
      return next;
    });
    notify('Classe supprimée');
    setClassToDelete(null);
  }

  const cfg = cfgForLevel(state, level);
  const currentClass = classId ? classes[classId] : null;

  // Un professeur de Moyen/Secondaire ne doit voir et saisir que les
  // matières qui lui sont effectivement affectées dans cette classe
  // (cochées lors de la création/modification de la classe). Les autres
  // profils (Super Admin, Accès IEF, admin d'école) gardent le barème
  // complet. Si la classe n'a pas encore de matières enregistrées
  // (anciennes classes créées avant cette fonctionnalité), aucune
  // restriction n'est appliquée pour ne rien casser côté existant.
  const cycle = state?.header?.cycle;
  const gradingCfg = useMemo(() => {
    if (!isTeacherScoped || !currentClass || !['moyen', 'secondaire'].includes(cycle)) return cfg;
    const assigned = currentClass.matieres;
    if (!Array.isArray(assigned) || !assigned.length) return cfg;
    return {
      ...cfg,
      domains: (cfg.domains || [])
        .map((d) => ({ ...d, disciplines: (d.disciplines || []).filter((x) => assigned.includes(x.label)) }))
        .filter((d) => d.disciplines.length),
    };
  }, [cfg, isTeacherScoped, currentClass, cycle]);

  if (loading || !state) {
    return (
      <div className="flex items-center justify-center py-24 text-muted">
        <Loader2 className="animate-spin mr-2" size={18} /> Chargement des données…
      </div>
    );
  }

  if (isTeacherScoped && !availableLevels.length) {
    return (
      <div className="sygenop-card p-10 text-center text-sm text-muted">
        Aucune classe ne vous est assignée pour le moment. Demandez à la direction de l'école de vous assigner une classe (onglet Personnel).
      </div>
    );
  }

    const commonStudentHeader = (
    <>
      {teacherName && <StudentTransferRequestsPanel state={state} updateState={updateState} notify={notify} mode="teacher" teacherName={teacherName} teacherStaffId={teacherStaffId} />}
      {readOnly && <div className="sygenop-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2" style={{ background: 'var(--gold-l)', color: '#92710c' }}><Eye size={14} /> Mode consultation (IEF) — lecture seule, aucune modification possible.</div>}
      {!!(state && state.mohebs) && <div className="sygenop-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}><BookOpen size={14} /> École MOHEBS — le barème inclut le domaine « Langue Nationale » pour chaque niveau.</div>}
      <StudentSectionNav section={studentSection} onChange={setStudentSection} />
    </>
  );

  if (studentSection === 'appel') {
    return <div className="space-y-4 sygenop-fade">{commonStudentHeader}{currentClass ? <AppelView state={state} updateState={updateState} notify={notify} teacherStaffId={teacherStaffId} readOnly={readOnly} fixedClassId={classId} /> : <div className="sygenop-card p-5 text-sm text-muted">Sélectionnez d'abord une classe dans l'onglet « Classes et élèves ».</div>}</div>;
  }
  if (studentSection === 'rapport') {
    return <div className="space-y-4 sygenop-fade">{commonStudentHeader}{currentClass ? <PresenceRapportView state={state} fixedClassId={classId} /> : <div className="sygenop-card p-5 text-sm text-muted">Sélectionnez d'abord une classe dans l'onglet « Classes et élèves ».</div>}</div>;
  }
  if (studentSection === 'timetable') {
    return <div className="space-y-4 sygenop-fade">{commonStudentHeader}<TimetableView state={state} classId={classId} teacherName={teacherName} updateState={updateState} notify={notify} readOnly={true} /></div>;
  }
  if (studentSection === 'synth') {
    return <div className="space-y-4 sygenop-fade">{commonStudentHeader}<SynthView state={state} loading={loading} teacherName={teacherName} /></div>;
  }
  if (studentSection === 'bull') {
    return <div className="space-y-4 sygenop-fade">{commonStudentHeader}<BulletinView state={state} loading={loading} teacherName={teacherName} /></div>;
  }

  return (
    <div className="space-y-4 sygenop-fade">
      {commonStudentHeader}
      <div className="flex flex-wrap gap-1.5 p-1 rounded-xl w-fit" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
        {(isTeacherScoped ? availableLevels : schoolLevels).map((l) => (
          <button
            key={l}
            onClick={() => setLevel(l)}
            className="px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={level === l ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
          >
            {l}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {classEntries.map(([id, c]) => (
          <button
            key={id}
            onClick={() => setClassId(id)}
            className="px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5"
            style={classId === id ? { background: 'var(--gold)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--muted)' }}
            title={classTeacherNames(c).length ? classTeacherNames(c).join(', ') : undefined}
          >
            {c.name} <span style={{ opacity: 0.7 }}>· {(c.students || []).length}</span>
            {classTeacherNames(c).length > 1 && <span style={{ opacity: 0.7 }}>· {classTeacherNames(c).length} ens.</span>}
          </button>
        ))}
{!isTeacherScoped && !readOnly && (
          <button
            onClick={() => setClassModal(null)}
            disabled={privateLevelFull}
            title={privateLevelFull ? `Limite atteinte : cette école privée ne peut compter que ${maxClassesPerLevel} classes en ${level}.` : 'Ajouter une classe'}
            className="px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}
          >
            <Plus size={13} /> Classe
          </button>
        )}
        {currentClass && !isTeacherScoped && !readOnly && (
          <>
            <button
              onClick={() => setClassModal({ ...currentClass, __key: classId })}
              className="p-1.5 rounded-full hover:bg-black/5 text-muted" title="Modifier la classe"
            >
              <Pencil size={14} />
            </button>
            <button
              onClick={() => setClassToDelete({ key: classId, name: currentClass.name })}
              className="p-1.5 rounded-full hover:bg-black/5" style={{ color: 'var(--red)' }} title="Supprimer la classe"
            >
              <Trash2 size={14} />
            </button>
          </>
        )}

        <div className="ml-auto flex gap-1.5 p-1 rounded-xl" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
          {schoolPeriods.map((t) => (
            <button
              key={t.key}
              onClick={() => setPeriod(t.key)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={period === t.key ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select value={evaluationType} onChange={(e) => setEvaluationType(e.target.value)} className="px-3 py-1.5 rounded-lg text-xs font-semibold border sygenop-input" aria-label="Type d’évaluation">
          {EVALUATION_TYPES.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
        </select>
      </div>

      {currentClass && (
        <div className="sygenop-card px-4 py-3 flex flex-wrap items-center gap-3">
          <div><div className="text-xs font-bold uppercase text-muted">Matériel affecté à {currentClass.name}</div><div className="text-sm mt-1">{(state.affectationsMateriel || []).filter((a) => a.classId === classId).map((a) => `${(state.materiel || []).find((m) => m.id === a.materielId)?.nom || 'Matériel'} (${a.quantite})`).join(' · ') || 'Aucun matériel affecté pour le moment.'}</div></div>
          <span className="ml-auto text-xs text-muted">Consultation uniquement — affectation par la comptabilité.</span>
        </div>
      )}

      {!currentClass ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          Aucune classe de {level} pour le moment. Ajoutez-en une pour commencer la saisie des notes.
        </div>
      ) : isTeacherScoped && ['moyen', 'secondaire'].includes(cycle) && Array.isArray(currentClass.matieres) && currentClass.matieres.length && !(gradingCfg.domains || []).length ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          Aucune matière ne vous est affectée pour {currentClass.name}. Demandez à la direction de l'école de vérifier votre affectation (Élèves → Classes, ou Personnel → vos spécialités).
        </div>
      ) : (
<GradeGrid
          key={classId + period}
          classId={classId}
          cls={currentClass}
          state={state}
          cfg={gradingCfg}
          periodKey={evaluationKey(period, evaluationType)}
          periods={schoolPeriods}
          updateState={updateState}
          notify={notify}
          readOnly={readOnly}
          isPrivateSchool={isPrivateSchool}
          maxStudentsPerClass={state?.header?.max_students_per_class ?? (isPrivateSchool ? 40 : null)}
        />
      )}

      {classModal !== undefined && (
        <ClassModal cls={classModal} level={level} personnel={personnel} materiel={state.materiel || []} affectations={state.affectationsMateriel || []} cfg={cfg} onSave={saveClass} onClose={() => setClassModal(undefined)} />
      )}
      {classToDelete && (
        <ConfirmModal
          title="Supprimer cette classe ?"
          message={`« ${classToDelete.name} » et tous les élèves/notes qu'elle contient seront définitivement supprimés.`}
          danger
          onConfirm={() => deleteClass(classToDelete.key)}
          onCancel={() => setClassToDelete(null)}
        />
      )}
    </div>
  );
}

function ageFromBirth(dateNaissance) {
  if (!dateNaissance) return '';
  const d = new Date(dateNaissance);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return String(age);
}

function AddStudentModal({ onSave, onClose }) {
  const [form, setForm] = useState({ prenom: '', nom: '', dateNaissance: '', lieuNaissance: '', genre: '', adresse: '', handicap: '', typeHandicap: '', casSocial: '' });
  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function submit(e) {
    e.preventDefault();
    if (!form.nom.trim() && !form.prenom.trim()) { return; }
    const id = uid('stu');
    onSave({ id, cardCode: `ELV-${id.slice(-8).toUpperCase()}`, prenom: form.prenom.trim(), nom: form.nom.trim(), dateNaissance: form.dateNaissance, lieuNaissance: form.lieuNaissance.trim(), age: ageFromBirth(form.dateNaissance), genre: form.genre.trim().toUpperCase().slice(0, 1), adresse: form.adresse.trim(), handicap: form.handicap, typeHandicap: form.handicap === 'Oui' ? form.typeHandicap.trim() : '', casSocial: normalizeCasSocial(form.casSocial), scores: {}, validated: {} });
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card w-full max-w-lg max-h-[92vh] flex flex-col overflow-hidden sygenop-fade">
        <div className="flex items-center justify-between gap-3 px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--modal-line)' }}>
          <div>
            <div className="font-bold text-[15px] text-ink">Ajouter un élève</div>
            <div className="text-[11px] text-muted">Création d'une nouvelle fiche élève</div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--muted)', background: 'var(--bg)' }}><X size={17} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3 overscroll-contain">
          <div className="flex items-center gap-2">
            <span className="w-1 h-3.5 rounded-full" style={{ background: 'var(--green-d)' }} />
            <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--green-d)' }}>Identité</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Prénom</label>
              <input autoFocus value={form.prenom} onChange={(e) => set('prenom', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Prénom de l'élève" />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Nom</label>
              <input value={form.nom} onChange={(e) => set('nom', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Nom de l'élève" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Date de naissance</label>
              <input type="date" value={form.dateNaissance} onChange={(e) => set('dateNaissance', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Lieu de naissance</label>
              <input value={form.lieuNaissance} onChange={(e) => set('lieuNaissance', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : Dakar" />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Genre</label>
            <select value={form.genre} onChange={(e) => set('genre', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle}>
              <option value="">—</option>
              <option value="M">Masculin</option>
              <option value="F">Féminin</option>
            </select>
          </div>

          <div className="flex items-center gap-2 pt-3" style={{ borderTop: '1px dashed var(--line)' }}>
            <span className="w-1 h-3.5 rounded-full" style={{ background: 'var(--gold)' }} />
            <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--gold)' }}>Situation</span>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Adresse</label>
            <input value={form.adresse} onChange={(e) => set('adresse', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : Parcelles Assainies, Dakar" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Handicap</label>
              <select value={form.handicap} onChange={(e) => set('handicap', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle}>
                <option value="">—</option>
                <option value="Oui">Oui</option>
                <option value="Non">Non</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Réduction cas social (%)</label>
              <input type="number" min="0" max="100" value={form.casSocial} onChange={(e) => set('casSocial', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="0" />
            </div>
          </div>
          {form.handicap === 'Oui' && (
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Type de handicap</label>
              <input value={form.typeHandicap} onChange={(e) => set('typeHandicap', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : moteur, visuel, auditif…" />
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 flex-shrink-0" style={{ borderTop: '1px solid var(--modal-line)' }}>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button type="submit" className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors" style={{ background: 'var(--green-d)' }}>
            <Plus size={14} className="inline -mt-0.5 mr-1" /> Ajouter l'élève
          </button>
        </div>
      </form>
    </div>
  );
}

function StudentFicheModal({ student, clsName, onCard, onCert, onEdit, onClose }) {
  const birthDate = student.dateNaissance
    ? (() => { const d = new Date(student.dateNaissance.split('-').length === 3 ? student.dateNaissance + 'T00:00:00' : student.dateNaissance); return isNaN(d.getTime()) ? student.dateNaissance : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); })()
    : '';
  const row = (label, value, action) => (
    <div className="flex items-center justify-between py-2.5" style={{ borderBottom: '1px solid var(--line)' }}>
      <span className="text-xs font-semibold text-muted">{label}</span>
      <span className="text-sm font-medium text-ink">{value || '—'}</span>
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="sygenop-card p-8 max-w-2xl w-full sygenop-fade">
        <div className="flex items-center justify-between mb-5">
          <div className="font-bold text-lg text-ink">Fiche élève</div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={20} /></button>
        </div>
        <div className="flex items-center gap-4 mb-5">
          <span style={{ display: 'inline-flex', lineHeight: 0 }}>
            {isFemale(student.genre) ? <AvatarGirl size={64} /> : <AvatarBoy size={64} />}
          </span>
          <div>
            <div className="font-bold text-xl text-ink">
              {((student.prenom || '') + ' ' + (student.nom || '')).trim() || <span className="italic text-sm text-muted">Élève sans nom</span>}
            </div>
            <div className="text-sm mt-0.5 text-muted">{clsName || ''}</div>
          </div>
        </div>
        <div>
          {row('Prénom', student.prenom)}
          {row('Nom', student.nom)}
          {row('Date de naissance', birthDate)}
          {row('Lieu de naissance', student.lieuNaissance)}
          {row('Sexe', student.genre === 'F' ? 'Féminin' : student.genre === 'M' ? 'Masculin' : student.genre)}
          {row('Adresse', student.adresse)}
          {row('Handicap', student.handicap ? (student.handicap === 'Oui' && student.typeHandicap ? `Oui — ${student.typeHandicap}` : student.handicap) : '')}
          {row('Cas social', normalizeCasSocial(student.casSocial) > 0 ? `${normalizeCasSocial(student.casSocial)}%` : '—')}
          {row('Tuteur / Responsable', student.tuteurNom)}
          {row('Contact tuteur', student.tuteurTel)}
        </div>
        <div className="grid gap-3 mt-6" style={{ gridTemplateColumns: onEdit ? '1fr 1fr' : '1fr 1fr 1fr' }}>
          <button type="button" onClick={onCard} className="px-3 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5" style={{ background: 'var(--gold, #ffd100)' }}><CreditCard size={16} /> Carte d’identité</button>
          <button type="button" onClick={onCert} className="px-3 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5" style={{ background: 'var(--green-d)' }}><FileText size={16} /> Certificat de scolarité</button>
          <button type="button" onClick={onClose} className="px-3 py-2.5 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--muted)' }}>Fermer</button>
          {onEdit && <button type="button" onClick={onEdit} className="px-3 py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5" style={{ background: 'var(--panel)', color: 'var(--ink)' }}><Pencil size={16} /> Modifier</button>}
        </div>
      </div>
    </div>
  );
}

function EditStudentModal({ student, onSave, onClose }) {
  const [form, setForm] = useState({
    prenom: student.prenom || '',
    nom: student.nom || '',
    dateNaissance: student.dateNaissance || '',
    lieuNaissance: student.lieuNaissance || '',
    genre: student.genre || '',
    tuteurNom: student.tuteurNom || '',
    tuteurTel: student.tuteurTel || '',
    photoData: student.photoData || '',
    adresse: student.adresse || '',
    handicap: student.handicap || '',
    typeHandicap: student.typeHandicap || '',
    casSocial: String(normalizeCasSocial(student.casSocial)),
  });
  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function submit(e) {
    e.preventDefault();
    if (!form.nom.trim() && !form.prenom.trim()) { return; }
    onSave({
      prenom: form.prenom.trim(),
      nom: form.nom.trim(),
      dateNaissance: form.dateNaissance,
      lieuNaissance: form.lieuNaissance.trim(),
      age: ageFromBirth(form.dateNaissance),
      genre: form.genre.trim().toUpperCase().slice(0, 1),
      tuteurNom: form.tuteurNom.trim(),
      tuteurTel: form.tuteurTel.trim(),
      photoData: form.photoData,
      adresse: form.adresse.trim(),
      handicap: form.handicap,
      typeHandicap: form.handicap === 'Oui' ? form.typeHandicap.trim() : '',
      casSocial: normalizeCasSocial(form.casSocial),
    });
  }
return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card w-full max-w-lg max-h-[92vh] flex flex-col overflow-hidden sygenop-fade">
        <div className="flex items-center justify-between gap-3 px-6 py-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--modal-line)' }}>
          <div>
            <div className="font-bold text-[15px] text-ink">Modifier l'élève</div>
            <div className="text-[11px] text-muted">Mise à jour de la fiche élève</div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg transition-colors" style={{ color: 'var(--muted)', background: 'var(--bg)' }}><X size={17} /></button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-3 overscroll-contain">
          <div className="flex items-center gap-2">
            <span className="w-1 h-3.5 rounded-full" style={{ background: 'var(--green-d)' }} />
            <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--green-d)' }}>Identité</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Prénom</label>
              <input autoFocus value={form.prenom} onChange={(e) => set('prenom', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Prénom de l'élève" />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Nom</label>
              <input value={form.nom} onChange={(e) => set('nom', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Nom de l'élève" />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Date de naissance</label>
              <input type="date" value={form.dateNaissance} onChange={(e) => set('dateNaissance', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Lieu de naissance</label>
              <input value={form.lieuNaissance} onChange={(e) => set('lieuNaissance', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : Dakar" />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Genre</label>
            <select value={form.genre} onChange={(e) => set('genre', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle}>
              <option value="">—</option>
              <option value="M">Masculin</option>
              <option value="F">Féminin</option>
            </select>
          </div>

          <div className="flex items-center gap-2 pt-3" style={{ borderTop: '1px dashed var(--line)' }}>
            <span className="w-1 h-3.5 rounded-full" style={{ background: 'var(--gold)' }} />
            <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--gold)' }}>Situation</span>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Adresse</label>
            <input value={form.adresse} onChange={(e) => set('adresse', e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : Parcelles Assainies, Dakar" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Handicap</label>
              <select value={form.handicap} onChange={(e) => set('handicap', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle}>
                <option value="">—</option>
                <option value="Oui">Oui</option>
                <option value="Non">Non</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Réduction cas social (%)</label>
              <input type="number" min="0" max="100" value={form.casSocial} onChange={(e) => set('casSocial', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="0" />
            </div>
          </div>
          {form.handicap === 'Oui' && (
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Type de handicap</label>
              <input value={form.typeHandicap} onChange={(e) => set('typeHandicap', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : moteur, visuel, auditif…" />
            </div>
          )}

          <div className="flex items-center gap-2 pt-3" style={{ borderTop: '1px dashed var(--line)' }}>
            <span className="w-1 h-3.5 rounded-full" style={{ background: 'var(--green-d)' }} />
            <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: 'var(--green-d)' }}>Tuteur / Responsable</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Nom du tuteur</label>
              <input value={form.tuteurNom} onChange={(e) => set('tuteurNom', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : M. Diop" />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Téléphone du tuteur</label>
              <input value={form.tuteurTel} onChange={(e) => set('tuteurTel', e.target.value)}
                className="w-full px-3 py-2 rounded-lg border text-sm" style={fieldStyle} placeholder="77 000 00 00" />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Photo de l'élève</label>
            <div className="flex items-center gap-3">
              <div className="w-14 h-16 rounded-lg border overflow-hidden flex items-center justify-center" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}>{form.photoData ? <img src={form.photoData} alt="Aperçu" className="w-full h-full object-cover" /> : <span className="text-[10px] text-center text-muted">Aucune photo</span>}</div>
              <input type="file" accept="image/*" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; readImageCompressed(file).then((data) => { if (data) set('photoData', data); }); }} className="text-xs" />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 flex-shrink-0" style={{ borderTop: '1px solid var(--modal-line)' }}>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-semibold transition-colors" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button type="submit" className="px-5 py-2 rounded-lg text-sm font-semibold text-white transition-colors" style={{ background: 'var(--green-d)' }}>
            <Save size={14} className="inline -mt-0.5 mr-1" /> Enregistrer
          </button>
        </div>
      </form>
    </div>
  );
}

/* ============================================================
   AVATARS ÉLÈVES — images fournies (garçon / fille)
   Placées dans public/homme.png et public/femme.png, affichées en
   rond devant le prénom de chaque élève dans la saisie des notes.
   ============================================================ */
const HOMME_AVATAR = new URL('./public/homme.png', import.meta.url).href;
const FEMME_AVATAR = new URL('./public/femme.png', import.meta.url).href;

function AvatarBoy({ size = 34, style }) {
  return (
    <img
      src={HOMME_AVATAR}
      alt="Homme"
      width={size}
      height={size}
      style={{
        borderRadius: '50%',
        objectFit: 'cover',
        display: 'inline-block',
        ...style,
      }}
      onError={(e) => { e.currentTarget.style.display = 'none'; }}
    />
  );
}
function AvatarGirl({ size = 34, style }) {
  return (
    <img
      src={FEMME_AVATAR}
      alt="Femme"
      width={size}
      height={size}
      style={{
        borderRadius: '50%',
        objectFit: 'cover',
        display: 'inline-block',
        ...style,
      }}
      onError={(e) => { e.currentTarget.style.display = 'none'; }}
    />
  );
}

function normalizeGender(value) {
  return String(value || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function isFemale(value) {
  const normalized = normalizeGender(value);
  return ['femme', 'f', 'feminin', 'feminine', 'female'].includes(normalized);
}
function isMale(value) {
  const normalized = normalizeGender(value);
  return ['homme', 'h', 'm', 'masculin', 'masculine', 'male'].includes(normalized);
}
function staffGenderSummary(personnel) {
  return (Array.isArray(personnel) ? personnel : []).reduce((summary, person) => {
    summary.total++;
    if (isFemale(person.genre)) summary.female++;
    else if (isMale(person.genre)) summary.male++;
    else summary.unknown++;
    return summary;
  }, { total: 0, male: 0, female: 0, unknown: 0 });
}

function StudentIdentityCard({ state, cls, student }) {
  const code = student.cardCode || `ELV-${String(student.id || '').slice(-8).toUpperCase()}`;
  const school = state.header?.ecole || 'Établissement scolaire';
  const birthDate = student.dateNaissance
    ? (() => { const d = new Date((student.dateNaissance || '').replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3/$1')); return isNaN(d.getTime()) ? student.dateNaissance : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); })()
    : '';
  const qrValue = `SYGENOP|CARTE|${code}|${student.id}`;
  return <div className="student-id-card-sheet"><div className="student-id-card-front sygenop-card p-5" style={{ border: '2px solid var(--green-d)' }}>
    <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-2 flex-shrink-0"><SenegalFlag className="w-16 h-auto flex-shrink-0" /></div><div><div className="text-lg font-bold" style={{ color: 'var(--green-d)' }}>{school}</div><div className="text-xs text-muted">CARTE D’IDENTITÉ SCOLAIRE · RECTO · Année {state.header?.annee || 'en cours'}</div></div><SchoolLogoMark state={state} width={72} /></div>
    <div className="grid grid-cols-[1fr_150px] gap-4 mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}><div className="space-y-1 text-sm"><div><b>Élève :</b> {student.prenom || '—'} {student.nom || ''}</div><div><b>Identifiant :</b> {code}</div><div><b>Classe :</b> {cls.name} · {cls.level}</div><div><b>Né(e) le :</b> {birthDate || '—'}</div><div><b>Lieu de naissance :</b> {student.lieuNaissance || '—'}</div><div><b>Genre :</b> {student.genre === 'F' ? 'Féminin' : student.genre === 'M' ? 'Masculin' : (student.genre || '—')}</div><div><b>Tuteur / Responsable :</b> {student.tuteurNom || 'Non renseigné'}</div><div><b>Contact tuteur :</b> {student.tuteurTel || 'Non renseigné'}</div></div><div className="border rounded-lg flex items-center justify-center overflow-hidden" style={{ borderColor: 'var(--line)', height: 150, background: 'var(--bg)' }}>{student.photoData ? <img src={student.photoData} alt={`Photo de ${student.prenom || 'l’élève'}`} className="w-full h-full object-cover" /> : <span className="text-xs text-center px-2 text-muted">Photo de l’élève</span>}</div></div>
    <div className="flex items-end justify-between gap-4 mt-2 pt-2" style={{ borderTop: '1px solid var(--line)' }}><div className="text-[10px] flex-1 text-muted">Scannez ce QR code pour vérifier la situation des mensualités dans l'application.</div><QRBadge value={qrValue} size={64} label="" /></div>
  </div><div className="student-id-card-back sygenop-card p-6 text-center" style={{ border: '2px solid var(--green-d)' }}><div className="font-bold text-lg" style={{ color: 'var(--green-d)' }}>{school}</div><div className="text-xs mb-5 text-muted">CARTE D’IDENTITÉ SCOLAIRE · VERSO</div><QRBadge value={qrValue} size={230} label="Identifiant permanent de l’élève" /><div className="mt-5 text-xs text-muted">Ce QR ne change jamais. La comptabilité le scanne pour consulter les mensualités à jour dans le système.</div></div></div>;
}

/* ---- Carte professionnelle du personnel — même format que la carte élève ---- */
function staffCardCode(person) {
  return person.cardCode || `PERS-${String(person.id || '').slice(-8).toUpperCase()}`;
}

function StaffIdentityCard({ state, person }) {
  const code = staffCardCode(person);
  const school = state.header?.ecole || 'Établissement scolaire';
  const qrValue = `SYGENOP|STAFF|${code}|${person.id}`;
  return <div className="student-id-card-sheet"><div className="student-id-card-front sygenop-card p-5" style={{ border: '2px solid var(--gold, #ffd100)' }}>
    <div className="flex items-start justify-between gap-4"><div className="flex items-center gap-2 flex-shrink-0"><SenegalFlag className="w-16 h-auto flex-shrink-0" /></div><div><div className="text-lg font-bold" style={{ color: 'var(--green-d)' }}>{school}</div><div className="text-xs text-muted">CARTE PROFESSIONNELLE · RECTO · Année {state.header?.annee || 'en cours'}</div></div><SchoolLogoMark state={state} width={72} /></div>
    <div className="grid grid-cols-[1fr_150px] gap-4 mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}><div className="space-y-1 text-sm"><div><b>Agent :</b> {person.prenom || '—'} {person.nom || ''}</div><div><b>Matricule :</b> {code}</div><div><b>Fonction :</b> {person.role || '—'}</div>{person.specialites?.length > 0 && <div><b>Spécialités :</b> {person.specialites.join(', ')}</div>}<div><b>Téléphone :</b> {person.telephone || '—'}</div><div><b>Statut :</b> {person.statut || 'Actif'}</div></div><div className="border rounded-lg flex items-center justify-center overflow-hidden" style={{ borderColor: 'var(--line)', height: 150, background: 'var(--bg)' }}>{person.photoData ? <img src={person.photoData} alt={`Photo de ${person.prenom || 'l’agent'}`} className="w-full h-full object-cover" /> : <span className="text-xs text-center px-2 text-muted">Photo de l’agent</span>}</div></div>
    <div className="flex items-end justify-between gap-4 mt-2 pt-2" style={{ borderTop: '1px solid var(--line)' }}><div className="text-[10px] flex-1 text-muted">Scannez ce QR code : badge d'accès au portail.</div><QRBadge value={qrValue} size={64} label="" /></div>
  </div><div className="student-id-card-back sygenop-card p-6 text-center" style={{ border: '2px solid var(--gold, #ffd100)' }}><div className="font-bold text-lg" style={{ color: 'var(--green-d)' }}>{school}</div><div className="text-xs mb-5 text-muted">CARTE PROFESSIONNELLE · VERSO</div><QRBadge value={qrValue} size={230} label="Identifiant permanent de l’agent" /><div className="mt-5 text-xs text-muted">Ce QR ne change jamais. Il sert de badge d’accès et d’identification du personnel dans le système.</div></div></div>;
}

function StudentSchoolCertificate({ state, cls, student }) {
  const school = state.header?.ecole || 'Établissement scolaire';
  const directeur = state.header?.directeur || '';
  const code = student.cardCode || `ELV-${String(student.id || '').slice(-8).toUpperCase()}`;
  const annee = state.header?.annee || 'année scolaire en cours';
  const today = new Date();
  const dateStr = today.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const localite = state.header?.localite || state.header?.adresse || 'à Dakar';
  const nomComplet = `${student.prenom || ''} ${student.nom || ''}`.trim() || 'l’élève désigné ci-dessous';
  const birthDate = student.dateNaissance
    ? (() => { const d = new Date((student.dateNaissance || '').split('/').length === 3 ? student.dateNaissance : student.dateNaissance + 'T00:00:00'); return isNaN(d.getTime()) ? student.dateNaissance : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); })()
    : '';
  const niveau = cls.level ? `${cls.level}` : '';
  const num = `N° ${String((state.certCounter || 0) + (student.cardCode ? 1 : 0)).padStart(4, '0')}/${annee}`;
  return (
    <div className="mx-auto bg-white" style={{ color: '#11231b', width: '210mm', minHeight: '148mm' }}>
      <div className="relative h-full border-4 p-1.5" style={{ borderColor: 'var(--green-d, #0a1e3d)' }}>
        <div className="h-full border-2 px-7 py-6 flex flex-col" style={{ borderColor: 'var(--green-d, #0a1e3d)' }}>
          {/* En-tête */}
          <div className="flex items-center justify-between border-b-2 pb-3" style={{ borderColor: 'var(--green-d, #0a1e3d)' }}>
            <SenegalFlag className="w-12 h-auto" />
            <div className="text-center">
              <div className="text-[10px]" style={{ color: '#4b6a5c' }}>République du Sénégal · Un Peuple, Un But, Une Foi</div>
              <div className="text-[10px]" style={{ color: '#4b6a5c' }}>Adresse : {localite} — {num}</div>
              <div className="text-base font-extrabold leading-tight" style={{ color: 'var(--green-d, #0a1e3d)' }}>{school}</div>
            </div>
            {schoolLogoData(state) ? <SchoolLogoMark state={state} width={44} /> : <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="#ffd100" strokeWidth="1.5"><circle cx="12" cy="12" r="9" /><path d="M8 7h8M8 12h8M8 17h5" /></svg>}
          </div>
          <div className="mt-3 text-center">
            <div className="inline-block px-5 py-1 font-extrabold text-base tracking-wide" style={{ border: '2px solid var(--green-d, #0a1e3d)', color: 'var(--green-d, #0a1e3d)' }}>CERTIFICAT DE SCOLARITÉ</div>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed">Je soussigné(e), <b>{directeur || 'le Directeur(trice)'}</b>, Directeur(trice) de l’établissement <b>{school}</b>, situé(e) {localite}, atteste que l’élève&nbsp;:</p>
          <div className="mt-3 text-center">
            <div className="font-extrabold text-lg" style={{ color: '#11231b' }}>{nomComplet}</div>
            <div className="text-xs mt-0.5" style={{ color: '#4b6a5c' }}>Identifiant scolaire : {code} · Né(e) le : {birthDate || '—'} · Lieu : {student.lieuNaissance || '—'} · Sexe : {student.genre ? (student.genre === 'F' ? 'Féminin' : 'Masculin') : '—'}</div>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed">est régulièrement inscrit(e) et entièrement pris(e) en charge dans l’effectif de notre établissement, dans la classe <b>{cls.name}{niveau ? ` — ${niveau}` : ''}</b>, pour l’{annee}.</p>
          <p className="text-[13px] leading-relaxed mt-2">Le présent certificat, délivré(e) à la demande de l’intéressé, en son père, sa mère ou tuteur, sert et vaudra pour tous droits et usages légaux, notamment pour l’inscription, la réinscription et toute démarche administrative.</p>
          <div className="mt-3 flex-1"></div>
          <p className="text-[13px] leading-relaxed">Fait {localite}, le {dateStr}.</p>
          <div className="mt-4 flex items-end justify-between">
            <div>
              <div className="text-[13px] font-semibold">{directeur || 'Le Directeur(trice)'}</div>
              <div className="mt-2 text-[10px]" style={{ color: '#4b6a5c' }}>Le Directeur(trice) — cachet officiel</div>
            </div>
            <QRBadge value={`SYGENOP|CERT|${code}|${student.id}`} size={72} label="Vérifier le certificat" />
          </div>
        </div>
      </div>
    </div>
  );
}
function StudentCardVerification({ state: incomingState, updateState, notify }) {
  const state = incomingState || { classes: {}, header: {}, fees: {} };
  const [rawCode, setRawCode] = useState('');
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scanTimerRef = useRef(null);
  function stopCamera() { if (scanTimerRef.current) clearInterval(scanTimerRef.current); scanTimerRef.current = null; if (streamRef.current) streamRef.current.getTracks().forEach((track) => track.stop()); streamRef.current = null; }
  async function startCamera() { try { setCameraError(''); if (!('BarcodeDetector' in window)) { setCameraError('Le navigateur ne prend pas en charge le scan caméra. Utilisez Chrome sur Android ou une douchette QR.'); return; } const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); streamRef.current = stream; if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); } const detector = new window.BarcodeDetector({ formats: ['qr_code'] }); scanTimerRef.current = setInterval(async () => { if (!videoRef.current) return; const codes = await detector.detect(videoRef.current); if (codes[0]?.rawValue) { setRawCode(codes[0].rawValue); stopCamera(); } }, 500); } catch (_) { setCameraError('Impossible d’accéder à la caméra. Autorisez-la dans votre navigateur.'); } }
  useEffect(() => () => stopCamera(), []);
  const code = rawCode.includes('|') ? rawCode.split('|')[2] : rawCode.trim();
  // Badge personnel (SYGENOP|STAFF|<matricule>|<id>) : le portail identifie
  // l'agent et affiche son pointage du jour au lieu des mensualités élève.
  const isStaffScan = rawCode.startsWith('SYGENOP|STAFF|');
  const staffScanParts = isStaffScan ? rawCode.split('|') : null;
  const staffFound = staffScanParts
    ? (state.personnel || []).find((p) => p.id === staffScanParts[3] || staffCardCode(p) === (staffScanParts[2] || ''))
    : null;
  const staffRecord = staffFound ? getPointageRecord(state.pointage || {}, todayISO(), staffFound.id) : null;
  const STAFF_POINTAGE_LABELS = { P: ['Présent', 'green'], A: ['Absent', 'red'], R: ['Retard', 'gold'], C: ['Congé', 'gold'] };
  // Pointage automatique : le premier scan valide du badge marque l'agent
  // « Présent » avec ses heures prévues. Un statut déjà saisi (A/R/C/P par
  // la direction) n'est JAMAIS écrasé, et le pointage reste fermé les jours
  // non ouvrés.
  const lastStaffCheckRef = useRef('');
  useEffect(() => {
    if (!staffFound || typeof updateState !== 'function') return undefined;
    const date = todayISO();
    const key = `${date}|${staffFound.id}`;
    if (lastStaffCheckRef.current === key) return undefined;
    lastStaffCheckRef.current = key;
    const daySettings = attendanceSettings(state);
    const reason = nonWorkingDayReason(date, daySettings);
    if (reason) { notify && notify(`Badge reconnu, mais pointage fermé aujourd'hui (${reason}).`, true); return undefined; }
    if (getPointageRecord(state.pointage || {}, date, staffFound.id)) {
      notify && notify(`${personFullName(staffFound)} déjà pointé(e) aujourd'hui — aucun changement.`);
      return undefined;
    }
    const heures = heuresAttenduesDate(date, daySettings);
    updateState((prev) => {
      const pt = { ...(prev.pointage || {}) };
      const dayRec = { ...(pt[date] || {}) };
      dayRec[staffFound.id] = { statut: 'P', heures };
      pt[date] = dayRec;
      return { ...prev, pointage: pt };
    });
    notify && notify(`${personFullName(staffFound)} pointé(e) présent(e) — ${heures} h servies.`);
    return undefined;
  }, [staffFound, updateState, notify]);
  const found = Object.entries(state.classes || {}).flatMap(([classId, cls]) => (cls.students || []).map((student) => ({ classId, cls, student }))).find(({ student }) => student.cardCode === code || student.id === code || `ELV-${String(student.id || '').slice(-8).toUpperCase()}` === code);
  // Pointage automatique de l'élève scanné au portail : marque « Présent »
  // au premier scan du jour. Si l'emploi du temps de sa classe est
  // renseigné pour aujourd'hui, la présence est rattachée à la séance en
  // cours (mode « classe ») ; sinon elle est enregistrée sur le créneau
  // journalier unique PORTAIL. Un statut déjà enregistré (scan précédent
  // ou correction manuelle) n'est jamais écrasé.
  const lastStudentCheckRef = useRef('');
  useEffect(() => {
    if (!found || staffFound || typeof updateState !== 'function') return undefined;
    const { student, classId } = found;
    const date = todayISO();
    const heure = new Date().toTimeString().slice(0, 5);
    const key = `${date}|${student.id}`;
    if (lastStudentCheckRef.current === key) return undefined;
    lastStudentCheckRef.current = key;
    const reason = nonWorkingDayReason(date, attendanceSettings(state));
    if (reason) { notify && notify(`Carte reconnue, mais pointage fermé aujourd'hui (${reason}).`, true); return undefined; }
    const seance = currentSeanceForClass(state, classId, date, heure);
    const slotId = seance ? seance.id : PORTAIL_SLOT_ID;
    if (getStudentPresenceRecord(state.presenceEleves || {}, date, student.id, slotId)) {
      notify && notify(`${student.prenom} ${student.nom} déjà pointé(e)${seance ? ` pour ${seance.subject}` : ' aujourd\u2019hui'} — aucun changement.`);
      return undefined;
    }
    updateState((prev) => withStudentPresenceRecord(prev, date, student.id, slotId, { statut: 'P', heure, source: 'portail' }));
    notify && notify(`${student.prenom} ${student.nom} pointé(e) présent(e)${seance ? ` — ${seance.subject} (${seance.start})` : ` à ${heure}`}.`);
    return undefined;
  }, [found, staffFound, updateState, notify]);
  const monthlyRows = found ? (() => {
    const { cls, student } = found;
    const count = feeForLevel(state, cls.level).mensualites;
    const monthlyDue = studentMonthlyDue(state, cls.level);
    const firstYear = Number((state.header?.annee || '').match(/\d{4}/)?.[0]) || new Date().getFullYear();
    let legacyCredit = studentPaiements(student).filter((payment) => !payment.mois).reduce((sum, payment) => sum + (Number(payment.montant) || 0), 0);
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(firstYear, 9 + index, 1);
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      const declared = studentPaiements(student).filter((payment) => payment.mois === month).reduce((sum, payment) => sum + (Number(payment.montant) || 0), 0);
      const appliedLegacy = Math.min(Math.max(0, monthlyDue - declared), legacyCredit);
      legacyCredit -= appliedLegacy;
      const paid = declared + appliedLegacy;
      return { label: date.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }), paid, status: paid >= monthlyDue ? 'À jour' : paid ? 'Partiel' : 'Impayé' };
    });
  })() : [];
  const access = monthlyRows.some((row) => row.status === 'Impayé') ? 'REFUSÉ — régularisation nécessaire' : monthlyRows.some((row) => row.status === 'Partiel') ? 'À RÉGULARISER' : 'AUTORISÉ — à jour';
  const gateStatus = found ? studentDayStatus(state, todayISO(), found.student.id, found.classId) : null;
  return <div className="space-y-4"><div className="sygenop-card p-5"><div className="font-bold flex items-center gap-2"><ScanLine size={18} /> Contrôle portail / Vérifier une carte</div><p className="text-xs mt-1 text-muted">Scannez avec la caméra du smartphone ou une douchette QR.</p><div className="flex gap-2 mt-3"><button onClick={startCamera} className="px-3 py-2 rounded-lg text-white text-sm" style={{ background: 'var(--green-d)' }}>Scanner avec la caméra</button><button onClick={stopCamera} className="px-3 py-2 rounded-lg text-sm bg-bg">Arrêter</button></div><video ref={videoRef} muted playsInline className="mt-3 w-full max-w-sm rounded-lg" /><input autoFocus value={rawCode} onChange={(e) => setRawCode(e.target.value)} placeholder="Code QR scanné" className="mt-3 w-full px-3 py-2.5 rounded-lg border text-sm sygenop-input" />{cameraError && <div className="text-xs mt-2" style={{ color: 'var(--red)' }}>{cameraError}</div>}</div>{rawCode && !found && !staffFound && <div className="sygenop-card p-5 text-sm" style={{ color: 'var(--red)' }}>Aucun élève ne correspond à ce code.</div>}{staffFound && <div className="sygenop-card p-5"><div className="font-bold text-center p-3 rounded-lg" style={{ background: staffRecord ? 'var(--green-l)' : 'var(--gold-l)', color: staffRecord ? 'var(--green-d)' : '#92710c' }}>{staffRecord ? `BADGE RECONNU — ${STAFF_POINTAGE_LABELS[staffRecord.statut]?.[0] || staffRecord.statut}` : 'BADGE RECONNU — non pointé aujourd\u2019hui'}</div><div className="mt-3 font-bold">{personFullName(staffFound)} — {staffFound.role || ''}</div><div className="text-xs mt-1 text-muted">Matricule {staffCardCode(staffFound)} · Statut administratif : {staffFound.statut || 'Actif'}</div>{staffRecord && <div className="mt-2 text-sm">Pointage du jour : <Pill tone={STAFF_POINTAGE_LABELS[staffRecord.statut]?.[1] || 'gold'}>{STAFF_POINTAGE_LABELS[staffRecord.statut]?.[0] || staffRecord.statut}</Pill> · {Number(staffRecord.heures) || 0} h</div>}</div>}{found && <div className="sygenop-card p-5"><div className="font-bold text-center p-3 rounded-lg" style={{ background: access.startsWith('AUTORISÉ') ? 'var(--green-l)' : access.startsWith('À') ? 'var(--gold-l)' : '#fdecea', color: access.startsWith('AUTORISÉ') ? 'var(--green-d)' : 'var(--red)' }}>{access}</div><div className="mt-3 font-bold">{found.student.prenom} {found.student.nom} — {found.cls.name}</div><div className="mt-1.5 text-sm">Pointage du jour : <Pill tone={STUDENT_PRESENCE_LABELS[gateStatus?.statut]?.[1] || 'gold'}>{STUDENT_PRESENCE_LABELS[gateStatus?.statut]?.[0] || '—'}</Pill></div><div className="overflow-x-auto mt-3"><table className="w-full text-sm"><tbody>{monthlyRows.map((row) => <tr key={row.label} style={{ borderTop: '1px solid var(--line)' }}><td className="p-2">{row.label}</td><td className="p-2 text-right">{fmtFCFA(row.paid)}</td><td className="p-2 text-right"><Pill tone={row.status === 'À jour' ? 'green' : row.status === 'Partiel' ? 'gold' : 'red'}>{row.status}</Pill></td></tr>)}</tbody></table></div></div>}</div>;
}

/* ---------------------------------------------------------------
   Faire l'appel — registre de présence des élèves (mode « classe »)
   ------------------------------------------------------------
   Permet à un enseignant (ou à la direction, pour correction) de
   marquer présents ses élèves en scannant leur carte QR, ou
   manuellement. Si l'emploi du temps de la classe est renseigné pour
   le jour choisi, l'appel se fait séance par séance ; sinon un
   pointage journalier unique (créneau PORTAIL) est utilisé — cohérent
   avec ce qu'enregistrerait un scan au portail le même jour.
   --------------------------------------------------------------- */
function AppelView({ state: incomingState, updateState, notify, teacherName, teacherStaffId, role, readOnly, fixedClassId }) {
  const state = incomingState || { classes: {}, header: {} };
  const isTeacherScoped = role === 'teacher';
  const classEntries = fixedClassId ? [] : Object.entries(state.classes || {})
    .filter(([, c]) => !isTeacherScoped || classHasTeacher(c, teacherName))
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
  const [classId, setClassId] = useState(fixedClassId || classEntries[0]?.[0] || '');
  useEffect(() => {
    if (fixedClassId) { setClassId(fixedClassId); return; }
    if (!classEntries.some(([id]) => id === classId)) setClassId(classEntries[0]?.[0] || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedClassId, classEntries.map(([id]) => id).join(',')]);
  const [date, setDate] = useState(todayISO());
  const cls = state.classes?.[classId];
  const students = [...(cls?.students || [])].sort((a, b) => (a.nom || '').localeCompare(b.nom || ''));
  const seances = seancesForClassDay(state, classId, date);
  const [slotId, setSlotId] = useState('');
  useEffect(() => {
    const nowHHMM = new Date().toTimeString().slice(0, 5);
    const defaultSlot = seances.length
      ? (date === todayISO() && currentSeanceForClass(state, classId, date, nowHHMM)?.id) || seances[0].id
      : PORTAIL_SLOT_ID;
    setSlotId(defaultSlot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, date, seances.map((s) => s.id).join(',')]);
  const activeSeance = seances.find((s) => s.id === slotId) || null;

  const settings = attendanceSettings(state);
  const closedReason = nonWorkingDayReason(date, settings);
  const canEdit = !readOnly && !closedReason;

  // ---- Scan caméra rapide (mêmes contraintes que le contrôle portail) ----
  const [rawCode, setRawCode] = useState('');
  const [cameraError, setCameraError] = useState('');
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scanTimerRef = useRef(null);
  function stopCamera() { if (scanTimerRef.current) clearInterval(scanTimerRef.current); scanTimerRef.current = null; if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
  async function startCamera() {
    try {
      setCameraError('');
      if (!('BarcodeDetector' in window)) { setCameraError('Le navigateur ne prend pas en charge le scan caméra. Utilisez Chrome sur Android ou une douchette QR.'); return; }
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      scanTimerRef.current = setInterval(async () => {
        if (!videoRef.current) return;
        const codes = await detector.detect(videoRef.current);
        if (codes[0]?.rawValue) setRawCode(codes[0].rawValue);
      }, 500);
    } catch (_) { setCameraError('Impossible d\u2019accéder à la caméra. Autorisez-la dans votre navigateur.'); }
  }
  useEffect(() => () => stopCamera(), []);

  function markStudent(studentId, statut) {
    if (!canEdit || typeof updateState !== 'function') return;
    const heure = new Date().toTimeString().slice(0, 5);
    updateState((prev) => withStudentPresenceRecord(prev, date, studentId, slotId, { statut, heure, source: 'manuel', par: teacherStaffId }));
  }
  // Scan : marque présent le premier élève de CETTE classe correspondant au code (une seule fois par code affiché).
  const lastScanRef = useRef(null);
  useEffect(() => {
    if (!rawCode || !canEdit) return;
    const code = rawCode.includes('|') ? rawCode.split('|')[2] : rawCode.trim();
    const now = Date.now();
    // Anti-doublon : ignore une même carte détectée plusieurs fois de suite
    // en moins de 3 s (le temps qu'elle reste face à la caméra), mais
    // autorise un nouveau scan de la même carte au-delà — nécessaire pour
    // pointer un élève sur une séance suivante plus tard dans la journée.
    if (lastScanRef.current && lastScanRef.current.code === code && now - lastScanRef.current.at < 3000) {
      setRawCode('');
      return;
    }
    lastScanRef.current = { code, at: now };
    const student = students.find((s) => s.cardCode === code || s.id === code || `ELV-${String(s.id || '').slice(-8).toUpperCase()}` === code);
    setRawCode('');
    if (!student) { notify && notify('Aucun élève de cette classe ne correspond à ce code.', true); return; }
    const heure = new Date().toTimeString().slice(0, 5);
    updateState && updateState((prev) => withStudentPresenceRecord(prev, date, student.id, slotId, { statut: 'P', heure, source: 'classe', par: teacherStaffId }));
    notify && notify(`${student.prenom} ${student.nom} marqué(e) présent(e).`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawCode]);

  function markAllUnrecordedAbsent() {
    if (!canEdit || typeof updateState !== 'function') return;
    const missing = students.filter((s) => !getStudentPresenceRecord(state.presenceEleves || {}, date, s.id, slotId));
    if (!missing.length) { notify && notify('Tous les élèves de cette classe ont déjà un statut pour ce créneau.'); return; }
    updateState((prev) => {
      let next = prev;
      missing.forEach((s) => { next = withStudentPresenceRecord(next, date, s.id, slotId, { statut: 'A', source: 'manuel', par: teacherStaffId }); });
      return next;
    });
    notify && notify(`${missing.length} élève(s) non pointé(s) marqué(s) absent(s).`);
  }

  const rows = students.map((s) => ({ student: s, record: getStudentPresenceRecord(state.presenceEleves || {}, date, s.id, slotId) }));
  const counts = rows.reduce((acc, r) => { const k = r.record?.statut; if (k) acc[k] = (acc[k] || 0) + 1; else acc.none++; return acc; }, { P: 0, R: 0, A: 0, none: 0 });

  if (!fixedClassId && !classEntries.length) {
    return <div className="sygenop-card p-5 text-sm text-muted">Aucune classe {isTeacherScoped ? 'ne vous est assignée' : "n'est enregistrée"}.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="sygenop-card p-5 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          {!fixedClassId && (
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Classe</label>
              <select value={classId} onChange={(e) => setClassId(e.target.value)} className="px-3 py-2.5 rounded-lg border text-sm sygenop-input">
                {classEntries.map(([id, c]) => <option key={id} value={id}>{c.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Date</label>
            <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} className="px-3 py-2.5 rounded-lg border text-sm sygenop-input" />
          </div>
          {seances.length > 0 && (
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Séance</label>
              <select value={slotId} onChange={(e) => setSlotId(e.target.value)} className="px-3 py-2.5 rounded-lg border text-sm sygenop-input">
                {seances.map((s) => <option key={s.id} value={s.id}>{s.start}–{s.end} · {s.subject}</option>)}
              </select>
            </div>
          )}
        </div>
        {closedReason && <div className="text-xs font-semibold px-3 py-2 rounded-lg" style={{ background: 'var(--gold-l)', color: '#92710c' }}>Appel fermé — {closedReason}.</div>}
        {!seances.length && <div className="text-xs text-muted">Aucun emploi du temps renseigné pour cette classe ce jour-là — pointage journalier unique.</div>}
      </div>

      {canEdit && (
        <div className="sygenop-card p-5">
          <div className="font-bold flex items-center gap-2 mb-2"><ScanLine size={18} /> Scanner les cartes des élèves</div>
          <div className="flex gap-2"><button onClick={startCamera} className="px-3 py-2 rounded-lg text-white text-sm" style={{ background: 'var(--green-d)' }}>Scanner avec la caméra</button><button onClick={stopCamera} className="px-3 py-2 rounded-lg text-sm bg-bg">Arrêter</button></div>
          <video ref={videoRef} muted playsInline className="mt-3 w-full max-w-sm rounded-lg" />
          <input value={rawCode} onChange={(e) => setRawCode(e.target.value)} placeholder="Ou saisir/coller le code QR ici" className="mt-3 w-full px-3 py-2.5 rounded-lg border text-sm sygenop-input" />
          {cameraError && <div className="text-xs mt-2" style={{ color: 'var(--red)' }}>{cameraError}</div>}
        </div>
      )}

      <div className="sygenop-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div className="flex flex-wrap gap-2 text-xs font-semibold">
            <Pill tone="green">{counts.P} présent(s)</Pill>
            <Pill tone="gold">{counts.R} retard(s)</Pill>
            <Pill tone="red">{counts.A} absent(s)</Pill>
            <Pill tone="gold">{counts.none} non pointé(s)</Pill>
          </div>
          {canEdit && counts.none > 0 && (
            <button onClick={markAllUnrecordedAbsent} className="text-xs font-semibold px-3 py-1.5 rounded-lg" style={{ background: 'var(--red-l)', color: 'var(--red)' }}>
              Marquer les non-pointés absents
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr style={{ borderBottom: '1px solid var(--line)' }}><th className="text-left p-2">Élève</th><th className="text-left p-2">Statut</th><th className="text-left p-2">Heure</th>{canEdit && <th className="text-right p-2">Action</th>}</tr></thead>
            <tbody>
              {rows.map(({ student, record }) => (
                <tr key={student.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td className="p-2">{student.prenom} {student.nom}</td>
                  <td className="p-2"><Pill tone={STUDENT_PRESENCE_LABELS[record?.statut]?.[1] || 'gold'}>{record ? (STUDENT_PRESENCE_LABELS[record.statut]?.[0] || record.statut) : 'Non pointé'}</Pill></td>
                  <td className="p-2 text-muted">{record?.heure || '—'}</td>
                  {canEdit && (
                    <td className="p-2 text-right whitespace-nowrap">
                      <button onClick={() => markStudent(student.id, 'P')} className="px-2 py-1 rounded text-xs font-semibold mr-1" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>Présent</button>
                      <button onClick={() => markStudent(student.id, 'R')} className="px-2 py-1 rounded text-xs font-semibold mr-1" style={{ background: 'var(--gold-l)', color: '#92710c' }}>Retard</button>
                      <button onClick={() => markStudent(student.id, 'A')} className="px-2 py-1 rounded text-xs font-semibold" style={{ background: 'var(--red-l)', color: 'var(--red)' }}>Absent</button>
                      {record?.statut === 'A' && (
                        <button
                          onClick={() => sendAbsenceWhatsapp(state, student, cls?.name || '', date, notify, activeSeance?.subject)}
                          title={student.tuteurTel ? `Prévenir ${student.tuteurNom || 'le tuteur'} sur WhatsApp` : 'Téléphone du tuteur non renseigné'}
                          className="ml-1 px-2 py-1 rounded text-xs font-semibold inline-flex items-center gap-1"
                          style={{ background: '#dcf8c6', color: '#075e54' }}
                        >
                          <MessageCircle size={12} /> WhatsApp
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Rapport de présence — statistiques d'absentéisme par classe/période.
   Lecture seule : s'appuie sur computeAttendanceStats (voir plus haut)
   pour agréger state.presenceEleves sur la plage de dates choisie.
   --------------------------------------------------------------- */
const PRESENCE_PERIODS = [
  { id: 'today', label: "Aujourd'hui" },
  { id: 'week', label: 'Cette semaine' },
  { id: 'month', label: 'Ce mois' },
  { id: 'custom', label: 'Personnalisé' },
];
function presencePeriodRange(periodId, customStart, customEnd) {
  const today = todayISO();
  if (periodId === 'today') return [today, today];
  if (periodId === 'week') {
    const d = new Date(`${today}T00:00:00`);
    const monday = new Date(d); monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return [monday.toISOString().slice(0, 10), today];
  }
  if (periodId === 'month') return [today.slice(0, 8) + '01', today];
  return [customStart || today, customEnd || today];
}
function PresenceRapportView({ state, session, fixedClassId }) {
  const isTeacherScoped = session?.role === 'teacher';
  const teacherName = isTeacherScoped ? teacherNameFromSession(state, session) : null;
  const classEntries = fixedClassId ? [] : Object.entries(state?.classes || {})
    .filter(([, c]) => !isTeacherScoped || classHasTeacher(c, teacherName))
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));
  const [classId, setClassId] = useState(fixedClassId || ''); // '' = toutes les classes (dans le périmètre autorisé)
  useEffect(() => { if (fixedClassId) setClassId(fixedClassId); }, [fixedClassId]);
  const [periodId, setPeriodId] = useState('week');
  const today = todayISO();
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const [startISO, endISO] = presencePeriodRange(periodId, customStart, customEnd);
  const classIds = classId ? [classId] : classEntries.map(([id]) => id);

  const stats = useMemo(
    () => computeAttendanceStats(state, classIds, startISO, endISO),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state?.presenceEleves, state?.emploiDuTemps, state?.classes, classIds.join(','), startISO, endISO]
  );

  const totalPresent = Object.values(stats.perClassTotals).reduce((s, c) => s + c.present, 0);
  const totalAbsent = Object.values(stats.perClassTotals).reduce((s, c) => s + c.absent, 0);
  const totalRetard = Object.values(stats.perClassTotals).reduce((s, c) => s + c.retard, 0);
  const totalJournees = totalPresent + totalAbsent; // une journée « retard » est déjà comptée dans present
  const tauxPresence = totalJournees ? Math.round((totalPresent / totalJournees) * 100) : null;

  const byClassData = Object.entries(stats.perClassTotals).map(([id, c]) => {
    const total = c.present + c.absent; // un retard compte comme une présence, cf. calcul du taux global
    return { classe: c.className, tauxPresence: total ? Math.round((c.present / total) * 100) : 0, tauxAbsence: total ? Math.round((c.absent / total) * 100) : 0 };
  }).sort((a, b) => b.tauxAbsence - a.tauxAbsence);
  const byDayData = classId ? (stats.perClassDaily[classId] || []).map((d) => {
    const total = d.present + d.absent;
    return { jour: d.date.slice(5), tauxPresence: total ? Math.round((d.present / total) * 100) : 0, tauxAbsence: total ? Math.round((d.absent / total) * 100) : 0 };
  }) : [];
  const topAbsents = Object.values(stats.perStudentTotals).filter((s) => s.absent > 0).sort((a, b) => b.absent - a.absent).slice(0, 15);

  if (!fixedClassId && !classEntries.length) {
    return <div className="sygenop-card p-5 text-sm text-muted">Aucune classe {isTeacherScoped ? 'ne vous est assignée' : "n'est enregistrée"}.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="sygenop-card p-5">
        <div className="flex flex-wrap gap-3 items-end">
          {!fixedClassId && (
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Classe</label>
              <select value={classId} onChange={(e) => setClassId(e.target.value)} className="px-3 py-2.5 rounded-lg border text-sm sygenop-input">
                <option value="">Toutes les classes{isTeacherScoped ? ' (les miennes)' : ''}</option>
                {classEntries.map(([id, c]) => <option key={id} value={id}>{c.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Période</label>
            <select value={periodId} onChange={(e) => setPeriodId(e.target.value)} className="px-3 py-2.5 rounded-lg border text-sm sygenop-input">
              {PRESENCE_PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          {periodId === 'custom' && (
            <>
              <div><label className="text-xs font-semibold block mb-1 text-muted">Du</label><input type="date" value={customStart} max={today} onChange={(e) => setCustomStart(e.target.value)} className="px-3 py-2.5 rounded-lg border text-sm sygenop-input" /></div>
              <div><label className="text-xs font-semibold block mb-1 text-muted">Au</label><input type="date" value={customEnd} max={today} min={customStart} onChange={(e) => setCustomEnd(e.target.value)} className="px-3 py-2.5 rounded-lg border text-sm sygenop-input" /></div>
            </>
          )}
        </div>
        <div className="text-xs mt-2 text-muted">{stats.joursComptabilises} jour(s) ouvré(s) comptabilisé(s) entre le {startISO} et le {endISO}.</div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={CheckCircle2} label="Taux de présence" value={tauxPresence == null ? '—' : `${tauxPresence}%`} tone="green" />
        <StatCard icon={AlertTriangle} label="Absences" value={totalAbsent} tone="red" />
        <StatCard icon={Clock} label="Retards" value={totalRetard} tone="gold" />
        <StatCard icon={Users} label="Journées présentes" value={totalPresent} tone="green" />
      </div>

      {!classId && byClassData.length > 0 && (
        <div className="sygenop-card p-5">
          <div className="font-bold text-sm mb-4 text-ink">Taux de présence / absence par classe</div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={byClassData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
              <XAxis dataKey="classe" tick={{ fontSize: 11, fill: 'var(--muted)' }} interval={0} angle={-25} textAnchor="end" height={60} />
              <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 12, fill: 'var(--muted)' }} allowDecimals={false} />
              <Tooltip formatter={(v) => `${v}%`} contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
              <Bar dataKey="tauxPresence" name="Taux de présence" fill="var(--green)" radius={[6, 6, 0, 0]} />
              <Bar dataKey="tauxAbsence" name="Taux d'absence" fill="var(--red)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {classId && byDayData.length > 0 && (
        <div className="sygenop-card p-5">
          <div className="font-bold text-sm mb-4 text-ink">Taux de présence / absence par jour — {state.classes[classId]?.name}</div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={byDayData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
              <XAxis dataKey="jour" tick={{ fontSize: 11, fill: 'var(--muted)' }} />
              <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 12, fill: 'var(--muted)' }} allowDecimals={false} />
              <Tooltip formatter={(v) => `${v}%`} contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
              <Bar dataKey="tauxPresence" name="Taux de présence" fill="var(--green)" radius={[6, 6, 0, 0]} />
              <Bar dataKey="tauxAbsence" name="Taux d'absence" fill="var(--red)" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="sygenop-card p-5">
        <div className="font-bold text-sm mb-3 text-ink">Élèves les plus absents sur la période</div>
        {topAbsents.length === 0 ? (
          <div className="text-sm text-muted">Aucune absence enregistrée sur cette période.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr style={{ borderBottom: '1px solid var(--line)' }}><th className="text-left p-2">Élève</th>{!classId && <th className="text-left p-2">Classe</th>}<th className="text-right p-2">Absences</th><th className="text-right p-2">Retards</th><th className="text-right p-2">Jours suivis</th></tr></thead>
              <tbody>
                {topAbsents.map((s, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                    <td className="p-2">{s.nom}</td>
                    {!classId && <td className="p-2 text-muted">{s.className}</td>}
                    <td className="p-2 text-right"><Pill tone="red">{s.absent}</Pill></td>
                    <td className="p-2 text-right"><Pill tone="gold">{s.retard}</Pill></td>
                    <td className="p-2 text-right text-muted">{s.jours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function GradeGrid({ state, classId, cls, cfg, periodKey, periods, updateState, notify, readOnly, isPrivateSchool, maxStudentsPerClass }) {
  // Toujours ordonner les élèves par ordre alphabétique (nom, puis prénom).
  const byName = (a, b) => (a.nom || '').localeCompare(b.nom || '') || (a.prenom || '').localeCompare(b.prenom || '');
  const [students, setStudents] = useState(() => [...(cls.students || [])].sort(byName));
  const [toDelete, setToDelete] = useState(null);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editStudent, setEditStudent] = useState(null); // élève en cours de modification des informations
  const [cardStudent, setCardStudent] = useState(null);
  const [certStudent, setCertStudent] = useState(null);
  const [ficheStudent, setFicheStudent] = useState(null);
  const [searchText, setSearchText] = useState('');
  const [gradingIdx, setGradingIdx] = useState(null); // index de l'élève en cours de notation (null = modal fermé)
  const [draft, setDraft] = useState({}); // notes en cours de saisie dans le modal
  const timerRef = useRef(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  function flush(latest) {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    updateState((prev) => {
      const next = { ...prev, classes: { ...(prev.classes || {}) } };
      next.classes[classId] = { ...next.classes[classId], students: latest };
      return next;
    });
  }
  function updateStudents(next) {
    const sorted = [...next].sort(byName);
    setStudents(sorted);
    flush(sorted);
  }

  function printStudentList() {
    const rows = students.map((st, i) => `<tr><td class="num">${i + 1}</td><td>${escHtml((st.prenom || '') + ' ' + (st.nom || ''))}</td><td class="num">${escHtml(st.genre || '—')}</td><td class="num">${escHtml(st.age || '—')}</td></tr>`).join('');
    const popup = window.open('', '_blank', 'width=800,height=650,scrollbars=yes');
    if (!popup) { notify('Autorisez les fenêtres pop-up pour générer le PDF.', true); return; }
    popup.document.open();
    popup.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Liste des élèves — ${escHtml(cls.name)}</title><style>html,body{background:#fff}body{font-family:Arial,sans-serif;color:#17251d;margin:0;padding:15mm}${PRINT_DOC_CSS}.meta{font-size:12px;color:#637269;margin-bottom:18px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #cfd8d2;padding:8px;text-align:left}th{background:#e8f3ed}td.num{text-align:center}@media print{body{margin:0;padding:15mm}@page{size:A4 portrait;margin:0}}</style></head><body>${docHeadHtml(state, 'LISTE DES ÉLÈVES')}<div class="meta"><strong>${escHtml(state?.header?.ecole || '')}</strong> · Niveau ${escHtml(cls.level || '')} · Classe ${escHtml(cls.name)} · Année ${escHtml(state?.header?.annee || '')} · ${students.length} élève(s)</div><table><thead><tr><th class="num">N°</th><th>Élève</th><th class="num">Genre</th><th class="num">Âge</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
    popup.document.close();
    popup.focus();
    setTimeout(() => { try { popup.print(); } catch (_) { popup.focus(); } }, 900);
  }

function addStudent(student) {
    if (readOnly) return;
    // École privée : plafond d'élèves par classe (par défaut 40, modifiable par le Super Admin).
    if (maxStudentsPerClass && students.length >= maxStudentsPerClass) {
      notify(`Limite atteinte : cette classe ne peut compter que ${maxStudentsPerClass} élèves.`, true);
      return;
    }
    const next = [...students, { ...student, scores: {}, validated: {} }];
    updateStudents(next);
    setAddModalOpen(false);
    notify(`Élève ${student.prenom || ''} ${student.nom || ''} ajouté(e)`);
  }

  function saveStudentEdit(patch) {
    if (readOnly || !editStudent) return;
    const next = students.map((s) => (s.id === editStudent.id ? { ...s, ...patch } : s));
    updateStudents(next);
    notify(`Informations de ${patch.prenom || ''} ${patch.nom || ''} enregistrées`);
    setEditStudent(null);
  }

  function confirmDelete() {
    if (readOnly) return;
    const next = students.filter((s) => s.id !== toDelete.id);
    updateStudents(next);
    setToDelete(null);
    notify('Élève supprimé');
  }

  const DOMAIN_COLORS = [
    { bg: '#dde6f2', fg: '#0a1e3d', bar: '#0a1e3d' },
    { bg: '#fff8cf', fg: '#92710c', bar: '#ffd100' },
    { bg: '#ede9fe', fg: '#5b21b6', bar: '#8b5cf6' },
    { bg: '#fdeef2', fg: '#9d174d', bar: '#ec4899' },
    { bg: '#e4edf9', fg: '#2a5a94', bar: '#2a5a94' },
    { bg: '#fff3e8', fg: '#9a3412', bar: '#f97316' },
  ];
  const doms = cfg.domains || [];
  const gbar = genBareme(cfg);
  const coefficientTotal = doms.reduce((sum, domain) => sum + (domain.disciplines || []).reduce((inner, discipline) => inner + Math.max(1, Number(discipline.coefficient) || 1), 0), 0);
    const gradingStudent = gradingIdx != null ? students[gradingIdx] : null;
  const weightedAssessments = !!cfg?.weightedAssessments && supportsWeightedAssessments(state);
  function draftForStudent(student) {
    const base = scoresFor(student, periodKey);
    return weightedAssessments ? { ...base, devoirs: { ...(base.devoirs || {}) } } : { ...base };
  }
  function openGrading(idx) {
    if (readOnly) return;
    setDraft(draftForStudent(students[idx]));
    setGradingIdx(idx);
  }

  function setDraftScore(discId, raw) {
    setDraft((d) => {
      const next = { ...d };
      if (raw.trim() === '') delete next[discId];
      else next[discId] = raw;
      return next;
    });
  }
  function setDraftDevoir(discId, devoirKey, raw) {
    setDraft((d) => {
      const discDevoirs = { ...(d.devoirs?.[discId] || {}) };
      if (raw.trim() === '') delete discDevoirs[devoirKey];
      else discDevoirs[devoirKey] = raw;
      return { ...d, devoirs: { ...(d.devoirs || {}), [discId]: discDevoirs } };
    });
  }

  function validateAndNext() {
    if (readOnly || gradingIdx == null) return;
    const idx = gradingIdx;
    const student = students[idx];
    const scores = { ...(student.scores || {}) };
    scores[periodKey] = { ...draft };
    const validated = { ...(student.validated || {}), [periodKey]: true };
    const updated = { ...student, scores, validated };
    const nextStudents = students.map((s, i) => (i === idx ? updated : s));
    updateStudents(nextStudents);
    notify(`Notes de ${(student.prenom || '') + ' ' + (student.nom || '')} enregistrées`);
    if (idx + 1 < nextStudents.length) {
      const nextIdx = idx + 1;
      setGradingIdx(nextIdx);
      setDraft(draftForStudent(nextStudents[nextIdx]));
    } else {
      setGradingIdx(null);
      setDraft({});
    }
  }

  function skipNext() {
    if (gradingIdx == null) return;
    const idx = gradingIdx;
    if (idx + 1 < students.length) {
      const nextIdx = idx + 1;
      setGradingIdx(nextIdx);
      setDraft({ ...scoresFor(students[nextIdx], periodKey) });
    } else {
      setGradingIdx(null);
      setDraft({});
    }
  }

  function closeModal() {
    setGradingIdx(null);
    setDraft({});
  }

  return (
    <div className="space-y-3">
<div className="sygenop-card p-4 flex flex-wrap items-center gap-3">
        <div>
          <div className="font-bold text-sm text-ink">{cls.name}</div>
          <div className="text-xs text-muted">
            {students.length} élève{students.length > 1 ? 's' : ''} · {cfg.weightedAssessments ? `coefficients ${coefficientTotal}` : `barème général /${gbar}`} · {periods.find((t) => t.key === periodKey)?.label || periodKey}
            {maxStudentsPerClass && <span style={{ color: 'var(--gold)' }}> · Limite privée : {students.length}/{maxStudentsPerClass} élèves</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Rechercher un élève…"
              className="pl-9 pr-3 py-2 rounded-lg border text-sm w-56 sygenop-input"
            />
            {searchText && (
              <button onClick={() => setSearchText('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted"><X size={14} /></button>
            )}
          </div>
          {!readOnly && (
            <button
              onClick={() => setAddModalOpen(true)}
              disabled={maxStudentsPerClass && students.length >= maxStudentsPerClass}
              title={maxStudentsPerClass && students.length >= maxStudentsPerClass ? `Limite atteinte : cette classe privée ne peut compter que ${maxStudentsPerClass} élèves.` : 'Ajouter un élève'}
              className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
              style={{ background: 'var(--green-d)' }}
            >
              <Plus size={16} /> Ajouter un élève
            </button>
          )}
          <button
            onClick={printStudentList}
            disabled={!students.length}
            className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40 whitespace-nowrap"
            style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}
            title="Télécharger / imprimer la liste des élèves au format PDF"
          >
            <Printer size={16} /> Imprimer / PDF
          </button>
        </div>
      </div>

      {!doms.length ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          Aucune matière configurée pour ce niveau.
        </div>
      ) : !students.length ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          Aucun élève dans {cls.name}. Ajoutez le premier élève pour commencer la saisie.
        </div>
      ) : (
        <div className="sygenop-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ borderBottom: '1px solid var(--line)' }}>
                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">Élève</th>
                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">Âge</th>
                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">Genre</th>
                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">Statut</th>
                <th className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-right text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {students
                .filter((st) => !searchText.trim() || `${st.prenom || ''} ${st.nom || ''} ${st.tuteurNom || ''}`.toLowerCase().includes(searchText.trim().toLowerCase()))
                .map((st, i) => {
                const isValidated = !!(st.validated && st.validated[periodKey]);
                return (
                  <tr key={st.id} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {!readOnly ? (
                          <button
                            onClick={() => setFicheStudent(st)}
                            title={isFemale(st.genre) ? `Voir la fiche de ${st.prenom || ''} ${st.nom || ''}` : `Voir la fiche de ${st.prenom || ''} ${st.nom || ''}`}
                            className="flex-shrink-0 p-1 rounded-full hover:bg-black/5 transition-colors"
                            style={{ cursor: 'pointer', lineHeight: 0 }}
                          >
                            {isFemale(st.genre) ? <AvatarGirl size={40} /> : <AvatarBoy size={40} />}
                          </button>
                        ) : (
                          <span style={{ display: 'inline-flex', lineHeight: 0 }}>
                            {isFemale(st.genre) ? <AvatarGirl size={40} /> : <AvatarBoy size={40} />}
                          </span>
                        )}
                        <div className="font-semibold text-ink">
                          {(st.prenom || '') + ' ' + (st.nom || '') || <span className="italic text-muted">Élève sans nom</span>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted">{st.age || '—'}</td>
                    <td className="px-4 py-3 text-muted">{st.genre || '—'}</td>
                    <td className="px-4 py-3">
                      {isValidated ? <Pill tone="green">Noté</Pill> : <Pill tone="muted">En attente</Pill>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        {!readOnly && (
                          <button
                            onClick={() => openGrading(i)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap"
                            style={isValidated
                              ? { background: 'var(--green-l)', color: 'var(--green-d)' }
                              : { background: 'var(--green-d)', color: '#fff' }}
                          >
                            <span className="text-[10px] leading-none">{isValidated ? 'Modifier' : 'Noter'}</span>
                            <BookOpen size={15} />
                          </button>
                        )}
                        {!readOnly && (
                          <button onClick={() => setToDelete(st)} className="p-1.5 rounded-lg hover:bg-black/5" style={{ color: 'var(--red)' }} title="Supprimer">
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {gradingStudent && !readOnly && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="sygenop-card p-6 max-w-2xl w-full sygenop-fade max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="font-bold text-ink">
                  Notation — {(gradingStudent.prenom || '') + ' ' + (gradingStudent.nom || '')}
                </div>
                <div className="text-xs text-muted">
                  {cls.name} · {periods.find((t) => t.key === periodKey)?.label || periodKey} · Élève {gradingIdx + 1} / {students.length}
                </div>
              </div>
              <button onClick={closeModal} style={{ color: 'var(--muted)' }} title="Fermer">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3">
              {doms.map((d, di) => {
                const c = DOMAIN_COLORS[di % DOMAIN_COLORS.length];
                return (
                  <div key={di} className="rounded-xl overflow-hidden" style={{ background: 'var(--bg)', border: '1px solid ' + c.bar + '33' }}>
                    <div
                      className="px-3 py-2 flex items-center justify-between"
                      style={{
                        background: `linear-gradient(135deg, ${c.bg}, ${c.bg}cc)`,
                        borderBottom: `2px solid ${c.bar}`,
                        color: c.fg,
                      }}
                    >
                      <span className="text-xs font-extrabold uppercase tracking-wide">{d.name}</span>
                      <span className="text-xs font-bold" style={{ opacity: 0.75 }}>{cfg.weightedAssessments ? `coef. ${(d.disciplines || []).reduce((sum, item) => sum + Math.max(1, Number(item.coefficient) || 1), 0)}` : `/${domBareme(d)}`}</span>
                    </div>
                    <div className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {d.disciplines.map((x) => {
                        const v = draft[x.id];
                        const devoirs = draft.devoirs?.[x.id];
                        const over = !isAbs(v) && v != null && v !== '' && x.max > 0 && toNum(v) > x.max;
                        const noteMoyenne = weightedAssessments ? moyenneMatiereAvecDevoirs(v, devoirs) : toNum(v);
                        return (
                          <div key={x.id} className="rounded-lg p-2" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
                            <div className="flex items-center justify-between gap-2 mb-1"><label className="text-xs font-medium text-ink" title={`${x.label} (/${x.max})`}>{x.label}</label>{weightedAssessments && <span className="text-[10px] text-muted">coef. {x.coefficient || 1}</span>}</div>
                            {weightedAssessments ? (
                              <div className="space-y-1.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[10px] w-[62px] text-muted">Devoirs</span>
                                  {DEVOIR_KEYS.map((key) => {
                                    const val = devoirs?.[key];
                                    const valOver = !isAbs(val) && val != null && val !== '' && x.max > 0 && toNum(val) > x.max;
                                    return (
                                      <input
                                        key={key}
                                        value={val == null ? '' : val}
                                        onChange={(e) => setDraftDevoir(x.id, key, e.target.value)}
                                        onBlur={(e) => { const raw = e.target.value.trim(); if (!isAbs(raw) && raw !== '' && x.max > 0) { const num = toNum(raw); if (num > x.max) { setDraftDevoir(x.id, key, String(x.max)); notify(`Note ramenée au maximum autorisé (/${x.max})`, true); } else if (num < 0) setDraftDevoir(x.id, key, '0'); } }}
                                        inputMode="decimal"
                                        placeholder={DEVOIR_LABELS[key]}
                                        title={`${DEVOIR_LABELS[key]} (/${x.max})`}
                                        className="w-11 px-1 py-1 rounded border text-xs text-center"
                                        style={valOver ? { borderColor: 'var(--red)', color: 'var(--red)' } : { borderColor: 'var(--line)', color: 'var(--ink)' }}
                                      />
                                    );
                                  })}
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <span className="text-[10px] w-[62px] text-muted">Composition</span>
                                  <input value={v == null ? '' : v} onChange={(e) => setDraftScore(x.id, e.target.value)} onBlur={(e) => { const raw = e.target.value.trim(); if (!isAbs(raw) && raw !== '' && x.max > 0) { const num = toNum(raw); if (num > x.max) { setDraftScore(x.id, String(x.max)); notify(`Note ramenée au maximum autorisé (/${x.max})`, true); } else if (num < 0) setDraftScore(x.id, '0'); } }} inputMode="decimal" className="w-14 px-1.5 py-1 rounded border text-xs text-center" style={over ? { borderColor: 'var(--red)', color: 'var(--red)' } : { borderColor: 'var(--line)', color: 'var(--ink)' }} />
                                  <span className="text-[10px] text-muted">/{x.max}</span>
                                  <span className="text-[10px] font-semibold ml-auto" style={{ color: 'var(--green-d)' }}>Moy. {noteMoyenne == null ? '0' : fmtNote(noteMoyenne, 2)}</span>
                                </div>
                              </div>
                            ) : (
                              <label className="text-[10px] text-muted">Note <input value={v == null ? '' : v} onChange={(e) => setDraftScore(x.id, e.target.value)} onBlur={(e) => { const raw = e.target.value.trim(); if (!isAbs(raw) && raw !== '' && x.max > 0) { const num = toNum(raw); if (num > x.max) { setDraftScore(x.id, String(x.max)); notify(`Note ramenée au maximum autorisé (/${x.max})`, true); } else if (num < 0) setDraftScore(x.id, '0'); } }} inputMode="decimal" className="w-14 px-1.5 py-1 rounded border text-xs text-center" style={over ? { borderColor: 'var(--red)', color: 'var(--red)' } : { borderColor: 'var(--line)', color: 'var(--ink)' }} /> /{x.max}</label>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 mt-5">
              <button
                onClick={skipNext}
                className="px-3.5 py-2 rounded-lg text-sm font-semibold"
                style={{ background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' }}
              >
                Passer sans enregistrer
              </button>
              <button
                onClick={closeModal}
                className="px-3.5 py-2 rounded-lg text-sm font-semibold"
                style={{ background: 'var(--bg)', color: 'var(--ink)' }}
              >
                Fermer
              </button>
              <button
                onClick={validateAndNext}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5"
                style={{ background: 'var(--green-d)' }}
              >
                <CheckCircle2 size={15} />
                {gradingIdx + 1 < students.length ? 'Valider et suivant' : 'Valider et terminer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {addModalOpen && (
        <AddStudentModal
          onSave={addStudent}
          onClose={() => setAddModalOpen(false)}
        />
      )}

      {ficheStudent && (
        <StudentFicheModal
          student={ficheStudent}
          clsName={cls.name}
          onCard={() => { setCardStudent(ficheStudent); setFicheStudent(null); }}
          onCert={() => { setCertStudent(ficheStudent); setFicheStudent(null); }}
          onEdit={readOnly ? null : () => { setEditStudent(ficheStudent); setFicheStudent(null); }}
          onClose={() => setFicheStudent(null)}
        />
      )}

      {editStudent && !readOnly && (
        <EditStudentModal
          student={editStudent}
          onSave={saveStudentEdit}
          onClose={() => setEditStudent(null)}
        />
      )}

      {cardStudent && (
        <div id="student-card-print" className="fixed inset-0 z-50 overflow-auto p-4"><div className="max-w-2xl mx-auto mt-4"><div className="no-print flex flex-wrap justify-end gap-2 mb-2"><label className="px-3 py-2 rounded-lg text-sm font-semibold cursor-pointer" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}>Ajouter / changer la photo<input type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; readImageCompressed(file).then((photoData) => { if (!photoData) return; const next = students.map((s) => s.id === cardStudent.id ? { ...s, photoData } : s); updateStudents(next); setCardStudent((s) => ({ ...s, photoData })); }); }} /></label><button onClick={() => window.print()} className="px-3 py-2 rounded-lg text-white flex items-center gap-1" style={{ background: 'var(--green-d)' }}><Printer size={14} /> Imprimer / PDF</button><button onClick={() => setCardStudent(null)} className="px-3 py-2 rounded-lg bg-panel">Fermer</button></div><StudentIdentityCard state={state} cls={cls} student={cardStudent} /></div></div>
      )}

      {certStudent && (
        <div id="student-cert-print" className="fixed inset-0 z-50 overflow-auto p-4"><div className="max-w-[220mm] mx-auto mt-4"><div className="no-print flex flex-wrap justify-end gap-2 mb-2"><button onClick={() => window.print()} className="px-3 py-2 rounded-lg text-white flex items-center gap-1" style={{ background: 'var(--green-d)' }}><Printer size={14} /> Imprimer / PDF</button><button onClick={() => setCertStudent(null)} className="px-3 py-2 rounded-lg bg-panel">Fermer</button></div><StudentSchoolCertificate state={state} cls={cls} student={certStudent} /></div></div>
      )}

      {toDelete && (
        <ConfirmModal
          title="Supprimer cet élève ?"
          message={`« ${toDelete.prenom || ''} ${toDelete.nom || ''} » sera définitivement retiré de ${cls.name}, avec toutes ses notes.`}
          danger
          onConfirm={confirmDelete}
          onCancel={() => setToDelete(null)}
        />
      )}
    </div>
  );
}



/* ============================================================
   VUE — SYNTHÈSE (par niveau et pour l'école entière)
   ============================================================ */
function RateCell({ num, den }) {
  if (!den) return <td>0<span className="synth-rate-n">—</span></td>;
  const r = num / den;
  return <td>{num}<span className={`synth-rate-n ${r >= 0.5 ? 'synth-rate-good' : 'synth-rate-bad'}`}>{fmtPctVal(r)}</span></td>;
}
function synthGroups(cfg) {
  const doms = cfg.domains || [];
  const groups = doms.map((d) => ({
    name: DOMSHORT(d.name),
    bar: domBareme(d),
    get: (sc) => domTotalVal(sc, d),
  }));
  const gb = genBareme(cfg);
  groups.push({ name: 'Moy. Gén.', bar: gb, get: (sc) => doms.reduce((s, d) => s + domTotalVal(sc, d), 0) });
  return groups;
}
function SynthLevelTable({ state, level, period, teacherName }) {
  const cfg = cfgForLevel(state, level);
  const groups = synthGroups(cfg);
  const entries = classesOfLevel(state, level).filter(([, c]) => !teacherName || classHasTeacher(c, teacherName));
  const rowsData = [];
  let totalB = 0, totalF = 0;
  const grandB = groups.map(() => 0), grandF = groups.map(() => 0);
  entries.forEach(([, cls]) => {
    const students = cls.students || [];
    const boys = students.filter((s) => s.genre === 'M');
    const girls = students.filter((s) => s.genre === 'F');
    if (!boys.length && !girls.length) return;
    const aggB = groups.map((g) => boys.filter((s) => g.bar > 0 && g.get(scoresFor(s, period)) >= g.bar / 2).length);
    const aggF = groups.map((g) => girls.filter((s) => g.bar > 0 && g.get(scoresFor(s, period)) >= g.bar / 2).length);
    aggB.forEach((v, i) => { grandB[i] += v; });
    aggF.forEach((v, i) => { grandF[i] += v; });
    totalB += boys.length; totalF += girls.length;
    rowsData.push({ id: cls.id, name: cls.name, boys, girls, aggB, aggF });
  });

  if (!totalB && !totalF) {
    return (
      <div className="sygenop-card p-10 text-center text-sm text-muted">
        <div className="font-bold mb-1 text-ink">Aucune donnée pour {level}</div>
        Saisissez des notes (avec le genre G/F) dans une classe de {level} pour « {periodLabel(state, period)} ».
      </div>
    );
  }
  const grandT = grandB.map((v, i) => v + grandF[i]);
  const effG = totalB + totalF;

  return (
    <div className="sygenop-card p-4 md:p-5 overflow-x-auto">
      <div className="text-xs font-semibold mb-1 text-muted">
        Synthèse · {level} · {periodLabel(state, period)}
      </div>
      <h3 className="font-bold text-sm mb-3 text-ink">Réussite par discipline et globale — {level}</h3>
      <table className="synth-table">
        <thead>
          <tr>
            <th>Classe</th><th>G/F</th><th>Effectif</th>
            {groups.map((g, i) => (
              <th key={i}>{g.name}<br /><span style={{ fontWeight: 600, opacity: 0.75 }}>≥{fmtNote(g.bar / 2, 1)}</span></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowsData.map((r) => {
            const effT = r.boys.length + r.girls.length;
            const aggT = r.aggB.map((v, i) => v + r.aggF[i]);
            return (
              <React.Fragment key={r.id}>
                <tr>
                  <td className="cl" rowSpan={3}>{r.name}</td>
                  <td className="gf">Garçons</td><td>{r.boys.length}</td>
                  {r.aggB.map((v, i) => <RateCell key={i} num={v} den={r.boys.length} />)}
                </tr>
                <tr>
                  <td className="gf">Filles</td><td>{r.girls.length}</td>
                  {r.aggF.map((v, i) => <RateCell key={i} num={v} den={r.girls.length} />)}
                </tr>
                <tr className="total">
                  <td className="gf">Total</td><td>{effT}</td>
                  {aggT.map((v, i) => <RateCell key={i} num={v} den={effT} />)}
                </tr>
              </React.Fragment>
            );
          })}
          <tr className="grand">
            <td className="cl" rowSpan={3}>Total {level}</td><td className="gf">Garçons</td><td>{totalB}</td>
            {grandB.map((v, i) => <RateCell key={i} num={v} den={totalB} />)}
          </tr>
          <tr className="grand">
            <td className="gf">Filles</td><td>{totalF}</td>
            {grandF.map((v, i) => <RateCell key={i} num={v} den={totalF} />)}
          </tr>
          <tr className="grand total">
            <td className="gf">Ensemble</td><td>{effG}</td>
            {grandT.map((v, i) => <RateCell key={i} num={v} den={effG} />)}
          </tr>
        </tbody>
      </table>
      <p className="text-xs mt-3 text-muted">
        « Réussite » = élèves dont le résultat atteint la moitié du barème (≥ 5/10). Seuls les élèves dont le genre (G/F) est renseigné sont comptés. Pourcentage rapporté à l'effectif de la ligne.
      </p>
    </div>
  );
}
function SynthSchoolTable({ state, period }) {
  const rows = [];
  let totalBoys = 0, totalGirls = 0;
  const domTotalsB = [0, 0, 0, 0], domTotalsF = [0, 0, 0, 0];
  let genB = 0, genF = 0;
  levelsForSchool(state).forEach((level) => {
    const cfg = cfgForLevel(state, level);
    const doms = cfg.domains || [];
    const gb = genBareme(cfg);
    let boys = 0, girls = 0;
    const domB = [0, 0, 0, 0], domF = [0, 0, 0, 0];
    let levGenB = 0, levGenF = 0;
    classesOfLevel(state, level).forEach(([, cls]) => {
      (cls.students || []).forEach((st) => {
        if (st.genre !== 'M' && st.genre !== 'F') return;
        const isB = st.genre === 'M';
        if (isB) boys++; else girls++;
        const sc = scoresFor(st, period);
        let gt = 0;
        doms.forEach((d, i) => {
          const t = domTotalVal(sc, d);
          gt += t;
          if (i < 4 && domBareme(d) > 0 && t >= domBareme(d) / 2) { if (isB) domB[i]++; else domF[i]++; }
        });
        if (gb > 0 && gt >= gb / 2) { if (isB) levGenB++; else levGenF++; }
      });
    });
    const eff = boys + girls;
    totalBoys += boys; totalGirls += girls;
    for (let i = 0; i < 4; i++) { domTotalsB[i] += domB[i]; domTotalsF[i] += domF[i]; }
    genB += levGenB; genF += levGenF;
    rows.push({ level, eff, boys, girls, domT: domB.map((v, i) => v + domF[i]), genT: levGenB + levGenF });
  });
  const effAll = totalBoys + totalGirls;
  const domTAll = domTotalsB.map((v, i) => v + domTotalsF[i]);
  const genTAll = genB + genF;

  return (
    <div className="sygenop-card p-4 md:p-5 overflow-x-auto">
      <div className="text-xs font-semibold mb-1 text-muted">
        Synthèse · École entière · {periodLabel(state, period)}
      </div>
      <h3 className="font-bold text-sm mb-3 text-ink">Résultats consolidés de l'établissement</h3>
      <table className="synth-table">
        <thead>
          <tr><th>Niveau</th><th>Effectif</th><th>G</th><th>F</th><th>LC</th><th>Maths</th><th>ESVS</th><th>EPSA</th><th>Moy. Gén.</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => r.eff ? (
            <tr key={r.level}>
              <td className="cl">{r.level}</td><td>{r.eff}</td><td className="gf">{r.boys}</td><td className="gf">{r.girls}</td>
              {r.domT.map((v, i) => <RateCell key={i} num={v} den={r.eff} />)}
              <RateCell num={r.genT} den={r.eff} />
            </tr>
          ) : (
            <tr key={r.level}>
              <td className="cl">{r.level}</td><td>0</td><td className="gf">0</td><td className="gf">0</td>
              <td colSpan={5} className="text-xs text-muted">— non renseigné —</td>
            </tr>
          ))}
          <tr className="grand">
            <td className="cl">TOTAL ÉCOLE</td><td>{effAll}</td><td>{totalBoys}</td><td>{totalGirls}</td>
            {domTAll.map((v, i) => <RateCell key={i} num={v} den={effAll} />)}
            <RateCell num={genTAll} den={effAll} />
          </tr>
        </tbody>
      </table>
      <p className="text-xs mt-3 text-muted">
        Les 4 premiers domaines de chaque niveau sont consolidés (LC / Maths / ESVS / EPSA). Élèves au genre renseigné uniquement.
      </p>
    </div>
  );
}
function SynthView({ state, loading, teacherName }) {
  const isTeacherScoped = !!teacherName;
  const availableLevels = useMemo(() => {
    if (!isTeacherScoped || !state) return [];
    const set = new Set(Object.values(state.classes || {}).filter((c) => classHasTeacher(c, teacherName)).map((c) => c.level));
    return levelsForSchool(state).filter((l) => set.has(l));
  }, [isTeacherScoped, teacherName, state]);
  const [level, setLevel] = useState(isTeacherScoped ? (teacherName && state ? (Object.values(state.classes || {}).find((c) => classHasTeacher(c, teacherName))?.level || levelsForSchool(state)[0]) : levelsForSchool(state)[0]) : '__ALL__');
  const [period, setPeriod] = useState('T1');
  const [evaluationType, setEvaluationType] = useState('controle');
  const schoolPeriods = periodsForSchool(state);

  useEffect(() => {
    if (schoolPeriods.length && !schoolPeriods.some((item) => item.key === period)) setPeriod(schoolPeriods[0].key);
  }, [schoolPeriods.map((item) => item.key).join(','), period]);
  // Suit la période activée globalement (barre du haut) quand elle change
  const globalPeriode = state && state.header && state.header.periodeActif;
  useEffect(() => {
    if (globalPeriode && globalPeriode !== period && schoolPeriods.some((p) => p.key === globalPeriode)) setPeriod(globalPeriode);
  }, [globalPeriode]);

  useEffect(() => {
    if (isTeacherScoped && availableLevels.length && !availableLevels.includes(level)) {
      setLevel(availableLevels[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacherScoped, availableLevels.join(',')]);

  if (loading || !state) {
    return (
      <div className="flex items-center justify-center py-24 text-muted">
        <Loader2 className="animate-spin mr-2" size={18} /> Chargement des données…
      </div>
    );
  }

  if (isTeacherScoped && !availableLevels.length) {
    return (
      <div className="sygenop-card p-10 text-center text-sm text-muted">
        Aucune classe ne vous est assignée pour le moment.
      </div>
    );
  }

  return (
    <div className="space-y-4 sygenop-fade">
      <div className="no-print flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5 p-1 rounded-xl" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
          {!isTeacherScoped && (
            <button
              onClick={() => setLevel('__ALL__')}
              className="px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors"
              style={level === '__ALL__' ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
            >
              École entière
            </button>
          )}
          {(isTeacherScoped ? availableLevels : levelsForSchool(state)).map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className="px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors"
              style={level === l ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1.5 p-1 rounded-xl" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
          {schoolPeriods.map((t) => (
            <button
              key={t.key}
              onClick={() => setPeriod(t.key)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={period === t.key ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select value={evaluationType} onChange={(e) => setEvaluationType(e.target.value)} className="px-3 py-1.5 rounded-lg text-xs font-semibold border sygenop-input">
          {EVALUATION_TYPES.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
        </select>
        <button
          onClick={() => window.print()}
          className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5"
          style={{ background: 'var(--gold)' }}
        >
          🖶 Imprimer / PDF
        </button>
      </div>
      <div className="text-sm font-bold text-ink">
        Synthèse {level === '__ALL__' ? '— École entière' : `— ${level}`} — {periodLabel(state, evaluationKey(period, evaluationType))}
        {state.header && state.header.ecole ? ` — ${state.header.ecole}` : ''}
      </div>
      <div className="flex justify-end"><QRBadge value={`EduLink Pro|Synthese|${state.header?.annee || ''}|${level}|${evaluationKey(period, evaluationType)}`} label="Synthèse vérifiable" /></div>
      {level === '__ALL__'
        ? <SynthSchoolTable state={state} period={evaluationKey(period, evaluationType)} />
        : <SynthLevelTable state={state} level={level} period={evaluationKey(period, evaluationType)} teacherName={teacherName} />}
    </div>
  );
}

/* ============================================================
   VUE — BULLETINS
   ============================================================ */
function SenegalFlag({ className = '' }) {
  return <img className={className} src={flagSenegal} alt="Drapeau officiel du Sénégal" style={{ objectFit: 'contain', display: 'block' }} />;
}
function BulletinSheet({ state, cls, level, cfg, student, studentIndex, period }) {
  const students = cls.students || [];
  const sc = scoresFor(student, period);
  const cs = computeStudentScores(cfg, sc);
  const ranks = computeRanks(cfg, students, period);
  const rang = ranks[studentIndex];
  const h = state.header || {};
  const classAvg = classAvgForPeriod(cfg, students, period);
  const m = mention(cs.moy, cfg.weightedAssessments);
  const disciplineRanks = {};
  if (cfg.weightedAssessments) {
    (cfg.domains || []).forEach((d) => {
      (d.disciplines || []).forEach((x) => {
        disciplineRanks[x.id] = computeDisciplineRanks(cfg, students, period, x.id);
      });
    });
  }
  const selectedEvaluation = splitEvaluationKey(period);
  const periodRows = periodsForSchool(state).map((t) => {
    const evaluationPeriodKey = evaluationKey(t.key, selectedEvaluation.type);
    const scP = scoresFor(student, evaluationPeriodKey);
    const hasData = Object.keys(scP).length > 0;
    if (!hasData) return { label: t.label, moy: null, rang: null, avg: null };
    const csP = computeStudentScores(cfg, scP);
    const ranksP = computeRanks(cfg, students, evaluationPeriodKey);
    const avgP = classAvgForPeriod(cfg, students, evaluationPeriodKey);
    return { label: `${t.label} — ${evaluationTypeLabel(selectedEvaluation.type)}`, moy: csP.moy, rang: ranksP[studentIndex], avg: avgP };
  });
  const trimVals = periodRows.filter((r) => r.moy != null).map((r) => r.moy);
  const trimAvgAll = trimVals.length ? trimVals.reduce((a, b) => a + b, 0) / trimVals.length : null;
  const now = new Date();
  const editStamp = now.toLocaleDateString('fr-FR') + ' à ' + now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="bull-sheet sygenop-card" style={{ marginBottom: 24 }}>
      <div className="flex items-start gap-3 pb-2" style={{ borderBottom: '2px solid #0a1e3d' }}>
        <SenegalFlag className="w-20 h-auto flex-shrink-0" />
        <div className="flex-1 text-center" style={{ fontSize: 11, lineHeight: 1.35 }}>
          <div>République du Sénégal</div>
          <div>Ministère de l'Éducation nationale</div>
          <div style={{ fontWeight: 700 }}>IEF {h.ief || 'GRAND DAKAR'}</div>
          <div style={{ fontWeight: 800, fontSize: 13, marginTop: 2 }}>{(h.ecole || 'ÉCOLE').toUpperCase()}</div>
          <div style={{ fontSize: 10, marginTop: 2 }}>ANNÉE SCOLAIRE : {h.annee}</div>
        </div>
        <SchoolLogoMark state={state} width={66} style={{ flexShrink: 0 }} />
      </div>
      <div className="grid grid-cols-2 gap-3" style={{ fontSize: 11, margin: '10px 0' }}>
        <div className="space-y-0.5">
          <div><b>Tél :</b> {h.tel || '—'}</div>
          <div><b>Niveau :</b> {level}</div>
          <div><b>Effectif :</b> {students.length}</div>
          <div><b>Moyenne classe :</b> {classAvg == null ? '—' : fmtNote(classAvg)}</div>
        </div>
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-0.5">
            <div><b>Sexe :</b> {student.genre === 'M' ? 'MASCULIN' : (student.genre === 'F' ? 'FÉMININ' : '—')}</div>
            <div><b>Classe :</b> {cls.name}</div>
            <div><b>Prénom(s) :</b> {student.prenom || '—'}</div>
            <div><b>Nom :</b> {student.nom || '—'}</div>
          </div>
          <QRBadge value={`SYGENOP|CARTE|${student.cardCode || `ELV-${String(student.id || '').slice(-8).toUpperCase()}`}|${student.id}`} size={70} label="" />
        </div>
      </div>
      <div className="text-center font-bold py-1.5" style={{ background: '#0a1e3d', color: '#fff', borderRadius: 4, fontSize: 12 }}>
        BULLETIN — {periodLabel(state, period)}
      </div>
      <table style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>Disciplines</th>
            {cfg.weightedAssessments ? (
              <>
                <th>Devoirs</th>
                <th>Compos</th>
                <th>Moy</th>
                <th>Coeff</th>
                <th>MoyxCoef</th>
                <th>Rang</th>
              </>
            ) : (
              <>
                <th>Note</th>
                <th>Barème</th>
              </>
            )}
            <th>Appréciations</th>
          </tr>
        </thead>
        <tbody>
          {(cfg.domains || []).map((d, di) => (
            <React.Fragment key={di}>
              <tr className="domrow"><td colSpan={cfg.weightedAssessments ? 8 : 4}>{d.name}</td></tr>
              {d.disciplines.map((x) => {
                const v = sc[x.id];
                const devoirs = sc.devoirs?.[x.id];
                const abs = isAbs(v);
                const num = abs ? null : (v == null || v === '' ? null : toNum(v));
                const devMoy = cfg.weightedAssessments ? devoirsMoyenne(devoirs) : null;
                const noteMoyenne = cfg.weightedAssessments ? moyenneMatiereAvecDevoirs(v, devoirs) : num;
                const coefficient = Math.max(1, Number(x.coefficient) || 1);
                const points = cfg.weightedAssessments && noteMoyenne != null ? noteMoyenne * coefficient : null;
                const pct = noteMoyenne != null && x.max > 0 ? noteMoyenne / x.max : null;
                const discRank = cfg.weightedAssessments && noteMoyenne != null ? disciplineRanks[x.id]?.[studentIndex] : null;
                return (
                  <tr key={x.id}>
                    <td>{x.label}</td>
                    {cfg.weightedAssessments ? (
                      <>
                        <td className="text-center">{abs ? 'Abs.' : (devMoy == null ? '—' : fmtNote(devMoy))}</td>
                        <td className="text-center">{abs ? 'Abs.' : (num == null ? '—' : fmtNote(num))}</td>
                        <td className="text-center">{abs ? 'Abs.' : (noteMoyenne == null ? '—' : fmtNote(noteMoyenne))}</td>
                        <td className="text-center">{coefficient}</td>
                        <td className="text-center">{points == null ? '—' : fmtNote(points, 2)}</td>
                        <td className="text-center">{discRank == null ? '—' : `${discRank}ex`}</td>
                      </>
                    ) : (
                      <>
                        <td className="text-center">{abs ? 'Abs.' : (num == null ? '—' : fmtNote(num))}</td>
                        <td className="text-center">{`/${x.max}`}</td>
                      </>
                    )}
                    <td>{pct == null ? '—' : noteAppreciation(pct)}</td>
                  </tr>
                );
              })}
            </React.Fragment>
          ))}
          {cfg.weightedAssessments ? (
            <tr className="tot">
              <td>Totaux</td>
              <td></td><td></td><td></td>
              <td className="text-center">{cs.coefficientTotal}</td>
              <td className="text-center">{fmtNote(cs.total, 2)}</td>
              <td></td><td></td>
            </tr>
          ) : (
            <tr className="tot"><td>Totaux</td><td className="text-center">{fmtNote(cs.total, 1)}</td><td className="text-center">/{cs.bareme}</td><td></td></tr>
          )}
        </tbody>
      </table>
      <div className="grid grid-cols-2 gap-3" style={{ marginTop: 10 }}>
        <table>
          <thead><tr><th>Période</th><th>Moyenne</th><th>Rang</th><th>Moy. classe</th></tr></thead>
          <tbody>
            {periodRows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="text-center">{r.moy == null ? '—' : fmtNote(r.moy)}</td>
                <td className="text-center">{r.rang == null ? '—' : `${r.rang}/${students.length}`}</td>
                <td className="text-center">{r.avg == null ? '—' : fmtNote(r.avg)}</td>
              </tr>
            ))}
            <tr className="tot"><td>Moyenne générale</td><td className="text-center">{trimAvgAll == null ? '—' : fmtNote(trimAvgAll)}</td><td></td><td></td></tr>
          </tbody>
        </table>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-3 py-2" style={{ background: '#dde6f2', borderRadius: 6 }}>
            <span style={{ fontSize: 11 }}>Rang</span><b>{rang}/{students.length}</b>
          </div>
          <div className="flex items-center justify-between px-3 py-2" style={{ background: cs.pass ? '#dde6f2' : '#fef2f2', borderRadius: 6 }}>
            <span style={{ fontSize: 11 }}>Moyenne {cfg.weightedAssessments ? '/20' : '/10'}</span><b style={{ color: cs.pass ? '#0a1e3d' : '#dc2626' }}>{fmtNote(cs.moy)}</b>
          </div>
          <div className="flex items-center justify-between px-3 py-2" style={{ background: '#fff8cf', borderRadius: 6 }}>
            <span style={{ fontSize: 11 }}>Mention</span><b>{m}</b>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 10, fontSize: 11 }}>
        <b>Observations du conseil des maîtres</b>
        <div style={{ border: '1px solid #cbd5e1', borderRadius: 6, minHeight: 40, marginTop: 4 }}></div>
      </div>
      <div className="grid grid-cols-3 gap-3" style={{ marginTop: 14, fontSize: 11, textAlign: 'center' }}>
        <div><div className="font-semibold">Le/La Maître(sse)</div><div style={{ marginTop: 24, borderTop: '1px solid #cbd5e1', paddingTop: 4 }}>{classTeacherNames(cls).join(' / ')}</div></div>
        <div><div className="font-semibold">{cycleTerminology(h.cycle).head}</div><div style={{ marginTop: 24, borderTop: '1px solid #cbd5e1', paddingTop: 4 }}>{h.directeur || ''}</div></div>
        <div><div className="font-semibold">Cachet de l'école</div><div style={{ marginTop: 24, borderTop: '1px solid #cbd5e1', paddingTop: 4 }}>&nbsp;</div></div>
      </div>
      <div className="flex items-center justify-between" style={{ marginTop: 14, fontSize: 9.5, color: '#64748b' }}>
        <span>N.B. : Ce bulletin n'est délivré qu'une seule fois. Toute demande de duplicata pourra faire l'objet d'une contrepartie financière.</span>
        <span>Bulletin édité le {editStamp}</span>
      </div>
    </div>
  );
}
function BulletinView({ state, loading, teacherName }) {
  const [classId, setClassId] = useState(null);
  const [studentIdx, setStudentIdx] = useState(0);
  const [period, setPeriod] = useState('T1');
  const [evaluationType, setEvaluationType] = useState('controle');
  const [mode, setMode] = useState('single');

  const classes = (state && state.classes) || {};
  const schoolPeriods = periodsForSchool(state);
  useEffect(() => {
    if (schoolPeriods.length && !schoolPeriods.some((item) => item.key === period)) setPeriod(schoolPeriods[0].key);
  }, [schoolPeriods.map((item) => item.key).join(','), period]);
  // Suit la période activée globalement (barre du haut) quand elle change
  const globalPeriode = state && state.header && state.header.periodeActif;
  useEffect(() => {
    if (globalPeriode && globalPeriode !== period && schoolPeriods.some((p) => p.key === globalPeriode)) setPeriod(globalPeriode);
  }, [globalPeriode]);
  const schoolLevels = levelsForSchool(state);
  const sheets = Object.entries(classes)
    .filter(([, c]) => (c.students || []).length && schoolLevels.includes(c.level) && (!teacherName || classHasTeacher(c, teacherName)))
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));

  useEffect(() => {
    if (!sheets.some(([id]) => id === classId)) {
      setClassId(sheets.length ? sheets[0][0] : null);
      setStudentIdx(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheets.map(([id]) => id).join(',')]);

  if (loading || !state) {
    return (
      <div className="flex items-center justify-center py-24 text-muted">
        <Loader2 className="animate-spin mr-2" size={18} /> Chargement des données…
      </div>
    );
  }

  if (!sheets.length) {
    return (
      <div className="sygenop-card p-10 text-center text-sm text-muted">
        <div className="font-bold mb-1 text-ink">Aucun élève</div>
        Ajoutez des élèves dans une classe du cycle {cycleLabel(state.header?.cycle).toLowerCase()} pour générer des bulletins.
      </div>
    );
  }

  const cls = classId ? classes[classId] : null;
  const students = (cls && cls.students) || [];
  const cfg = cls ? cfgForLevel(state, cls.level) : null;
  const student = students[studentIdx];
  const selectedEvaluationKey = evaluationKey(period, evaluationType);

  function sendWhatsapp() {
    if (!student) return;
    const tel = (student.tuteurTel || '').replace(/[^\d+]/g, '');
    if (!tel) { window.alert('Renseignez le téléphone du tuteur pour cet élève.'); return; }
    const cs = computeStudentScores(cfg, scoresFor(student, selectedEvaluationKey));
    const ranks = computeRanks(cfg, students, selectedEvaluationKey);
    const rang = ranks[studentIdx];
    const m = mention(cs.moy, cfg.weightedAssessments);
    const ecole = (state.header && state.header.ecole) || "l'école";
    const echelle = cfg.weightedAssessments ? '/20' : '/10';
    const msg = `Bonjour${student.tuteurNom ? ' ' + student.tuteurNom : ''}, voici les résultats de ${student.prenom || ''} ${student.nom || ''} — classe ${cls.name}, ${periodLabel(state, selectedEvaluationKey)} : moyenne ${fmtNote(cs.moy)}${echelle}, rang ${rang}/${students.length}, mention ${m}. Le bulletin détaillé est disponible et remis par ${ecole}. Merci.`;
    const url = 'https://wa.me/' + encodeURIComponent(tel.replace('+', '')) + '?text=' + encodeURIComponent(msg);
    window.open(url, '_blank');
  }

  return (
    <div className="space-y-4 sygenop-fade">
      <div className="no-print flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-semibold mb-1 text-muted">Classe</label>
          <select
            value={classId || ''}
            onChange={(e) => { setClassId(e.target.value); setStudentIdx(0); setMode('single'); }}
            className="px-3 py-2 rounded-lg border text-sm sygenop-input"
          >
            {sheets.map(([id, c]) => <option key={id} value={id}>{c.name} — {c.level}</option>)}
          </select>
        </div>
        {mode === 'single' && (
          <div>
            <label className="block text-xs font-semibold mb-1 text-muted">Élève</label>
            <select
              value={studentIdx}
              onChange={(e) => setStudentIdx(+e.target.value)}
              className="px-3 py-2 rounded-lg border text-sm sygenop-input"
            >
              {students.map((s, i) => <option key={s.id} value={i}>{(s.prenom || '') + ' ' + (s.nom || '') || `Élève ${i + 1}`}</option>)}
            </select>
          </div>
        )}
        <div className="flex gap-1.5 p-1 rounded-xl" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
          {schoolPeriods.map((t) => (
            <button
              key={t.key}
              onClick={() => setPeriod(t.key)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
              style={period === t.key ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select value={evaluationType} onChange={(e) => setEvaluationType(e.target.value)} className="px-3 py-2 rounded-lg border text-sm sygenop-input">
          {EVALUATION_TYPES.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
        </select>
        <button
          onClick={sendWhatsapp}
          disabled={mode !== 'single'}
          className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40"
          style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}
        >
          <Phone size={15} /> Envoyer au tuteur
        </button>
        <button
          onClick={() => window.print()}
          className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5"
          style={{ background: 'var(--gold)' }}
        >
          🖶 Imprimer
        </button>
        <button
          onClick={() => setMode(mode === 'batch' ? 'single' : 'batch')}
          className="px-3.5 py-2 rounded-lg text-sm font-semibold"
          style={{ background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' }}
        >
          {mode === 'batch' ? '↩ Revenir à un seul élève' : '🖶 Toute la classe (PDF multipages)'}
        </button>
      </div>

      {mode === 'batch' ? (
        students.map((s, i) => (
          <BulletinSheet key={s.id} state={state} cls={cls} level={cls.level} cfg={cfg} student={s} studentIndex={i} period={selectedEvaluationKey} />
        ))
      ) : student ? (
        <BulletinSheet state={state} cls={cls} level={cls.level} cfg={cfg} student={student} studentIndex={studentIdx} period={selectedEvaluationKey} />
      ) : (
        <div className="sygenop-card p-10 text-center text-sm text-muted">Sélectionnez un élève.</div>
      )}
    </div>
  );
}

/* ============================================================
   VUE — PAIEMENTS (frais de scolarité, reçus, WhatsApp, classement)
   ============================================================ */
function phoneDigits(tel) {
  return (tel || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
}
function QRBadge({ value, label = 'Document vérifiable', size = 120 }) {
  const sourceSize = Math.max(240, size * 2);
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=${sourceSize}x${sourceSize}&ecc=M&margin=4&format=png&data=${encodeURIComponent(value)}`;
  return <div className="text-center text-[9px] text-muted"><img src={src} alt="QR code de vérification" width={size} height={size} className="mx-auto" style={{ background: '#fff', padding: 3 }} />{label}</div>;
}

function FeesModal({ level, fees, onSave, onClose }) {
  const [rubriques, setRubriques] = useState(() => normalizePaymentRubriques(fees));
  const [mensualites, setMensualites] = useState(fees.mensualites || 10);
  function submit(e) {
    e.preventDefault();
    onSave({ rubriques: rubriques.filter((r) => r.label.trim()).map((r) => ({ ...r, label: r.label.trim(), montant: Math.max(0, Number(r.montant) || 0), actif: r.actif !== false })), mensualites: Math.max(1, Number(mensualites) || 10) });
  }
  const actives = rubriques.filter((r) => r.actif !== false);
  // Les montants « À l'entrée » sont réglés au moment de l'inscription :
  // ils ne participent PAS au paiement mensuel (seules les rubriques
  // à échéance annuelle sont étalées sur les mensualités).
  const totalEntree = actives.reduce((sum, r) => sum + (r.nature === 'entree' ? Number(r.montant) || 0 : 0), 0);
  const totalAnnuel = actives.reduce((sum, r) => sum + (r.nature !== 'entree' ? Number(r.montant) || 0 : 0), 0);
  const total = totalEntree + totalAnnuel;
  const nbMois = Math.max(1, Number(mensualites) || 10);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card p-6 max-w-5xl w-full sygenop-fade flex flex-col" style={{ maxHeight: '90vh' }}>
        <div className="flex items-center justify-between mb-2">
          <div className="font-bold text-ink">Frais de scolarité — {level}</div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <p className="text-xs mb-3 text-muted">Chaque rubrique est un montant annuel pour les élèves de {level}. Les rubriques « À l'entrée » sont payées à l'inscription et ne sont pas incluses dans les mensualités.</p>
        <div className="overflow-y-auto pr-1">
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
            {rubriques.map((r, index) => <div key={r.id} className="rounded-lg border p-3 flex flex-col gap-3" style={{ borderColor: 'var(--line)' }}><div className="flex items-center gap-2"><label className="block text-xs font-semibold flex-1">Rubrique<input value={r.label} onChange={(e) => setRubriques((list) => list.map((x, i) => i === index ? { ...x, label: e.target.value } : x))} className="mt-1 w-full px-3 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--line)' }} placeholder="Cantine, transport…" /></label><button type="button" onClick={() => setRubriques((list) => list.filter((_, i) => i !== index))} className="p-2 rounded-lg" style={{ color: 'var(--red)' }} title="Retirer"><Trash2 size={16} /></button></div><div className="flex items-end gap-2"><label className="block text-xs font-semibold flex-1">Montant<input type="number" min="0" step="500" value={r.montant} onChange={(e) => setRubriques((list) => list.map((x, i) => i === index ? { ...x, montant: e.target.value } : x))} className="mt-1 w-full px-3 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--line)' }} /></label><label className="block text-[10px] font-semibold w-28">Échéance<select value={r.nature || 'annuel'} onChange={(e) => setRubriques((list) => list.map((x, i) => i === index ? { ...x, nature: e.target.value } : x))} className="mt-1 w-full px-1.5 py-2 rounded-lg border text-xs"><option value="annuel">Annuelle</option><option value="entree">À l'entrée</option></select></label></div></div>)}
            <button type="button" onClick={() => setRubriques((list) => [...list, { id: uid('fee'), label: '', montant: 0, nature: 'annuel' }])} className="text-sm font-semibold flex items-center gap-1 self-end pb-2.5 justify-self-start" style={{ color: 'var(--green-d)' }}><Plus size={15} /> Ajouter une rubrique</button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="flex items-end gap-4">
            <label className="text-xs font-semibold block">Nombre de mensualités<input type="number" min="1" max="12" value={mensualites} onChange={(e) => setMensualites(e.target.value)} className="mt-1 w-24 px-3 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--line)' }} /></label>
            <div className="text-xs leading-relaxed text-muted">
              Total annuel : <b className="text-ink">{fmtFCFA(total)}</b> · Dont à l'entrée : <b style={{ color: 'var(--gold, #ffd100)' }}>{fmtFCFA(totalEntree)}</b><br />
              Mensualité ({nbMois} mois, hors entrée) : <b style={{ color: 'var(--green-d)' }}>{fmtFCFA(Math.round(totalAnnuel / nbMois))}</b>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
            <button type="submit" className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--green-d)' }}>Enregistrer</button>
          </div>
        </div>
      </form>
    </div>
  );
}

function StudentFeesModal({ level, fees, months, student, onSave, onClose }) {
  const rubriques = (fees && fees.rubriques) || [];
  const mensualites = (fees && fees.mensualites) || 10;
  const [casSocial, setCasSocial] = useState(normalizeCasSocial(student && student.casSocial));
  const [rubriquesMois, setRubriquesMois] = useState(() => {
    const existing = (student && student.rubriquesMois) || {};
    return Object.fromEntries(rubriques.map((r) => [r.id, existing[r.id] === undefined ? months.slice() : (Array.isArray(existing[r.id]) ? existing[r.id].slice() : [])]));
  });
  function toggleMonth(rubId, month) {
    setRubriquesMois((prev) => {
      const list = prev[rubId] || [];
      return { ...prev, [rubId]: list.includes(month) ? list.filter((m) => m !== month) : [...list, month].sort() };
    });
  }
  function setAll(rubId, on) {
    setRubriquesMois((prev) => ({ ...prev, [rubId]: on ? months.slice() : [] }));
  }
  function submit(e) {
    e.preventDefault();
    onSave({ casSocial: normalizeCasSocial(casSocial), rubriquesMois });
  }
  const coef = casSocial > 0 ? (100 - casSocial) / 100 : 1;
  // Même logique que studentAnnualDue : somme les montants bruts des rubriques
  // actives sans diviser par mensualites (sinon gonfle de 12/mensualites).
  const anneeDue = rubriques.filter((r) => r.nature !== 'entree' && (rubriquesMois[r.id] || []).length > 0).reduce((sum, r) => sum + Math.round(Number(r.montant) * coef), 0);
  const inscriptionDue = rubriques.filter((r) => r.nature === 'entree' && (rubriquesMois[r.id] || []).length > 0).reduce((s, r) => s + Math.round(Number(r.montant) * coef), 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card p-6 max-w-3xl w-full sygenop-fade flex flex-col" style={{ maxHeight: '90vh' }}>
        <div className="flex items-center justify-between mb-2">
          <div className="font-bold text-ink">Frais spécifiques — {student ? `${student.prenom || ''} ${student.nom || ''}`.trim() : ''}</div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <p className="text-xs mb-3 text-muted">{level} · Par défaut l'élève est abonné à toutes les rubriques tous les mois. Désactivez les mois où il n'est pas abonné (cantine, car…). S'il est « cas social », indiquez sa réduction en %.</p>
        <div className="overflow-y-auto pr-1 space-y-2">
          {rubriques.map((r) => {
            const liste = rubriquesMois[r.id] || [];
            return (
              <div key={r.id} className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--line)' }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold flex-1 text-ink">{r.label}</span>
                  <span className="text-xs font-semibold whitespace-nowrap" style={{ color: 'var(--green-d)' }}>{fmtFCFA(Number(r.montant) || 0)}</span>
                  <span className="text-[10px] uppercase whitespace-nowrap text-muted">{r.nature === 'entree' ? "À l'entrée" : `Mensuel ×${mensualites}`}</span>
                  <button type="button" onClick={() => setAll(r.id, true)} className="px-2 py-0.5 rounded text-[10px] font-bold uppercase" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>Tous</button>
                  <button type="button" onClick={() => setAll(r.id, false)} className="px-2 py-0.5 rounded text-[10px] font-bold uppercase" style={{ background: 'var(--bg)', color: 'var(--muted)' }}>Aucun</button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {months.map((M) => {
                    const on = liste.includes(M);
                    return <button type="button" key={M} onClick={() => toggleMonth(r.id, M)} className="px-2 py-1 rounded-lg text-[11px] font-semibold" style={on ? { background: 'var(--green-d)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' }}>{monthLabel(M)}</button>;
                  })}
                </div>
              </div>
            );
          })}
          <div className="flex flex-wrap items-end gap-4">
            <label className="text-xs font-semibold block">Réduction « cas social » (%)<input type="number" min="0" max="100" value={casSocial} onChange={(e) => setCasSocial(e.target.value)} className="mt-1 w-28 px-3 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--line)' }} placeholder="0" /></label>
            <div className="text-xs leading-relaxed text-muted">
              Inscription : <b style={{ color: 'var(--gold, #ffd100)' }}>{fmtFCFA(inscriptionDue)}</b> · Mensualités (année) : <b className="text-ink">{fmtFCFA(anneeDue)}</b><br />
              Total à payer par l'élève : <b style={{ color: 'var(--green-d)' }}>{fmtFCFA(inscriptionDue + anneeDue)}</b>{casSocial > 0 ? ` (réduction de ${casSocial}%)` : ''}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button type="submit" className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--green-d)' }}>Enregistrer</button>
        </div>
      </form>
    </div>
  );
}

function PaymentModal({ student, payment, rubriques = [], onSave, onClose, defaultMois }) {
  const isEdit = !!payment;
  const defaultLines = rubriques.map((r) => ({ id: r.id, label: r.label, montant: r.nature === 'entree' ? Number(r.montant) || 0 : Math.round((Number(r.montant) || 0) / Math.max(1, Number(r.mensualites) || 10)), checked: false }));
  const [typePaiement, setTypePaiement] = useState(() => {
    if (isEdit && payment?.type_paiement) return payment.type_paiement;
    return null;
  });
  const [form, setForm] = useState(() => (payment
    ? { date: payment.date || todayISO(), mois: payment.mois || (payment.date || todayISO()).slice(0, 7), montant: String(payment.montant ?? ''), mode: payment.mode || 'especes', lignes: payment.lignes || [], note: payment.note || '', type_paiement: payment.type_paiement || '' }
    : { date: todayISO(), mois: defaultMois || todayISO().slice(0, 7), montant: '', mode: 'especes', lignes: defaultLines, note: '', type_paiement: '' }));
  const filteredLines = useMemo(() => {
    if (!typePaiement) return form.lignes;
    if (typePaiement === 'inscription') return form.lignes.filter((l) => rubriques.find((r) => r.id === l.id && r.nature === 'entree'));
    return form.lignes.filter((l) => rubriques.find((r) => r.id === l.id && r.nature !== 'entree'));
  }, [typePaiement, form.lignes, rubriques]);
  function submit(e) {
    e.preventDefault();
    const lignes = (form.lignes || []).filter((line) => line.checked || payment?.lignes).map((line) => ({ ...line, montant: Number(line.montant) || 0 })).filter((line) => line.montant > 0);
    const montant = lignes.length ? lignes.reduce((sum, line) => sum + line.montant, 0) : Number(String(form.montant).replace(',', '.'));
    if (!montant || montant <= 0) return;
    onSave({ ...form, montant, lignes, rubrique: lignes.length === 1 ? lignes[0].id : 'general', type_paiement: typePaiement || 'mensualite' });
  }
  function handleTypeSelect(selectedType) {
    setTypePaiement(selectedType);
    setForm((f) => {
      const updatedLignes = defaultLines.map((line) => {
        const rubrique = rubriques.find((r) => r.id === line.id);
        if (selectedType === 'inscription') return { ...line, checked: rubrique?.nature === 'entree', montant: rubrique?.nature === 'entree' ? Number(rubrique.montant) || 0 : line.montant };
        return { ...line, checked: rubrique?.nature !== 'entree' && rubrique?.active !== false, montant: rubrique?.nature !== 'entree' ? Math.round((Number(rubrique?.montant) || 0) / Math.max(1, Number(rubrique?.mensualites) || 10)) : line.montant };
      });
      const autoMontant = updatedLignes.filter((l) => l.checked).reduce((sum, l) => sum + (Number(l.montant) || 0), 0);
      return { ...f, type_paiement: selectedType, lignes: updatedLignes, montant: autoMontant > 0 ? String(autoMontant) : '' };
    });
  }
  if (!isEdit && !typePaiement) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="sygenop-card p-6 max-w-lg w-full sygenop-fade">
          <div className="flex items-center justify-between mb-4">
            <div className="font-bold text-ink">Type de paiement — {student.prenom} {student.nom}</div>
            <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
          </div>
          <p className="text-xs mb-4 text-muted">Choisissez le type de paiement avant de procéder à l'encaissement.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => handleTypeSelect('inscription')}
              className="p-5 rounded-xl border-2 text-left transition-all hover:scale-[1.02]"
              style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--green-d)'; e.currentTarget.style.background = 'var(--green-l)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.background = 'var(--bg)'; }}
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}>
                  <ClipboardCheck size={20} />
                </div>
                <div className="font-bold text-sm text-ink">Inscription / Réinscription</div>
              </div>
              <div className="text-xs text-muted">Frais d'entrée à l'inscription (inscription, tenue…)</div>
            </button>
            <button
              type="button"
              onClick={() => handleTypeSelect('mensualite')}
              className="p-5 rounded-xl border-2 text-left transition-all hover:scale-[1.02]"
              style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--green-d)'; e.currentTarget.style.background = 'var(--green-l)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--line)'; e.currentTarget.style.background = 'var(--bg)'; }}
            >
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
                  <CalendarDays size={20} />
                </div>
                <div className="font-bold text-sm text-ink">Mensualité / Scolarité</div>
              </div>
              <div className="text-xs text-muted">Paiement mensuel de la scolarité</div>
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card p-6 max-w-5xl w-full sygenop-fade flex flex-col" style={{ maxHeight: '90vh' }}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="font-bold text-ink">
              {isEdit ? `Modifier le paiement — reçu ${payment.recu}` : `Nouveau paiement — ${student.prenom} ${student.nom}`}
            </div>
            {!isEdit && (
              <div
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold cursor-pointer"
                style={{ background: typePaiement === 'inscription' ? 'var(--gold-l)' : 'var(--green-l)', color: typePaiement === 'inscription' ? 'var(--gold)' : 'var(--green-d)' }}
                onClick={() => { setTypePaiement(null); setForm((f) => ({ ...f, type_paiement: '', lignes: defaultLines })); }}
                title="Changer le type de paiement"
              >
                {typePaiement === 'inscription' ? <ClipboardCheck size={12} /> : <CalendarDays size={12} />}
                {PAYMENT_TYPES[typePaiement]?.label}
                <X size={11} />
              </div>
            )}
          </div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Montant (FCFA) *</label>
            <input
              autoFocus type="number" min="0" step="any" inputMode="decimal" value={form.montant}
              onChange={(e) => setForm((f) => ({ ...f, montant: e.target.value }))}
              className="w-full px-3 py-2.5 rounded-lg border text-sm sygenop-input"
              placeholder="0"
            />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Date</label>
            <input
              type="date" value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
              className="w-full px-3 py-2.5 rounded-lg border text-sm sygenop-input"
            />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Mode de paiement</label>
            <select
              value={form.mode} onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}
              className="w-full px-3 py-2.5 rounded-lg border text-sm sygenop-input"
            >
              {Object.entries(MODES_PAIEMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Mois concerné</label>
            <input type="month" value={form.mois} onChange={(e) => setForm((f) => ({ ...f, mois: e.target.value }))} className="w-full px-3 py-2.5 rounded-lg border text-sm sygenop-input" />
          </div>
        </div>
        <div className="overflow-y-auto pr-1 mt-4">
          <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--line)' }}>
            <div className="text-xs font-semibold text-muted">
              {typePaiement === 'inscription' ? "Rubriques d'inscription — cochez et ajustez le montant" : "Rubriques mensuelles — cochez et ajustez le montant si paiement partiel"}
            </div>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-2">
              {filteredLines.map((line, index) => {
                const realIndex = form.lignes.findIndex((l) => l.id === line.id);
                return <div key={line.id} className="grid grid-cols-[auto_1fr_120px] items-center gap-2 text-sm"><input type="checkbox" checked={!!line.checked} onChange={(e) => setForm((f) => ({ ...f, lignes: f.lignes.map((x, i) => i === realIndex ? { ...x, checked: e.target.checked } : x) }))} /><span>{line.label}</span><input type="number" min="0" disabled={!line.checked} value={line.montant} onChange={(e) => setForm((f) => ({ ...f, lignes: f.lignes.map((x, i) => i === realIndex ? { ...x, montant: e.target.value } : x) }))} className="px-2 py-1 rounded border" style={{ borderColor: 'var(--line)' }} /></div>;
              })}
              {filteredLines.length === 0 && (
                <div className="text-xs py-2 text-muted">
                  {typePaiement === 'inscription' ? "Aucune rubrique d'entrée configurée pour ce niveau." : "Aucune rubrique mensuelle configurée pour ce niveau."}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3">
          <label className="text-xs font-semibold block mb-1 text-muted">Note (facultatif)</label>
          <input
            value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            className="w-full px-3 py-2.5 rounded-lg border text-sm sygenop-input"
            placeholder="Ex : versement partiel"
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="text-xs font-semibold text-muted">
            Montant total : <b style={{ color: 'var(--green-d)' }}>{fmtFCFA(form.lignes?.filter((line) => line.checked).reduce((sum, line) => sum + (Number(line.montant) || 0), 0) || Number(String(form.montant).replace(',', '.')) || 0)}</b>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
            <button type="submit" className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: 'var(--green-d)' }}>
              {isEdit ? <><Pencil size={14} /> Enregistrer les modifications</> : <><Receipt size={14} /> Encaisser &amp; générer le reçu</>}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function ReceiptSheet({ state, cls, student, payment }) {
  const h = state.header || {};
  const reliquat = studentReliquatByType(state, cls.level, student);
  const list = studentPaiements(student);
  const idx = list.findIndex((p) => p.id === payment.id);
  const isTypeInscription = paymentTypeKey(payment) === 'inscription';
  const typeDue = isTypeInscription ? reliquat.due.inscription : reliquat.due.mensualite;
  const paidBeforeType = list.slice(0, idx < 0 ? list.length : idx).filter((p) => isTypeInscription ? paymentTypeKey(p) === 'inscription' : paymentTypeKey(p) === 'mensualite').reduce((s, p) => s + (Number(p.montant) || 0), 0);
  const paidTotalType = paidBeforeType + (Number(payment.montant) || 0);
  const soldeType = Math.max(0, typeDue - paidTotalType);
  const now = new Date();
  const editStamp = now.toLocaleDateString('fr-FR') + ' à ' + now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const rubrique = feeForLevel(state, cls.level).rubriques.find((item) => item.id === payment.rubrique);
  const periodeLabel = rubrique?.label || (payment.rubrique === 'general' ? 'Scolarité générale' : payment.periode || 'Scolarité');
  const moisPaiement = payment.mois || (payment.date || '').slice(0, 7);
  const totalMoisType = studentPaiements(student).filter((item) => (item.mois || (item.date || '').slice(0, 7)) === moisPaiement && (isTypeInscription ? paymentTypeKey(item) === 'inscription' : paymentTypeKey(item) === 'mensualite')).reduce((sum, item) => sum + (Number(item.montant) || 0), 0);
  const reliquatMensuel = Math.max(0, studentMonthlyDue(state, cls.level, student) - totalMoisType);

  return (
    <div className="recu-sheet sygenop-card">
          <div className="flex items-center gap-3 pb-2" style={{ borderBottom: '2px solid #0a1e3d' }}>
        <SchoolLogoMark state={state} width={50} />
        <div className="flex-1 text-center" style={{ fontSize: 10.5, lineHeight: 1.3 }}>
          <div>République du Sénégal</div>
          <div style={{ fontWeight: 800, fontSize: 13, marginTop: 2 }}>{(h.ecole || 'ÉCOLE').toUpperCase()}</div>
          <div style={{ fontSize: 9.5 }}>IEF {h.ief || ''} · Année scolaire {h.annee || ''}</div>
        </div>
      </div>
      <div className="text-center font-bold py-1.5" style={{ background: '#0a1e3d', color: '#fff', borderRadius: 4, fontSize: 12, marginTop: 8 }}>
        REÇU DE PAIEMENT N° {payment.recu}
        {isTypeInscription && <div style={{ fontSize: 9, fontWeight: 600, marginTop: 2, background: '#ffd100', display: 'inline-block', padding: '1px 8px', borderRadius: 3 }}>INSCRIPTION / RÉINSCRIPTION</div>}
        {!isTypeInscription && <div style={{ fontSize: 9, fontWeight: 600, marginTop: 2, background: '#0a1e3d', border: '1px solid #fff', display: 'inline-block', padding: '1px 8px', borderRadius: 3 }}>MENSUALITÉ / SCOLARITÉ</div>}
      </div>
      <div className="flex justify-end mt-2"><QRBadge value={`SYGENOP|CARTE|${student.cardCode || `ELV-${String(student.id || '').slice(-8).toUpperCase()}`}|${student.id}`} /></div>
      <div className="grid grid-cols-2 gap-2" style={{ fontSize: 11, margin: '10px 0' }}>
        <div><b>Élève :</b> {student.prenom || '—'} {student.nom || ''}</div>
        <div><b>Classe :</b> {cls.name} ({cls.level})</div>
        <div><b>Date de paiement :</b> {fmtDateFr(payment.date)}</div>
        <div><b>Mode :</b> {MODES_PAIEMENT[payment.mode] || payment.mode}</div>
      </div>
      <table>
        <thead><tr><th>Désignation</th><th>Montant</th></tr></thead>
        <tbody>
          {(payment.lignes?.length ? payment.lignes : [{ label: periodeLabel, montant: payment.montant }]).map((line, index) => <tr key={index}><td>{line.label}{moisPaiement ? ` — ${moisPaiement}` : ''}{payment.note && index === 0 ? ` — ${payment.note}` : ''}</td><td className="text-center">{fmtFCFA(line.montant)}</td></tr>)}
          <tr className="recu-total"><td>Montant reçu</td><td className="text-center">{fmtFCFA(payment.montant)}</td></tr>
          {isTypeInscription ? <tr><td>Reliquat inscription</td><td className="text-center" style={{ color: reliquat.inscription > 0 ? '#dc2626' : '#0a1e3d', fontWeight: 700 }}>{fmtFCFA(reliquat.inscription)}</td></tr> : <>
            <tr><td>Reliquat scolarité</td><td className="text-center" style={{ color: reliquat.mensualite > 0 ? '#dc2626' : '#0a1e3d', fontWeight: 700 }}>{fmtFCFA(reliquat.mensualite)}</td></tr>
            <tr><td>Reliquat mensuel</td><td className="text-center">{fmtFCFA(reliquatMensuel)}</td></tr>
          </>}
        </tbody>
      </table>
      <div style={{ fontSize: 10.5, fontStyle: 'italic', margin: '8px 0' }}>
        Arrêté le présent reçu à la somme de : <b>{montantEnLettres(payment.montant)} francs CFA</b>.
      </div>
      <div className="grid grid-cols-2 gap-2" style={{ fontSize: 11 }}>
        <div><b>{isTypeInscription ? 'Total dû (inscription) :' : 'Total dû (scolarité) :'}</b> {fmtFCFA(typeDue)}</div>
        <div><b>Total versé à ce jour :</b> {fmtFCFA(paidTotalType)}</div>
        <div style={{ gridColumn: '1 / -1' }}>
          <b>Solde restant :</b> <span style={{ color: soldeType > 0 ? '#dc2626' : '#0a1e3d', fontWeight: 700 }}>{fmtFCFA(soldeType)}</span>
        </div>
        <div style={{ gridColumn: '1 / -1', borderTop: '1px solid #cbd5e1', paddingTop: 6, marginTop: 4 }}>
          {isTypeInscription ? (
            <b style={{ color: '#ffd100' }}>Reliquat inscription :</b>
          ) : (
            <b style={{ color: '#0a1e3d' }}>Reliquat scolarité :</b>
          )}{' '}
          <span style={{ color: (isTypeInscription ? reliquat.inscription : reliquat.mensualite) > 0 ? '#dc2626' : '#0a1e3d', fontWeight: 700 }}>
            {fmtFCFA(isTypeInscription ? reliquat.inscription : reliquat.mensualite)}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3" style={{ marginTop: 16, fontSize: 10.5, textAlign: 'center' }}>
        <div><div className="font-semibold">Signature du payeur</div><div style={{ marginTop: 20, borderTop: '1px solid #cbd5e1', paddingTop: 4 }}>&nbsp;</div></div>
        <div><div className="font-semibold">{cycleTerminology(h.cycle).head}</div><div style={{ marginTop: 20, borderTop: '1px solid #cbd5e1', paddingTop: 4 }}>{h.directeur || ''}</div></div>
      </div>
      <div className="recu-stub flex items-center justify-between">
        <span>Reçu édité le {editStamp}</span>
        <span>{h.tel || ''}</span>
      </div>
    </div>
  );
}

function StudentHistoryModal({ state, student, cls, due, monthlyDue = 0, onClose, onPrint, onEdit, onDelete }) {
  const payments = studentPaiements(student).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const paid = studentTotalPaid(student);
  const solde = Math.max(0, due - paid);
  const reliquat = studentReliquatByType(state, cls.level, student);
  const monthKeys = (() => {
    const set = new Set(schoolYearMonths(state));
    studentPaiements(student).forEach((p) => { const k = paymentMonthKey(p); if (k) set.add(k); });
    return [...set].sort();
  })();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="sygenop-card p-6 max-w-lg w-full sygenop-fade max-h-[85vh] overflow-auto">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="font-bold text-ink">Historique — {student.prenom} {student.nom}</div>
            <div className="text-xs text-muted">
              {cls.name} · Mensualité {fmtFCFA(monthlyDue)} · Dû {fmtFCFA(due)} · Payé {fmtFCFA(paid)} · Solde {fmtFCFA(solde)}
            </div>
            <div className="flex items-center gap-3 mt-1.5">
              <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}>
                <ClipboardCheck size={10} /> Inscription : dû {fmtFCFA(reliquat.due.inscription)} · payé {fmtFCFA(reliquat.paid.inscription)} · reliquat {fmtFCFA(reliquat.inscription)}
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
                <CalendarDays size={10} /> Scolarité : dû {fmtFCFA(reliquat.due.mensualite)} · payé {fmtFCFA(reliquat.paid.mensualite)} · reliquat {fmtFCFA(reliquat.mensualite)}
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        {!!monthKeys.length && (
          <div className="mb-4">
            <div className="text-xs font-bold uppercase tracking-wide mb-2 text-muted">Récap mensuel — versements &amp; reliquats</div>
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line)' }}>
                  {['Mois', 'Versé', 'Situation', 'Reliquat'].map((hh) => (
                    <th key={hh} className="py-1.5 px-1 text-left font-bold uppercase tracking-wide text-muted">{hh}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {monthKeys.map((month) => {
                  const paidM = studentPaidInMonth(student, month);
                  const resteM = Math.max(0, monthlyDue - paidM);
                  const stM = paidM <= 0 ? { label: 'Pas à jour', tone: 'red' } : (monthlyDue > 0 && paidM >= monthlyDue) ? { label: 'À jour', tone: 'green' } : { label: 'Partiel', tone: 'gold' };
                  return (
                    <tr key={month} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td className="py-1.5 px-1 font-semibold text-ink">{monthLabel(month)}</td>
                      <td className="py-1.5 px-1" style={{ color: paidM > 0 ? 'var(--green-d)' : 'var(--muted)' }}>{paidM > 0 ? fmtFCFA(paidM) : '—'}</td>
                      <td className="py-1.5 px-1"><Pill tone={stM.tone}>{stM.label}</Pill></td>
                      <td className="py-1.5 px-1 font-semibold" style={{ color: resteM > 0 ? 'var(--red)' : 'var(--muted)' }}>{resteM > 0 ? fmtFCFA(resteM) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!payments.length ? (
          <div className="text-sm text-center py-8 text-muted">Aucun paiement enregistré pour cet élève.</div>
        ) : (
          <div className="space-y-2">
            {payments.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 p-3 rounded-lg bg-bg">
                <div>
                  <div className="text-sm font-semibold text-ink">
                    {fmtFCFA(p.montant)} <span className="font-normal text-muted">· {MODES_PAIEMENT[p.mode] || p.mode}</span>
                    {p.type_paiement === 'inscription' && <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}><ClipboardCheck size={9} /> Inscription</span>}
                    {p.type_paiement === 'mensualite' && <span className="ml-1 inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}><CalendarDays size={9} /> Mensualité</span>}
                  </div>
                  <div className="text-xs text-muted">{fmtDateFr(p.date)} · Reçu {p.recu}{p.note ? ` · ${p.note}` : ''}</div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {onEdit && <button onClick={() => onEdit(p)} className="p-1.5 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' }} title="Modifier ce reçu"><Pencil size={14} /></button>}
                  <button onClick={() => onPrint(p)} className="p-1.5 rounded-lg" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }} title="Imprimer le reçu"><Printer size={14} /></button>
                  {onDelete && <button onClick={() => onDelete(p)} className="p-1.5 rounded-lg" style={{ background: 'var(--red-l)', color: 'var(--red)' }} title="Supprimer"><Trash2 size={14} /></button>}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end mt-5">
          <button onClick={onClose} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Fermer</button>
        </div>
      </div>
    </div>
  );
}

function InterSchoolRanking({ activeSchoolId }) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
const schools = (await sb('GET', 'schools', 'select=id,name,type&actif=not.is.false&order=name.asc')) || [];
        const datas = (await sb('GET', 'school_data', 'select=school_id,payload')) || [];
        const byId = {};
        datas.forEach((d) => { byId[d.school_id] = d.payload; });
        const computed = schools
          .map((s) => {
            const payload = byId[s.id];
            const sum = payload ? schoolPaymentsSummary(payload) : { totalDue: 0, totalPaid: 0, effectif: 0, aJour: 0, taux: 0 };
            return { id: s.id, name: s.name, type: s.type, ...sum };
          })
          .sort((a, b) => b.taux - a.taux || b.totalPaid - a.totalPaid);
        if (!cancelled) setRows(computed);
      } catch (e) {
        if (!cancelled) setError(sbErrMsg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted">
        <Loader2 className="animate-spin mr-2" size={18} /> Calcul du classement…
      </div>
    );
  }
  if (error) {
    return (
      <div className="sygenop-card p-6 text-sm" style={{ color: 'var(--red)' }}>
        Impossible de charger le classement inter-écoles : {error}
      </div>
    );
  }
  const withData = rows.filter((r) => r.effectif > 0);
  return (
    <div className="space-y-3">
      <p className="text-xs px-1 text-muted">
        Classement des écoles selon leur taux de recouvrement des frais de scolarité (montant encaissé ÷ montant dû), toutes classes confondues.
      </p>
      {!withData.length ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          Aucune donnée de paiement disponible pour le moment dans les écoles connectées.
        </div>
      ) : (
        <div className="sygenop-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ borderBottom: '1px solid var(--line)' }}>
                {['Rang', 'École', 'Élèves', 'Dû', 'Encaissé', 'Taux', 'À jour'].map((hh) => (
                  <th key={hh} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap text-muted">{hh}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {withData.map((r, i) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--line)', background: r.id === activeSchoolId ? 'var(--green-l)' : 'transparent' }}>
                  <td className="px-4 py-3 font-bold flex items-center gap-1" style={{ color: 'var(--gold)' }}>{i === 0 && <Trophy size={13} />} {i + 1}</td>
                  <td className="px-4 py-3 font-semibold flex items-center gap-1.5 text-ink">
                    <Building2 size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
                    {r.name}{r.id === activeSchoolId ? <span style={{ color: 'var(--green-d)' }}> (votre école)</span> : ''}
                  </td>
                  <td className="px-4 py-3">{r.effectif}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{fmtFCFA(r.totalDue)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{fmtFCFA(r.totalPaid)}</td>
                  <td className="px-4 py-3 font-bold" style={{ color: r.taux >= 0.8 ? 'var(--green-d)' : r.taux >= 0.5 ? 'var(--gold)' : 'var(--red)' }}>{Math.round(r.taux * 100)}%</td>
                  <td className="px-4 py-3">{r.aJour}/{r.effectif}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   DÉPENSES (SORTIES) + RÉCAPITULATIF ENTRÉES/SORTIES
   ============================================================ */
const DEPENSE_CATEGORIES = [
  'Fournitures scolaires', 'Matériel & équipement', 'Entretien & maintenance',
  'Eau & électricité', 'Salaires & indemnités', 'Transport', 'Communication', 'Autres',
];

function ExpenseModal({ expense, personnel = [], onSave, onClose, defaultDate = null }) {
  const isEdit = !!expense;
  const [form, setForm] = useState(() => (expense
    ? { libelle: expense.libelle || '', montant: String(expense.montant ?? ''), date: expense.date || todayISO(), categorie: expense.categorie || DEPENSE_CATEGORIES[0], mode: expense.mode || 'especes', beneficiaire: expense.beneficiaire || '', note: expense.note || '', personnelIds: expense.personnelIds || [] }
    : { libelle: '', montant: '', date: defaultDate || todayISO(), categorie: DEPENSE_CATEGORIES[0], mode: 'especes', beneficiaire: '', note: '', personnelIds: [] }));
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function submit(e) {
    e.preventDefault();
    if (!form.libelle.trim()) return;
    const montant = form.categorie === 'Salaires & indemnités'
      ? personnel.filter((p) => form.personnelIds.includes(p.id)).reduce((sum, p) => sum + (Number(p.salaireBase) || 0), 0)
      : Number(String(form.montant).replace(',', '.'));
    if (!montant || montant <= 0) return;
    onSave({ libelle: form.libelle.trim(), montant, date: form.date || todayISO(), categorie: form.categorie || 'Autres', mode: form.mode || 'especes', beneficiaire: form.beneficiaire.trim(), note: form.note.trim(), personnelIds: form.personnelIds });
  }
  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card p-6 max-w-md w-full sygenop-fade max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-ink">
            {isEdit ? 'Modifier la dépense' : 'Nouvelle dépense'}
          </div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Objet / Libellé de la dépense *</label>
            <input autoFocus value={form.libelle} onChange={(e) => set('libelle', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : Achat de craies et cahiers" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Montant (FCFA) *</label>
              <input type="number" min="0" step="any" inputMode="decimal" value={form.montant} onChange={(e) => set('montant', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle} placeholder="0" />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Date</label>
              <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle} />
            </div>
          </div>
          {form.categorie === 'Salaires & indemnités' && <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}><div className="text-xs font-bold text-muted">Personnel à payer</div>{personnel.filter((p) => p.statut === 'Actif').map((p) => <label key={p.id} className="flex items-center justify-between gap-2 text-sm"><span><input type="checkbox" checked={form.personnelIds.includes(p.id)} onChange={(e) => set('personnelIds', e.target.checked ? [...form.personnelIds, p.id] : form.personnelIds.filter((id) => id !== p.id))} className="mr-2" />{personFullName(p)} <span className="text-muted">({displayStaffRole(p.role)})</span></span><b>{fmtFCFA(p.salaireBase)}</b></label>)}<div className="pt-2 font-bold text-sm" style={{ borderTop: '1px solid var(--line)' }}>Total salaires : {fmtFCFA(personnel.filter((p) => form.personnelIds.includes(p.id)).reduce((sum, p) => sum + (Number(p.salaireBase) || 0), 0))}</div></div>}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Catégorie</label>
              <select value={form.categorie} onChange={(e) => set('categorie', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle}>
                {DEPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Mode de paiement</label>
              <select value={form.mode} onChange={(e) => set('mode', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle}>
                {Object.entries(MODES_PAIEMENT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Bénéficiaire (fournisseur, prestataire…) <span className="font-normal">(facultatif)</span></label>
            <input value={form.beneficiaire} onChange={(e) => set('beneficiaire', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : Librairie du Plateau" />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Note <span className="font-normal">(facultatif)</span></label>
            <input value={form.note} onChange={(e) => set('note', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle} placeholder="Détails complémentaires…" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button type="submit" className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: 'var(--green-d)' }}>
            <TrendingDown size={14} /> {isEdit ? 'Enregistrer' : 'Encaisser la dépense'}
          </button>
        </div>
      </form>
    </div>
  );
}

function DepensesTab({ depenses, onAdd, onEdit, onDelete, onPrint, readOnly, onExport, baseMonths = [], focusMonth = null }) {
  const [q, setQ] = useState('');
  const [month, setMonth] = useState('');
  const [showAllYear, setShowAllYear] = useState(false);
  useEffect(() => {
    if (focusMonth) setMonth(focusMonth);
  }, [focusMonth]);
  const todayKey = todayISO().slice(0, 7);
  const baseMonthList = [...new Set([...(baseMonths || []), ...depenses.map((d) => String(d.date || '').slice(0, 7)).filter(Boolean)])].sort();
  const expenseMonths = [...new Set(depenses.map((d) => String(d.date || '').slice(0, 7)).filter(Boolean))].sort();
  let activeMonth;
  if (month && baseMonthList.includes(month)) activeMonth = month;
  else if (expenseMonths.includes(todayKey)) activeMonth = todayKey;
  else if (expenseMonths.length) activeMonth = expenseMonths[expenseMonths.length - 1];
  else activeMonth = todayKey;
  const monthOptions = baseMonthList.includes(activeMonth) ? baseMonthList : [...baseMonthList, activeMonth].sort();
  const sorted = [...depenses].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  // « Année entière » = année scolaire uniquement (mois de baseMonths, Oct → Juil)
  const baseMonthSet = new Set(baseMonths || []);
  const scoped = showAllYear
    ? sorted.filter((d) => baseMonthSet.has(String(d.date || '').slice(0, 7)))
    : sorted.filter((d) => String(d.date || '').slice(0, 7) === activeMonth);
  const filtered = q.trim()
    ? scoped.filter((d) => `${d.libelle || ''} ${d.categorie || ''} ${d.beneficiaire || ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    : scoped;
  const total = filtered.reduce((s, d) => s + (Number(d.montant) || 0), 0);
  // Plus grosse dépense — calcul sûr même si le tableau est vide ou contient
  // des montants non numériques (évite "Cannot read properties of null").
  const maxDep = filtered.length
    ? filtered.reduce((m, d) => (Number(d.montant) || 0) > (Number(m.montant) || 0) ? d : m, filtered[0])
    : null;
  const byCategory = {};
  scoped.forEach((d) => { const key = d.categorie || 'Autre'; byCategory[key] = (byCategory[key] || 0) + (Number(d.montant) || 0); });
  const scopedTotal = scoped.reduce((s, d) => s + (Number(d.montant) || 0), 0);

  return (
    <div className="space-y-4">
      {readOnly && (
        <div className="sygenop-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2" style={{ background: 'var(--gold-l)', color: '#92710c' }}>
          <Eye size={14} /> Mode consultation (IEF) — lecture seule, aucune modification possible.
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard icon={TrendingDown} label={showAllYear ? 'Total des sorties' : `Sorties — ${monthLabel(activeMonth)}`} value={fmtFCFA(total)} tone="red" />
        <StatCard icon={Receipt} label="Nombre de dépenses" value={filtered.length} tone="gold" />
        <StatCard icon={AlertTriangle} label="Plus grosse dépense" tone="red" value={maxDep ? fmtFCFA(maxDep.montant) : '—'} sub={maxDep ? maxDep.libelle : 'Aucune dépense'} />
      </div>
      {!showAllYear && !!depenses.length && (
        <div className="text-xs px-1 flex flex-wrap gap-x-4 gap-y-1 items-center text-muted">
          <span>Récap <b className="text-ink">{monthLabel(activeMonth)}</b> : <b className="text-ink">{fmtFCFA(scopedTotal)}</b> en {scoped.length} opération(s)</span>
          {Object.entries(byCategory).map(([cat, amount]) => <span key={cat}>{cat} : <b className="text-ink">{fmtFCFA(amount)}</b></span>)}
        </div>
      )}
      <div className="sygenop-card p-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <select value={activeMonth} onChange={(e) => setMonth(e.target.value)} className="px-3 py-2.5 rounded-lg border text-sm font-semibold whitespace-nowrap" style={{ borderColor: 'var(--line)', background: 'var(--bg)', color: 'var(--ink)' }}>
          {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <button onClick={() => setShowAllYear((v) => !v)} className="px-3 py-2.5 rounded-lg text-xs font-semibold whitespace-nowrap" style={{ background: 'var(--bg)', color: showAllYear ? 'var(--green-d)' : 'var(--muted)', border: '1px solid var(--line)' }}>
          {showAllYear ? 'Année entière' : 'Mois sélectionné'}
        </button>
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une dépense (libellé, catégorie, bénéficiaire)…" className="w-full pl-9 pr-3 py-2.5 rounded-lg border text-sm" style={{ borderColor: 'var(--line)', background: 'var(--bg)', color: 'var(--ink)' }} />
        </div>
        <div className="flex gap-2">
          <button onClick={onExport} className="px-3.5 py-2.5 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 whitespace-nowrap sygenop-btn sygenop-btn--ghost">
            <Download size={15} /> Exporter CSV
          </button>
          {!readOnly && (
            <button onClick={() => onAdd((activeMonth && activeMonth !== todayKey) ? lastDayISO(activeMonth) : null)} className="px-3.5 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 whitespace-nowrap" style={{ background: 'var(--red)' }}>
              <Plus size={16} /> Nouvelle dépense
            </button>
          )}
        </div>
      </div>
      {!depenses.length ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          Aucune dépense enregistrée pour le moment. Ajoutez la première dépense (sortie d'argent) de l'école.
        </div>
      ) : !filtered.length ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          {showAllYear ? 'Aucun résultat pour cette recherche.' : `Aucune dépense enregistrée en ${monthLabel(activeMonth)}.`}
        </div>
      ) : (
        <div className="sygenop-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ borderBottom: '1px solid var(--line)' }}>
                {['Date', 'Libellé', 'Catégorie', 'Mode', 'Bénéficiaire', 'Montant', 'Actions'].map((h) => (
                  <th key={h} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap text-muted">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td className="px-4 py-3 whitespace-nowrap text-muted">{fmtDateFr(d.date)}</td>
                  <td className="px-4 py-3 font-semibold text-ink">{d.libelle}</td>
                  <td className="px-4 py-3"><Pill tone="gold">{d.categorie}</Pill></td>
                  <td className="px-4 py-3 text-muted">{MODES_PAIEMENT[d.mode] || d.mode || '—'}</td>
                  <td className="px-4 py-3 text-muted">{d.beneficiaire || '—'}</td>
                  <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: 'var(--red)' }}>− {fmtFCFA(d.montant)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => onPrint(d)} className="p-1.5 rounded-lg hover:bg-black/5" style={{ color: 'var(--gold)' }} title="Voir le reçu"><Printer size={15} /></button>
                      {!readOnly && (
                        <>
                        <button onClick={() => onEdit(d)} className="p-1.5 rounded-lg hover:bg-black/5 text-muted" title="Modifier"><Pencil size={15} /></button>
                        <button onClick={() => onDelete(d)} className="p-1.5 rounded-lg hover:bg-black/5" style={{ color: 'var(--red)' }} title="Supprimer"><Trash2 size={15} /></button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="px-4 py-3 font-bold" colSpan={2} style={{ color: 'var(--ink)' }}>Total sorties</td>
                <td colSpan={3}></td>
                <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: 'var(--red)' }}>− {fmtFCFA(total)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function ExpenseReceipt({ state, expense }) {
  const code = expense.recu || expense.id;
  const editStamp = new Date().toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  return <div className="recu-sheet sygenop-card">
    <div className="flex items-start justify-between"><div className="flex items-center gap-2"><SchoolLogoMark state={state} width={48} /><div><div className="font-bold text-lg">{state.header?.ecole || 'EduLink Pro'}</div><div className="text-xs text-muted">Gestion scolaire</div></div></div><QRBadge value={`EduLink Pro|Sortie|${code}`} /></div>
    <h2 className="text-center font-bold py-2 mt-3" style={{ background: '#7f1d1d', color: '#fff' }}>REÇU DE SORTIE / DÉPENSE</h2>
    <div className="space-y-2 mt-4 text-sm"><div><b>Code :</b> {code}</div><div><b>Date :</b> {fmtDateFr(expense.date)}</div><div><b>Rubrique :</b> {expense.categorie}</div><div><b>Libellé :</b> {expense.libelle}</div><div><b>Bénéficiaire :</b> {expense.beneficiaire || '—'}</div><div><b>Mode :</b> {MODES_PAIEMENT[expense.mode] || expense.mode || '—'}</div><div><b>Montant sorti :</b> {fmtFCFA(expense.montant)}</div>{expense.note && <div><b>Note :</b> {expense.note}</div>}</div>
    <p className="recu-stub">Document vérifiable par QR code · édité le {editStamp}</p>
  </div>;
}

function RecapTab({ state, notify, session, updateState }) {
  const [month, setMonth] = useState('');
  const [showAllYear, setShowAllYear] = useState(false);
  const incoming = schoolPaymentsSummary(state);
  const depenses = schoolDepenses(state);
  const totalOut = schoolTotalOut(state);
  const solde = incoming.totalPaid - totalOut;
  const classesList = Object.values((state && state.classes) || {});
  const months = (() => {
    const set = new Set(schoolYearMonths(state));
    classesList.forEach((cls) => (cls.students || []).forEach((s) => studentPaiements(s).forEach((p) => { const key = paymentMonthKey(p); if (key) set.add(key); })));
    depenses.forEach((d) => { const key = String(d.date || '').slice(0, 7); if (key) set.add(key); });
    return [...set].sort();
  })();
  const activeMonth = month && months.includes(month) ? month : (months.includes(todayISO().slice(0, 7)) ? todayISO().slice(0, 7) : (months[0] || ''));
  const monthInRows = [];
  classesList.forEach((cls) => (cls.students || []).forEach((s) => studentPaiements(s).forEach((p) => { if (paymentMonthKey(p) === activeMonth) monthInRows.push(p); })));
  const monthIn = monthInRows.reduce((sum, p) => sum + (Number(p.montant) || 0), 0);
  const monthOutRows = depenses.filter((d) => String(d.date || '').slice(0, 7) === activeMonth);
  const monthOut = monthOutRows.reduce((sum, d) => sum + (Number(d.montant) || 0), 0);
  // « Année entière » = année scolaire uniquement (Oct → Juil de header.annee),
  // et non plus tous les mois depuis la création de l'école.
  const schoolYearSet = new Set(schoolYearMonths(state));
  const yearInRows = [];
  classesList.forEach((cls) => (cls.students || []).forEach((s) => studentPaiements(s).forEach((p) => { if (schoolYearSet.has(paymentMonthKey(p))) yearInRows.push(p); })));
  const yearIn = yearInRows.reduce((sum, p) => sum + (Number(p.montant) || 0), 0);
  const yearOutRows = depenses.filter((d) => schoolYearSet.has(String(d.date || '').slice(0, 7)));
  const yearOut = yearOutRows.reduce((sum, d) => sum + (Number(d.montant) || 0), 0);
  const scopedIn = showAllYear ? yearIn : monthIn;
  const scopedOut = showAllYear ? yearOut : monthOut;
  const scopedDepenses = showAllYear ? yearOutRows : monthOutRows;
  const expectedMonth = classesList.reduce((sum, cls) => sum + (cls.students || []).reduce((s2, st) => s2 + studentMonthlyDue(state, cls.level, st, activeMonth), 0), 0);
  // Année scolaire : encaissé de l'année (et non toutes années confondues)
  const yearTaux = incoming.totalDue > 0 ? Math.min(1, yearIn / incoming.totalDue) : 0;
  const reliquatAnnuel = Math.max(0, incoming.totalDue - yearIn);

  const byCategorie = {};
  scopedDepenses.forEach((d) => {
    const cat = d.categorie || 'Autres';
    byCategorie[cat] = (byCategorie[cat] || 0) + (Number(d.montant) || 0);
  });
  const catRows = Object.entries(byCategorie).sort((a, b) => b[1] - a[1]);
  const periodLabel = showAllYear ? `année ${(state.header && state.header.annee) || ''}`.trim() : monthLabel(activeMonth);
  // Tableau mensuel : entrées / sorties / solde pour chaque mois (tous les
  // mois ayant au moins une opération ou appartenant à l'année scolaire).
  const monthlyRows = months.map((m) => {
    let ent = 0, sort = 0, nbIn = 0, nbOut = 0;
    classesList.forEach((cls) => (cls.students || []).forEach((s) => studentPaiements(s).forEach((p) => { if (paymentMonthKey(p) === m) { ent += Number(p.montant) || 0; nbIn += 1; } })));
    depenses.forEach((d) => { if (String(d.date || '').slice(0, 7) === m) { sort += Number(d.montant) || 0; nbOut += 1; } });
    return { month: m, ent, sort, nbIn, nbOut, solde: ent - sort };
  });
  const monthlyTotals = monthlyRows.reduce((acc, r) => ({ ent: acc.ent + r.ent, sort: acc.sort + r.sort, solde: acc.solde + (r.ent - r.sort), nbIn: acc.nbIn + r.nbIn, nbOut: acc.nbOut + r.nbOut }), { ent: 0, sort: 0, solde: 0, nbIn: 0, nbOut: 0 });

  function exportRecap() {
    const header = ['Indicateur', 'Montant (FCFA)'];
    const rows = [
      [`Période : ${periodLabel}`, ''],
      [showAllYear ? 'Total entrées (paiements encaissés)' : `Entrées — ${monthLabel(activeMonth)}`, scopedIn],
      [showAllYear ? 'Total sorties (dépenses)' : `Sorties — ${monthLabel(activeMonth)}`, scopedOut],
      [showAllYear ? 'Solde de trésorerie' : 'Solde du mois', scopedIn - scopedOut],
      ...(showAllYear
        ? [['Reliquat annuel (à recouvrer)', reliquatAnnuel]]
        : [['Mensualités attendues (mois)', expectedMonth], ['Reliquat du mois', Math.max(0, expectedMonth - monthIn)]]),
      ...catRows.map(([cat, mont]) => [`Sorties — ${cat}`, mont]),
    ];
    const ecole = (state.header && state.header.ecole) || 'ecole';
    downloadCSV(`recap_entrees_sorties_${showAllYear ? 'annee' : activeMonth}_${ecole}.csv`, [header, ...rows]);
  }

  function log(action, details) {
    if (session && updateState) {
      updateState((prev) => ({ ...prev, auditLog: pushAuditEntry(prev.auditLog, { actor: actorLabel(session, prev), role: session && session.role, action, details }) }));
    }
  }

  return (
    <div className="space-y-4">
      <div className="no-print sygenop-card p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="text-xs font-semibold block mb-1 text-muted">Mois</label>
          <select value={activeMonth} onChange={(event) => setMonth(event.target.value)} className="px-3 py-2 rounded-lg border text-sm font-semibold sygenop-input">
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </div>
        <button onClick={() => setShowAllYear((v) => !v)} className="px-3 py-2 rounded-lg text-xs font-semibold" style={{ background: 'var(--bg)', color: showAllYear ? 'var(--green-d)' : 'var(--muted)', border: '1px solid var(--line)' }}>
          {showAllYear ? 'Année entière' : 'Mois sélectionné'}
        </button>
        <span className="text-xs ml-auto text-muted">Période affichée : <b className="text-ink">{periodLabel}</b></span>
      </div>
      <div className="flex items-center gap-3 pb-3 mb-1" style={{ borderBottom: '2px solid var(--green-d)' }}>
        <SchoolLogoMark state={state} width={52} style={{ margin: '0 auto' }} />
        <div className="flex-1 text-center">
          <div className="text-sm font-bold" style={{ color: 'var(--green-d)' }}>{(state.header && state.header.ecole) || 'Établissement scolaire'}</div>
          <div className="text-base font-extrabold text-ink">RÉCAPITULATIF ENTRÉES / SORTIES</div>
          <div className="text-xs text-muted">Période : {periodLabel}{showAllYear ? ' · Année entière' : ' · Mois'} · Année {state.header?.annee || ''}</div>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard icon={ArrowUpCircle} label={showAllYear ? 'Total entrées (encaissé)' : `Entrées — ${monthLabel(activeMonth)}`} value={fmtFCFA(scopedIn)} sub={showAllYear ? `${incoming.effectif} élève(s) · ${incoming.aJour} à jour` : `${monthInRows.length} versement(s)`} tone="green" />
        <StatCard icon={ArrowDownCircle} label={showAllYear ? 'Total sorties (dépenses)' : `Sorties — ${monthLabel(activeMonth)}`} value={fmtFCFA(scopedOut)} sub={`${scopedDepenses.length} dépense(s)`} tone="red" />
        <StatCard
          icon={Scale} tone={(scopedIn - scopedOut) >= 0 ? 'green' : 'red'}
          label={showAllYear ? 'Solde de trésorerie' : 'Solde du mois'}
          value={fmtFCFA(scopedIn - scopedOut)}
          sub={(scopedIn - scopedOut) >= 0 ? 'Situation positive' : 'Situation déficitaire'}
        />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="sygenop-card p-5 space-y-3">
          <div className="text-xs font-bold uppercase tracking-wide flex items-center gap-1.5 text-muted">
            <ArrowUpCircle size={13} /> {showAllYear ? 'Détail des entrées (année)' : `Entrées — ${monthLabel(activeMonth)}`}
          </div>
          <div className="space-y-2 text-sm">
            {showAllYear ? (
              <>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'var(--green-l)' }}>
                  <span style={{ color: 'var(--green-d)' }}>À payer (année, école)</span>
                  <b style={{ color: 'var(--green-d)' }}>{fmtFCFA(incoming.totalDue)}</b>
                </div>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'var(--green-l)' }}>
                  <span style={{ color: 'var(--green-d)' }}>Encaissé (année)</span>
                  <b style={{ color: 'var(--green-d)' }}>{fmtFCFA(yearIn)}</b>
                </div>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: '#f7e8e5' }}>
                  <span style={{ color: 'var(--red)' }}>Reliquat annuel (école)</span>
                  <b style={{ color: 'var(--red)' }}>{fmtFCFA(reliquatAnnuel)}</b>
                </div>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-bg">
                  <span className="text-muted">Taux de recouvrement</span>
                  <b className="text-ink">{Math.round(yearTaux * 100)}%</b>
                </div>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-bg">
                  <span className="text-muted">Élèves à jour</span>
                  <b className="text-ink">{incoming.aJour} / {incoming.effectif}</b>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'var(--green-l)' }}>
                  <span style={{ color: 'var(--green-d)' }}>Encaissé — {monthLabel(activeMonth)}</span>
                  <b style={{ color: 'var(--green-d)' }}>{fmtFCFA(monthIn)}</b>
                </div>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-bg">
                  <span className="text-muted">Versements du mois</span>
                  <b className="text-ink">{monthInRows.length}</b>
                </div>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: 'var(--gold-l)' }}>
                  <span style={{ color: '#92710c' }}>Mensualités attendues (mois)</span>
                  <b style={{ color: '#92710c' }}>{fmtFCFA(expectedMonth)}</b>
                </div>
                <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: '#f7e8e5' }}>
                  <span style={{ color: 'var(--red)' }}>Reliquat du mois</span>
                  <b style={{ color: 'var(--red)' }}>{fmtFCFA(Math.max(0, expectedMonth - monthIn))}</b>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="sygenop-card p-5 space-y-3">
          <div className="text-xs font-bold uppercase tracking-wide flex items-center gap-1.5 text-muted">
            <ArrowDownCircle size={13} /> {showAllYear ? 'Sorties par catégorie (année)' : `Sorties — ${monthLabel(activeMonth)}`}
          </div>
          {!catRows.length ? (
            <div className="text-sm py-6 text-center text-muted">{showAllYear ? 'Aucune dépense enregistrée.' : `Aucune dépense en ${monthLabel(activeMonth)}.`}</div>
          ) : (
            <div className="space-y-2 text-sm">
              {catRows.map(([cat, mont]) => {
                const pct = scopedOut > 0 ? (mont / scopedOut) * 100 : 0;
                return (
                  <div key={cat}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-ink">{cat}</span>
                      <b style={{ color: 'var(--red)' }}>{fmtFCFA(mont)} <span className="text-xs font-normal text-muted">({Math.round(pct)}%)</span></b>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden bg-bg">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: 'linear-gradient(90deg,#dc2626,#e07a63)' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="sygenop-card overflow-x-auto">
        <div className="px-4 py-3 text-xs font-bold uppercase tracking-wide text-muted">Tableau mensuel — Entrées / Sorties / Solde</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left" style={{ borderBottom: '1px solid var(--line)' }}>
              {['Mois', 'Entrées (encaissées)', 'Nb', 'Sorties (dépenses)', 'Nb', 'Solde du mois'].map((hh) => (
                <th key={hh} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap text-muted">{hh}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {monthlyRows.map((row) => (
              <tr key={row.month} onClick={() => { setMonth(row.month); setShowAllYear(false); }} className="cursor-pointer" style={{ borderBottom: '1px solid var(--line)' }}>
                <td className="px-4 py-3 font-semibold whitespace-nowrap" style={{ color: row.month === activeMonth ? 'var(--green-d)' : 'var(--ink)' }}>{monthLabel(row.month)}</td>
                <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--green-d)' }}>{row.ent > 0 ? fmtFCFA(row.ent) : '—'}</td>
                <td className="px-4 py-3 whitespace-nowrap text-xs text-muted">{row.nbIn || ''}</td>
                <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--red)' }}>{row.sort > 0 ? fmtFCFA(row.sort) : '—'}</td>
                <td className="px-4 py-3 whitespace-nowrap text-xs text-muted">{row.nbOut || ''}</td>
                <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: row.solde >= 0 ? 'var(--green-d)' : 'var(--red)' }}>{fmtFCFA(row.solde)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--line)' }}>
              <td className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">Totaux</td>
              <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: 'var(--green-d)' }}>{fmtFCFA(monthlyTotals.ent)}</td>
              <td className="px-4 py-3 whitespace-nowrap text-xs text-muted">{monthlyTotals.nbIn}</td>
              <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: 'var(--red)' }}>{fmtFCFA(monthlyTotals.sort)}</td>
              <td className="px-4 py-3 whitespace-nowrap text-xs text-muted">{monthlyTotals.nbOut}</td>
              <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: monthlyTotals.solde >= 0 ? 'var(--green-d)' : 'var(--red)' }}>{fmtFCFA(monthlyTotals.solde)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="no-print flex flex-wrap items-center gap-2">
        <button onClick={exportRecap} className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 sygenop-btn sygenop-btn--ghost">
          <Download size={15} /> Exporter le récapitulatif (CSV)
        </button>
        <button onClick={() => { log('Export récapitulatif', `Entrées ${fmtFCFA(incoming.totalPaid)} · Sorties ${fmtFCFA(totalOut)} · Solde ${fmtFCFA(solde)}`); notify('Récapitulatif exporté'); }} className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 sygenop-btn sygenop-btn--ghost">
          <History size={15} /> Journaliser dans l'audit
        </button>
      </div>
    </div>
  );
}

function MaterielModal({ item, onSave, onClose }) {
  const [form, setForm] = useState(() => item || { nom: '', categorie: '', quantite: 1, etat: 'Bon état', note: '' });
  function submit(e) {
    e.preventDefault();
    if (!form.nom.trim()) return;
    onSave({ ...form, nom: form.nom.trim(), categorie: form.categorie.trim(), quantite: Math.max(0, Number(form.quantite) || 0), note: form.note.trim() });
  }
  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
    <form onSubmit={submit} className="sygenop-card p-6 max-w-md w-full space-y-4 sygenop-fade">
      <div className="flex items-center justify-between"><h3 className="font-bold">{item ? 'Modifier le matériel' : 'Ajouter du matériel'}</h3><button type="button" onClick={onClose}><X size={18} /></button></div>
      <label className="block text-sm font-semibold">Désignation<input required value={form.nom} onChange={(e) => setForm((f) => ({ ...f, nom: e.target.value }))} className="mt-1 w-full px-3 py-2 rounded-lg border" style={fieldStyle} placeholder="Ex. Tables-bancs" /></label>
      <div className="grid grid-cols-2 gap-3"><label className="text-sm font-semibold">Catégorie<input value={form.categorie} onChange={(e) => setForm((f) => ({ ...f, categorie: e.target.value }))} className="mt-1 w-full px-3 py-2 rounded-lg border" style={fieldStyle} placeholder="Mobilier" /></label><label className="text-sm font-semibold">Quantité<input type="number" min="0" value={form.quantite} onChange={(e) => setForm((f) => ({ ...f, quantite: e.target.value }))} className="mt-1 w-full px-3 py-2 rounded-lg border" style={fieldStyle} /></label></div>
      <label className="block text-sm font-semibold">État<select value={form.etat} onChange={(e) => setForm((f) => ({ ...f, etat: e.target.value }))} className="mt-1 w-full px-3 py-2 rounded-lg border" style={fieldStyle}><option>Bon état</option><option>À réparer</option><option>Hors service</option></select></label>
      <label className="block text-sm font-semibold">Note<textarea value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} className="mt-1 w-full px-3 py-2 rounded-lg border" style={fieldStyle} rows="3" /></label>
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="px-3 py-2">Annuler</button><button className="px-3 py-2 rounded-lg text-white font-semibold" style={{ background: 'var(--green-d)' }}>Enregistrer</button></div>
    </form>
  </div>;
}

function AffectationMaterielModal({ items, classes, affectation, onSave, onClose }) {
  const [form, setForm] = useState(() => affectation ? { materielId: affectation.materielId, classId: affectation.classId, quantite: affectation.quantite } : { materielId: items[0]?.id || '', classId: Object.keys(classes)[0] || '', quantite: 1 });
  const selected = items.find((item) => item.id === form.materielId);
  function submit(e) { e.preventDefault(); if (!form.materielId || !form.classId || Number(form.quantite) <= 0) return; onSave({ ...form, quantite: Number(form.quantite) }); }
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4"><form onSubmit={submit} className="sygenop-card p-6 max-w-md w-full space-y-4"><div className="flex justify-between"><b>{affectation ? 'Modifier l’affectation' : 'Affecter du matériel'}</b><button type="button" onClick={onClose}><X size={18} /></button></div><label className="block text-sm font-semibold">Article<select value={form.materielId} onChange={(e) => setForm((f) => ({ ...f, materielId: e.target.value }))} className="mt-1 w-full px-3 py-2 border rounded-lg">{items.map((item) => <option key={item.id} value={item.id}>{item.nom} — stock : {item.quantite}</option>)}</select></label><div className="rounded-lg px-3 py-2 text-sm" style={{ background: 'var(--bg)', color: 'var(--muted)' }}><b>Rubrique :</b> {selected?.categorie || 'Non renseignée'} · Stock disponible : {selected?.quantite ?? 0}</div><label className="block text-sm font-semibold">Classe<select value={form.classId} onChange={(e) => setForm((f) => ({ ...f, classId: e.target.value }))} className="mt-1 w-full px-3 py-2 border rounded-lg">{Object.entries(classes).map(([id, cls]) => <option key={id} value={id}>{cls.name} — {cls.level}</option>)}</select></label><label className="block text-sm font-semibold">Quantité à affecter<input type="number" min="1" value={form.quantite} onChange={(e) => setForm((f) => ({ ...f, quantite: e.target.value }))} className="mt-1 w-full px-3 py-2 border rounded-lg" /></label><div className="flex justify-end gap-2"><button type="button" onClick={onClose}>Annuler</button><button className="px-3 py-2 rounded-lg text-white" style={{ background: 'var(--green-d)' }}>{affectation ? 'Enregistrer' : 'Affecter et générer le reçu'}</button></div></form></div>;
}

function MaterielTab({ items, classes = {}, affectations = [], onAdd, onAssign, onEdit, onDelete, readOnly }) {
  const total = items.reduce((sum, item) => sum + (Number(item.quantite) || 0), 0);
  const bonEtat = items.reduce((sum, item) => sum + (item.etat === 'Bon état' ? (Number(item.quantite) || 0) : 0), 0);
  const aReparer = items.reduce((sum, item) => sum + (item.etat === 'À réparer' ? (Number(item.quantite) || 0) : 0), 0);
  const horsService = items.reduce((sum, item) => sum + (item.etat === 'Hors service' ? (Number(item.quantite) || 0) : 0), 0);
  return <div className="space-y-4">
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard icon={Package} label="Matériel inventorié" value={total} tone="green" />
      <StatCard icon={CheckCircle2} label="Bon état" value={bonEtat} tone="green" />
      <StatCard icon={Wrench} label="À réparer" value={aReparer} tone="gold" />
      <StatCard icon={AlertTriangle} label="Hors service" value={horsService} tone="red" />
    </div>
    <div className="sygenop-card p-4">
    <div className="flex flex-wrap items-center gap-3"><div><h3 className="font-bold">Matériel de l’école</h3><p className="text-xs text-muted">Inventaire du mobilier, des fournitures et des équipements.</p></div>{!readOnly && <><button onClick={onAssign} className="ml-auto px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}><Package size={15} /> Affecter à une classe</button><button onClick={onAdd} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: 'var(--green-d)' }}><Plus size={15} /> Ajouter</button></>}</div>
    {!items.length ? <div className="py-8 text-center text-sm text-muted">Aucun matériel enregistré.</div> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr style={{ borderBottom: '1px solid var(--line)' }}>{['Désignation', 'Catégorie', 'Quantité', 'État', 'Classe affectée', 'Note', ''].map((h) => <th key={h} className="px-3 py-2 text-left text-[11px] font-bold uppercase text-muted">{h}</th>)}</tr></thead><tbody>{items.map((item) => { const destinations = affectations.filter((a) => a.materielId === item.id).map((a) => `${classes[a.classId]?.name || 'Classe'} (${a.quantite})`).join(', '); return <tr key={item.id} style={{ borderBottom: '1px solid var(--line)' }}><td className="px-3 py-3 font-semibold">{item.nom}</td><td className="px-3 py-3">{item.categorie || '—'}</td><td className="px-3 py-3">{item.quantite}</td><td className="px-3 py-3"><Pill tone={item.etat === 'Bon état' ? 'green' : item.etat === 'À réparer' ? 'gold' : 'red'}>{item.etat}</Pill></td><td className="px-3 py-3">{destinations || 'Non affecté'}</td><td className="px-3 py-3 text-muted">{item.note || '—'}</td><td className="px-3 py-3 whitespace-nowrap">{!readOnly && <><button onClick={() => onEdit(item)} className="p-1.5" title="Modifier"><Pencil size={14} /></button><button onClick={() => onDelete(item)} className="p-1.5" style={{ color: 'var(--red)' }} title="Supprimer"><Trash2 size={14} /></button></>}</td></tr>})}</tbody></table></div>}
    </div>
  </div>;
}

function MaterielJournal({ items, affectations, classes, onEdit, onDelete, readOnly }) {
  const [type, setType] = useState('__ALL__');
  const types = [...new Set(items.map((item) => item.categorie || 'Sans rubrique'))].sort();
  const selectedItems = type === '__ALL__' ? items : items.filter((item) => (item.categorie || 'Sans rubrique') === type);
  const assignedFor = (id) => affectations.filter((a) => a.materielId === id).reduce((sum, a) => sum + (Number(a.quantite) || 0), 0);
  return <div className="space-y-4">
    <div className="sygenop-card p-4 flex flex-wrap items-center gap-3"><div><h3 className="font-bold">Journal des affectations</h3><p className="text-xs text-muted">Stock total, matériel affecté et quantité disponible par type.</p></div><label className="ml-auto text-sm font-semibold">Type de matériel<select value={type} onChange={(e) => setType(e.target.value)} className="ml-2 px-3 py-2 border rounded-lg sygenop-input"><option value="__ALL__">Tous les types</option>{types.map((t) => <option key={t} value={t}>{t}</option>)}</select></label></div>
    <div className="sygenop-card overflow-x-auto"><table className="w-full text-sm"><thead><tr style={{ borderBottom: '1px solid var(--line)' }}>{['Matériel', 'Rubrique', 'Stock total', 'Affecté', 'Disponible', 'Détail des affectations', 'Actions'].map((h) => <th key={h} className="px-3 py-2 text-left text-[11px] font-bold uppercase text-muted">{h}</th>)}</tr></thead><tbody>{selectedItems.map((item) => { const rows = affectations.filter((a) => a.materielId === item.id); const affected = assignedFor(item.id); const available = Number(item.quantite) || 0; return <tr key={item.id} style={{ borderBottom: '1px solid var(--line)' }}><td className="px-3 py-3 font-semibold">{item.nom}</td><td className="px-3 py-3">{item.categorie || 'Sans rubrique'}</td><td className="px-3 py-3">{available + affected}</td><td className="px-3 py-3">{affected}</td><td className="px-3 py-3 font-bold" style={{ color: available ? 'var(--green-d)' : 'var(--red)' }}>{available}</td><td className="px-3 py-3">{rows.length ? rows.map((a) => <div key={a.id} className="flex items-center gap-1 mb-1">{classes[a.classId]?.name || 'Classe'} : {a.quantite} {!readOnly && <><button onClick={() => onEdit(a)} title="Modifier l'affectation"><Pencil size={13} /></button><button onClick={() => onDelete(a)} title="Supprimer l'affectation" style={{ color: 'var(--red)' }}><Trash2 size={13} /></button></>}</div>) : <span className="text-muted">Aucune</span>}</td><td className="px-3 py-3">{rows.length ? `${rows.length} mouvement(s)` : '—'}</td></tr>; })}</tbody></table></div>
  </div>;
}

function MaterielAffectationReceipt({ state, affectation, item, cls }) {
  const code = affectation.code || affectation.id;
  const qr = `https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=${encodeURIComponent(`EduLink Pro|${code}`)}`;
  return <div className="recu-sheet sygenop-card p-6"><div className="flex justify-between items-start"><div className="flex items-center gap-2"><SchoolLogoMark state={state} width={48} /><div><h2 className="font-bold">{state?.header?.ecole || 'EduLink Pro'}</h2><p className="text-xs">La plateforme intelligente de gestion scolaire</p></div></div><img src={qr} alt="QR code du reçu" width="80" height="80" /></div><h3 className="text-center font-bold py-2 mt-3" style={{ background: '#0a1e3d', color: '#fff' }}>REÇU D’AFFECTATION DE MATÉRIEL</h3><div className="space-y-2 mt-4 text-sm"><div><b>Code :</b> {code}</div><div><b>Date :</b> {fmtDateFr(affectation.date)}</div><div><b>Classe :</b> {cls?.name} — {cls?.level}</div><div><b>Matériel :</b> {item?.nom}</div><div><b>Catégorie :</b> {item?.categorie || '—'}</div><div><b>Quantité affectée :</b> {affectation.quantite}</div></div><p className="text-xs mt-6 text-muted">Document vérifiable avec le QR code.</p></div>;
}

function PaiementsView({ state, loading, updateState, notify, activeSchoolId, role, readOnly, session }) {
  const [level, setLevel] = useState('CI');
  const [classId, setClassId] = useState(null);
  const canSeeRanking = role === 'ief' || role === 'admin';
  const [viewMode, setViewMode] = useState('suivi'); // suivi | classement | depenses | recap | materiel
  const [feesModalOpen, setFeesModalOpen] = useState(false);
  const [paymentModalStudent, setPaymentModalStudent] = useState(null);
  const [editingPayment, setEditingPayment] = useState(null); // { student, payment }
  const [historyStudent, setHistoryStudent] = useState(null);
  const [printing, setPrinting] = useState(null); // { studentId, paymentId }
  const [toDeletePayment, setToDeletePayment] = useState(null);
  const [expenseModal, setExpenseModal] = useState(undefined); // undefined=closed, null=new, obj=edit
  const [toDeleteExpense, setToDeleteExpense] = useState(null);
  const [printingExpense, setPrintingExpense] = useState(null);
  const [expenseFocusMonth, setExpenseFocusMonth] = useState(null);
  const [newExpenseDefaultDate, setNewExpenseDefaultDate] = useState(null);
  const [materielModal, setMaterielModal] = useState(undefined);
  const [toDeleteMateriel, setToDeleteMateriel] = useState(null);
  const [affectationModal, setAffectationModal] = useState(false);
  const [printingAffectation, setPrintingAffectation] = useState(null);
  const [editingAffectation, setEditingAffectation] = useState(null);
  const [toDeleteAffectation, setToDeleteAffectation] = useState(null);
  const [q, setQ] = useState('');
  const [payView, setPayView] = useState('mois');
  const [selectedMonth, setSelectedMonth] = useState('');
  const [presetMois, setPresetMois] = useState(null);
  const [paymentFeesStudent, setPaymentFeesStudent] = useState(null);

  const classes = (state && state.classes) || {};
  const schoolLevels = levelsForSchool(state);
  useEffect(() => {
    if (schoolLevels.length && !schoolLevels.includes(level)) setLevel(schoolLevels[0]);
  }, [schoolLevels.join(','), level]);
  const classEntries = Object.entries(classes)
    .filter(([, c]) => c.level === level)
    .sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));

  useEffect(() => {
    if (!classEntries.some(([id]) => id === classId)) {
      setClassId(classEntries.length ? classEntries[0][0] : null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, classEntries.map(([id]) => id).join(',')]);

  if (loading || !state) {
    return (
      <div className="flex items-center justify-center py-24 text-muted">
        <Loader2 className="animate-spin mr-2" size={18} /> Chargement des données…
      </div>
    );
  }

  const currentClass = classId ? classes[classId] : null;
  const due = studentTotalDue(state, level);
  const students = (currentClass && currentClass.students) || [];
  const filteredStudents = q.trim()
    ? students.filter((s) => `${s.prenom || ''} ${s.nom || ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    : students;
  const monthlyDue = studentMonthlyDue(state, level);
  const allMonths = (() => {
    const set = new Set(schoolYearMonths(state));
    students.forEach((s) => studentPaiements(s).forEach((p) => { const key = paymentMonthKey(p); if (key) set.add(key); }));
    return [...set].sort();
  })();
  const effectiveMonth = selectedMonth && allMonths.includes(selectedMonth) ? selectedMonth : (allMonths.includes(todayISO().slice(0, 7)) ? todayISO().slice(0, 7) : (allMonths[0] || ''));
  const monthPayments = [];
  filteredStudents.forEach((s) => studentPaiements(s).forEach((p) => { if (paymentMonthKey(p) === effectiveMonth && p.type_paiement === 'mensualite') monthPayments.push({ student: s, payment: p }); }));
  const monthTotal = monthPayments.reduce((sum, x) => sum + (Number(x.payment.montant) || 0), 0);
  const monthPaymentCount = monthPayments.length;
  const monthModes = {};
  monthPayments.forEach((x) => { const label = MODES_PAIEMENT[x.payment.mode] || x.payment.mode || 'Autre'; monthModes[label] = (monthModes[label] || 0) + (Number(x.payment.montant) || 0); });
  const monthStats = filteredStudents.reduce((acc, s) => {
    const sDue = studentMonthlyDue(state, level, s, effectiveMonth);
    const paidMonth = studentPaidInMonthByType(s, effectiveMonth, 'mensualite');
    acc.reste += Math.max(0, sDue - paidMonth);
    if (paidMonth <= 0) acc.sans += 1;
    else if (sDue > 0 && paidMonth >= sDue) acc.couvert += 1;
    else acc.partiel += 1;
    return acc;
  }, { couvert: 0, partiel: 0, sans: 0, reste: 0 });

  function updateStudent(studentId, patch) {
    updateState((prev) => {
      const next = { ...prev, classes: { ...(prev.classes || {}) } };
      const cls = next.classes[classId];
      if (!cls) return prev;
      next.classes[classId] = { ...cls, students: (cls.students || []).map((s) => (s.id === studentId ? { ...s, ...patch } : s)) };
      return next;
    });
  }

  function saveFees(vals) {
    updateState((prev) => ({ ...prev, fees: { ...(prev.fees || {}), [level]: vals } }));
    notify(`Frais mis à jour pour ${level}`);
    setFeesModalOpen(false);
  }

  function saveStudentFees(patch) {
    if (!paymentFeesStudent) return;
    updateStudent(paymentFeesStudent.id, patch);
    notify(`Frais de ${paymentFeesStudent.prenom || ''} ${paymentFeesStudent.nom || ''} enregistrés`);
    setPaymentFeesStudent(null);
  }

  function savePayment(form) {
    const student = paymentModalStudent;
    if (!student) return;
    const { numero, seq } = nextRecuNumero(state);
    const payment = { id: uid('pay'), recu: numero, ...form };
    updateState((prev) => {
      const next = { ...prev, classes: { ...(prev.classes || {}) }, recuSeq: seq };
      const cls = next.classes[classId];
      if (!cls) return prev;
      next.classes[classId] = {
        ...cls,
        students: (cls.students || []).map((s) => (s.id === student.id ? { ...s, paiements: [...studentPaiements(s), payment] } : s)),
      };
      return next;
    });
    notify(`Paiement enregistré — reçu ${numero}`);
    setPaymentModalStudent(null);
    setPresetMois(null);
    setPrinting({ studentId: student.id, paymentId: payment.id });
  }

  function saveEditedPayment(form) {
    const { student, payment } = editingPayment;
    updateState((prev) => {
      const next = { ...prev, classes: { ...(prev.classes || {}) } };
      const cls = next.classes[classId];
      if (!cls) return prev;
      next.classes[classId] = {
        ...cls,
        students: (cls.students || []).map((s) => (s.id === student.id
          ? { ...s, paiements: studentPaiements(s).map((p) => (p.id === payment.id ? { ...p, ...form } : p)) }
          : s)),
      };
      return next;
    });
    notify(`Reçu ${payment.recu} modifié`);
    setEditingPayment(null);
    setPrinting({ studentId: student.id, paymentId: payment.id });
  }

  function confirmDeletePayment() {
    const { student, payment } = toDeletePayment;
    updateState((prev) => {
      const next = { ...prev, classes: { ...(prev.classes || {}) } };
      const cls = next.classes[classId];
      if (!cls) return prev;
      next.classes[classId] = {
        ...cls,
        students: (cls.students || []).map((s) => (s.id === student.id ? { ...s, paiements: studentPaiements(s).filter((p) => p.id !== payment.id) } : s)),
      };
      return next;
    });
    notify('Paiement supprimé');
    setToDeletePayment(null);
  }

  function saveMateriel(form) {
    if (readOnly) return;
    updateState((prev) => {
      const list = prev.materiel || [];
      const item = materielModal?.id ? { ...form, id: materielModal.id } : { ...form, id: uid('mat') };
      return { ...prev, materiel: materielModal?.id ? list.map((x) => x.id === item.id ? item : x) : [...list, item] };
    });
    notify(materielModal?.id ? 'Matériel mis à jour' : 'Matériel ajouté');
    setMaterielModal(undefined);
  }

  function deleteMateriel() {
    if (readOnly || !toDeleteMateriel) return;
    updateState((prev) => ({ ...prev, materiel: (prev.materiel || []).filter((x) => x.id !== toDeleteMateriel.id) }));
    notify('Matériel supprimé');
    setToDeleteMateriel(null);
  }

  function saveAffectationMateriel(form) {
    const previous = editingAffectation;
    const item = (state.materiel || []).find((entry) => entry.id === form.materielId);
    const restoredStock = (Number(item?.quantite) || 0) + (previous && previous.materielId === form.materielId ? Number(previous.quantite) || 0 : 0);
    if (!item || form.quantite > restoredStock) { notify('Quantité indisponible en stock.', true); return; }
    const affectation = previous ? { ...previous, ...form } : { id: uid('aff'), code: `MAT-${todayISO().replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, date: todayISO(), ...form };
    updateState((prev) => ({ ...prev, materiel: (prev.materiel || []).map((entry) => {
      let qty = Number(entry.quantite) || 0;
      if (previous && entry.id === previous.materielId) qty += Number(previous.quantite) || 0;
      if (entry.id === form.materielId) qty -= Number(form.quantite) || 0;
      return { ...entry, quantite: qty };
    }), affectationsMateriel: previous ? (prev.affectationsMateriel || []).map((a) => a.id === previous.id ? affectation : a) : [...(prev.affectationsMateriel || []), affectation] }));
    setAffectationModal(false);
    setEditingAffectation(null);
    setPrintingAffectation(affectation);
    notify(previous ? 'Affectation modifiée' : 'Matériel affecté et reçu généré');
  }

  function deleteAffectationMateriel() {
    const affected = toDeleteAffectation;
    if (!affected) return;
    updateState((prev) => ({ ...prev, materiel: (prev.materiel || []).map((item) => item.id === affected.materielId ? { ...item, quantite: (Number(item.quantite) || 0) + (Number(affected.quantite) || 0) } : item), affectationsMateriel: (prev.affectationsMateriel || []).filter((a) => a.id !== affected.id) }));
    setToDeleteAffectation(null);
    notify('Affectation supprimée : le matériel a été remis en stock');
  }

  function sendWhatsappReminder(student, solde) {
    const tel = phoneDigits(student.tuteurTel);
    if (!tel) { notify("Renseignez le téléphone du tuteur pour cet élève.", true); return; }
    const ecole = (state.header && state.header.ecole) || "l'école";
    const msg = `Bonjour${student.tuteurNom ? ' ' + student.tuteurNom : ''}, ceci est un rappel de ${ecole} : il reste un solde de ${fmtFCFA(solde)} à régler pour la scolarité de ${student.prenom || ''} ${student.nom || ''} (${currentClass.name}). Merci de régulariser dans les meilleurs délais.`;
    window.open('https://wa.me/' + encodeURIComponent(tel) + '?text=' + encodeURIComponent(msg), '_blank');
  }

  function sendWhatsappReceipt(student, payment) {
    const tel = phoneDigits(student.tuteurTel);
    if (!tel) { notify("Renseignez le téléphone du tuteur pour cet élève.", true); return; }
    const ecole = (state.header && state.header.ecole) || "l'école";
    const typeLabel = payment.type_paiement === 'inscription' ? " (Inscription)" : payment.type_paiement === 'mensualite' ? " (Mensualité)" : "";
    const msg = `Bonjour${student.tuteurNom ? ' ' + student.tuteurNom : ''}, ${ecole} confirme la réception de ${fmtFCFA(payment.montant)}${typeLabel} pour ${student.prenom || ''} ${student.nom || ''} le ${fmtDateFr(payment.date)} (reçu ${payment.recu}). Merci.`;
    window.open('https://wa.me/' + encodeURIComponent(tel) + '?text=' + encodeURIComponent(msg), '_blank');
  }

  function exportCSVClasse() {
    if (!currentClass) return;
    const header = ['Élève', 'Classe', 'Téléphone tuteur', 'Dû annuel', ...allMonths.map(monthLabel), 'Total payé', 'Rel. Inscription', 'Rel. Scolarité', 'Solde', 'Statut'];
    const rows = students.map((s) => {
      const paid = studentTotalPaid(s);
      const reliquat = studentReliquatByType(state, level, s);
      const solde = reliquat.inscription + reliquat.mensualite;
      const st = paymentStatus(due, paid);
      return [`${s.prenom || ''} ${s.nom || ''}`, currentClass.name, s.tuteurTel || '', due, ...allMonths.map((month) => studentPaidInMonthByType(s, month, 'mensualite')), paid, reliquat.inscription, reliquat.mensualite, solde, st.label];
    });
    downloadCSV(`paiements_${currentClass.name}_${level}.csv`, [header, ...rows]);
  }

  function exportCSVTransactions() {
    const header = ['N° Reçu', 'Date', 'Élève', 'Classe', 'Niveau', 'Montant', 'Mode', 'Type', 'Période', 'Note'];
    const rows = [];
    Object.values(classes).forEach((cls) => {
      (cls.students || []).forEach((s) => {
        studentPaiements(s).forEach((p) => {
          rows.push([p.recu, p.date, `${s.prenom || ''} ${s.nom || ''}`, cls.name, cls.level, p.montant, MODES_PAIEMENT[p.mode] || p.mode, p.type_paiement === 'inscription' ? 'Inscription' : p.type_paiement === 'mensualite' ? 'Mensualité' : '', p.periode, p.note || '']);
        });
      });
    });
    rows.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const ecole = (state.header && state.header.ecole) || 'ecole';
    downloadCSV(`historique_paiements_${ecole}.csv`, [header, ...rows]);
  }

  // ---- Dépenses (sorties) ---- 
  function saveExpense(form) {
    if (readOnly) return;
    const previousAmount = expenseModal && expenseModal.id ? (Number(expenseModal.montant) || 0) : 0;
    const available = schoolPaymentsSummary(state).totalPaid - schoolTotalOut(state) + previousAmount;
    if ((Number(form.montant) || 0) > available) { notify(`Sortie refusée : caisse disponible ${fmtFCFA(Math.max(0, available))}.`, true); return; }
    const receipt = expenseModal && expenseModal.id ? expenseModal : { id: uid('dep'), recu: `SORT-${todayISO().replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, ...form };
    updateState((prev) => {
      const list = prev.depenses || [];
      if (expenseModal && expenseModal.id) {
        return { ...prev, depenses: list.map((d) => (d.id === expenseModal.id ? { ...d, ...form, id: expenseModal.id } : d)) };
      }
      return { ...prev, depenses: [...list, receipt] };
    });
    notify(expenseModal && expenseModal.id ? 'Dépense modifiée' : 'Dépense enregistrée (sortie d\u2019argent)');
    setExpenseModal(undefined);
    setExpenseFocusMonth(String(form.date || todayISO()).slice(0, 7));
    setPrintingExpense(receipt);
  }

  function confirmDeleteExpense() {
    if (readOnly || !toDeleteExpense) return;
    updateState((prev) => ({ ...prev, depenses: (prev.depenses || []).filter((d) => d.id !== toDeleteExpense.id) }));
    notify('Dépense supprimée');
    setToDeleteExpense(null);
  }

  function exportDepenses() {
    const header = ['Date', 'Libellé', 'Catégorie', 'Mode', 'Bénéficiaire', 'Montant', 'Note'];
    const rows = (state.depenses || []).map((d) => [d.date, d.libelle, d.categorie, d.mode, d.beneficiaire, d.montant, d.note || '']);
    const ecole = (state.header && state.header.ecole) || 'ecole';
    downloadCSV(`depenses_${ecole}.csv`, [header, ...rows]);
  }

  function printMonthRecap() {
    if (!currentClass) return;
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const rows = filteredStudents.map((s) => {
      const sDue = studentMonthlyDue(state, level, s, effectiveMonth);
      const paidMonth = studentPaidInMonthByType(s, effectiveMonth, 'mensualite');
      const reliquatInscription = studentReliquatByType(state, level, s).inscription;
      const resteMois = Math.max(0, sDue - paidMonth);
      const st = paidMonth <= 0 ? 'Pas à jour' : (sDue > 0 && paidMonth >= sDue) ? 'À jour' : 'Partiel';
      return `<tr><td>${esc(`${s.prenom || ''} ${s.nom || ''}`)}</td><td>${esc(currentClass.name)}</td><td class="num">${new Intl.NumberFormat('fr-FR').format(reliquatInscription)}</td><td class="num">${new Intl.NumberFormat('fr-FR').format(paidMonth)}</td><td class="num">${new Intl.NumberFormat('fr-FR').format(resteMois)}</td><td>${st}</td></tr>`;
    }).join('');
    const modeRows = Object.entries(monthModes).map(([label, amount]) => `<tr><td>${esc(label)}</td><td class="num">${fmtFCFA(amount)}</td></tr>`).join('');
    const popup = window.open('', '_blank', 'width=900,height=700,scrollbars=yes');
    if (!popup) { notify('Autorisez les fenêtres pop-up pour générer le PDF.', true); return; }
    popup.document.open();
    popup.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Récap paiements ${escHtml(monthLabel(effectiveMonth))}</title><style>html,body{background:#fff}body{font-family:Arial,sans-serif;color:#17251d;margin:0;padding:15mm}${PRINT_DOC_CSS}.meta{font-size:12px;color:#637269;margin-bottom:18px}table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:18px}th,td{border:1px solid #cfd8d2;padding:8px;text-align:left}th{background:#e8f3ed}td.num{text-align:right}th.num{text-align:right}h2{font-size:14px;margin:16px 0 8px;color:#176b49}@media print{body{margin:0;padding:15mm}@page{size:A4 portrait;margin:0}}</style></head><body>${docHeadHtml(state, `RÉCAPITULATIF DES PAIEMENTS — ${escHtml(monthLabel(effectiveMonth)).toUpperCase()}`)}<div class="meta"><strong>${escHtml(state?.header?.ecole || '')}</strong> · Classe ${escHtml(currentClass.name)} (${escHtml(level)}) · Année ${escHtml(state?.header?.annee || '')} · Mensualité de référence : ${fmtFCFA(monthlyDue)}</div><table><thead><tr><th>Élève</th><th>Classe</th><th>Rel. Inscription</th><th>Versé</th><th>Reliquat</th><th>Situation du mois</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th colspan="2">Totaux</th><th class="num">${fmtFCFA(filteredStudents.reduce((s, st) => s + studentReliquatByType(state, level, st).inscription, 0))}</th><th class="num">${fmtFCFA(monthTotal)}</th><th class="num">${fmtFCFA(monthStats.reste)}</th><th>${monthPaymentCount} versement(s)</th></tr></tfoot></table>${modeRows ? `<h2>Répartition par mode de paiement</h2><table><thead><tr><th>Mode</th><th>Montant</th></tr></thead><tbody>${modeRows}</tbody></table>` : ''}</body></html>`);
    popup.document.close();
    popup.focus();
    setTimeout(() => { try { popup.print(); } catch (_) { popup.focus(); } }, 900);
  }

  // ---- Mode impression d'un reçu (remplace toute la vue, comme pour les bulletins) ----
  if (printing) {
    const cls = classId ? classes[classId] : null;
    const student = cls ? (cls.students || []).find((s) => s.id === printing.studentId) : null;
    const payment = student ? studentPaiements(student).find((p) => p.id === printing.paymentId) : null;
    return (
      <div className="space-y-4 sygenop-fade">
        <div className="no-print flex flex-wrap items-center gap-2">
          <button onClick={() => setPrinting(null)} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>
            ↩ Retour
          </button>
          <button onClick={() => window.print()} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: 'var(--gold)' }}>
            <Printer size={15} /> Imprimer / PDF
          </button>
          {student && payment && (
            <button
              onClick={() => { setPrinting(null); setEditingPayment({ student, payment }); }}
              className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 sygenop-btn sygenop-btn--ghost"
            >
              <Pencil size={15} /> Modifier ce reçu (erreur ?)
            </button>
          )}
          {student && payment && (
            <button
              onClick={() => sendWhatsappReceipt(student, payment)}
              className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5"
              style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}
            >
              <MessageCircle size={15} /> Envoyer le reçu sur WhatsApp
            </button>
          )}
        </div>
        {student && payment ? (
          <ReceiptSheet state={state} cls={cls} student={student} payment={payment} />
        ) : (
          <div className="sygenop-card p-10 text-center text-sm text-muted">Reçu introuvable.</div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 sygenop-fade">
      <div className="no-print flex flex-wrap gap-1.5 p-1 rounded-xl w-fit" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
        <button
          onClick={() => setViewMode('suivi')}
          className="px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5"
          style={viewMode !== 'materiel' ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
        >
          <ArrowUpCircle size={14} /> Finance
        </button>
        <button
          onClick={() => setViewMode('materiel')}
          className="px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5"
          style={viewMode === 'materiel' ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
        >
          <Package size={14} /> Matériel
        </button>
      </div>

      {viewMode !== 'materiel' && (
        <div className="no-print flex flex-wrap gap-1.5 p-1 rounded-xl w-fit" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
          <button onClick={() => setViewMode('suivi')} className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1" style={viewMode === 'suivi' ? { background: 'var(--green-l)', color: 'var(--green-d)' } : { color: 'var(--muted)' }}><ArrowUpCircle size={13} /> Paiements</button>
          <button onClick={() => setViewMode('depenses')} className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1" style={viewMode === 'depenses' ? { background: 'var(--green-l)', color: 'var(--green-d)' } : { color: 'var(--muted)' }}><TrendingDown size={13} /> Dépenses</button>
          <button onClick={() => setViewMode('verification')} className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1" style={viewMode === 'verification' ? { background: 'var(--green-l)', color: 'var(--green-d)' } : { color: 'var(--muted)' }}><ScanLine size={13} /> Vérifier QR</button>
          <button onClick={() => setViewMode('recap')} className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1" style={viewMode === 'recap' ? { background: 'var(--green-l)', color: 'var(--green-d)' } : { color: 'var(--muted)' }}><Scale size={13} /> Entrées / sorties</button>
          {canSeeRanking && <button onClick={() => setViewMode('classement')} className="px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1" style={viewMode === 'classement' ? { background: 'var(--green-l)', color: 'var(--green-d)' } : { color: 'var(--muted)' }}><Trophy size={13} /> Classement</button>}
        </div>
      )}

      {viewMode !== 'materiel' && !canSeeRanking && (
        <div className="sygenop-card p-4">
          <div className="text-xs font-bold uppercase tracking-wide mb-3 flex items-center gap-1.5 text-muted">
            <Building2 size={13} /> Récapitulatif de l'école
          </div>
          {(() => {
            const sum = schoolPaymentsSummary(state);
            if (viewMode === 'suivi' && payView === 'mois' && effectiveMonth) {
              let attenduEcole = 0, encaisseEcole = 0, aJourMois = 0;
              Object.values(classes).forEach((c) => {
                (c.students || []).forEach((st) => {
                  const mdue = studentMonthlyDue(state, c.level, st, effectiveMonth);
                  attenduEcole += mdue;
                  const paidM = studentPaidInMonthByType(st, effectiveMonth, 'mensualite');
                  encaisseEcole += paidM;
                  if (mdue > 0 && paidM >= mdue) aJourMois += 1;
                });
              });
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatCard icon={Users} label="Élèves" value={sum.effectif} tone="green" />
                  <StatCard icon={Wallet} label={`Mensualités attendues — ${monthLabel(effectiveMonth)}`} value={fmtFCFA(attenduEcole)} tone="gold" />
                  <StatCard icon={CheckCircle2} label={`Encaissé — ${monthLabel(effectiveMonth)}`} value={fmtFCFA(encaisseEcole)} tone="green" />
                  <StatCard icon={AlertTriangle} label="Reliquat du mois (école)" value={fmtFCFA(Math.max(0, attenduEcole - encaisseEcole))} sub={`${aJourMois}/${sum.effectif} élève(s) à jour`} tone="red" />
                </div>
              );
            }
            return (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard icon={Users} label="Élèves" value={sum.effectif} tone="green" />
                <StatCard icon={Wallet} label="À payer (école, année)" value={fmtFCFA(sum.totalDue)} tone="gold" />
                <StatCard icon={CheckCircle2} label="Total encaissé (année)" value={fmtFCFA(sum.totalPaid)} tone="green" />
                <StatCard
                  icon={TrendingUp} label="Taux de recouvrement" tone={sum.taux >= 0.8 ? 'green' : sum.taux >= 0.5 ? 'gold' : 'red'}
                  value={`${Math.round(sum.taux * 100)}%`} sub={`${sum.aJour}/${sum.effectif} élève(s) à jour`}
                />
              </div>
            );
          })()}
        </div>
      )}

{viewMode === 'materiel' ? (
        <div className="space-y-4"><MaterielTab
          items={state.materiel || []}
          classes={state.classes || {}}
          affectations={state.affectationsMateriel || []}
          onAdd={() => setMaterielModal(null)}
          onAssign={() => setAffectationModal(true)}
          onEdit={(item) => setMaterielModal(item)}
          onDelete={(item) => setToDeleteMateriel(item)}
          readOnly={readOnly}
        /><MaterielJournal items={state.materiel || []} affectations={state.affectationsMateriel || []} classes={state.classes || {}} onEdit={(a) => { setEditingAffectation(a); setAffectationModal(true); }} onDelete={(a) => setToDeleteAffectation(a)} readOnly={readOnly} /></div>
      ) : viewMode === 'depenses' ? (
        <DepensesTab
          depenses={state.depenses || []}
          baseMonths={schoolYearMonths(state)}
          focusMonth={expenseFocusMonth}
          onAdd={(defaultDate) => { setNewExpenseDefaultDate(defaultDate); setExpenseModal(null); }}
          onEdit={(d) => setExpenseModal(d)}
          onDelete={(d) => setToDeleteExpense(d)}
          onPrint={(d) => setPrintingExpense(d)}
          readOnly={readOnly}
          onExport={exportDepenses}
        />
      ) : viewMode === 'verification' ? (
        <StudentCardVerification state={state} updateState={updateState} notify={notify} />
      ) : viewMode === 'recap' ? (
        <RecapTab state={state} notify={notify} session={session} updateState={updateState} />
      ) : viewMode === 'classement' && canSeeRanking ? (
        <InterSchoolRanking activeSchoolId={activeSchoolId} />
      ) : (
        <>
          <div className="no-print flex flex-wrap gap-1.5 p-1 rounded-xl w-fit" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
            {levelsForSchool(state).map((l) => (
              <button
                key={l} onClick={() => setLevel(l)}
                className="px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors"
                style={level === l ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
              >
                {l}
              </button>
))}
          </div>

      <div className="no-print flex flex-wrap items-center gap-2">
            {classEntries.map(([id, c]) => (
              <button
                key={id} onClick={() => setClassId(id)}
                className="px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5"
                style={classId === id ? { background: 'var(--gold)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--muted)' }}
              >
                {c.name} <span style={{ opacity: 0.7 }}>· {(c.students || []).length}</span>
              </button>
            ))}
            {!readOnly && (
            <button
              onClick={() => setFeesModalOpen(true)}
              className="px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5"
              style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}
            >
              <Wallet size={13} /> {payView === 'mois' ? `Mensualité ${level} : ${fmtFCFA(monthlyDue)}` : `Frais ${level} : ${fmtFCFA(due)}`}
            </button>
            )}
            <input
              value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un élève…"
              className="px-3 py-1.5 rounded-full text-xs border"
              style={{ borderColor: 'var(--line)', background: 'var(--bg)', color: 'var(--ink)' }}
            />
            <div className="ml-auto flex flex-wrap gap-2">
              <button
                onClick={exportCSVClasse} disabled={!currentClass}
                className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40 sygenop-btn sygenop-btn--ghost"
              >
                <Download size={15} /> CSV (classe)
              </button>
              <button
                onClick={exportCSVTransactions}
                className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 sygenop-btn sygenop-btn--ghost"
              >
                <FileSpreadsheet size={15} /> CSV (historique complet)
              </button>
              <button
                onClick={() => window.print()}
                className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5"
                style={{ background: 'var(--gold)' }}
              >
                <Printer size={15} /> Imprimer / PDF
              </button>
            </div>
          </div>

          {currentClass && payView !== 'mois' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
              <StatCard icon={Wallet} label="À payer (classe, année)" value={fmtFCFA(students.reduce((s, st) => s + studentTotalDue(state, level, st), 0))} tone="gold" />
              <StatCard icon={CheckCircle2} label="Versé (année)" value={fmtFCFA(students.reduce((s, st) => s + studentTotalPaid(st), 0))} tone="green" />
              {(() => {
                const totalRelInscription = students.reduce((s, st) => s + studentReliquatByType(state, level, st).inscription, 0);
                const totalRelMensualite = students.reduce((s, st) => s + studentReliquatByType(state, level, st).mensualite, 0);
                const totalRel = totalRelInscription + totalRelMensualite;
                return (
                  <>
                    <StatCard icon={ClipboardCheck} label="Rel. Inscription (classe)" value={fmtFCFA(totalRelInscription)} tone="gold" />
                    <StatCard icon={AlertTriangle} label="Rel. Scolarité (classe)" value={fmtFCFA(totalRelMensualite)} tone="red" />
                    <StatCard icon={TrendingUp} label="Reliquat total (classe)" value={fmtFCFA(totalRel)} tone={totalRel > 0 ? 'red' : 'green'} />
                  </>
                );
              })()}
            </div>
          )}

          <div className="no-print flex gap-1 p-1 rounded-lg w-fit" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
            <button onClick={() => setPayView('mois')} className="px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1" style={payView === 'mois' ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}><CalendarDays size={13} /> Par mois</button>
            <button onClick={() => setPayView('annuel')} className="px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1" style={payView !== 'mois' ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}><Wallet size={13} /> Résumé annuel</button>
          </div>

          {!currentClass ? (
            <div className="sygenop-card p-10 text-center text-sm text-muted">
              Aucune classe de {level} pour le moment. Créez-en une dans « Évaluation → Saisie des notes ».
            </div>
          ) : !filteredStudents.length ? (
            <div className="sygenop-card p-10 text-center text-sm text-muted">
              Aucun élève {q ? 'ne correspond à la recherche' : `dans ${currentClass.name}`}.
            </div>
          ) : payView === 'mois' ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <StatCard icon={CalendarDays} label={`Attendu — ${monthLabel(effectiveMonth)}`} value={fmtFCFA(filteredStudents.reduce((s, st) => s + studentMonthlyDue(state, level, st, effectiveMonth), 0))} sub={`${filteredStudents.length} élève(s)`} tone="gold" />
                <StatCard icon={CheckCircle2} label={`Versements — ${monthLabel(effectiveMonth)}`} value={fmtFCFA(monthTotal)} sub={`${monthPaymentCount} versement(s)`} tone="green" />
                <StatCard icon={AlertTriangle} label={`Reliquat mensuel — ${monthLabel(effectiveMonth)}`} value={fmtFCFA(monthStats.reste)} sub={`${monthStats.couvert} à jour · ${monthStats.partiel} partiel(s) · ${monthStats.sans} pas à jour`} tone="red" />
              </div>
              <div className="no-print sygenop-card p-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <label className="text-xs font-semibold whitespace-nowrap text-muted">Mois</label>
                <select value={effectiveMonth} onChange={(event) => setSelectedMonth(event.target.value)} className="px-3 py-2.5 rounded-lg border text-sm font-semibold sygenop-input">
                  {allMonths.map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}
                </select>
                <div className="flex-1"></div>
                <button type="button" onClick={printMonthRecap} className="px-3.5 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5 whitespace-nowrap" style={{ background: 'var(--green-d)' }}>
                  <Printer size={15} /> Récap du mois (PDF)
                </button>
              </div>
              {Object.keys(monthModes).length > 0 && (
                <div className="no-print text-xs px-1 flex flex-wrap gap-x-4 gap-y-1 text-muted">
                  {Object.entries(monthModes).map(([label, amount]) => <span key={label}>{label} : <b className="text-ink">{fmtFCFA(amount)}</b></span>)}
                </div>
              )}
              <div className="sygenop-card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left" style={{ borderBottom: '1px solid var(--line)' }}>
                      {['Élève', 'Rel. Inscription', `Versement — ${monthLabel(effectiveMonth)}`, 'Situation du mois', `Reliquat — ${monthLabel(effectiveMonth)}`, 'Actions'].map((hh) => (
                        <th key={hh} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap text-muted">{hh}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStudents.map((s) => {
                      const paid = studentTotalPaid(s);
                      const solde = Math.max(0, studentTotalDue(state, level, s) - paid);
                      const paidMonth = studentPaidInMonthByType(s, effectiveMonth, 'mensualite');
                      const reliquatInscription = studentReliquatByType(state, level, s).inscription;
                      const sDue = studentMonthlyDue(state, level, s, effectiveMonth);
                      const resteMois = Math.max(0, sDue - paidMonth);
                      const covered = sDue > 0 && paidMonth >= sDue;
                      const status = paidMonth <= 0 ? { label: 'Pas à jour', tone: 'red' } : covered ? { label: 'À jour', tone: 'green' } : { label: 'Partiel', tone: 'gold' };
                      const sCas = normalizeCasSocial(s.casSocial) > 0;
                      return (
                        <tr key={s.id} style={{ borderBottom: '1px solid var(--line)' }}>
                          <td className="px-4 py-3 font-semibold whitespace-nowrap text-ink">{s.prenom || ''} {s.nom || ''}{sCas && <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase align-middle" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}>Cas social −{normalizeCasSocial(s.casSocial)}%</span>}</td>
                          <td className="px-4 py-3 whitespace-nowrap font-semibold" style={{ color: reliquatInscription > 0 ? 'var(--gold)' : 'var(--muted)' }}>{reliquatInscription > 0 ? fmtFCFA(reliquatInscription) : '—'}</td>
                          <td className="px-4 py-3 whitespace-nowrap font-semibold" style={{ color: paidMonth > 0 ? 'var(--green-d)' : 'var(--muted)' }}>{paidMonth > 0 ? fmtFCFA(paidMonth) : '—'}</td>
                          <td className="px-4 py-3"><Pill tone={status.tone}>{status.label}</Pill></td>
                          <td className="px-4 py-3 whitespace-nowrap font-semibold" style={{ color: resteMois > 0 ? 'var(--red)' : 'var(--muted)' }}>{resteMois > 0 ? fmtFCFA(resteMois) : '—'}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {!readOnly && (
                                <button onClick={() => { setPresetMois(effectiveMonth); setPaymentModalStudent(s); }} className="px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }} title={`Encaisser pour ${monthLabel(effectiveMonth)}`}>
                                  <Plus size={13} /> Encaisser
                                </button>
                              )}
                              {!readOnly && (
                                <button onClick={() => setPaymentFeesStudent(s)} className="p-1.5 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--muted)' }} title="Frais spécifiques (abonnements / cas social)">
                                  <Settings size={14} />
                                </button>
                              )}
                              <button onClick={() => setHistoryStudent(s)} className="p-1.5 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--muted)' }} title="Historique">
                                <History size={14} />
                              </button>
                              <button
                                onClick={() => sendWhatsappReminder(s, solde)} disabled={solde <= 0}
                                className="p-1.5 rounded-lg disabled:opacity-30" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }} title="Rappel WhatsApp"
                              >
                                <MessageCircle size={14} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--line)' }}>
                      <td className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-muted">Totaux — {monthLabel(effectiveMonth)}</td>
                      <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: filteredStudents.reduce((s, st) => s + studentReliquatByType(state, level, st).inscription, 0) > 0 ? 'var(--gold)' : 'var(--muted)' }}>{fmtFCFA(filteredStudents.reduce((s, st) => s + studentReliquatByType(state, level, st).inscription, 0))}</td>
                      <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: 'var(--green-d)' }}>{fmtFCFA(monthTotal)}</td>
                      <td></td>
                      <td className="px-4 py-3 font-bold whitespace-nowrap" style={{ color: monthStats.reste > 0 ? 'var(--red)' : 'var(--muted)' }}>{fmtFCFA(monthStats.reste)}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          ) : (
            <div className="sygenop-card overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left" style={{ borderBottom: '1px solid var(--line)' }}>
                    {['Élève', 'Téléphone tuteur', 'Rel. Inscription', 'Rel. Scolarité', 'Reliquat total', 'Statut', 'Actions'].map((hh) => (
                      <th key={hh} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide whitespace-nowrap text-muted">{hh}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredStudents.map((s) => {
                    const paid = studentTotalPaid(s);
                    const reliquat = studentReliquatByType(state, level, s);
                    const sCas = normalizeCasSocial(s.casSocial) > 0;
                    const solde = reliquat.inscription + reliquat.mensualite;
                    const status = paymentStatus(studentTotalDue(state, level, s), paid);
                    return (
                      <tr key={s.id} style={{ borderBottom: '1px solid var(--line)' }}>
                        <td className="px-4 py-3 font-semibold whitespace-nowrap text-ink">{s.prenom || ''} {s.nom || ''}{sCas && <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase align-middle" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}>Cas social −{normalizeCasSocial(s.casSocial)}%</span>}</td>
                        <td className="px-4 py-3">
                          <input
                            defaultValue={s.tuteurTel || ''}
                            onBlur={(e) => { if (!readOnly && e.target.value !== (s.tuteurTel || '')) updateStudent(s.id, { tuteurTel: e.target.value }); }}
                            placeholder="77 000 00 00"
                            disabled={readOnly}
                            className="w-32 px-2 py-1 rounded border text-xs disabled:opacity-60 sygenop-input"
                          />
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap font-semibold" style={{ color: reliquat.inscription > 0 ? 'var(--gold)' : 'var(--muted)' }}>{reliquat.inscription > 0 ? fmtFCFA(reliquat.inscription) : '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap font-semibold" style={{ color: reliquat.mensualite > 0 ? 'var(--red)' : 'var(--muted)' }}>{reliquat.mensualite > 0 ? fmtFCFA(reliquat.mensualite) : '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap font-semibold" style={{ color: solde > 0 ? 'var(--red)' : 'var(--muted)' }}>{solde > 0 ? fmtFCFA(solde) : '—'}</td>
                        <td className="px-4 py-3"><Pill tone={status.tone}>{status.label}</Pill></td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            {!readOnly && (
                            <button onClick={() => setPaymentFeesStudent(s)} className="p-1.5 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--muted)' }} title="Frais spécifiques (abonnements / cas social)">
                              <Settings size={14} />
                            </button>
                            )}
                            {!readOnly && (
                            <button onClick={() => setPaymentModalStudent(s)} className="p-1.5 rounded-lg" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }} title="Nouveau paiement">
                              <Plus size={14} />
                            </button>
                            )}
                            <button onClick={() => setHistoryStudent(s)} className="p-1.5 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--muted)' }} title="Historique">
                              <History size={14} />
                            </button>
                            <button
                              onClick={() => sendWhatsappReminder(s, solde)} disabled={solde <= 0}
                              className="p-1.5 rounded-lg disabled:opacity-30" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }} title="Rappel WhatsApp"
                            >
                              <MessageCircle size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {payView === 'mois' && currentClass && !!filteredStudents.length && (
            <div className="text-xs px-1 text-muted">
              Mensualité de référence ({level}) : <b>{fmtFCFA(monthlyDue)}</b>. Le bouton « Encaisser » crée un paiement avec le mois sélectionné déjà renseigné.
            </div>
          )}
        </>
      )}

      {feesModalOpen && (
        <FeesModal level={level} fees={feeForLevel(state, level)} onSave={saveFees} onClose={() => setFeesModalOpen(false)} />
      )}
      {paymentFeesStudent && currentClass && !readOnly && (
        <StudentFeesModal level={level} fees={feeForLevel(state, level)} months={schoolYearMonths(state)} student={paymentFeesStudent} onSave={saveStudentFees} onClose={() => setPaymentFeesStudent(null)} />
      )}
      {paymentModalStudent && (
        <PaymentModal student={paymentModalStudent} defaultMois={presetMois || undefined} rubriques={studentFeesFor(state, level, paymentModalStudent).rubriques.map((r) => ({ ...r, mensualites: studentFeesFor(state, level, paymentModalStudent).mensualites, active: presetMois ? r.activeMonths.includes(presetMois) : r.activeMonths.length > 0 }))} onSave={savePayment} onClose={() => { setPaymentModalStudent(null); setPresetMois(null); }} />
      )}
      {editingPayment && (
        <PaymentModal
          student={editingPayment.student}
          payment={editingPayment.payment}
          rubriques={studentFeesFor(state, level, editingPayment.student).rubriques.map((r) => ({ ...r, mensualites: studentFeesFor(state, level, editingPayment.student).mensualites, active: editingPayment.payment.mois ? r.activeMonths.includes(editingPayment.payment.mois) : r.activeMonths.length > 0 }))}
          onSave={saveEditedPayment}
          onClose={() => setEditingPayment(null)}
        />
      )}
      {historyStudent && currentClass && (
        <StudentHistoryModal
          state={state}
          student={historyStudent}
          cls={currentClass}
          due={studentTotalDue(state, level, historyStudent)}
          monthlyDue={studentMonthlyDue(state, level, historyStudent)}
          onClose={() => setHistoryStudent(null)}
          onPrint={(payment) => { setHistoryStudent(null); setPrinting({ studentId: historyStudent.id, paymentId: payment.id }); }}
          onEdit={readOnly ? undefined : (payment) => { setEditingPayment({ student: historyStudent, payment }); setHistoryStudent(null); }}
          onDelete={readOnly ? undefined : (payment) => setToDeletePayment({ student: historyStudent, payment })}
        />
      )}
      {toDeletePayment && (
        <ConfirmModal
          title="Supprimer ce paiement ?"
          message={`Le versement de ${fmtFCFA(toDeletePayment.payment.montant)} (reçu ${toDeletePayment.payment.recu}) sera définitivement supprimé.`}
          danger
          onConfirm={confirmDeletePayment}
          onCancel={() => setToDeletePayment(null)}
        />
      )}
      {expenseModal !== undefined && (
        <ExpenseModal expense={expenseModal} personnel={state.personnel || []} defaultDate={newExpenseDefaultDate} onSave={saveExpense} onClose={() => setExpenseModal(undefined)} />
      )}
      {toDeleteExpense && (
        <ConfirmModal
          title="Supprimer cette dépense ?"
          message={`La sortie de ${fmtFCFA(toDeleteExpense.montant)} (« ${toDeleteExpense.libelle} ») sera définitivement supprimée.`}
          danger
          onConfirm={confirmDeleteExpense}
          onCancel={() => setToDeleteExpense(null)}
        />
      )}
      {materielModal !== undefined && (
        <MaterielModal item={materielModal} onSave={saveMateriel} onClose={() => setMaterielModal(undefined)} />
      )}
      {toDeleteMateriel && (
        <ConfirmModal
          title="Supprimer ce matériel ?"
          message={`« ${toDeleteMateriel.nom} » sera définitivement retiré de l’inventaire.`}
          danger
          onConfirm={deleteMateriel}
          onCancel={() => setToDeleteMateriel(null)}
        />
      )}
      {affectationModal && (
        <AffectationMaterielModal items={state.materiel || []} classes={state.classes || {}} affectation={editingAffectation} onSave={saveAffectationMateriel} onClose={() => { setAffectationModal(false); setEditingAffectation(null); }} />
      )}
      {toDeleteAffectation && <ConfirmModal title="Supprimer cette affectation ?" message={`Les ${toDeleteAffectation.quantite} unité(s) seront remises dans le stock disponible.`} danger onConfirm={deleteAffectationMateriel} onCancel={() => setToDeleteAffectation(null)} />}
      {printingAffectation && (
        <div className="fixed inset-0 z-50 overflow-auto p-4"><div className="max-w-lg mx-auto mt-4"><div className="flex justify-end gap-2 mb-2"><button onClick={() => window.print()} className="px-3 py-2 rounded-lg text-white" style={{ background: 'var(--green-d)' }}><Printer size={14} /> Imprimer</button><button onClick={() => setPrintingAffectation(null)} className="px-3 py-2 rounded-lg bg-panel">Fermer</button></div><MaterielAffectationReceipt state={state} affectation={printingAffectation} item={(state.materiel || []).find((item) => item.id === printingAffectation.materielId)} cls={(state.classes || {})[printingAffectation.classId]} /></div></div>
      )}
      {printingExpense && (
        <div className="fixed inset-0 z-50 overflow-auto p-4"><div className="max-w-lg mx-auto mt-4"><div className="flex justify-end gap-2 mb-2"><button onClick={() => window.print()} className="px-3 py-2 rounded-lg text-white flex items-center gap-1" style={{ background: 'var(--red)' }}><Printer size={14} /> Imprimer</button><button onClick={() => setPrintingExpense(null)} className="px-3 py-2 rounded-lg bg-panel">Fermer</button></div><ExpenseReceipt state={state} expense={printingExpense} /></div></div>
      )}
    </div>
  );
}

/* ============================================================
   MODULE 5 — ADMINISTRATION + DONNÉES
   (config barème par niveau, infos établissement, import/export
   JSON/CSV, journal d'audit)
   ============================================================ */

/* ---- Identité de l'auteur d'une action, pour le journal d'audit ---- */
function actorLabel(session, state) {
  if (!session) return 'Système';
  if (session.role === 'teacher') {
    return `${teacherNameFromSession(state, session) || cycleTerminology(state?.header?.cycle).teacher} (${cycleTerminology(state?.header?.cycle).teacher})`;
  }
  if (session.role === 'school') {
    const dir = state && state.header && state.header.directeur;
    return dir ? `${dir} (Direction)` : 'Direction de l\u2019école';
  }
  if (session.role === 'ief') return session.kind === 'groupe' ? 'Groupe scolaire (lecture seule)' : 'IEF (lecture seule)';
  if (session.role === 'admin') return 'Super Administrateur';
  return 'Utilisateur';
}
/* ---- Ajoute une entrée en tête du journal d'audit, plafonné à 300 lignes ---- */
function pushAuditEntry(log, entry) {
  const next = [{ id: uid('log'), ts: new Date().toISOString(), ...entry }, ...((log && Array.isArray(log)) ? log : [])];
  return next.slice(0, 300);
}
function fmtAuditTs(iso) {
  try {
    return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return iso || '—'; }
}

/* ---- Parseur CSV minimal (supporte ; ou , comme séparateur, et les guillemets) ---- */
function parseCSV(text) {
  const clean = String(text || '').replace(/^\uFEFF/, '');
  const firstLine = clean.split(/\r?\n/)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') { if (clean[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignoré */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c || '').trim() !== ''));
}

/* ---------------------------------------------------------------
   Onglet « Barème » — édition des domaines/matières par niveau
   --------------------------------------------------------------- */
function BaremeEditorTab({ state, updateState, notify, readOnly, session }) {
  const [level, setLevel] = useState('CI');
  const isMohebs = !!(state && state.mohebs);
  const schoolLevels = levelsForSchool(state);
  useEffect(() => {
    if (schoolLevels.length && !schoolLevels.includes(level)) setLevel(schoolLevels[0]);
  }, [schoolLevels.join(','), level]);
  const stored = state && state.config && state.config[level];
  const initialDomains = (stored && Array.isArray(stored.domains) && stored.domains.length)
    ? stored.domains
    : officialDomainsForLevel(level, isMohebs);

  const [domains, setDomains] = useState(() => JSON.parse(JSON.stringify(initialDomains)));
  const [dirty, setDirty] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    const src = (state && state.config && state.config[level] && Array.isArray(state.config[level].domains) && state.config[level].domains.length)
      ? state.config[level].domains
      : officialDomainsForLevel(level, isMohebs);
    setDomains(JSON.parse(JSON.stringify(src)));
    setDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level, state && state.config && state.config[level], isMohebs]);

  function touch(fn) { if (readOnly) return; fn(); setDirty(true); }
  function setDomainName(di, name) { touch(() => setDomains((ds) => ds.map((d, i) => (i === di ? { ...d, name } : d)))); }
  function addDomain() { touch(() => setDomains((ds) => [...ds, { name: 'Nouveau domaine', disciplines: [] }])); }
  function removeDomain(di) { touch(() => setDomains((ds) => ds.filter((_, i) => i !== di))); }
  function setDiscField(di, xi, field, val) {
    touch(() => setDomains((ds) => ds.map((d, i) => (i !== di ? d : { ...d, disciplines: d.disciplines.map((x, j) => (j !== xi ? x : { ...x, [field]: val })) }))));
  }
  function addDiscipline(di) {
    touch(() => setDomains((ds) => ds.map((d, i) => (i !== di ? d : { ...d, disciplines: [...d.disciplines, { id: uid(`${level}_m`), label: 'Nouvelle matière', max: 10, coefficient: 1 }] }))));
  }
  function removeDiscipline(di, xi) {
    touch(() => setDomains((ds) => ds.map((d, i) => (i !== di ? d : { ...d, disciplines: d.disciplines.filter((_, j) => j !== xi) }))));
  }
  function resetOfficial() {
    setDomains(JSON.parse(JSON.stringify(officialDomainsForLevel(level, isMohebs))));
    setDirty(true);
    setConfirmReset(false);
    notify(`Barème ${level} réinitialisé au barème officiel${isMohebs ? ' MOHEBS (langues nationales)' : ''} (non enregistré — pensez à Enregistrer)`);
  }
  function save() {
    if (readOnly) return;
const cleanDomains = domains
      .map((d) => ({
        name: (d.name || '').trim() || 'Domaine',
        disciplines: (d.disciplines || []).map((x) => ({ id: x.id, label: (x.label || '').trim() || 'Matière', max: Math.max(0, Number(x.max) || 0), coefficient: Math.max(1, Number(x.coefficient) || 1) })),
      }))
      .filter((d) => d.disciplines.length > 0);
    if (!cleanDomains.length) { notify('Le barème doit contenir au moins un domaine avec une matière', true); return; }
    const total = cleanDomains.reduce((s, d) => s + d.disciplines.reduce((a, x) => a + x.max, 0), 0);
    const totalCoefficients = cleanDomains.reduce((s, d) => s + d.disciplines.reduce((a, x) => a + (Number(x.coefficient) || 1), 0), 0);
    const nbMatieres = cleanDomains.reduce((s, d) => s + d.disciplines.length, 0);
    updateState((prev) => {
      const next = { ...prev, config: { ...(prev.config || {}), [level]: { domains: cleanDomains, weightedAssessments: supportsWeightedAssessments(prev) } } };
      next.auditLog = pushAuditEntry(prev.auditLog, {
        actor: actorLabel(session, prev), role: session && session.role,
        action: 'Modification du barème', details: `Niveau ${level} — ${nbMatieres} matière(s), total /${total}${supportsWeightedAssessments(state) ? `, coefficients ${totalCoefficients}` : ''}`,
      });
      return next;
    });
    notify(`Barème ${level} enregistré`);
    setDirty(false);
  }

  const total = domains.reduce((s, d) => s + (d.disciplines || []).reduce((a, x) => a + (Number(x.max) || 0), 0), 0);
  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };

  return (
    <div className="space-y-4">
      {readOnly && (
        <div className="sygenop-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2" style={{ background: 'var(--gold-l)', color: '#92710c' }}>
          <Eye size={14} /> Mode consultation (IEF) — lecture seule, aucune modification possible.
        </div>
      )}
      <div className="sygenop-card p-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-1.5 p-1 rounded-xl" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
          {levelsForSchool(state).map((l) => (
            <button
              key={l}
              onClick={() => setLevel(l)}
              className="px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors"
              style={level === l ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isMohebs && <Pill tone="green">École MOHEBS — Langues nationales</Pill>}
          <Pill tone="gold">Barème général : /{total}</Pill>
          {dirty && <Pill tone="red">Non enregistré</Pill>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        {domains.map((d, di) => {
          const domTotal = (d.disciplines || []).reduce((s, x) => s + (Number(x.max) || 0), 0);
          return (
            <div key={di} className="sygenop-card p-4 space-y-3">
              <div className="flex items-center gap-2">
                <input
                  value={d.name}
                  disabled={readOnly}
                  onChange={(e) => setDomainName(di, e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg border text-sm font-bold"
                  style={fieldStyle}
                  placeholder="Nom du domaine"
                />
                <Pill tone="green">/{domTotal}</Pill>
                {!readOnly && (
                  <button onClick={() => removeDomain(di)} className="p-2 rounded-lg" style={{ color: 'var(--red)' }} title="Supprimer ce domaine">
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {(d.disciplines || []).map((x, xi) => (
                  <div key={x.id} className="flex items-center gap-2">
                    <input
                      value={x.label}
                      disabled={readOnly}
                      onChange={(e) => setDiscField(di, xi, 'label', e.target.value)}
                      className="flex-1 px-3 py-2 rounded-lg border text-sm"
                      style={fieldStyle}
                      placeholder="Nom de la matière"
                    />
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-muted">Barème /</span>
                      <input
                        type="number" min="0" step="1"
                        value={x.max}
                        disabled={readOnly}
                        onChange={(e) => setDiscField(di, xi, 'max', e.target.value)}
                        className="w-20 px-2 py-2 rounded-lg border text-sm text-center"
                        style={fieldStyle}
                      />
                    </div>
                    {supportsWeightedAssessments(state) && (
                      <label className="flex items-center gap-1 text-xs text-muted">
                        Coef.
                        <input type="number" min="1" step="1" value={x.coefficient || 1} disabled={readOnly} onChange={(e) => setDiscField(di, xi, 'coefficient', e.target.value)} className="w-16 px-2 py-2 rounded-lg border text-sm text-center" style={fieldStyle} />
                      </label>
                    )}
                    {!readOnly && (
                      <button onClick={() => removeDiscipline(di, xi)} className="p-2 rounded-lg text-muted" title="Supprimer cette matière">
                        <X size={15} />
                      </button>
                    )}
                  </div>
                ))}
                {!(d.disciplines || []).length && (
                  <div className="text-xs italic text-muted">Aucune matière dans ce domaine.</div>
                )}
              </div>
              {!readOnly && (
                <button
                  onClick={() => addDiscipline(di)}
                  className="text-xs font-semibold flex items-center gap-1.5 px-3 py-1.5 rounded-lg"
                  style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}
                >
                  <Plus size={13} /> Ajouter une matière
                </button>
              )}
            </div>
          );
        })}
      </div>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={addDomain}
            className="px-3.5 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-1.5 sygenop-btn sygenop-btn--ghost"
          >
            <Plus size={15} /> Ajouter un domaine
          </button>
          <button
            onClick={() => setConfirmReset(true)}
            className="px-3.5 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-1.5"
            style={{ background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' }}
          >
            <RotateCcw size={15} /> Réinitialiser au barème officiel
          </button>
          <button
            onClick={save}
            disabled={!dirty}
            className="ml-auto px-4 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
            style={{ background: 'var(--green-d)' }}
          >
            <Save size={15} /> Enregistrer le barème {level}
          </button>
        </div>
      )}
      <div className="sygenop-card px-4 py-3 text-xs flex items-start gap-2 text-muted">
        <AlertCircle size={15} className="flex-shrink-0 mt-0.5" style={{ color: 'var(--gold)' }} />
        Modifier le barème s'applique à toutes les classes de ce niveau. Renommer ou changer le barème (/max) d'une
        matière existante n'efface pas les notes déjà saisies ; supprimer une matière rend ses notes invisibles
        (elles restent en base tant que les élèves ne sont pas modifiés).
      </div>

      {confirmReset && (
        <ConfirmModal
          title="Réinitialiser au barème officiel ?"
          message={`Toutes les modifications apportées au barème ${level} seront remplacées par le barème officiel${isMohebs ? ' MOHEBS (avec le domaine Langue Nationale)' : ''}. Cliquez ensuite sur « Enregistrer » pour confirmer.`}
          onConfirm={resetOfficial}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Onglet « Établissement » — informations affichées sur bulletins/reçus
   --------------------------------------------------------------- */
/* Champ de formulaire stable (défini hors du composant) : un composant créé
   dans le corps d'un autre est recréé à chaque rendu, ce qui fait perdre le
   focus de l'input après chaque caractère saisi. */
function EtabField({ label, value, onChange, placeholder, type = 'text', disabled }) {
  return (
    <div>
      <label className="text-xs font-semibold block mb-1 text-muted">{label}</label>
      <input
        type={type}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2.5 rounded-lg border text-sm sygenop-input"
        placeholder={placeholder}
      />
    </div>
  );
}

/* ---- Carte « Horaires et jours ouvrés » (Administration → Établissement) ----
   Paramétrage hebdomadaire de l'établissement : jours de la semaine ouverts
   et heures à servir par jour ouvert. Réservé au chef d'établissement
   (Directeur/Directrice, Principal, Censeur et Proviseur selon le cycle)
   et au Super Admin ; les autres rôles autorisés sur l'onglet (secrétaire)
   le voient en lecture seule. Stocké dans config.pointage — partagé avec
   les règles de pointage existantes. */
function HorairesJoursOuvresCard({ state, updateState, notify, readOnly, session }) {
  const cycle = state?.header?.cycle;
  const headLabel = cycleTerminology(cycle).head;
  const canEdit = !readOnly && (session?.role === 'school' || session?.role === 'admin');
  const raw = state?.config?.pointage || {};
  const [jours, setJours] = useState(() => attendanceSettings(state).joursOuvres);
  const [heures, setHeures] = useState(() => attendanceSettings(state).heuresParJour);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    const s = attendanceSettings(state);
    setJours(s.joursOuvres);
    setHeures(s.heuresParJour);
  }, [raw.joursOuvres, raw.heuresParJour]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleJour(key) {
    if (!canEdit) return;
    setJours((prev) => {
      // On garde toujours au moins un jour ouvré.
      if (prev.includes(key)) return prev.length > 1 ? prev.filter((d) => d !== key) : prev;
      return [...prev, key].sort((a, b) => a - b);
    });
    setDirty(true);
  }
  function setHeure(key, value) {
    if (!canEdit) return;
    const v = Math.max(0, Math.min(24, Number(value) || 0));
    setHeures((prev) => ({ ...prev, [key]: v }));
    setDirty(true);
  }
  function save() {
    if (!canEdit) return;
    updateState((prev) => {
      const kept = (prev.config && prev.config.pointage) || {};
      const heuresParJour = Object.fromEntries(
        JOURS_SEMAINE.map(({ key }) => [key, Math.max(0, Math.min(24, Number(heures[key]) || 0))])
      );
      const pointage = { ...kept, planningVersion: 2, joursOuvres: [...jours].sort((a, b) => a - b), heuresParJour };
      const next = { ...prev, config: { ...(prev.config || {}), pointage } };
      next.auditLog = pushAuditEntry(prev.auditLog, {
        actor: actorLabel(session, prev), role: session && session.role,
        action: 'Modification des horaires et jours ouvrés',
        details: `${jours.length} jour(s) ouvré(s) (${libelleJoursOuvres(jours)})`,
      });
      return next;
    });
    notify('Horaires et jours ouvrés enregistrés');
    setDirty(false);
  }

  const totalHeuresSemaine = jours.reduce((s, key) => s + (Number(heures[key]) || 0), 0);
  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };

  return (
    <div className="sygenop-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <Clock size={18} style={{ color: 'var(--green-d)' }} />
        <div>
          <div className="font-bold text-sm text-ink">Horaires et jours ouvrés</div>
          <div className="text-xs text-muted">
            Semaine type de l'établissement — utilisée par le pointage, la paie et les objectifs horaires.
          </div>
        </div>
      </div>
      {!canEdit && (
        <div className="px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2" style={{ background: 'var(--gold-l)', color: '#92710c' }}>
          <Eye size={13} /> Réservé {/^[aeiouyéè]/i.test(headLabel) ? "à l'" : 'au '} {headLabel.toLowerCase()} (consultation seule).
        </div>
      )}
      <div>
        <div className="text-xs font-semibold mb-2 text-muted">Jours ouvrés de la semaine</div>
        <div className="flex flex-wrap gap-2">
          {JOURS_SEMAINE.map(({ key, label }) => {
            const actif = jours.includes(key);
            return (
              <button
                key={key}
                type="button"
                disabled={!canEdit}
                onClick={() => toggleJour(key)}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-60"
                style={actif
                  ? { background: 'var(--green-d)', color: '#fff', border: '1px solid var(--green-d)' }
                  : { background: 'var(--bg)', color: 'var(--muted)', border: '1px solid var(--line)' }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <div className="text-xs font-semibold mb-2 text-muted">Heures à servir par jour ouvert</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {JOURS_SEMAINE.filter(({ key }) => jours.includes(key)).map(({ key, label }) => (
            <label key={key} className="text-xs font-semibold text-ink">
              {label}
              <input
                type="number"
                min="0"
                max="24"
                step="0.5"
                disabled={!canEdit}
                value={heures[key]}
                onChange={(e) => setHeure(key, e.target.value)}
                className="mt-1 w-full px-3 py-2 rounded-lg border text-sm"
                style={fieldStyle}
              />
            </label>
          ))}
        </div>
      </div>
      <div className="text-xs text-muted">
        Semaine actuelle : {jours.length} jour(s) ouvré(s) ({libelleJoursOuvres(jours)}) · {totalHeuresSemaine} h attendues par agent.
        Les jours fériés ponctuels se gèrent dans Pointage (jours non ouvrés).
      </div>
      {canEdit && (
        <div className="flex justify-end">
          <button onClick={save} disabled={!dirty} className="px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50" style={{ background: 'var(--green-d)' }}>
            <Save size={15} /> Enregistrer
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- Réglage du pointage des élèves (carte QR) : heure limite au-delà
   de laquelle un élève non pointé est considéré absent (pointage
   « portail », sans emploi du temps). N'affecte pas les écoles qui
   utilisent l'appel en classe séance par séance (emploi du temps). */
function PresenceElevesCard({ state, updateState, notify, readOnly, session }) {
  const canEdit = !readOnly && (session?.role === 'school' || session?.role === 'admin');
  const [heureLimite, setHeureLimite] = useState(() => studentAttendanceConfig(state).heureLimite);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setHeureLimite(studentAttendanceConfig(state).heureLimite);
  }, [state?.config?.presenceEleves?.heureLimite]); // eslint-disable-line react-hooks/exhaustive-deps
  function save() {
    if (!canEdit) return;
    updateState((prev) => {
      const next = { ...prev, config: { ...(prev.config || {}), presenceEleves: { ...(prev.config?.presenceEleves || {}), heureLimite } } };
      next.auditLog = pushAuditEntry(prev.auditLog, {
        actor: actorLabel(session, prev), role: session && session.role,
        action: 'Modification de l\u2019heure limite de pointage des élèves', details: heureLimite,
      });
      return next;
    });
    notify('Heure limite de pointage enregistrée');
    setDirty(false);
  }
  return (
    <div className="sygenop-card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <ScanLine size={18} style={{ color: 'var(--green-d)' }} />
        <div>
          <div className="font-bold text-sm text-ink">Présence des élèves (carte QR)</div>
          <div className="text-xs text-muted">
            Un élève non scanné après cette heure est considéré absent — uniquement pour les classes sans emploi du temps renseigné (sinon l'appel se fait séance par séance).
          </div>
        </div>
      </div>
      <label className="text-xs font-semibold block text-ink">
        Heure limite
        <input
          type="time"
          disabled={!canEdit}
          value={heureLimite}
          onChange={(e) => { setHeureLimite(e.target.value); setDirty(true); }}
          className="mt-1 block px-3 py-2 rounded-lg border text-sm sygenop-input"
        />
      </label>
      {canEdit && (
        <div className="flex justify-end">
          <button onClick={save} disabled={!dirty} className="px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50" style={{ background: 'var(--green-d)' }}>
            <Save size={15} /> Enregistrer
          </button>
        </div>
      )}
    </div>
  );
}

 function EtablissementTab({ state, updateState, notify, readOnly, session }) {
  const h = (state && state.header) || {};
  const [form, setForm] = useState({
    ecole: h.ecole || '', type: schoolTypeLabel(h.type), ia: h.ia || '',
    ief: h.ief || '', directeur: h.directeur || '', tel: h.tel || '', annee: h.annee || '',
    logo: h.logo || '',
  });
  const [mohebs, setMohebs] = useState(!!(state && state.mohebs));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const hh = (state && state.header) || {};
    setForm({
      ecole: hh.ecole || '', type: schoolTypeLabel(hh.type), ia: hh.ia || '',
      ief: hh.ief || '', directeur: hh.directeur || '', tel: hh.tel || '', annee: hh.annee || '',
      logo: hh.logo || '',
    });
    setMohebs(!!(state && state.mohebs));
    setDirty(false);
  }, [state && state.header, state && state.mohebs]);

  function set(k, v) { if (readOnly) return; setForm((f) => ({ ...f, [k]: v })); setDirty(true); }
  function setMohebsFlag(v) { if (readOnly) return; setMohebs(v); setDirty(true); }
  function save() {
    if (readOnly) return;
    if (!form.ecole.trim()) { notify('Le nom de l\u2019école est requis', true); return; }
    updateState((prev) => {
      const next = { ...prev, header: { ...(prev.header || {}), ...form, ecole: form.ecole.trim() }, mohebs };
      next.auditLog = pushAuditEntry(prev.auditLog, {
        actor: actorLabel(session, prev), role: session && session.role,
        action: 'Modification des informations établissement', details: form.ecole.trim(),
      });
      return next;
    });
    notify('Informations de l\u2019établissement enregistrées');
    setDirty(false);
  }

  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };

  return (
    <div className="space-y-4">
      {readOnly && (
        <div className="sygenop-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2" style={{ background: 'var(--gold-l)', color: '#92710c' }}>
          <Eye size={14} /> Mode consultation (IEF) — lecture seule, aucune modification possible.
        </div>
      )}
      <div className="sygenop-card p-5 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <EtabField label="Nom de l'école *" value={form.ecole} onChange={(v) => set('ecole', v)} disabled={readOnly} placeholder="Ex : École Élémentaire Liberté 6" />
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Type</label>
            <select value={form.type} disabled={readOnly} onChange={(e) => set('type', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle}>
              {SCHOOL_TYPES.map((t) => <option key={t.value} value={t.label}>{t.label}</option>)}
            </select>
          </div>
          <EtabField label="Inspection d'Académie (IA)" value={form.ia} onChange={(v) => set('ia', v)} disabled={readOnly} placeholder="Ex : DAKAR" />
          <EtabField label="IEF de rattachement" value={form.ief} onChange={(v) => set('ief', v)} disabled={readOnly} placeholder="Ex : IEF Dakar" />
          <EtabField label={cycleTerminology(form.cycle || state.header?.cycle).head} value={form.directeur} onChange={(v) => set('directeur', v)} disabled={readOnly} placeholder={`Nom du/de la ${cycleTerminology(form.cycle || state.header?.cycle).head.toLowerCase()}`} />
          <EtabField label="Téléphone" value={form.tel} onChange={(v) => set('tel', v)} disabled={readOnly} placeholder="Ex : 77 000 00 00" />
          <EtabField label="Année scolaire" value={form.annee} onChange={(v) => set('annee', v)} disabled={readOnly} placeholder="Ex : 2026/2027" />
        </div>
        <div className="pt-2" style={{ borderTop: '1px solid var(--line)' }}>
          <label className="text-xs font-semibold block mb-1 text-muted">Logo de l’école (affiché sur les bulletins, cartes, certificats, reçus et PDF)</label>
          <div className="flex items-center gap-3">
            <div className="w-16 h-16 rounded-lg border overflow-hidden flex items-center justify-center" style={{ borderColor: 'var(--line)', background: 'var(--bg)' }}>
              {form.logo ? <img src={form.logo} alt="Aperçu du logo" className="w-full h-full object-contain" /> : <span className="text-[10px] text-center px-1 text-muted">Aucun logo</span>}
            </div>
            {!readOnly && <>
              <label className="px-3 py-2 rounded-lg text-sm font-semibold cursor-pointer text-white" style={{ background: 'var(--green-d)' }}>
                {form.logo ? 'Changer le logo' : 'Ajouter un logo'}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; readImageCompressed(file, { maxSize: 400, type: 'image/png' }).then((data) => { if (data) set('logo', data); }); }} />
              </label>
              {form.logo && <button type="button" onClick={() => set('logo', '')} className="px-3 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--red)' }}>Retirer le logo</button>}
            </>}
            {readOnly && form.logo && <span className="text-xs text-muted">Logo actuel affiché sur les documents.</span>}
          </div>
        </div>
        <div className="pt-2" style={{ borderTop: '1px solid var(--line)' }}>
          <label className="flex items-start gap-2.5 text-sm cursor-pointer text-ink">
            <input
              type="checkbox"
              checked={mohebs}
              disabled={readOnly}
              onChange={(e) => setMohebsFlag(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-semibold">École MOHEBS (Langues nationales)</span>
              <span className="block text-xs mt-0.5 text-muted">
                À cocher si cette école enseigne des matières spécifiques en langue nationale. Un domaine
                « Langue Nationale » s'ajoute alors au barème de chaque niveau (visible et modifiable dans
                Administration → Barème par niveau) et la saisie des notes s'y calibre automatiquement.
              </span>
            </span>
          </label>
        </div>
      </div>
      <HorairesJoursOuvresCard state={state} updateState={updateState} notify={notify} readOnly={readOnly} session={session} />
      <PresenceElevesCard state={state} updateState={updateState} notify={notify} readOnly={readOnly} session={session} />
      {!readOnly && (
        <div className="flex justify-end">
          <button
            onClick={save}
            disabled={!dirty}
            className="px-4 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
            style={{ background: 'var(--green-d)' }}
          >
            <Save size={15} /> Enregistrer
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Vue « Administration »
   --------------------------------------------------------------- */
function AdminView({ state, loading, updateState, notify, readOnly, session }) {
  const [tab, setTab] = useState('bareme');
  if (loading || !state) {
    return (
      <div className="flex items-center justify-center py-24 text-muted">
        <Loader2 className="animate-spin mr-2" size={18} /> Chargement des données…
      </div>
    );
  }
  const tabs = [
    { id: 'bareme', label: 'Barème par niveau', icon: BookOpen },
    { id: 'timetable', label: 'Emploi du temps', icon: CalendarDays },
    { id: 'etab', label: 'Établissement', icon: School },
  ];
  return (
    <div className="space-y-4 sygenop-fade">
      <div className="flex flex-wrap gap-1.5 p-1 rounded-xl w-fit" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={tab === t.id ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'bareme' && <BaremeEditorTab state={state} updateState={updateState} notify={notify} readOnly={readOnly} session={session} />}
      {tab === 'timetable' && <TimetableView state={state} updateState={updateState} notify={notify} readOnly={readOnly} mode="admin" />}
      {tab === 'etab' && <EtablissementTab state={state} updateState={updateState} notify={notify} readOnly={readOnly} session={session} />}
    </div>
  );
}

/* ---------------------------------------------------------------
   Export — JSON complet & CSV (élèves/notes, personnel, paiements)
   --------------------------------------------------------------- */
function buildStudentsCSVRows(state) {
  const header = ['Niveau', 'Classe', 'Nom', 'Prénom', 'Âge', 'Genre'];
  TRIMESTRES.forEach((t) => header.push(`${t.key} Total`, `${t.key} Barème`, `${t.key} Moyenne/10`, `${t.key} Rang`, `${t.key} Mention`));
  const rows = [header];
  levelsForSchool(state).forEach((level) => {
    const cfg = cfgForLevel(state, level);
    classesOfLevel(state, level).forEach(([, cls]) => {
      const students = cls.students || [];
      const ranksByPeriod = {};
      TRIMESTRES.forEach((t) => { ranksByPeriod[t.key] = computeRanks(cfg, students, t.key); });
      students.forEach((s, idx) => {
        const row = [level, cls.name, s.nom || '', s.prenom || '', s.age || '', s.genre || ''];
        TRIMESTRES.forEach((t) => {
          const hasData = Object.keys(scoresFor(s, t.key)).length > 0;
          if (!hasData) { row.push('', '', '', '', ''); return; }
          const sc = computeStudentScores(cfg, scoresFor(s, t.key));
          row.push(fmtNote(sc.total, 1), sc.bareme, fmtNote(sc.moy, 2), ranksByPeriod[t.key][idx], mention(sc.moy, cfg.weightedAssessments));
        });
        rows.push(row);
      });
    });
  });
  return rows;
}
function buildPersonnelCSVRows(state) {
  const header = ['Prénom(s)', 'Nom', 'Rôle', 'Téléphone', 'Code enseignant', 'Classe(s) assignée(s)'];
  const rows = [header];
  const classesByTeacher = {};
  Object.values((state && state.classes) || {}).forEach((c) => {
    classTeacherNames(c).forEach((name) => { (classesByTeacher[name] = classesByTeacher[name] || []).push(c.name); });
  });
  ((state && state.personnel) || []).forEach((p) => {
    const full = personFullName(p);
    rows.push([p.prenom || '', p.nom || '', p.role || '', p.telephone || p.tel || '', p.code || '', (classesByTeacher[full] || classesByTeacher[p.nom] || []).join(', ')]);
  });
  return rows;
}
function buildPaymentsCSVRows(state) {
  const header = ['Niveau', 'Classe', 'Élève', 'N° Reçu', 'Date', 'Montant (FCFA)', 'Rubrique(s)', 'Mode', 'Type', 'Mois', 'Période', 'Note'];
  const rows = [header];
  levelsForSchool(state).forEach((level) => {
    classesOfLevel(state, level).forEach(([, cls]) => {
      (cls.students || []).forEach((s) => {
        studentPaiements(s).forEach((p) => {
          const rubriqueLabels = (p.lignes || []).filter((line) => line.checked !== false).map((line) => line.label).join(' | ') || p.rubriqueLabel || p.rubrique || '';
          rows.push([level, cls.name, `${s.prenom || ''} ${s.nom || ''}`.trim(), p.recu || '', p.date || '', p.montant || 0, rubriqueLabels, MODES_PAIEMENT[p.mode] || p.mode || '', p.type_paiement === 'inscription' ? 'Inscription' : p.type_paiement === 'mensualite' ? 'Mensualité' : '', p.mois || '', p.periode || '', p.note || '']);
        });
      });
    });
  });
  return rows;
}
function downloadJSONBackup(state, schoolName) {
  const clean = { ...state };
  delete clean.__version;
  const payload = { meta: { exporte_le: new Date().toISOString(), ecole: schoolName || (state.header && state.header.ecole) || '', version: state.__version || 1 }, data: clean };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `sygenop_${(schoolName || 'ecole').replace(/[^a-z0-9]+/gi, '_')}_${todayISO()}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function ExportCard({ icon: Icon, title, desc, onClick, tone = 'green' }) {
  const toneMap = { green: { bg: 'var(--green-l)', fg: 'var(--green-d)' }, gold: { bg: 'var(--gold-l)', fg: 'var(--gold)' } };
  const t = toneMap[tone] || toneMap.green;
  return (
    <div className="sygenop-card p-5 flex flex-col gap-3">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: t.bg, color: t.fg }}>
        <Icon size={18} />
      </div>
      <div>
        <div className="font-bold text-sm text-ink">{title}</div>
        <p className="text-xs mt-1 text-muted">{desc}</p>
      </div>
      <button onClick={onClick} className="mt-auto px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-1.5" style={{ background: 'var(--green-d)' }}>
        <Download size={15} /> Télécharger
      </button>
    </div>
  );
}

function ExportTab({ state, activeSchoolName, updateState, notify, session }) {
  function log(action, details) {
    updateState((prev) => ({ ...prev, auditLog: pushAuditEntry(prev.auditLog, { actor: actorLabel(session, prev), role: session && session.role, action, details }) }));
  }
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <ExportCard
        icon={Database} tone="gold" title="Sauvegarde complète (JSON)"
        desc="Toutes les données de l'école : classes, élèves, notes, personnel, pointage, paiements, barèmes et journal d'audit."
        onClick={() => { downloadJSONBackup(state, activeSchoolName); log('Export JSON', 'Sauvegarde complète des données de l\u2019école'); notify('Export JSON généré'); }}
      />
      <ExportCard
        icon={GraduationCap} title="Élèves &amp; notes (CSV)"
        desc="Un tableau par élève avec totaux, moyennes, rangs et mentions pour les 3 trimestres, toutes classes confondues."
        onClick={() => { downloadCSV(`sygenop_eleves_${todayISO()}.csv`, buildStudentsCSVRows(state)); log('Export CSV', 'Élèves et notes (tous niveaux)'); notify('Export CSV élèves généré'); }}
      />
      <ExportCard
        icon={Users} title="Personnel (CSV)"
        desc="Liste du personnel avec rôle, téléphone et classe(s) assignée(s)."
        onClick={() => { downloadCSV(`sygenop_personnel_${todayISO()}.csv`, buildPersonnelCSVRows(state)); log('Export CSV', 'Personnel'); notify('Export CSV personnel généré'); }}
      />
      <ExportCard
        icon={CreditCard} title="Paiements (CSV)"
        desc="Historique de tous les versements enregistrés (reçus, montants, modes, périodes)."
        onClick={() => { downloadCSV(`sygenop_paiements_${todayISO()}.csv`, buildPaymentsCSVRows(state)); log('Export CSV', 'Paiements'); notify('Export CSV paiements généré'); }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------
   Import JSON — restauration complète depuis une sauvegarde
   --------------------------------------------------------------- */
function ImportJSONPanel({ state, updateState, notify, session }) {
  const inputRef = useRef(null);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [confirmApply, setConfirmApply] = useState(false);

  function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setPending(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const payload = parsed && parsed.data ? parsed.data : parsed;
        if (!payload || typeof payload !== 'object' || typeof payload.classes !== 'object') {
          setError('Fichier invalide : structure de données SYGENOP non reconnue.');
          return;
        }
        setPending(payload);
      } catch (err) {
        setError('Fichier JSON illisible : ' + err.message);
      }
    };
    reader.readAsText(file);
  }
  function apply() {
    if (!pending) return;
    updateState((prev) => {
      const merged = { ...pending, __version: prev.__version };
      merged.auditLog = pushAuditEntry(pending.auditLog || prev.auditLog, {
        actor: actorLabel(session, prev), role: session && session.role,
        action: 'Import JSON', details: 'Remplacement complet des données de l\u2019école depuis un fichier de sauvegarde',
      });
      return merged;
    });
    notify('Import réussi — les données de l\u2019école ont été remplacées');
    setPending(null);
    setConfirmApply(false);
  }
  const counts = pending ? {
    classes: Object.keys(pending.classes || {}).length,
    eleves: Object.values(pending.classes || {}).reduce((s, c) => s + ((c.students || []).length), 0),
    personnel: (pending.personnel || []).length,
  } : null;

  return (
    <div className="sygenop-card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}>
          <Upload size={18} />
        </div>
        <div>
          <div className="font-bold text-sm text-ink">Restaurer une sauvegarde (JSON)</div>
          <p className="text-xs text-muted">Remplace <strong>toutes</strong> les données actuelles de l'école par le contenu du fichier.</p>
        </div>
      </div>
      <input ref={inputRef} type="file" accept="application/json,.json" onChange={onFile} className="hidden" />
      <button
        onClick={() => inputRef.current && inputRef.current.click()}
        className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 sygenop-btn sygenop-btn--ghost"
      >
        <Upload size={15} /> Choisir un fichier .json
      </button>
      {error && (
        <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--red)' }}><AlertCircle size={13} /> {error}</div>
      )}
      {counts && (
        <div className="rounded-lg p-3 text-xs space-y-1" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
          <div className="font-semibold text-ink">Aperçu du fichier :</div>
          <div className="text-muted">{counts.classes} classe(s) · {counts.eleves} élève(s) · {counts.personnel} membre(s) du personnel</div>
          <button
            onClick={() => setConfirmApply(true)}
            className="mt-2 px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5"
            style={{ background: 'var(--red)' }}
          >
            <Upload size={14} /> Remplacer les données de l'école
          </button>
        </div>
      )}
      {confirmApply && (
        <ConfirmModal
          title="Remplacer toutes les données de l'école ?"
          message="Cette action est irréversible : les classes, élèves, notes, personnel et paiements actuels seront écrasés par le contenu du fichier importé."
          danger
          onConfirm={apply}
          onCancel={() => setConfirmApply(false)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Import CSV — ajout en masse d'élèves dans une classe
   --------------------------------------------------------------- */
function ImportStudentsCSVPanel({ state, updateState, notify, session }) {
  const [level, setLevel] = useState('CI');
  const schoolLevels = levelsForSchool(state);
  useEffect(() => {
    if (schoolLevels.length && !schoolLevels.includes(level)) setLevel(schoolLevels[0]);
  }, [schoolLevels.join(','), level]);
  const classes = classesOfLevel(state, level);
  const [classId, setClassId] = useState(classes[0] ? classes[0][0] : '');
  const inputRef = useRef(null);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const cs = classesOfLevel(state, level);
    setClassId(cs[0] ? cs[0][0] : '');
    setRows(null); setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);

  function downloadTemplate() {
    downloadCSV('modele_eleves_sygenop.csv', [['Nom', 'Prénom', 'Âge', 'Genre (M/F)'], ['DIOP', 'Awa', '7', 'F'], ['FALL', 'Moussa', '8', 'M']]);
  }
  function onFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError(''); setRows(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const table = parseCSV(String(reader.result));
        if (!table.length) { setError('Fichier vide.'); return; }
        const head = table[0].map((c) => String(c || '').trim().toLowerCase());
        const iPrenom = head.findIndex((c) => c.includes('prénom') || c.includes('prenom'));
        const iNom = head.findIndex((c, idx) => c.includes('nom') && idx !== iPrenom);
        const iAge = head.findIndex((c) => c.includes('âge') || c.includes('age'));
        const iGenre = head.findIndex((c) => c.includes('genre') || c.includes('sexe'));
        if (iNom === -1 && iPrenom === -1) { setError('Colonnes "Nom" et "Prénom" introuvables dans l\u2019en-tête du fichier.'); return; }
        const parsed = table.slice(1).map((r) => ({
          nom: iNom > -1 ? (r[iNom] || '').trim() : '',
          prenom: iPrenom > -1 ? (r[iPrenom] || '').trim() : '',
          age: iAge > -1 ? (r[iAge] || '').trim() : '',
          genre: iGenre > -1 ? (r[iGenre] || '').trim().toUpperCase().slice(0, 1) : '',
        })).filter((r) => r.nom || r.prenom);
        if (!parsed.length) { setError('Aucune ligne exploitable trouvée dans le fichier.'); return; }
        setRows(parsed);
      } catch (err) { setError('Erreur de lecture du fichier : ' + err.message); }
    };
    reader.readAsText(file);
  }
  function apply() {
    if (!rows || !classId) return;
    updateState((prev) => {
      const next = { ...prev, classes: { ...(prev.classes || {}) } };
      const cls = next.classes[classId];
      if (!cls) return prev;
      const added = rows.map((r) => ({ id: uid('stu'), nom: r.nom, prenom: r.prenom, age: r.age, genre: r.genre, scores: {} }));
      const byName = (a, b) => (a.nom || '').localeCompare(b.nom || '') || (a.prenom || '').localeCompare(b.prenom || '');
      next.classes[classId] = { ...cls, students: [...(cls.students || []), ...added].sort(byName) };
      next.auditLog = pushAuditEntry(prev.auditLog, {
        actor: actorLabel(session, prev), role: session && session.role,
        action: 'Import CSV élèves', details: `${added.length} élève(s) ajouté(s) — ${cls.name} (${level})`,
      });
      return next;
    });
    notify(`${rows.length} élève(s) importé(s) dans la classe`);
    setRows(null);
  }

  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };
  return (
    <div className="sygenop-card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
          <FileSpreadsheet size={18} />
        </div>
        <div>
          <div className="font-bold text-sm text-ink">Importer des élèves (CSV)</div>
          <p className="text-xs text-muted">Ajoute une liste d'élèves à une classe existante, sans notes (à saisir ensuite).</p>
        </div>
        <button onClick={downloadTemplate} className="ml-auto text-xs font-semibold flex items-center gap-1.5 px-3 py-1.5 rounded-lg whitespace-nowrap sygenop-btn sygenop-btn--ghost">
          <FileSpreadsheet size={13} /> Modèle CSV
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-semibold block mb-1 text-muted">Niveau</label>
          <select value={level} onChange={(e) => setLevel(e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle}>
            {levelsForSchool(state).map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold block mb-1 text-muted">Classe de destination</label>
          <select value={classId} onChange={(e) => setClassId(e.target.value)} disabled={!classes.length} className="w-full px-3 py-2.5 rounded-lg border text-sm disabled:opacity-50" style={fieldStyle}>
            {!classes.length && <option value="">Aucune classe pour ce niveau</option>}
            {classes.map(([id, c]) => <option key={id} value={id}>{c.name} ({(c.students || []).length} élève(s))</option>)}
          </select>
        </div>
      </div>
      <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" />
      <button
        onClick={() => classId && inputRef.current && inputRef.current.click()}
        disabled={!classId}
        className="px-3.5 py-2 rounded-lg text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50 sygenop-btn sygenop-btn--ghost"
      >
        <Upload size={15} /> Choisir un fichier .csv
      </button>
      {error && <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--red)' }}><AlertCircle size={13} /> {error}</div>}
      {rows && (
        <div className="rounded-lg p-3 text-xs space-y-2" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}>
          <div className="font-semibold text-ink">{rows.length} élève(s) prêt(s) à importer :</div>
          <div className="max-h-40 overflow-y-auto space-y-1">
            {rows.slice(0, 8).map((r, i) => (
              <div key={i} style={{ color: 'var(--muted)' }}>{r.nom} {r.prenom} {r.age ? `· ${r.age} ans` : ''} {r.genre ? `· ${r.genre}` : ''}</div>
            ))}
            {rows.length > 8 && <div className="text-muted">… et {rows.length - 8} autre(s)</div>}
          </div>
          <button onClick={apply} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: 'var(--green-d)' }}>
            <CheckCircle2 size={14} /> Importer dans {classes.find(([id]) => id === classId)?.[1]?.name || 'la classe'}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Journal d'audit
   --------------------------------------------------------------- */
function AuditLogTab({ state, updateState, notify, readOnly, session }) {
  const [q, setQ] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const log = (state && state.auditLog) || [];
  const filtered = log.filter((e) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return (e.action || '').toLowerCase().includes(s) || (e.actor || '').toLowerCase().includes(s) || (e.details || '').toLowerCase().includes(s);
  });
  function clearLog() {
    if (readOnly) return;
    updateState((prev) => ({
      ...prev,
      auditLog: [{ id: uid('log'), ts: new Date().toISOString(), actor: actorLabel(session, prev), role: session && session.role, action: 'Purge du journal', details: `${(prev.auditLog || []).length} entrée(s) supprimée(s)` }],
    }));
    notify('Journal d\u2019audit vidé');
    setConfirmClear(false);
  }
  function toneFor(action = '') {
    const a = action.toLowerCase();
    if (a.includes('suppr') || a.includes('purge')) return 'red';
    if (a.includes('import')) return 'gold';
    return 'green';
  }
  return (
    <div className="space-y-3">
      <div className="sygenop-card p-4 flex flex-wrap items-center gap-3">
        <input
          value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher (action, auteur, détail)…"
          className="flex-1 px-3 py-2 rounded-lg border text-sm"
          style={{ borderColor: 'var(--line)', background: 'var(--bg)', color: 'var(--ink)' }}
        />
        <span className="text-xs font-semibold whitespace-nowrap text-muted">{filtered.length} / {log.length} entrée(s)</span>
        {!readOnly && log.length > 0 && (
          <button onClick={() => setConfirmClear(true)} className="px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap" style={{ background: 'var(--red-l)', color: 'var(--red)' }}>
            <Trash2 size={13} /> Vider le journal
          </button>
        )}
      </div>
      {!filtered.length ? (
        <div className="sygenop-card p-10 text-center text-sm text-muted">
          {log.length ? 'Aucune entrée ne correspond à la recherche.' : 'Aucune action enregistrée pour le moment.'}
        </div>
      ) : (
        <div className="sygenop-card overflow-x-auto">
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left whitespace-nowrap" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>Date &amp; heure</th>
                <th className="px-3 py-2 text-left whitespace-nowrap" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>Auteur</th>
                <th className="px-3 py-2 text-left whitespace-nowrap" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>Action</th>
                <th className="px-3 py-2 text-left" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--line)' }}>Détails</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>{fmtAuditTs(e.ts)}</td>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)', color: 'var(--ink)' }}>{e.actor || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)' }}><Pill tone={toneFor(e.action)}>{e.action}</Pill></td>
                  <td className="px-3 py-2" style={{ borderBottom: '1px solid var(--line)', color: 'var(--muted)' }}>{e.details || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirmClear && (
        <ConfirmModal
          title="Vider le journal d'audit ?"
          message="Toutes les entrées actuelles seront définitivement supprimées. Cette action est elle-même enregistrée."
          danger
          onConfirm={clearLog}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Vue « Données » — export, import, journal d'audit
   --------------------------------------------------------------- */
function ImportPaymentsCSVPanel({ state, updateState, notify, session }) {
  const inputRef = useRef(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);
  const parseLine = (line) => {
    const cells = []; let current = ''; let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (char === '"' && line[i + 1] === '"' && quoted) { current += '"'; i += 1; }
      else if (char === '"') quoted = !quoted;
      else if ((char === ';' || char === ',') && !quoted) { cells.push(current.trim()); current = ''; }
      else current += char;
    }
    cells.push(current.trim()); return cells;
  };
  const normalize = (value) => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const onFile = (event) => {
    const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
    setError(''); setPending(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const lines = String(reader.result || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
        if (lines.length < 2) throw new Error('Le fichier ne contient aucune ligne de paiement.');
        const headers = parseLine(lines[0]).map(normalize);
        const idx = (...names) => headers.findIndex((header) => names.includes(header));
        const iLevel = idx('niveau'); const iClass = idx('classe'); const iStudent = idx('eleve', 'etudiant'); const iFirst = idx('prenom'); const iLast = idx('nom');
        const iRubrique = idx('rubrique', 'rubriques', 'rubrique(s)', 'frais'); const iAmount = idx('montant', 'montant fcfa', 'montant (fcfa)'); const iDate = idx('date');
        const rubriqueColumns = [
          { id: 'inscription', labels: ["frais d'inscription", 'inscription'] },
          { id: 'scolarite', labels: ['scolarite'] },
          { id: 'cantine', labels: ['cantine'] },
          { id: 'car', labels: ['car', 'car / transport scolaire', 'transport', 'transport scolaire'] },
          { id: 'tenue', labels: ['tenue', 'tenue scolaire'] },
          { id: 'bibliotheque', labels: ['bibliotheque'] },
          { id: 'informatique', labels: ['informatique'] },
        ].map((definition) => ({ ...definition, index: definition.labels.map((label) => idx(label)).find((index) => index > -1) ?? -1 })).filter((definition) => definition.index > -1);
        const iMode = idx('mode', 'mode de paiement'); const iMonth = idx('mois'); const iReceipt = idx('n recu', 'numero recu', 'recu'); const iNote = idx('note', 'commentaire');
        if (iClass < 0 || (iAmount < 0 && !rubriqueColumns.length) || (iStudent < 0 && (iFirst < 0 || iLast < 0))) throw new Error('Colonnes requises : Classe, Élève (ou Prénom/Nom) et au moins une rubrique de paiement.');
        const classEntries = Object.entries(state.classes || {});
        const rows = lines.slice(1).map((line, rowIndex) => {
          const cells = parseLine(line); const level = iLevel > -1 ? cells[iLevel] || '' : '';
          const classValue = cells[iClass] || ''; const studentValue = iStudent > -1 ? cells[iStudent] || '' : `${cells[iFirst] || ''} ${cells[iLast] || ''}`.trim();
          const clsFound = classEntries.find(([id, cls]) => normalize(id) === normalize(classValue) || normalize(cls.name) === normalize(classValue));
          if (!clsFound) throw new Error(`Ligne ${rowIndex + 2} : classe introuvable (« ${classValue} »).`);
          const [classId, cls] = clsFound; const studentFound = (cls.students || []).find((student) => normalize(`${student.prenom || ''} ${student.nom || ''}`) === normalize(studentValue) || normalize(`${student.nom || ''} ${student.prenom || ''}`) === normalize(studentValue));
          if (!studentFound) throw new Error(`Ligne ${rowIndex + 2} : élève introuvable dans ${cls.name} (« ${studentValue} »).`);
          const parseAmount = (value) => Number(String(value || '0').replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0;
          let lignes = [];
          if (rubriqueColumns.length) {
            const configuredRubriques = feeForLevel(state, cls.level).rubriques;
            lignes = rubriqueColumns.map((column) => { const configured = configuredRubriques.find((item) => item.id === column.id); return { id: column.id, label: configured?.label || PAYMENT_RUBRIQUE_DEFAULTS.find((item) => item.id === column.id)?.label || column.id, montant: parseAmount(cells[column.index]), checked: true }; }).filter((line) => line.montant > 0);
          } else {
            const amount = parseAmount(cells[iAmount]); const rubriqueText = iRubrique > -1 ? cells[iRubrique] || '' : 'Scolarité'; const rubrique = feeForLevel(state, cls.level).rubriques.find((item) => normalize(item.id) === normalize(rubriqueText) || normalize(item.label) === normalize(rubriqueText));
            lignes = [{ id: rubrique?.id || 'scolarite', label: rubrique?.label || rubriqueText || 'Scolarité', montant: amount, checked: true }];
          }
          const amount = lignes.reduce((sum, line) => sum + line.montant, 0);
          if (amount <= 0) throw new Error(`Ligne ${rowIndex + 2} : aucun montant de rubrique valide.`);
          return { classId, studentId: studentFound.id, recu: iReceipt > -1 ? cells[iReceipt] || '' : '', date: iDate > -1 ? cells[iDate] || todayISO() : todayISO(), montant: amount, rubrique: lignes[0].id, rubriqueLabel: lignes.map((line) => line.label).join(' | '), lignes, mode: iMode > -1 ? cells[iMode] || 'especes' : 'especes', mois: iMonth > -1 ? cells[iMonth] || '' : '', note: iNote > -1 ? cells[iNote] || '' : '', level };
        });
        setPending(rows);
      } catch (err) { setError(err.message || 'Fichier CSV de paiements invalide.'); }
    };
    reader.readAsText(file, 'UTF-8');
  };
  const templateRows = [['Niveau', 'Classe', 'Élève', "Frais d'inscription", 'Scolarité', 'Cantine', 'Car / transport scolaire', 'Tenue scolaire', 'Bibliothèque', 'Informatique', 'Date', 'Mode', 'Mois', 'N° Reçu', 'Note'], ['CI', 'CI A', 'Prénom Nom', '0', '25000', '0', '0', '0', '0', '0', todayISO(), 'especes', '', '', '']];
  const downloadPaymentTemplate = () => { downloadCSV('modele-paiements.csv', templateRows); notify('Modèle CSV de paiement téléchargé'); };
  const apply = () => {
    if (!pending?.length) return;
    updateState((prev) => {
      const next = { ...prev, classes: { ...(prev.classes || {}) } }; let seq = Number(next.recuSeq) || 0;
      pending.forEach((row) => {
        const cls = next.classes[row.classId]; if (!cls) return;
        seq += 1; const recu = row.recu || `REC-${String(seq).padStart(5, '0')}`;
        next.classes[row.classId] = { ...cls, students: (cls.students || []).map((student) => student.id === row.studentId ? { ...student, paiements: [...studentPaiements(student), { id: uid('pay'), recu, date: row.date, montant: row.montant, mode: row.mode, mois: row.mois, note: row.note, rubrique: row.rubrique, rubriqueLabel: row.rubriqueLabel, lignes: row.lignes }] } : student) };
      });
      next.recuSeq = seq; next.auditLog = pushAuditEntry(prev.auditLog, { actor: actorLabel(session, prev), role: session?.role, action: 'Import CSV paiements', details: `${pending.length} paiement(s) importé(s)` }); return next;
    });
    notify(`${pending.length} paiement(s) importé(s)`); setPending(null);
  };
  return <div className="sygenop-card p-5 space-y-3"><div className="flex items-center gap-2"><div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}><CreditCard size={18} /></div><div><div className="font-bold text-sm text-ink">Importer des paiements (CSV)</div><p className="text-xs text-muted">Rubriques reconnues : inscription, scolarité, cantine, car/transport, tenue, bibliothèque et informatique.</p></div></div><input ref={inputRef} type="file" accept=".csv,text/csv" onChange={onFile} className="hidden" /><div className="flex flex-wrap gap-2"><button type="button" onClick={downloadPaymentTemplate} className="px-3.5 py-2 rounded-lg text-sm font-semibold sygenop-btn sygenop-btn--ghost"><FileSpreadsheet size={14} className="inline mr-1" /> Modèle CSV</button><button onClick={() => inputRef.current?.click()} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--green-d)' }}><Upload size={14} className="inline mr-1" /> Choisir un CSV</button></div><div className="rounded-lg p-3 text-xs overflow-x-auto" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}><div className="font-semibold mb-1 text-ink">Colonnes du modèle CSV</div><div className="text-muted">Niveau · Classe · Élève · Frais d'inscription · Scolarité · Cantine · Car / transport scolaire · Tenue scolaire · Bibliothèque · Informatique · Date · Mode · Mois · N° Reçu · Note</div></div>{error && <div className="text-xs" style={{ color: 'var(--red)' }}><AlertCircle size={13} className="inline mr-1" />{error}</div>}{pending && <div className="rounded-lg p-3 text-xs" style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}><div className="font-semibold">{pending.length} paiement(s) prêt(s) à importer.</div><button onClick={apply} className="mt-2 px-3.5 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--green-d)' }}><Save size={14} className="inline mr-1" /> Confirmer l’import</button></div>}</div>;
}
function DataView({ state, loading, updateState, notify, readOnly, session, activeSchoolName }) {
  const [tab, setTab] = useState('export');
  if (loading || !state) {
    return (
      <div className="flex items-center justify-center py-24 text-muted">
        <Loader2 className="animate-spin mr-2" size={18} /> Chargement des données…
      </div>
    );
  }
  const tabs = [
    { id: 'export', label: 'Export', icon: Download },
    { id: 'import', label: 'Import', icon: Upload },
    { id: 'audit', label: "Journal d'audit", icon: History },
  ];
  return (
    <div className="space-y-4 sygenop-fade">
      {readOnly && (
        <div className="sygenop-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2" style={{ background: 'var(--gold-l)', color: '#92710c' }}>
          <Eye size={14} /> Mode consultation (IEF) — lecture seule, aucune modification possible.
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 p-1 rounded-xl w-fit" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={tab === t.id ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'export' && <ExportTab state={state} activeSchoolName={activeSchoolName} updateState={updateState} notify={notify} session={session} />}
      {tab === 'import' && (
        readOnly ? (
          <div className="sygenop-card p-10 text-center text-sm text-muted">
            L'import de données n'est pas disponible en mode consultation (IEF).
          </div>
        ) : (
          <div className="space-y-4">
            <ImportJSONPanel state={state} updateState={updateState} notify={notify} session={session} />
            <ImportStudentsCSVPanel state={state} updateState={updateState} notify={notify} session={session} />
            <ImportPaymentsCSVPanel state={state} updateState={updateState} notify={notify} session={session} />
          </div>
        )
      )}
      {tab === 'audit' && <AuditLogTab state={state} updateState={updateState} notify={notify} readOnly={readOnly} session={session} />}
    </div>
  );
}

/* ============================================================
   ÉCRAN "EN CONSTRUCTION" — modules des phases suivantes
   ============================================================ */
function ComingSoonView({ view }) {
  const label = PAGE_TITLES[view]?.[0] || view;
  return (
    <div className="sygenop-card p-10 flex flex-col items-center text-center sygenop-fade">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }}>
        <Wrench size={24} />
      </div>
      <div className="font-bold mb-1 text-ink">{label} — module en cours de portage</div>
      <p className="text-sm max-w-sm text-muted">
        Ce module (moteur de barème, saisie, bulletins, pointage, paiements avec reçus…) fait partie
        des prochaines phases du portage. La structure et la connexion Supabase sont déjà en place.
      </p>
    </div>
  );
}

/* ============================================================
   LISTE DES ÉCOLES (IEF / Admin lecture seule)
   ============================================================ */
function IEFSchoolsView({ onOpenSchool, session }) {
  const role = session && session.role;
  const sessionIefId = session && session.iefId;
  const sessionGroupeId = session && session.groupeId;
  // Un compte IEF (lecture seule) est verrouillé sur son groupe scolaire :
  // il ne voit que les écoles de CE groupe. Un admin décentralisé est
  // verrouillé sur son IEF (circonscription).
  const isLockedIef = role === 'ief' && !!sessionGroupeId;
  const isLockedAdmin = role === 'admin' && !!sessionIefId;
  const isLocked = isLockedIef || isLockedAdmin;
  const lockedIefId = isLockedAdmin ? (sessionIefId || GRAND_DAKAR_FAKE_ID) : null;
  const [selectedIefId, setSelectedIefId] = useState(isLockedAdmin ? lockedIefId : '');
  const [iefList, setIefList] = useState([]);
  const [schools, setSchools] = useState([]);
  const [payloadsById, setPayloadsById] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [selectedCycle, setSelectedCycle] = useState('');
  const [presMois, setPresMois] = useState(currentMonthISO());
  const [notePeriod, setNotePeriod] = useState('T1');

  // Charge la liste des IEF pour le sélecteur (visible surtout pour le Super Admin racine)
  useEffect(() => {
    if (isLocked) return;
    let cancelled = false;
    (async () => {
      try {
        const rows = (await sb('POST', 'rpc/list_active_iefs', '', {})) || [];
        if (!cancelled) setIefList(rows);
      } catch (_) { /* table iefs pas encore créée */ }
    })();
    return () => { cancelled = true; };
  }, [isLocked]);

  // IEF effective = celle de la session (verrouillée) sinon celle choisie dans le sélecteur
  const effectiveIefId = isLockedAdmin ? lockedIefId : selectedIefId;
  // Pour le rôle ief, on charge par groupe_id (pas ief_id)
  const effectiveGroupeId = isLockedIef ? sessionGroupeId : null;
  const isGrandDakar = effectiveIefId === GRAND_DAKAR_FAKE_ID;
  // Si une VRAIE IEF « GRAND DAKAR » existe en base (post-migration
  // ief_grand_dakar), la sentinelle virtuelle (écoles ief_id null) ne doit
  // plus apparaître dans le sélecteur : elle n'a plus aucune école.
  const hasRealGrandDakar = (iefList || []).some((i) => (i.nom || '').toUpperCase().includes('GRAND DAKAR'));
  const selectedIefName = isLockedIef
    ? (session.iefName || 'Votre groupe scolaire')
    : isLockedAdmin
    ? (isGrandDakar ? 'IEF GRAND DAKAR' : (session.iefName || 'Votre IEF'))
    : (isGrandDakar
        ? 'IEF GRAND DAKAR'
        : (iefList.find((i) => i.id === effectiveIefId)?.nom || 'Toutes les IEF'));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        let params = 'order=name.asc';
        if (effectiveGroupeId) {
          // Rôle ief : charge les écoles de CE groupe scolaire
          params = `order=name.asc&groupe_id=eq.${effectiveGroupeId}`;
        } else if (effectiveIefId) {
          params = isGrandDakar
            ? 'order=name.asc&ief_id=is.null'
            : `order=name.asc&ief_id=eq.${effectiveIefId}`;
        }
        const rows = (await sb('GET', 'schools', params)) || [];
        // Isolement strict : on ne télécharge QUE les payloads des écoles
        // de la circonscription affichée — jamais ceux des autres IEF.
        const ids = rows.map((r) => r && r.id).filter(Boolean);
        const byId = await fetchSchoolPayloads(ids);
        if (!cancelled) { setSchools(rows); setPayloadsById(byId); }
      } catch (e) {
        if (!cancelled) setError(sbErrMsg(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [effectiveIefId, effectiveGroupeId, isGrandDakar]);
  // Polling : recharger les données toutes les 60 secondes pour que
  // le groupe scolaire / Super Admin voie les changements en temps réel.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      if (!pageIsVisible()) return;
      try {
        let params = 'order=name.asc';
        if (effectiveGroupeId) {
          params = `order=name.asc&groupe_id=eq.${effectiveGroupeId}`;
        } else if (effectiveIefId) {
          params = isGrandDakar
            ? 'order=name.asc&ief_id=is.null'
            : `order=name.asc&ief_id=eq.${effectiveIefId}`;
        }
        const rows = (await sb('GET', 'schools', params)) || [];
        const ids = rows.map((r) => r && r.id).filter(Boolean);
        const byId = await fetchSchoolPayloads(ids);
        if (active) { setSchools(rows); setPayloadsById(byId); }
      } catch (_) {}
    };
    const id = setInterval(poll, 300000); // 5 min (était 60 s : ~11 Mo téléchargés par minute)
    return () => { active = false; clearInterval(id); };
  }, [effectiveIefId, effectiveGroupeId, isGrandDakar]);

  const perSchoolStats = useMemo(() => {
    return schools.map((s) => {
      const payload = payloadsById[s.id];
      let effectif = 0, garcons = 0, filles = 0, classesActives = 0, totalClasses = 0;
      let personnelGender = { total: 0, male: 0, female: 0, unknown: 0 };
      if (payload) {
        const classEntries = Object.values(payload.classes || {});
        totalClasses = classEntries.length;
        classEntries.forEach((c) => {
          const n = (c.students || []).length;
          if (n > 0) classesActives++;
          effectif += n;
          (c.students || []).forEach((st) => {
            if (String(st.genre).toUpperCase() === 'M') garcons++;
            else if (String(st.genre).toUpperCase() === 'F') filles++;
          });
        });
        personnelGender = staffGenderSummary(payload.personnel);
      }
      const pay = payload ? schoolPaymentsSummary(payload) : { totalDue: 0, totalPaid: 0, taux: 0 };
      return { id: s.id, name: s.name, type: s.type, cycle: resolvedSchoolCycle(s, payload), actif: s.actif, effectif, garcons, filles, classesActives, totalClasses, personnelTotal: personnelGender.total, personnelMale: personnelGender.male, personnelFemale: personnelGender.female, personnelUnknown: personnelGender.unknown, ...pay };
    });
  }, [schools, payloadsById]);

  const activeSchoolStats = useMemo(() => perSchoolStats.filter((s) => s.actif !== false), [perSchoolStats]);
  useEffect(() => {
    if (!activeSchoolStats.length) return;
    if (!selectedCycle || !activeSchoolStats.some((s) => s.cycle === selectedCycle)) {
      setSelectedCycle(activeSchoolStats.find((s) => s.cycle)?.cycle || '');
    }
  }, [activeSchoolStats, selectedCycle]);
  const cycleSchoolStats = useMemo(
    () => activeSchoolStats.filter((s) => s.cycle === selectedCycle),
    [activeSchoolStats, selectedCycle]
  );
  const totals = useMemo(() => cycleSchoolStats.reduce((acc, s) => {
    acc.effectif += s.effectif;
    acc.garcons += s.garcons;
    acc.filles += s.filles;
    acc.personnel += s.personnelTotal;
    acc.personnelMale = (acc.personnelMale || 0) + (s.personnelMale || 0);
    acc.personnelFemale = (acc.personnelFemale || 0) + (s.personnelFemale || 0);
    acc.personnelUnknown = (acc.personnelUnknown || 0) + (s.personnelUnknown || 0);
    acc.classesActives += s.classesActives;
    acc.totalDue += s.totalDue;
    acc.totalPaid += s.totalPaid;
    return acc;
  }, { effectif: 0, garcons: 0, filles: 0, personnel: 0, personnelMale: 0, personnelFemale: 0, personnelUnknown: 0, classesActives: 0, totalDue: 0, totalPaid: 0 }), [cycleSchoolStats]);

  const presenceIEF = useMemo(
    () => combinePresenceSummaries(cycleSchoolStats.map((s) => schoolPresenceSummary(payloadsById[s.id] || emptySchoolState(), presMois))),
    [cycleSchoolStats, payloadsById, presMois]
  );
  const academicIEF = useMemo(
    () => combineAcademicSummaries(cycleSchoolStats.map((s) => schoolAcademicSummary(payloadsById[s.id] || emptySchoolState(), notePeriod))),
    [cycleSchoolStats, payloadsById, notePeriod]
  );
  const newsFeed = useMemo(() => {
    const all = [];
    cycleSchoolStats.forEach((s) => {
      const payload = payloadsById[s.id];
      ((payload && payload.actualites) || []).forEach((item) => all.push({ ...item, __school: s.name }));
    });
    return sortActualites(all);
  }, [cycleSchoolStats, payloadsById]);

  const tauxGlobal = totals.totalDue > 0 ? totals.totalPaid / totals.totalDue : 0;
  const genderData = [
    { name: 'Garçons', value: totals.garcons },
    { name: 'Filles', value: totals.filles },
  ];
  const GENDER_COLORS = ['#0a1e3d', '#ffd100'];
  const personnelGenderData = [
    { name: 'Hommes', value: totals.personnelMale || 0 },
    { name: 'Femmes', value: totals.personnelFemale || 0 },
    ...(totals.personnelUnknown ? [{ name: 'Non renseigné', value: totals.personnelUnknown }] : []),
  ];
  const PERSONNEL_GENDER_COLORS = ['#0a1e3d', '#ffd100', '#94a3b8'];
const barData = cycleSchoolStats
    .filter((s) => s.effectif > 0)
    .sort((a, b) => b.effectif - a.effectif)
    .slice(0, 12)
    .map((s) => ({ ecole: s.name.length > 14 ? s.name.slice(0, 13) + '…' : s.name, effectif: s.effectif }));

  const filtered = cycleSchoolStats.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
  const presenceBySchool = useMemo(() => cycleSchoolStats.map((s) => {
    const summary = schoolPresenceSummary(payloadsById[s.id] || emptySchoolState(), presMois);
    return { ecole: s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name, taux: summary.tauxPresence == null ? null : Math.round(summary.tauxPresence * 100) };
  }).filter((s) => s.taux != null), [cycleSchoolStats, payloadsById, presMois]);
  const academicBySchool = useMemo(() => cycleSchoolStats.map((s) => {
    const summary = schoolAcademicSummary(payloadsById[s.id] || emptySchoolState(), notePeriod);
    return {
      ecole: s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name,
      moyenne: summary.effectifNote > 0 ? Number(summary.moyenne.toFixed(2)) : null,
    };
  }).filter((s) => s.moyenne != null), [cycleSchoolStats, payloadsById, notePeriod]);

  if (loading) {
    return <AppLoader label={isLockedIef ? "Chargement des écoles du groupe scolaire…" : "Chargement des écoles et statistiques de l'IEF…"} />;
  }
  if (error) {
    return (
      <div className="sygenop-card p-6 text-sm" style={{ color: 'var(--red)' }}>
        Impossible de charger la vue d'ensemble : {error}
      </div>
    );
  }

  return (
    <div className="sygenop-fade space-y-6">
      {/* Sélecteur du groupe scolaire / IEF — le Super Admin racine choisit une IEF
          dont il voit la vue d'ensemble (écoles + statistiques), sans impacter les autres. */}
      <div className="sygenop-card px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Building2 size={16} style={{ color: 'var(--green-d)' }} />
          <span className="text-xs font-bold uppercase tracking-wide text-muted">{isLockedIef ? 'Groupe scolaire' : 'IEF'}</span>
        </div>
        {isLocked ? (
          <span className="text-sm font-bold px-3 py-1.5 rounded-lg" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
            {selectedIefName}
          </span>
        ) : (
          <select
            value={effectiveIefId || ''}
            onChange={(e) => setSelectedIefId(e.target.value || '')}
            className="px-3 py-2 rounded-lg border text-sm font-semibold"
            style={{ borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)', minWidth: 240 }}
          >
            <option value="">— Toutes les IEF (vue globale) —</option>
            {iefList.map((i) => <option key={i.id} value={i.id}>{i.nom}</option>)}
            {!hasRealGrandDakar && <option value={GRAND_DAKAR_FAKE_ID}>IEF GRAND DAKAR</option>}
          </select>
        )}
        <div className="text-xs font-semibold ml-auto text-muted">
          Vue d'ensemble — <span style={{ color: 'var(--green-d)' }}>{selectedIefName}</span>
        </div>
        <select value={selectedCycle} onChange={(e) => setSelectedCycle(e.target.value)} className="px-3 py-2 rounded-lg border text-sm font-semibold sygenop-input">
          {CYCLE_OPTIONS.map((cycle) => <option key={cycle.value} value={cycle.value}>{cycle.label}</option>)}
        </select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Building2} label="Écoles" value={cycleSchoolStats.length} sub={`${cycleSchoolStats.filter((s) => s.effectif > 0).length} avec élèves saisis · ${cycleLabel(selectedCycle)}`} tone="gold" />
        <StatCard icon={GraduationCap} label="Élèves inscrits (groupe scolaire)" value={totals.effectif} sub={`${totals.garcons} garçons · ${totals.filles} filles`} tone="green" />
        <StatCard icon={Users} label="Personnel (groupe scolaire)" value={totals.personnel} sub={`${totals.personnelMale} hommes · ${totals.personnelFemale} femmes${totals.personnelUnknown ? ` · ${totals.personnelUnknown} non renseigné(s)` : ''}`} tone="green" />
        <StatCard icon={CreditCard} label="Recouvrement global" value={`${Math.round(tauxGlobal * 100)}%`} sub={`${fmtFCFA(totals.totalPaid)} / ${fmtFCFA(totals.totalDue)}`} tone="gold" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="sygenop-card p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-bold text-sm flex items-center gap-2 text-ink">
              <Clock size={16} /> Présences du personnel — tout le groupe scolaire
            </div>
            <input
              type="month"
              value={presMois}
              onChange={(e) => setPresMois(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border text-xs sygenop-input"
            />
          </div>
          {presenceIEF.personnelTotal > 0 ? (
            <>
              <div className="flex items-end gap-2">
                <span className="text-3xl font-extrabold" style={{ color: 'var(--green-d)' }}>{presenceIEF.tauxExecution == null ? '—' : `${Math.round(presenceIEF.tauxExecution * 100)}%`}</span>
                <span className="text-xs mb-1 text-muted">score d’exécution des heures du groupe scolaire — {monthLabelFr(presMois)}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span>{presenceIEF.personnelTotal} agent(s) sur le groupe scolaire</span>
                <span>{presenceIEF.schoolsWithData} école(s) avec pointage renseigné</span>
                <span>Score moyen : {presenceIEF.moyenneHeures.toFixed(1)} h / agent</span>
                <span>Objectif moyen : {presenceIEF.objectifMoyen.toFixed(1)} h / agent</span>
                <span>{presenceIEF.totalHeures} h servies dans les écoles renseignées</span>
                <span>{presenceIEF.joursPresents} / {presenceIEF.joursPointes} pointages présents</span>
              </div>
              {presenceBySchool.length > 0 && (
                <ResponsiveContainer width="100%" height={150}>
                  <BarChart data={presenceBySchool} margin={{ top: 12, right: 8, left: -20, bottom: 32 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="ecole" tick={{ fontSize: 10, fill: 'var(--muted)' }} interval={0} angle={-25} textAnchor="end" />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--muted)' }} tickFormatter={(v) => `${v}%`} />
                    <Tooltip formatter={(v) => [`${v}%`, 'Taux de présence']} contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
                    <Bar dataKey="taux" fill="#4f46e5" radius={[5, 5, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </>
          ) : (
            <div className="text-sm py-4 text-muted">Aucun pointage enregistré ce mois-ci dans le groupe scolaire.</div>
          )}
        </div>

        <div className="sygenop-card p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-bold text-sm flex items-center gap-2 text-ink">
              <Trophy size={16} /> Score du trimestre — tout le groupe scolaire
            </div>
            <div className="flex gap-1 p-1 rounded-lg bg-bg">
              {TRIMESTRES.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setNotePeriod(t.key)}
                  className="px-2.5 py-1 rounded-md text-xs font-semibold transition-colors"
                  style={notePeriod === t.key ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
                >
                  {t.key}
                </button>
              ))}
            </div>
          </div>
          {academicIEF.effectifNote > 0 ? (
            <>
              <div className="flex items-end gap-2">
                <span className="text-3xl font-extrabold" style={{ color: 'var(--gold)' }}>{fmtNote(academicIEF.moyenne)}/10</span>
                <span className="text-xs mb-1 text-muted">moyenne générale — {TRIMESTRES.find((t) => t.key === notePeriod)?.label}</span>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span>{fmtPctVal(academicIEF.tauxReussite)} de taux de réussite</span>
                <span>{academicIEF.effectifNote} élève(s) noté(s) sur le groupe scolaire</span>
              </div>
              {academicBySchool.length > 0 && (
                <ResponsiveContainer width="100%" height={150}>
                  <LineChart data={academicBySchool} margin={{ top: 12, right: 12, left: -20, bottom: 32 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                    <XAxis dataKey="ecole" tick={{ fontSize: 10, fill: 'var(--muted)' }} interval={0} angle={-25} textAnchor="end" />
                    <YAxis domain={[0, 10]} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
                    <Tooltip formatter={(v) => [`${v}/10`, 'Moyenne']} contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
                    <Line type="monotone" dataKey="moyenne" stroke="#ffd100" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </>
          ) : (
            <div className="text-sm py-4 text-muted">Aucune note saisie pour ce trimestre dans le groupe scolaire.</div>
          )}
        </div>
      </div>

      <ActualitesPanel
        actualites={newsFeed}
        limit={8}
        title="Actualités de toutes les écoles"
      />

      {(totals.effectif > 0 || totals.personnel > 0) && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="sygenop-card p-5 lg:col-span-2">
            <div className="font-bold text-sm mb-4 text-ink">Effectifs par école (top {barData.length})</div>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={barData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
                <XAxis dataKey="ecole" tick={{ fontSize: 11, fill: 'var(--muted)' }} interval={0} angle={-25} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 12, fill: 'var(--muted)' }} />
                <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
                <Bar dataKey="effectif" fill="#0a1e3d" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            </div>
            <div className="sygenop-card p-5">
            <div className="font-bold text-sm mb-4 text-ink">Répartition par genre</div>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={genderData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={80} paddingAngle={2}>
                  {genderData.map((_, i) => <Cell key={i} fill={GENDER_COLORS[i]} />)}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 text-xs mt-2">
              <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: GENDER_COLORS[0] }} /> Garçons</span>
              <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: GENDER_COLORS[1] }} /> Filles</span>
            </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <div className="sygenop-card p-5">
              <div className="font-bold text-sm mb-4 text-ink">Personnel — Répartition Homme / Femme</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={personnelGenderData} layout="vertical" margin={{ top: 4, right: 25, left: 5, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
                  <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11, fill: 'var(--muted)' }} />
                  <Tooltip contentStyle={{ borderRadius: 10, border: '1px solid var(--line)', fontSize: 12 }} />
                  <Bar dataKey="value" fill="#4f46e5" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <div className="flex justify-center gap-4 text-xs mt-2">
                <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: PERSONNEL_GENDER_COLORS[0] }} /> Hommes</span>
                <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: PERSONNEL_GENDER_COLORS[1] }} /> Femmes</span>
                {totals.personnelUnknown > 0 && <span className="flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: PERSONNEL_GENDER_COLORS[2] }} /> Non renseigné</span>}
              </div>
              <div className="text-xs text-center mt-2 text-muted">Hommes : {totals.personnelMale} · Femmes : {totals.personnelFemale}{totals.personnelUnknown ? ` · Non renseigné : ${totals.personnelUnknown}` : ''}</div>
            </div>
          </div>
        </>
      )}

      <div className="sygenop-card p-4 flex items-center justify-between gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher une école…"
          className="flex-1 px-3 py-2 rounded-lg border text-sm"
          style={{ borderColor: 'var(--line)', background: 'var(--bg)', color: 'var(--ink)' }}
        />
        <span className="text-xs font-semibold whitespace-nowrap text-muted">
          {filtered.length} / {cycleSchoolStats.length} école(s) · {cycleLabel(selectedCycle)}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((s) => (
          <button key={s.id} onClick={() => onOpenSchool(s.id, s.name, s.actif)} className="sygenop-card p-4 text-left">
            <div className="font-bold text-sm text-ink">{s.name}</div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted">{schoolTypeLabel(s.type)}</span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
                {cycleLabel(s.cycle)}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2.5 text-xs text-muted">
              <span className="flex items-center gap-1"><GraduationCap size={12} /> {s.effectif} élève(s)</span>
              <span className="flex items-center gap-1"><Users size={12} /> {s.personnelTotal} agent(s)</span>
              <span className="flex items-center gap-1"><School size={12} /> {s.classesActives}/{s.totalClasses} classe(s)</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   MODALE DE GESTION DES RESTRICTIONS D'ÉCOLE (Super Admin)
   ============================================================ */
function RestrictionsModal({ school, onSave, onClose }) {
  const [form, setForm] = useState(() => ({
    max_classes_per_level: school?.max_classes_per_level ?? null,
    max_students_per_class: school?.max_students_per_class ?? null,
  }));
  const [busy, setBusy] = useState(false);

  const isPrivate = String(school?.type || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('privee');

  function set(k, v) {
    const val = v === '' ? null : (v ? Number(v) : null);
    setForm((f) => ({ ...f, [k]: val }));
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    await onSave(form);
    setBusy(false);
  }

  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card p-6 max-w-md w-full sygenop-fade">
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-ink">Restrictions d'école — {school.name}</div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        {!isPrivate && (
          <div className="text-xs mb-4 p-3 rounded-lg" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
            <CheckCircle2 size={14} className="inline mr-2" />
            École publique : aucune restriction par défaut.
          </div>
        )}
        {isPrivate && (
          <div className="text-xs mb-4 p-3 rounded-lg" style={{ background: 'var(--gold-l)', color: '#92710c' }}>
            École privée : restrictions par défaut de 2 classes/niveau et 40 élèves/classe.
          </div>
        )}
        <div className="space-y-4">
          <div>
            <label className="text-xs font-semibold block mb-2 text-muted">Nombre maximum de classes par niveau</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                max="20"
                value={form.max_classes_per_level ?? ''}
                onChange={(e) => set('max_classes_per_level', e.target.value)}
                className="flex-1 px-3 py-2.5 rounded-lg border text-sm"
                style={fieldStyle}
                placeholder={isPrivate ? '2' : '—'}
              />
              <button
                type="button"
                onClick={() => set('max_classes_per_level', '')}
                className="px-3 py-2 rounded-lg text-xs font-semibold sygenop-btn sygenop-btn--ghost"
              >
                Enlever
              </button>
            </div>
            <p className="text-[11px] mt-1 text-muted">
              {form.max_classes_per_level ? (
                <>Limité à <b>{form.max_classes_per_level}</b> classe(s) par niveau</>
              ) : (
                <>Aucune limite — écoles publiques ou écoles privées sans restriction</>
              )}
            </p>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-2 text-muted">Nombre maximum d'élèves par classe</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="10"
                max="200"
                value={form.max_students_per_class ?? ''}
                onChange={(e) => set('max_students_per_class', e.target.value)}
                className="flex-1 px-3 py-2.5 rounded-lg border text-sm"
                style={fieldStyle}
                placeholder={isPrivate ? '40' : '—'}
              />
              <button
                type="button"
                onClick={() => set('max_students_per_class', '')}
                className="px-3 py-2 rounded-lg text-xs font-semibold sygenop-btn sygenop-btn--ghost"
              >
                Enlever
              </button>
            </div>
            <p className="text-[11px] mt-1 text-muted">
              {form.max_students_per_class ? (
                <>Limité à <b>{form.max_students_per_class}</b> élève(s) par classe</>
              ) : (
                <>Aucune limite — écoles publiques ou écoles privées sans restriction</>
              )}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button type="submit" disabled={busy} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-60" style={{ background: 'var(--green-d)' }}>
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ============================================================
   SUPER ADMIN — Gestion des écoles & des administrateurs
   ============================================================ */
function SchoolModal({ school, onSave, onClose, iefOptions, fixedIefName, groupeOptions, fixedGroupeName }) {
  const isEdit = !!school;
const initialCycles = (() => {
    const base = school?.cycles && Array.isArray(school.cycles) && school.cycles.length ? school.cycles : (school?.cycle ? [school.cycle] : []);
    return base.filter((c) => CYCLE_OPTIONS.some((o) => o.value === c));
  })();
  const [form, setForm] = useState(() => ({
    name: school?.name || '',
    type: school?.type ? normalizeSchoolType(school.type) : SCHOOL_TYPES[0].value,
    cycles: initialCycles,
    directeur: school?.directeur || '',
    code: school?.code || generateAccessCode(),
    ief_id: school?.ief_id || (iefOptions && iefOptions[0] ? iefOptions[0].id : ''),
    groupe_id: school?.groupe_id || (groupeOptions && groupeOptions[0] ? groupeOptions[0].id : ''),
    actif: school?.actif !== false,
  }));
  const [showCode, setShowCode] = useState(true);
  const [busy, setBusy] = useState(false);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  function toggleCycle(cycleId) {
    setForm((f) => {
      const current = f.cycles || [];
      const next = current.includes(cycleId) ? current.filter((c) => c !== cycleId) : [...current, cycleId];
      return { ...f, cycles: next };
    });
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) return;
    if (!form.cycles || form.cycles.length === 0) return;
    if (!String(form.code).trim()) return;
    setBusy(true);
    await onSave({ ...form, name: form.name.trim(), code: String(form.code).trim(), cycle: form.cycles[0] || '' });
    setBusy(false);
  }

  const primaryCycle = form.cycles[0] || '';
  const cyclesValid = form.cycles && form.cycles.length > 0;
  const isGroupeScolaire = (form.cycles || []).length >= 2;
  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card p-6 max-w-md w-full sygenop-fade max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-ink">{isEdit ? (isGroupeScolaire ? 'Modifier le groupe scolaire' : 'Modifier l\u2019école') : (isGroupeScolaire ? 'Nouveau groupe scolaire' : 'Nouvelle école')}</div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Nom de l'école *</label>
            <input
              autoFocus
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border text-sm"
              style={fieldStyle}
              placeholder="Ex : École Élémentaire Liberté 6"
            />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Type</label>
            <select value={form.type} onChange={(e) => set('type', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle}>
              {SCHOOL_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Cycles couverts * <span className="font-normal">({form.cycles.length}/5 — 1 cycle = école simple, 2 à 5 = groupe scolaire)</span></label>
            <div className="grid grid-cols-1 gap-1.5">
              {CYCLE_OPTIONS.map((cycle) => {
                const checked = (form.cycles || []).includes(cycle.value);
                return (
                  <button
                    key={cycle.value}
                    type="button"
                    onClick={() => toggleCycle(cycle.value)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-left transition-colors"
                    style={checked
                      ? { background: 'var(--green-l)', color: 'var(--green-d)', border: '1.5px solid var(--green-d)' }
                      : { background: 'var(--bg)', color: 'var(--muted)', border: '1.5px solid var(--line)' }}
                  >
                    <span className="w-4 h-4 rounded flex items-center justify-center" style={checked ? { background: 'var(--green-d)', color: '#fff' } : { border: '1.5px solid var(--line)' }}>
                      {checked && '✓'}
                    </span>
                    {cycle.label}
                  </button>
                );
              })}
            </div>
            {!cyclesValid && form.cycles.length === 0 && (
              <p className="text-[11px] mt-1 text-muted">Sélectionnez au moins 1 cycle pour créer l'école.</p>
            )}
          </div>
          <div>
<label className="text-xs font-semibold block mb-1 text-muted">{cycleTerminology(primaryCycle).head}</label>
            <input
              value={form.directeur}
              onChange={(e) => set('directeur', e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border text-sm"
              style={fieldStyle}
              placeholder={`Nom du/de la ${cycleTerminology(primaryCycle).head.toLowerCase()}`}
            />
          </div>
          {iefOptions ? (
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">IEF de rattachement</label>
              <select value={form.ief_id} onChange={(e) => set('ief_id', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle}>
                <option value="">— Aucune (visible uniquement du Super Admin global) —</option>
                {iefOptions.map((i) => <option key={i.id} value={i.id}>{i.nom}</option>)}
              </select>
            </div>
          ) : fixedIefName ? (
            <div className="text-[11px] px-3 py-2 rounded-lg" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
              Cette école sera rattachée à l'IEF <b>{fixedIefName}</b>.
            </div>
          ) : null}
          {groupeOptions ? (
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Groupe scolaire de rattachement</label>
              <select value={form.groupe_id} onChange={(e) => set('groupe_id', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle}>
                <option value="">— Aucun —</option>
                {groupeOptions.map((g) => <option key={g.id} value={g.id}>{g.nom}</option>)}
              </select>
            </div>
          ) : fixedGroupeName ? (
            <div className="text-[11px] px-3 py-2 rounded-lg" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
              Cette école sera rattachée au Groupe scolaire <b>{fixedGroupeName}</b>.
            </div>
          ) : null}
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Code d'accès (École) *</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  type={showCode ? 'text' : 'password'}
                  value={form.code}
                  onChange={(e) => set('code', e.target.value.toUpperCase())}
                  className="w-full pl-9 pr-3 py-2.5 rounded-lg border text-sm font-mono tracking-widest"
                  style={fieldStyle}
                />
                <button type="button" onClick={() => setShowCode((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
                  {showCode ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => set('code', generateAccessCode())}
                className="px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap sygenop-btn sygenop-btn--ghost"
              >
                Générer
              </button>
            </div>
<p className="text-[11px] mt-1 text-muted">
              Ce code sera demandé à l'école pour se connecter (onglet « École » de l'écran de connexion).
            </p>
          </div>
          {isEdit && (
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Statut de l'école</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => set('actif', true)}
                  className="px-3 py-2 rounded-lg text-xs font-semibold"
                  style={form.actif ? { background: 'var(--green-d)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--ink)', border: '1px solid var(--line)' }}
                >
                  Active
                </button>
                <button
                  type="button"
                  onClick={() => set('actif', false)}
                  className="px-3 py-2 rounded-lg text-xs font-semibold"
                  style={!form.actif ? { background: 'var(--red)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--ink)', border: '1px solid var(--line)' }}
                >
                  Désactivée
                </button>
              </div>
              <p className="text-[11px] mt-1 text-muted">
                Une école désactivée est inaccessible à tous (directeur, enseignants, lecteur du groupe scolaire).
              </p>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button type="submit" disabled={busy} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-60" style={{ background: 'var(--green-d)' }}>
            {busy ? 'Enregistrement…' : (isEdit ? 'Enregistrer' : 'Créer l\u2019école')}
          </button>
        </div>
      </form>
    </div>
  );
}

/* IEF GRAND DAKAR légataire (fictif / sentinelle) — correspond aux écoles
   sans ief_id (ief_id null), c'est-à-dire l'IEF historique du système
   avant décentralisation. Utilisé dans le sélecteur du Super Admin. */
const GRAND_DAKAR_FAKE_ID = '__GRAND_DAKAR__';

function EcolesAdminTab({ notify, onOpenSchool, session, iefIdOverride, iefList: iefListProp }) {
  const iefId = iefIdOverride !== undefined && iefIdOverride !== null ? iefIdOverride : (session && session.iefId);
  const isGlobalAdmin = !iefId;
  const isGrandDakar = iefId === GRAND_DAKAR_FAKE_ID;
  // Résout le vrai ief_id de GRAND DAKAR depuis la liste IEF
  const grandDakarRealId = isGrandDakar
    ? ((Array.isArray(iefListProp) && iefListProp.find((i) => i.nom && i.nom.toUpperCase().includes('GRAND DAKAR'))?.id) || null)
    : null;
  const [schools, setSchools] = useState([]);
  const [iefList, setIefList] = useState([]);
  const [groupeList, setGroupeList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null); // null | 'new' | school object
  const [restrictionsModal, setRestrictionsModal] = useState(null); // null | school object
  const [attendanceSchool, setAttendanceSchool] = useState(null);
  const [holidaysModal, setHolidaysModal] = useState(false);
  const [applyingHolidays, setApplyingHolidays] = useState(null); // null | {done,total}
  const [toDelete, setToDelete] = useState(null);
  const [revealed, setRevealed] = useState({});

  useEffect(() => {
    if (!isGlobalAdmin) return;
    (async () => {
      try {
        const rows = (await sb('POST', 'rpc/list_active_iefs', '', {})) || [];
        setIefList(rows);
      } catch (_) { /* migration multi-IEF pas encore appliquée */ }
      try {
        const rows = (await sb('POST', 'rpc/list_active_groupes', '', {})) || [];
        setGroupeList(rows);
      } catch (_) { /* migration groupes_scolaires pas encore appliquée */ }
    })();
  }, [isGlobalAdmin]);

async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const params = iefId
        ? (isGrandDakar ? 'order=name.asc&ief_id=is.null' : `order=name.asc&ief_id=eq.${iefId}`)
        : 'order=name.asc';
      // Sélectionne les colonnes de base + tente d'inclure `actif` et `cycles`.
      // Si `actif` n'existe pas encore (migration SQL non exécutée), on se rabat
      // sur une lecture sans `actif` et on considère toutes les écoles comme actives.
      let rows = null;
      let keepActif = true;
      let keepCycles = true;
      let keepIef = true;
      const cols = () => {
        const parts = ['id', 'name', 'type', 'cycle'];
        if (keepCycles) parts.push('cycles');
        if (keepIef) parts.push('ief_id', 'groupe_id');
        parts.push('directeur', 'code');
        if (keepActif) parts.push('actif');
        return parts.join(',');
      };
      const attempt = async () => {
        rows = (await sb('GET', 'schools', `select=${cols()}${params ? '&' + params : ''}`)) || [];
      };
      // Dégradation séquentielle : si une colonne manque (base pré-migration),
      // on la retire et on relit — sans échouer sur l'ensemble de la liste.
      try {
        await attempt();
} catch (e) {
        let lastErr = e;
        let retried = true;
        while (retried) {
          const msg = sbErrMsg(lastErr);
          retried = false;
          if (/cycles/.test(msg) && keepCycles) { keepCycles = false; retried = true; }
          else if (/ief_id|groupe_id/.test(msg) && keepIef) { keepIef = false; retried = true; }
          else if (/actif|schema cache/.test(msg) && keepActif) { keepActif = false; retried = true; }
          if (!retried) break;
          try { await attempt(); retried = false; }
          catch (e2) { lastErr = e2; retried = true; }
        }
        if (!rows) throw lastErr;
      }
      if (!keepActif) rows.forEach((r) => { r.actif = true; });
      // Les valeurs récentes sont aussi conservées dans school_data.header,
      // ce qui garde la liste utilisable avant l'exécution de la migration.
      // PERF : on ne télécharge QUE le sous-champ payload->header (quelques
      // octets par école) — jamais les payloads complets (élèves, notes…),
      // sinon la liste devient très lente dès quelques dizaines d'écoles.
      if (rows.length && rows.some((s) => s.directeur === undefined || !s.directeur || !s.cycle)) {
        try {
          // On ne lit QUE directeur / cycle / cycles : payload->header contient
          // aussi le LOGO en base64 (jusqu'à 5,8 Mo par école !).
          let datas;
          try {
            datas = ((await sb('GET', 'school_data', 'select=school_id,directeur:payload->header->>directeur,cycle:payload->header->>cycle,cycles:payload->header->cycles')) || [])
              .map((d) => ({ school_id: d.school_id, payload: { directeur: d.directeur, cycle: d.cycle, cycles: d.cycles } }));
          } catch (_) {
            datas = (await sb('GET', 'school_data', 'select=school_id,payload->header')) || [];
          }
          const byId = {};
          datas.forEach((d) => { byId[d.school_id] = d.payload; });
          rows.forEach((s) => {
            if (!s.directeur && byId[s.id]) s.directeur = byId[s.id].directeur || '';
            if (!Array.isArray(s.cycles) || !s.cycles.length) {
              const hCycles = byId[s.id] && byId[s.id].cycles;
              if (Array.isArray(hCycles) && hCycles.length) s.cycles = hCycles;
            }
            s.cycle = resolvedSchoolCycle(s, { header: byId[s.id] });
          });
} catch (_) {}
      }
      // Si aucune donnée associée n'existe, il s'agit aussi d'une école historique
      // et elle doit rester visible dans le cycle élémentaire.
      rows.forEach((s) => {
        if (!Array.isArray(s.cycles) || !s.cycles.length) s.cycles = s.cycle ? [s.cycle] : [];
        s.cycle = resolvedSchoolCycle(s);
      });
      setSchools(rows);
    } catch (e) {
      setError(sbErrMsg(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, [iefId]);
  // Polling : recharger la liste des écoles toutes les 30 secondes
  // pour que le Super Admin voie les changements faits par les écoles.
  useEffect(() => {
    const id = setInterval(() => { if (pageIsVisible()) refresh(); }, 300000);
    return () => clearInterval(id);
  }, [iefId]);

  async function handleSave(form) {
    // GRAND DAKAR utilise le vrai UUID de la table iefs (pas null)
    const iefField = { ief_id: isGrandDakar ? grandDakarRealId : (isGlobalAdmin ? (form.ief_id || null) : iefId) };
    const groupeField = { groupe_id: isGlobalAdmin ? (form.groupe_id || null) : null };
    try {
      let directeurSaved = true;
      if (modal && modal !== 'new' && modal.id) {
        // RÉAFFECTATION (Super Admin) : le PATCH générique « schools » ne
        // modifie JAMAIS ief_id/groupe_id côté serveur (frontière d'isolation
        // entre circonscriptions) — l'ancien code l'acceptait silencieusement.
        // Le changement passe désormais par la RPC dédiée reaffecter_ecole,
        // vérifiée et validée par le code maître ; un refus = message clair.
        if (isGlobalAdmin) {
          const prevIef = (modal && modal.ief_id) || null;
          const prevGroupe = (modal && modal.groupe_id) || null;
          const nextIef = form.ief_id || null;
          const nextGroupe = form.groupe_id || null;
          if (prevIef !== nextIef || prevGroupe !== nextGroupe) {
            try {
              const raw = await sb('POST', 'rpc/reaffecter_ecole', '', {
                p_school_id: modal.id,
                p_nouvel_ief_id: nextIef,
                p_nouveau_groupe_id: nextGroupe,
                p_admin_code: (session && session.adminCode) || '',
              });
              const rr = raw && (raw.data || raw);
              if (!rr || rr.ok !== true) {
                notify((rr && rr.error) ? ('Réaffectation refusée : ' + rr.error) : 'Réaffectation refusée par le serveur', true);
                return;
              }
            } catch (e2) {
              const m2 = sbErrMsg(e2);
              if (/PGRST202|could not find|does not exist|not find/i.test(m2)) {
                notify('Réaffectation d\u2019IEF indisponible : exécutez une fois sql/migration_reaffectation_ecole.sql dans l\u2019éditeur SQL Supabase, puis réessayez.', true);
              } else {
                notify('Réaffectation impossible : ' + m2, true);
              }
              return;
            }
          }
        }
        const res = await upsertSchoolRow('PATCH', `id=eq.${modal.id}`, {
          name: form.name, type: form.type, cycle: form.cycle, cycles: form.cycles, directeur: form.directeur, code: form.code, actif: form.actif,
          ...(isGlobalAdmin ? {} : iefField),
          ...(isGlobalAdmin ? {} : groupeField),
        });
        directeurSaved = res.directeurSaved;
        // Répercute le nom/directeur dans les données de l'école si elle existe déjà
        try {
const st = await loadSchoolData(modal.id);
          st.header = { ...(st.header || {}), ecole: form.name, directeur: form.directeur, cycle: form.cycle, cycles: form.cycles };
          await saveSchoolData(modal.id, st);
        } catch (_) {}
        notify(directeurSaved ? 'École modifiée avec succès' : 'École modifiée (le directeur est enregistré, mais exécutez la migration SQL pour qu\u2019il apparaisse aussi dans la liste — voir instructions fournies)');
      } else {
        const res = await upsertSchoolRow('POST', '', {
          name: form.name, type: form.type, cycle: form.cycle, cycles: form.cycles, directeur: form.directeur, code: form.code, actif: form.actif, ...iefField, ...groupeField,
        });
        directeurSaved = res.directeurSaved;
        const created = res.data || [];
        const newSchool = created[0];
        if (newSchool && newSchool.id) {
          try {
            const st = emptySchoolState();
            st.header.ecole = form.name;
            st.header.directeur = form.directeur;
            st.header.type = schoolTypeLabel(form.type);
            st.header.cycle = form.cycle;
            st.header.cycles = form.cycles;
            await sb('POST', 'school_data', '', { school_id: newSchool.id, payload: st, version: 1 });
          } catch (_) {}
        }
        notify(directeurSaved ? 'École créée avec succès' : 'École créée (le directeur est enregistré, mais exécutez la migration SQL pour qu\u2019il apparaisse aussi dans la liste — voir instructions fournies)');
      }
      setModal(null);
      refresh();
    } catch (e) {
      notify('Erreur : ' + sbErrMsg(e), true);
    }
  }

  async function handleDelete(s) {
    try {
      await sb('PATCH', 'schools', `id=eq.${s.id}`, { actif: false });
      notify('École archivée. Ses données sont conservées et elle pourra être réactivée.');
      setToDelete(null);
      refresh();
    } catch (e) {
      notify('Erreur lors de la suppression : ' + sbErrMsg(e), true);
    }
  }

  async function openAttendanceSettings(school) {
    try {
      const state = await loadSchoolData(school.id);
      setAttendanceSchool({ ...school, pointageSettings: attendanceSettings(state) });
    } catch (e) { notify('Impossible de charger les paramètres : ' + sbErrMsg(e), true); }
  }
  async function saveAttendanceSettings(settings) {
    if (!attendanceSchool) return;
    try {
      const state = await loadSchoolData(attendanceSchool.id);
      await saveSchoolData(attendanceSchool.id, { ...state, config: { ...(state.config || {}), pointage: settings } });
      notify('Règles de pointage enregistrées');
      setAttendanceSchool(null);
    } catch (e) { notify('Erreur : ' + sbErrMsg(e), true); }
  }

  // Applique la même liste de jours non ouvrés/fériés en un seul geste.
  // Super Admin racine : TOUTES les écoles actives du système (même si une
  // IEF est sélectionnée dans le filtre d'affichage). Admin d'IEF : les
  // écoles de son périmètre affichées. Les autres réglages de pointage de
  // chaque école sont préservés.
  async function applyHolidaysToAll(dates) {
    const racine = session?.role === 'admin' && !(session && session.iefId);
    let targets = schools.filter((s) => s.actif !== false);
    if (racine) {
      try {
        const rows = (await sb('GET', 'schools', 'select=id,name&actif=neq.false&order=name.asc')) || [];
        if (rows.length) targets = rows;
      } catch (_) { /* filtre actif absent ou hors-ligne : garde la liste affichée */ }
    }
    if (!targets.length) { notify('Aucune école active.', true); return; }
    setApplyingHolidays({ done: 0, total: targets.length });
    let okCount = 0; let failCount = 0;
    for (const s of targets) {
      try {
        const st = await loadSchoolData(s.id);
        const pointage = { ...((st.config && st.config.pointage) || {}), joursNonOuvres: dates };
        await saveSchoolData(s.id, { ...st, config: { ...(st.config || {}), pointage } });
        okCount++;
      } catch (_) { failCount++; }
      setApplyingHolidays((p) => ({ done: (p ? p.done : 0) + 1, total: targets.length }));
    }
    setApplyingHolidays(null);
    setHolidaysModal(false);
    notify(failCount
      ? `Jours non ouvrés appliqués à ${okCount}/${targets.length} école(s) — ${failCount} échec(s).`
      : `Jours non ouvrés et fériés appliqués aux ${okCount} école(s).`);
  }

  async function saveRestrictions(restrictions) {
    if (!restrictionsModal) return;
    try {
      const state = await loadSchoolData(restrictionsModal.id);
      const header = { ...(state.header || {}) };
      if (restrictions.max_classes_per_level !== null) {
        header.max_classes_per_level = restrictions.max_classes_per_level;
      } else {
        delete header.max_classes_per_level;
      }
      if (restrictions.max_students_per_class !== null) {
        header.max_students_per_class = restrictions.max_students_per_class;
      } else {
        delete header.max_students_per_class;
      }
      await saveSchoolData(restrictionsModal.id, { ...state, header });
      notify('Restrictions enregistrées');
      setRestrictionsModal(null);
      refresh();
    } catch (e) { notify('Erreur : ' + sbErrMsg(e), true); }
  }

  const [selectedCycle, setSelectedCycle] = useState('');
  useEffect(() => {
    const availableCycles = schools.map((s) => s.cycle).filter(Boolean);
    if (availableCycles.length && !availableCycles.includes(selectedCycle)) setSelectedCycle(availableCycles[0]);
  }, [schools, selectedCycle]);
  const filtered = schools.filter((s) =>
    (s.name || '').toLowerCase().includes(q.toLowerCase()) &&
    (s.cycle === selectedCycle || (Array.isArray(s.cycles) && s.cycles.includes(selectedCycle)))
  );

  return (
    <div className="space-y-4">
      <div className="sygenop-card p-4 flex flex-col sm:flex-row gap-3 sm:items-center">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher une école…"
          className="flex-1 px-3 py-2 rounded-lg border text-sm"
          style={{ borderColor: 'var(--line)', background: 'var(--bg)', color: 'var(--ink)' }}
        />
        <select value={selectedCycle} onChange={(e) => setSelectedCycle(e.target.value)} className="px-3 py-2 rounded-lg border text-sm" style={{ borderColor: 'var(--line)', background: 'var(--bg)', color: 'var(--ink)' }}>
          {CYCLE_OPTIONS.map((cycle) => <option key={cycle.value} value={cycle.value}>{cycle.label}</option>)}
        </select>
        <button
          onClick={() => setModal('new')}
          className="px-3.5 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 justify-center"
          style={{ background: 'var(--green-d)' }}
        >
          <Plus size={15} /> Nouvelle école
        </button>
        {session?.role === 'admin' && (
          <button
            onClick={() => setHolidaysModal(true)}
            className="px-3.5 py-2.5 rounded-lg text-sm font-semibold flex items-center gap-1.5 justify-center whitespace-nowrap"
            style={{ background: 'var(--gold-l)', color: 'var(--gold)', border: '1px solid var(--gold)' }}
            title="Définir les jours non ouvrés et fériés pour toutes les écoles d'un coup"
          >
            <CalendarDays size={15} /> Jours fériés (toutes)
          </button>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16 text-muted">
          <Loader2 className="animate-spin mr-2" size={18} /> Chargement des écoles…
        </div>
      )}
      {error && !loading && (
        <div className="sygenop-card p-6 text-sm" style={{ color: 'var(--red)' }}>
          Impossible de charger les écoles : {error}
        </div>
      )}

      {!loading && !error && (
        <div className="sygenop-card overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                <th className="text-left px-4 py-3 font-semibold text-muted">École</th>
                <th className="text-left px-4 py-3 font-semibold text-muted">Type</th>
                <th className="text-left px-4 py-3 font-semibold text-muted">Cycle</th>
<th className="text-left px-4 py-3 font-semibold text-muted">Directeur</th>
                <th className="text-left px-4 py-3 font-semibold text-muted">Statut</th>
                <th className="text-left px-4 py-3 font-semibold text-muted">Code d'accès</th>
                <th className="text-right px-4 py-3 font-semibold text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td className="px-4 py-3 font-semibold text-ink">{s.name}</td>
                  <td className="px-4 py-3 text-muted">{schoolTypeLabel(s.type)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(Array.isArray(s.cycles) && s.cycles.length ? s.cycles : (s.cycle ? [s.cycle] : [])).map((c) => (
                        <span key={c} className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
                          {cycleLabel(c)}
                        </span>
                      ))}
                      {Array.isArray(s.cycles) && s.cycles.length >= 2 && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'var(--gold-l)', color: '#92710c' }}>
                          Groupe scolaire
                        </span>
                      )}
                    </div>
                  </td>
<td className="px-4 py-3 text-muted">{s.directeur || <span className="italic opacity-60">Non renseigné</span>}</td>
                  <td className="px-4 py-3">
                    <Pill tone={s.actif === false ? 'red' : 'green'}>
                      {s.actif === false ? 'Désactivée' : 'Active'}
                    </Pill>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold tracking-widest text-ink">
                        {revealed[s.id] ? (s.code || '—') : '••••••'}
                      </span>
                      <button onClick={() => setRevealed((r) => ({ ...r, [s.id]: !r[s.id] }))} style={{ color: 'var(--muted)' }} title="Afficher / masquer">
                        {revealed[s.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      {s.code && (
                        <button onClick={() => copyToClipboard(s.code, notify)} style={{ color: 'var(--muted)' }} title="Copier le code">
                          <FileSpreadsheet size={14} />
                        </button>
                      )}
                    </div>
                  </td>
<td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <button
                        onClick={() => s.actif === false ? handleToggleActif(s) : setToDelete(s)}
                        className="px-2.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
                        style={s.actif === false
                          ? { background: 'var(--green-l)', color: 'var(--green-d)' }
                          : { background: 'var(--red-l)', color: 'var(--red)' }}
                        title={s.actif === false ? 'Réactiver cette école' : 'Archiver cette école'}
                      >
                        {s.actif === false ? <CheckCircle2 size={14} /> : <History size={14} />}
                        {s.actif === false ? 'Réactiver' : 'Archiver'}
                      </button>
<button onClick={() => onOpenSchool && onOpenSchool(s.id, s.name, s.actif)} className="p-2 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }} title="Ouvrir l'école">
                        <ChevronRight size={15} />
                      </button>
                      <button onClick={() => setModal(s)} className="p-2 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }} title="Modifier">
                        <Pencil size={15} />
                      </button>
                      {session?.role === 'admin' && (
                        <button onClick={async () => {
                            try {
                              const schoolState = await loadSchoolData(s.id);
                              const limits = schoolState?.header || {};
                              setRestrictionsModal({ ...s, max_classes_per_level: limits.max_classes_per_level ?? null, max_students_per_class: limits.max_students_per_class ?? null });
                            } catch (e) {
                              notify('Impossible de charger les restrictions : ' + sbErrMsg(e), true);
                            }
                          }} className="p-2 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--gold)' }} title="Gérer les restrictions (classes/effectifs)">
                          <AlertCircle size={15} />
                        </button>
                      )}
                      {session?.role === 'admin' && schoolSupportsAttendanceSettings(s) && (
                        <button onClick={() => openAttendanceSettings(s)} className="p-2 rounded-lg" style={{ background: 'var(--gold-l)', color: 'var(--gold)' }} title="Paramétrer les heures et jours non ouvrés">
                          <Clock size={15} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
{!filtered.length && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">Aucune école trouvée.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(modal === 'new' || (modal && modal.id)) && (
        <SchoolModal
          school={modal === 'new' ? null : modal}
          onSave={handleSave}
          onClose={() => setModal(null)}
          iefOptions={isGlobalAdmin && iefList.length ? iefList : null}
          fixedIefName={!isGlobalAdmin ? (session && session.iefName) : null}
          groupeOptions={isGlobalAdmin && groupeList.length ? groupeList : null}
        />
      )}
      {attendanceSchool && (
        <AttendanceSettingsModal
          school={attendanceSchool}
          onSave={saveAttendanceSettings}
          onClose={() => setAttendanceSchool(null)}
        />
      )}
      {holidaysModal && (
        <JoursFeriesGlobauxModal
          isRacine={session?.role === 'admin' && !(session && session.iefId)}
          nbEcoles={schools.filter((s) => s.actif !== false).length}
          applying={applyingHolidays}
          onApply={applyHolidaysToAll}
          onClose={() => setHolidaysModal(false)}
        />
      )}
      {restrictionsModal && (
        <RestrictionsModal
          school={restrictionsModal}
          onSave={saveRestrictions}
          onClose={() => setRestrictionsModal(null)}
        />
      )}
      {toDelete && (
        <ConfirmModal
          title="Archiver cette école ?"
          message={`« ${toDelete.name} » sera désactivée et masquée des vues courantes. Les données restent conservées et l'école pourra être réactivée.`}
          onCancel={() => setToDelete(null)}
          onConfirm={() => handleDelete(toDelete)}
        />
      )}
    </div>
  );
}

function IEFAccountModal({ admin, onSave, onClose, allowRoleAdmin }) {
  const isEdit = !!admin;
  const [form, setForm] = useState(() => ({
    nom: admin?.nom || '',
    code: admin?.code || generateAccessCode(),
    role: admin?.role || 'ief',
  }));
  const [showCode, setShowCode] = useState(true);
  const [busy, setBusy] = useState(false);

  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  async function submit(e) {
    e.preventDefault();
    if (!form.nom.trim() || !String(form.code).trim()) return;
    setBusy(true);
    await onSave({ ...form, nom: form.nom.trim(), code: String(form.code).trim() });
    setBusy(false);
  }
  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card p-6 max-w-md w-full sygenop-fade">
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-ink">{isEdit ? 'Modifier le compte' : 'Nouveau compte IEF'}</div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <p className="text-xs mb-4 text-muted">
          {form.role === 'admin'
            ? "Ce compte pourra créer et modifier des écoles, mais uniquement au sein de sa propre IEF."
            : "Ce compte pourra consulter les écoles de son IEF (lecture seule) via l'onglet « IEF » de l'écran de connexion, sans pouvoir rien modifier."}
        </p>
        <div className="space-y-3">
          {allowRoleAdmin && (
            <div>
              <label className="text-xs font-semibold block mb-1 text-muted">Type de compte</label>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => set('role', 'ief')} className="px-3 py-2 rounded-lg text-xs font-semibold" style={form.role === 'ief' ? { background: 'var(--green-d)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--ink)', border: '1px solid var(--line)' }}>Lecture seule</button>
                <button type="button" onClick={() => set('role', 'admin')} className="px-3 py-2 rounded-lg text-xs font-semibold" style={form.role === 'admin' ? { background: 'var(--green-d)', color: '#fff' } : { background: 'var(--bg)', color: 'var(--ink)', border: '1px solid var(--line)' }}>Administrateur IEF</button>
              </div>
            </div>
          )}
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Nom *</label>
            <input autoFocus value={form.nom} onChange={(e) => set('nom', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : M. Ndiaye" />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Code d'accès *</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  type={showCode ? 'text' : 'password'}
                  value={form.code}
                  onChange={(e) => set('code', e.target.value.toUpperCase())}
                  className="w-full pl-9 pr-3 py-2.5 rounded-lg border text-sm font-mono tracking-widest"
                  style={fieldStyle}
                />
                <button type="button" onClick={() => setShowCode((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
                  {showCode ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <button type="button" onClick={() => set('code', generateAccessCode())} className="px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap sygenop-btn sygenop-btn--ghost">
                Générer
              </button>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button type="submit" disabled={busy} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-60" style={{ background: 'var(--green-d)' }}>
            {busy ? 'Enregistrement…' : (isEdit ? 'Enregistrer' : 'Ajouter')}
          </button>
        </div>
      </form>
    </div>
  );
}

const ADMINS_TABLE_SQL = `-- ============================================================
--  SYGENOP — MIGRATION MULTI-IEF (script complet & idempotent)
--  À exécuter UNE FOIS dans l'éditeur SQL de Supabase.
--  Le script peut être relancé sans risque (IF NOT EXISTS).
-- ============================================================

-- 1) TABLE "iefs" — inspections décentralisées
create table if not exists public.iefs (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  code_lecture text not null unique,
  code_admin text not null unique,
  actif boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2) TABLE "admins" — comptes IEF / Administrateurs IEF
create table if not exists public.admins (
  id uuid primary key default gen_random_uuid(),
  nom text not null,
  code text not null unique,
  role text not null default 'ief',
  actif boolean not null default true,
  ief_id uuid references public.iefs(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Compatibilité : si la table admins existait déjà (ancienne version
-- sans role/ief_id), on ajoute ces colonnes sans les dupliquer.
alter table public.admins add column if not exists role text not null default 'ief';
alter table public.admins add column if not exists ief_id uuid references public.iefs(id) on delete set null;

-- 3) TABLE "schools" — colonnes manquantes
alter table public.schools add column if not exists ief_id uuid references public.iefs(id) on delete set null;
alter table public.schools add column if not exists directeur text;
alter table public.schools add column if not exists cycle text;
create index if not exists idx_schools_ief_id on public.schools(ief_id);
create index if not exists idx_schools_cycle on public.schools(cycle);

-- 4) TABLE "ief_config" — clé/valeur partagée
create table if not exists public.ief_config (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

-- 5) Row Level Security — AUCUN accès direct pour le rôle anon.
--    ⚠️ NE PAS créer de politique "anon ... using (true)" : la clé anon
--    est publique par conception, quiconque pourrait alors lire/écrire
--    ces tables et récupérer tous les codes d'accès.
alter table public.iefs enable row level security;
drop policy if exists "iefs_anon_all" on public.iefs;
drop policy if exists "iefs_anon_read" on public.iefs;

alter table public.admins enable row level security;
drop policy if exists "admins_anon_all" on public.admins;
drop policy if exists "admins_anon_read" on public.admins;

alter table public.ief_config enable row level security;
drop policy if exists "ief_config_anon_all" on public.ief_config;
drop policy if exists "ief_config_anon_read" on public.ief_config;

-- 6) Valeurs par défaut — PROVISOIRES, à changer immédiatement après
--    installation depuis l'application (Super Admin → Gestion des IEF).
insert into public.ief_config (key, value) values ('admin_code', 'ADMIN-2025') on conflict (key) do nothing;
insert into public.ief_config (key, value) values ('ief_code', 'IEF-DAKAR') on conflict (key) do nothing;

-- 7) IEF GRAND DAKAR par défaut (l'IEF historique du système)
--    Les écoles existantes sans ief_id appartiennent à cette IEF.
--    On l'insère une seule fois (si aucune IEF nommée "GRAND DAKAR" n'existe).
insert into public.iefs (nom, code_lecture, code_admin, actif)
select 'IEF GRAND DAKAR', 'IEF-DAKAR', 'ADMIN-DAKAR', true
where not exists (
  select 1 from public.iefs where upper(nom) like upper('%GRAND DAKAR%')
);

-- ============================================================
--  8) SÉCURISATION OBLIGATOIRE — à exécuter ensuite, dans l'ordre :
--     sql/migration_securite_rpc.sql   (vérif de codes sans exposition)
--     sql/migration_securite_data.sql  (RLS stricte + RPC données)
--     sql/migration_rate_limit.sql     (anti brute-force serveur)
-- ============================================================`;

function IEFAccountsTab({ notify, session, iefIdOverride, iefList }) {
  const iefId = iefIdOverride !== undefined && iefIdOverride !== null ? iefIdOverride : (session && session.iefId);
  const isGlobalAdmin = !iefId;
  const isGrandDakar = iefId === GRAND_DAKAR_FAKE_ID;
  // Résout le vrai ief_id de GRAND DAKAR depuis la liste IEF (pas null)
  const grandDakarRealId = isGrandDakar
    ? ((Array.isArray(iefList) && iefList.find((i) => i.nom && i.nom.toUpperCase().includes('GRAND DAKAR'))?.id) || null)
    : null;
  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [missingTable, setMissingTable] = useState(false);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [masterCode, setMasterCode] = useState('');
  const [masterInput, setMasterInput] = useState('');
  const [showMaster, setShowMaster] = useState(false);
  const [savingMaster, setSavingMaster] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    setMissingTable(false);
    try {
      // Pour GRAND DAKAR, cherche les admins avec le vrai UUID OU ceux encore
      // avec ief_id=null (compatibilité avec les anciens comptes créés avant le fix).
      let params;
      if (isGrandDakar) {
        const realId = grandDakarRealId;
        params = realId
          ? `order=created_at.asc&or=(ief_id.eq.${realId},ief_id.is.null)`
          : 'order=created_at.asc&ief_id=is.null';
      } else if (iefId) {
        params = `order=created_at.asc&ief_id=eq.${iefId}`;
      } else {
        params = 'order=created_at.asc&ief_id=is.null';
      }
      const rows = (await sb('GET', 'admins', params)) || [];
      setAdmins(rows);
    } catch (e) {
      const msg = sbErrMsg(e);
      if (/relation .*admins.* does not exist|not find the table/i.test(msg)) setMissingTable(true);
      else setError(msg);
    } finally {
      setLoading(false);
    }
    if (isGlobalAdmin) {
      try {
        const cfg = (await sb('GET', 'ief_config', 'key=eq.admin_code&select=value')) || [];
        const val = cfg[0]?.value || '';
        setMasterCode(val);
        setMasterInput(val);
      } catch (_) {}
    }
  }

  useEffect(() => { refresh(); }, [iefId]);

  async function saveMasterCode() {
    if (!masterInput.trim()) { notify('Le code ne peut pas être vide', true); return; }
    setSavingMaster(true);
    try {
      const cfg = (await sb('GET', 'ief_config', 'key=eq.admin_code&select=key')) || [];
      if (cfg.length) await sb('PATCH', 'ief_config', 'key=eq.admin_code', { value: masterInput.trim() });
      else await sb('POST', 'ief_config', '', { key: 'admin_code', value: masterInput.trim() });
      setMasterCode(masterInput.trim());
      notify('Votre code Super Admin a été mis à jour');
    } catch (e) {
      notify('Erreur : ' + sbErrMsg(e), true);
    }
    setSavingMaster(false);
  }

  async function handleSave(form) {
    try {
      // Résout le vrai ief_id : GRAND DAKAR utilise le UUID réel de la table iefs
      // (pas null) car les RPC exigent ief_id IS NOT NULL pour autoriser l'accès.
      const accountIefId = isGrandDakar ? grandDakarRealId : iefId;
      if (modal && modal !== 'new' && modal.id) {
        await sb('PATCH', 'admins', `id=eq.${modal.id}`, { nom: form.nom, code: form.code, role: form.role });
        notify('Compte modifié');
      } else {
        await sb('POST', 'admins', '', { nom: form.nom, code: form.code, role: form.role || 'ief', actif: true, ief_id: accountIefId || null });
        notify('Compte ajouté');
      }
      setModal(null);
      refresh();
    } catch (e) {
      notify('Erreur : ' + sbErrMsg(e), true);
    }
  }

  async function handleDelete(a) {
    try {
      await sb('DELETE', 'admins', `id=eq.${a.id}`);
      notify('Compte supprimé');
      setToDelete(null);
      refresh();
    } catch (e) {
      notify('Erreur : ' + sbErrMsg(e), true);
    }
  }

  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };

  return (
    <div className="space-y-4">
      <div className="sygenop-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2" style={{ background: 'var(--gold-l)', color: '#92710c' }}>
        <Eye size={14} /> Les comptes créés ci-dessous sont rattachés {iefId ? <>à <b>votre IEF uniquement</b></> : <>au périmètre <b>global</b></>} : « lecture seule » pour consulter, « Administrateur IEF » pour créer/modifier des écoles.
      </div>

      {isGlobalAdmin && (
        <div className="sygenop-card p-5 space-y-2">
          <div className="font-bold text-sm text-ink">Votre code Super Administrateur (racine)</div>
          <p className="text-xs text-muted">
            C'est votre propre code, celui qui donne un accès complet à toutes les IEF. Vous pouvez le changer ici.
          </p>
          <div className="flex gap-2 max-w-md">
            <div className="relative flex-1">
              <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type={showMaster ? 'text' : 'password'}
                value={masterInput}
                onChange={(e) => setMasterInput(e.target.value.toUpperCase())}
                className="w-full pl-9 pr-3 py-2.5 rounded-lg border text-sm font-mono tracking-widest"
                style={fieldStyle}
              />
              <button type="button" onClick={() => setShowMaster((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">
                {showMaster ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <button onClick={() => setMasterInput(generateAccessCode())} className="px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap sygenop-btn sygenop-btn--ghost">Générer</button>
            <button onClick={saveMasterCode} disabled={savingMaster || masterInput === masterCode} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50" style={{ background: 'var(--green-d)' }}>
              <Save size={14} className="inline -mt-0.5 mr-1" /> Enregistrer
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <div className="font-bold text-sm text-ink">Comptes IEF {iefId ? `— ${session.iefName || ''}` : '(périmètre global)'}</div>
          <p className="text-xs text-muted">Chacun se connecte via l'onglet « IEF » ou « Super Admin » de l'écran de connexion, avec son propre code.</p>
        </div>
        {!missingTable && (
          <button onClick={() => setModal('new')} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 whitespace-nowrap" style={{ background: 'var(--green-d)' }}>
            <Plus size={15} /> Ajouter un compte
          </button>
        )}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-10 text-muted">
          <Loader2 className="animate-spin mr-2" size={18} /> Chargement…
        </div>
      )}

      {missingTable && !loading && (
        <div className="sygenop-card p-5 space-y-3">
          <div className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--gold-d, #92710c)' }}>
            <AlertTriangle size={16} /> Fonctionnalité non activée
          </div>
          <p className="text-xs text-muted">
            Pour pouvoir ajouter des comptes IEF (chacun avec son propre code), exécutez une fois ce script dans l'éditeur SQL de Supabase, puis rechargez cette page :
          </p>
          <pre className="text-[11px] p-3 rounded-lg overflow-auto" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>{ADMINS_TABLE_SQL}</pre>
          <button onClick={() => copyToClipboard(ADMINS_TABLE_SQL, notify)} className="px-3 py-2 rounded-lg text-xs font-semibold sygenop-btn sygenop-btn--ghost">
            Copier le script SQL
          </button>
        </div>
      )}

      {error && !loading && (
        <div className="sygenop-card p-6 text-sm" style={{ color: 'var(--red)' }}>Erreur : {error}</div>
      )}

      {!loading && !missingTable && !error && (
        <div className="sygenop-card overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                <th className="text-left px-4 py-3 font-semibold text-muted">Nom</th>
                <th className="text-left px-4 py-3 font-semibold text-muted">Code d'accès</th>
                <th className="text-left px-4 py-3 font-semibold text-muted">Rôle</th>
                <th className="text-right px-4 py-3 font-semibold text-muted">Actions</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td className="px-4 py-3 font-semibold text-ink">{a.nom}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold tracking-widest text-ink">{revealed[a.id] ? a.code : '••••••'}</span>
                      <button onClick={() => setRevealed((r) => ({ ...r, [a.id]: !r[a.id] }))} style={{ color: 'var(--muted)' }}>
                        {revealed[a.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                      <button onClick={() => copyToClipboard(a.code, notify)} style={{ color: 'var(--muted)' }} title="Copier le code">
                        <FileSpreadsheet size={14} />
                      </button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Pill tone="gold">{a.role === 'admin' ? 'Administrateur IEF' : 'IEF — lecture seule'}</Pill>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <button onClick={() => setModal(a)} className="p-2 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }} title="Modifier"><Pencil size={15} /></button>
                      <button onClick={() => setToDelete(a)} className="p-2 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--red)' }} title="Supprimer"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!admins.length && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-muted">Aucun compte pour le moment.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {(modal === 'new' || (modal && modal.id)) && (
        <IEFAccountModal admin={modal === 'new' ? null : modal} onSave={handleSave} onClose={() => setModal(null)} allowRoleAdmin={isGlobalAdmin} />
      )}
      {toDelete && (
        <ConfirmModal
          title="Supprimer ce compte ?"
          message={`« ${toDelete.nom} » ne pourra plus se connecter avec son code. Cette action est irréversible.`}
          danger
          onCancel={() => setToDelete(null)}
          onConfirm={() => handleDelete(toDelete)}
        />
      )}
    </div>
  );
}

/* ============================================================
   GESTION DES IEF — décentralisation (créées par le Super Admin racine)
   ============================================================ */
function IEFModal({ ief, onSave, onClose }) {
  const isEdit = !!ief;
  const [form, setForm] = useState(() => ({
    nom: ief?.nom || '',
    code_lecture: ief?.code_lecture || generateAccessCode(),
    code_admin: ief?.code_admin || generateAccessCode(),
    cycles: ief?.cycles || [],
  }));
  const [showLecture, setShowLecture] = useState(true);
  const [showAdmin, setShowAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  function set(k, v) { setForm((f) => ({ ...f, [k]: v })); }
  async function submit(e) {
    e.preventDefault();
    if (!form.nom.trim()) return;
    setBusy(true);
    await onSave({ ...form, nom: form.nom.trim() });
    setBusy(false);
  }
  const fieldStyle = { borderColor: 'var(--line)', background: 'var(--panel)', color: 'var(--ink)' };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="sygenop-card p-6 max-w-md w-full sygenop-fade max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-ink">{isEdit ? 'Modifier l\'IEF' : 'Nouvelle IEF'}</div>
          <button type="button" onClick={onClose} style={{ color: 'var(--muted)' }}><X size={18} /></button>
        </div>
        <p className="text-xs mb-4 text-muted">
          Une IEF (circonscription) regroupe des écoles. Chaque école créée est rattachée à une IEF.
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Nom de l'IEF *</label>
            <input autoFocus value={form.nom} onChange={(e) => set('nom', e.target.value)} className="w-full px-3 py-2.5 rounded-lg border text-sm" style={fieldStyle} placeholder="Ex : IEF Dakar Centre" />
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Code « IEF (lecture seule) »</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input type={showLecture ? 'text' : 'password'} value={form.code_lecture} onChange={(e) => set('code_lecture', e.target.value.toUpperCase())} className="w-full pl-9 pr-3 py-2.5 rounded-lg border text-sm font-mono tracking-widest" style={fieldStyle} />
                <button type="button" onClick={() => setShowLecture((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">{showLecture ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
              <button type="button" onClick={() => set('code_lecture', generateAccessCode())} className="px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap sygenop-btn sygenop-btn--ghost">Générer</button>
            </div>
            <p className="text-[11px] mt-1 text-muted">Permet de consulter (sans modifier) toutes les écoles de cette IEF via l'onglet « IEF ».</p>
          </div>
          <div>
            <label className="text-xs font-semibold block mb-1 text-muted">Code « Administrateur IEF »</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <KeyRound size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input type={showAdmin ? 'text' : 'password'} value={form.code_admin} onChange={(e) => set('code_admin', e.target.value.toUpperCase())} className="w-full pl-9 pr-3 py-2.5 rounded-lg border text-sm font-mono tracking-widest" style={fieldStyle} />
                <button type="button" onClick={() => setShowAdmin((s) => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted">{showAdmin ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
              <button type="button" onClick={() => set('code_admin', generateAccessCode())} className="px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap sygenop-btn sygenop-btn--ghost">Générer</button>
            </div>
            <p className="text-[11px] mt-1 text-muted">Donne un accès complet (créer/modifier des écoles, comptes) mais limité à cette seule IEF.</p>
          </div>
          <div>
            <label className="text-xs font-semibold text-muted">Cycles couverts</label>
            <p className="text-[11px] text-muted mb-2">Pour chaque cycle coché, une école membre sera automatiquement créée avec un code d'accès généré.</p>
            <div className="flex flex-wrap gap-2">
              {CYCLE_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border cursor-pointer" style={{ borderColor: form.cycles?.includes(opt.value) ? 'var(--green-d)' : 'var(--line)', background: form.cycles?.includes(opt.value) ? 'var(--green-l)' : 'var(--panel)' }}>
                  <input
                    type="checkbox"
                    checked={form.cycles?.includes(opt.value) || false}
                    onChange={(e) => {
                      const current = form.cycles || [];
                      const next = e.target.checked ? [...current, opt.value] : current.filter((c) => c !== opt.value);
                      setForm({ ...form, cycles: next });
                    }}
                    className="rounded"
                  />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button type="button" onClick={onClose} className="px-3.5 py-2 rounded-lg text-sm font-semibold" style={{ background: 'var(--bg)', color: 'var(--ink)' }}>Annuler</button>
          <button type="submit" disabled={busy} className="px-3.5 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-60" style={{ background: 'var(--green-d)' }}>
            {busy ? 'Enregistrement…' : (isEdit ? 'Enregistrer' : 'Créer l\'IEF')}
          </button>
        </div>
      </form>
    </div>
  );
}

// Le script de migration complet est partagé entre les deux onglets
// (« Administrateurs IEF » et « Gestion des IEF ») pour éviter toute
// divergence — voir ADMINS_TABLE_SQL ci-dessus.
const IEFS_TABLE_SQL = ADMINS_TABLE_SQL;

function IEFsAdminTab({ notify, iefId }) {
  const isGlobal = !iefId; // null = mode global (root admin) ; sinon IEF ciblée
  const isSentinel = iefId === GRAND_DAKAR_FAKE_ID;
  const [iefs, setIefs] = useState([]);
  const [schoolCounts, setSchoolCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [missingTable, setMissingTable] = useState(false);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null);
  const [toDelete, setToDelete] = useState(null);
  const [revealed, setRevealed] = useState({});

  async function refresh() {
    setLoading(true);
    setError(null);
    setMissingTable(false);
    try {
      // Le sentinelle GRAND DAKAR est une IEF virtuelle (écoles ief_id null) :
      // on ne peut pas la requêter dans "iefs", on affiche donc juste un état
      // vide sans forcer une ligne en base.
      if (isSentinel) {
        setIefs([{
          id: GRAND_DAKAR_FAKE_ID,
          nom: 'IEF GRAND DAKAR',
          code_lecture: 'IEF-DAKAR',
          code_admin: 'ADMIN-DAKAR',
          actif: true,
          __sentinel: true,
        }]);
        setLoading(false);
        return;
      }
      const params = isGlobal ? 'order=created_at.asc' : `id=eq.${iefId}&order=created_at.asc`;
      const rows = (await sb('GET', 'iefs', params)) || [];
      // En mode global, on ajoute l'IEF GRAND DAKAR virtuelle (écoles ief_id null)
      // afin qu'elle apparaisse dans la liste avec ses accès historiques.
      if (isGlobal) {
        const hasGrandDakar = rows.some((i) => (i.nom || '').toUpperCase().includes('GRAND DAKAR'));
        if (!hasGrandDakar) {
          rows.push({
            id: GRAND_DAKAR_FAKE_ID,
          nom: 'IEF GRAND DAKAR',
            code_lecture: 'IEF-DAKAR',
            code_admin: 'ADMIN-DAKAR',
            actif: true,
            __sentinel: true,
          });
        }
      }
      setIefs(rows);
      try {
        const schools = (await sb('GET', 'schools', 'select=ief_id')) || [];
        const counts = {};
        schools.forEach((s) => { if (s.ief_id) counts[s.ief_id] = (counts[s.ief_id] || 0) + 1; });
        // Pour GRAND DAKAR, on compte les écoles sans ief_id
        if (isGlobal) counts[GRAND_DAKAR_FAKE_ID] = schools.filter((s) => !s.ief_id).length;
        setSchoolCounts(counts);
      } catch (_) {}
    } catch (e) {
      const msg = sbErrMsg(e);
      if (/relation .*iefs.* does not exist|not find the table/i.test(msg)) setMissingTable(true);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { refresh(); }, [iefId]);

  async function handleSave(form) {
    if (modal && modal.id === GRAND_DAKAR_FAKE_ID) {
      notify('IEF historique gérée automatiquement — ses accès ne peuvent pas être modifiés ici.', true);
      setModal(null);
      return;
    }
    try {
      const payload = { ...form };
      let savedIefId = null;
      if (modal && modal !== 'new' && modal.id) {
        savedIefId = modal.id;
        try {
          await sb('PATCH', 'iefs', `id=eq.${modal.id}`, payload);
        } catch (e) {
          if (/cycles|schema cache/gi.test(sbErrMsg(e))) {
            delete payload.cycles;
            await sb('PATCH', 'iefs', `id=eq.${modal.id}`, payload);
          } else throw e;
        }
        notify('IEF modifiée avec succès');
      } else {
        let res;
        try {
          res = await sb('POST', 'iefs', '', { ...payload, actif: true });
        } catch (e) {
          if (/cycles|schema cache/gi.test(sbErrMsg(e))) {
            const { cycles, ...rest } = payload;
            res = await sb('POST', 'iefs', '', { ...rest, actif: true });
          } else throw e;
        }
        savedIefId = res?.data?.[0]?.id || res?.[0]?.id || null;
        notify('IEF créée avec succès — communiquez ses codes à l\u2019équipe concernée');
      }
      const checkedCycles = form.cycles || [];
      if (savedIefId && checkedCycles.length) {
        for (const cycleId of checkedCycles) {
          const cycleOpt = CYCLE_OPTIONS.find((c) => c.value === cycleId);
          const schoolName = `${form.nom} — ${cycleOpt?.label || cycleId}`;
          const schoolCode = generateAccessCode();
          const schoolType = cycleId === 'petite_enfance' || cycleId === 'prescolaire' ? 'maternelle' : cycleId;
          try {
            await sb('POST', 'schools', '', {
              name: schoolName,
              type: schoolType,
              cycle: cycleId,
              cycles: [cycleId],
              code: schoolCode,
              directeur: '',
              actif: true,
              ief_id: savedIefId,
            });
          } catch (_) { /* école non créée — non bloquant */ }
        }
      }
      setModal(null);
      refresh();
    } catch (e) {
      notify('Erreur : ' + sbErrMsg(e), true);
    }
  }
  async function handleToggleActif(ief) {
    try {
      await sb('PATCH', 'iefs', `id=eq.${ief.id}`, { actif: !ief.actif });
      refresh();
    } catch (e) { notify('Erreur : ' + sbErrMsg(e), true); }
  }
  async function handleDelete(ief) {
if (schoolCounts[ief.id]) { notify('Impossible : cette IEF a encore des écoles rattachées', true); return; }
    try {
      await sb('DELETE', 'iefs', `id=eq.${ief.id}`);
      notify('IEF supprimée');
      setToDelete(null);
      refresh();
    } catch (e) { notify('Erreur : ' + sbErrMsg(e), true); }
  }

  if (missingTable) {
    return (
      <div className="sygenop-card p-5 space-y-3">
        <div className="font-bold text-sm flex items-center gap-2 text-ink"><AlertTriangle size={16} /> Migration requise</div>
        <p className="text-xs text-muted">
          La table <code>iefs</code> n'existe pas encore dans votre base Supabase. Pour activer la gestion des Groupes scolaires, exécutez une fois ce script dans l'éditeur SQL de Supabase, puis rechargez cette page :
        </p>
        <pre className="text-[11px] p-3 rounded-lg overflow-auto max-h-72" style={{ background: 'var(--bg)', color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{IEFS_TABLE_SQL}</pre>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => copyToClipboard(IEFS_TABLE_SQL, notify)} className="px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 sygenop-btn sygenop-btn--ghost">
            <FileSpreadsheet size={13} /> Copier le script SQL
          </button>
        </div>
        <p className="text-xs text-muted">
          Le script est également disponible dans le fichier <code>sql/migration_multi_ief.sql</code> fourni avec le projet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
<div className="sygenop-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2" style={{ background: 'var(--gold-l)', color: '#92710c' }}>
        <Building2 size={14} />
        {isGlobal
          ? <>Chaque IEF fonctionne de façon indépendante : ses écoles et ses comptes ne sont visibles que par son propre administrateur, jamais par les autres.</>
          : <>Vous consultez l'IEF <b>{iefs[0]?.nom || ''}</b> — ses codes d'accès sont affichés ci-dessous. La création/suppression n'est possible qu'en mode global.</>}
      </div>
      <div className="flex items-center justify-between">
        <div className="font-bold text-sm text-ink">IEF — chaque école créée est rattachée à une IEF</div>
        {isGlobal && (
          <button onClick={() => setModal('new')} className="px-3.5 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5 justify-center" style={{ background: 'var(--green-d)' }}>
            <Plus size={15} /> Nouvelle IEF
          </button>
        )}
      </div>
      {loading ? (
        <div className="text-sm py-6 text-center text-muted">Chargement…</div>
      ) : error ? (
        <div className="text-sm py-6 text-center" style={{ color: '#c0392b' }}>{error}</div>
      ) : iefs.length === 0 ? (
        <div className="sygenop-card p-6 text-sm text-center text-muted">Aucune IEF pour ce périmètre.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {iefs.map((ief) => (
            <div key={ief.id} className="sygenop-card p-4 space-y-2">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-bold text-sm text-ink">{ief.nom}</div>
                  <div className="text-[11px] text-muted">{schoolCounts[ief.id] || 0} école(s) rattachée(s)</div>
                  {ief.cycles && ief.cycles.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {ief.cycles.map((c) => {
                        const opt = CYCLE_OPTIONS.find((o) => o.value === c);
                        return (
                          <span key={c} className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
                            {opt?.label || c}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
                {isGlobal && !ief.__sentinel && (
                  <button onClick={() => handleToggleActif(ief)} className="text-[11px] font-semibold px-2 py-1 rounded-full" style={ief.actif ? { background: 'var(--green-l)', color: 'var(--green-d)' } : { background: '#fdecea', color: '#8a2f24' }}>
                    {ief.actif ? 'Active' : 'Désactivée'}
                  </button>
                )}
                {isGlobal && ief.__sentinel && (
                  <span className="text-[11px] font-semibold px-2 py-1 rounded-full" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>Active</span>
                )}
              </div>
              <div className="text-[11px] space-y-1 font-mono text-muted">
                <div className="flex items-center justify-between">
                  <span>Code lecture : {revealed[ief.id + '_l'] ? ief.code_lecture : '••••••'}</span>
                  <button onClick={() => setRevealed((r) => ({ ...r, [ief.id + '_l']: !r[ief.id + '_l'] }))} style={{ color: 'var(--green-d)' }}>{revealed[ief.id + '_l'] ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                </div>
                <div className="flex items-center justify-between">
                  <span>Code admin : {revealed[ief.id + '_a'] ? ief.code_admin : '••••••'}</span>
                  <button onClick={() => setRevealed((r) => ({ ...r, [ief.id + '_a']: !r[ief.id + '_a'] }))} style={{ color: 'var(--green-d)' }}>{revealed[ief.id + '_a'] ? <EyeOff size={13} /> : <Eye size={13} />}</button>
                </div>
              </div>
{isGlobal && !ief.__sentinel && (
                <div className="flex gap-2 pt-1">
                  <button onClick={() => setModal(ief)} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }}><Pencil size={12} /> Modifier</button>
                  <button onClick={() => setToDelete(ief)} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg" style={{ background: '#fdecea', color: '#8a2f24' }}><Trash2 size={12} /> Supprimer</button>
                </div>
              )}
              {isGlobal && ief.__sentinel && (
                <div className="flex gap-2 pt-1">
                  <button onClick={() => setModal(ief)} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg" style={{ background: 'var(--bg)', color: 'var(--ink)' }}><Pencil size={12} /> Modifier</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {(modal === 'new' || (modal && modal.id)) && isGlobal && (
        <IEFModal ief={modal === 'new' ? null : modal} onSave={handleSave} onClose={() => setModal(null)} />
      )}
      {toDelete && isGlobal && (
        <ConfirmModal
          title="Supprimer cette IEF ?"
          message={`« ${toDelete.nom} » sera définitivement supprimée. Cette action est impossible si des écoles y sont encore rattachées.`}
          onConfirm={() => handleDelete(toDelete)}
          onCancel={() => setToDelete(null)}
          danger
        />
      )}
    </div>
  );
}

function SuperAdminView({ notify, onOpenSchool, session, migrationStatus }) {
  const isGlobalAdmin = !(session && session.iefId); // Super Admin racine (voit/gère toutes les IEF)
  const [tab, setTab] = useState('ecoles');
  const [adminIefId, setAdminIefId] = useState(session && session.iefId ? session.iefId : null);
const [iefList, setIefList] = useState([]);
  const [loadingIefs, setLoadingIefs] = useState(false);

  // IEF GRAND DAKAR — l'IEF historique du système (avant décentralisation).
  // Les écoles sans ief_id (ief_id null) y appartiennent.
  const grandDakarEntry = { id: GRAND_DAKAR_FAKE_ID, nom: 'IEF GRAND DAKAR', actif: true };

  // Chargement de la liste des IEF pour le sélecteur (root admin uniquement)
  useEffect(() => {
    if (!isGlobalAdmin) return;
    let cancelled = false;
    setLoadingIefs(true);
    (async () => {
      try {
        const rows = (await sb('POST', 'rpc/list_active_iefs', '', {})) || [];
        if (!cancelled) setIefList(rows);
      } catch (_) { /* table iefs pas encore créée */ }
      finally { if (!cancelled) setLoadingIefs(false); }
    })();
    return () => { cancelled = true; };
  }, [isGlobalAdmin]);

  // Fusionne la liste réelle avec l'IEF GRAND DAKAR (toujours en premier)
  const mergedIefList = useMemo(() => {
    const real = iefList || [];
    if (real.some((i) => (i.nom || '').toUpperCase().includes('GRAND DAKAR'))) return real;
    return [grandDakarEntry, ...real];
  }, [iefList]);

  // Si aucun id n'est sélectionné et que GRAND DAKAR existe, on le choisit par défaut
  useEffect(() => {
    if (isGlobalAdmin && !adminIefId && mergedIefList.length) {
      setAdminIefId(mergedIefList[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGlobalAdmin, mergedIefList.length]);

  const selectedIefName = isGlobalAdmin
    ? (mergedIefList.find((i) => i.id === adminIefId)?.nom || 'Tous les groupes scolaires')
    : (session.iefName || 'Votre IEF');

  const tabs = [
    { id: 'ecoles', label: 'Écoles', icon: Building2 },
    { id: 'admins', label: 'Comptes IEF', icon: UserCog },
    { id: 'iefs', label: 'Gestion des IEF', icon: Database },
  ];

  const activeIefId = isGlobalAdmin ? adminIefId : (session && session.iefId);

  return (
    <div className="space-y-4 sygenop-fade">
      {/* Avertissement migrations manquantes */}
      {migrationStatus.checked && !migrationStatus.ok && (
        <div className="sygenop-card px-4 py-3 text-xs font-semibold flex items-start gap-2" style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #f59e0b' }}>
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-bold mb-1">Migrations SQL requises</div>
            <div className="font-normal">
              Certaines migrations de sécurité ne sont pas appliquées sur la base Supabase.
              Les fonctionnalités affectées peuvent ne pas fonctionner correctement.
            </div>
            <div className="font-normal mt-1 opacity-75">Fichiers manquants : {migrationStatus.missing.join(', ')}</div>
          </div>
        </div>
      )}
      {/* Bandeau administrateur */}
      <div className="sygenop-card px-4 py-2.5 text-xs font-semibold flex items-center gap-2" style={{ background: 'var(--green-l)', color: 'var(--green-d)' }}>
        <Building2 size={14} />
        {isGlobalAdmin ? (
          <span className="flex items-center gap-2 flex-wrap">
            Super Admin — IEF administrée :
            <select
              value={adminIefId || ''}
              onChange={(e) => setAdminIefId(e.target.value || null)}
              className="px-2 py-1 rounded-lg border text-xs font-semibold"
              style={{ borderColor: 'var(--green-d)', background: 'var(--panel)', color: 'var(--green-d)', maxWidth: 220 }}
            >
              <option value="">— Toutes les IEF (mode global) —</option>
              {mergedIefList.map((i) => <option key={i.id} value={i.id}>{i.nom}</option>)}
            </select>
            {loadingIefs && <Loader2 size={12} className="animate-spin" />}
          </span>
        ) : (
          <>Vous administrez l'IEF <b>{session.iefName || ''}</b> : les écoles et comptes créés ici seront automatiquement rattachés à cette IEF, sans impact sur les autres.</>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 p-1 rounded-xl w-fit" style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors"
            style={tab === t.id ? { background: 'var(--green-d)', color: '#fff' } : { color: 'var(--muted)' }}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'ecoles' && <EcolesAdminTab notify={notify} onOpenSchool={onOpenSchool} session={session} iefIdOverride={activeIefId} iefList={mergedIefList} />}
      {tab === 'admins' && <IEFAccountsTab notify={notify} session={session} iefIdOverride={activeIefId} iefList={mergedIefList} />}
      {tab === 'iefs' && <IEFsAdminTab notify={notify} iefId={activeIefId} />}
    </div>
  );
}

/* ============================================================
   APP RACINE
   ============================================================ */
export default function SygenopApp({ onBack, connectHome }) {
  const [dark, setDark] = useState(loadJSON(LS_THEME, false));
  const [session, setSession] = useState(null); // {role, schoolId?, staffId?}
  const [activeSchoolId, setActiveSchoolId] = useState(loadJSON(LS_SCHOOL_ID, null));
  const [activeSchoolName, setActiveSchoolName] = useState(loadJSON(LS_SCHOOL_NAME, ''));
  const [schoolState, setSchoolState] = useState(null);
  const [loadingState, setLoadingState] = useState(false);
  const [schoolLoadError, setSchoolLoadError] = useState('');
  const [loadNonce, setLoadNonce] = useState(0);
  const [active, setActive] = useState('dash');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [toast, setToast] = useState(null);

  const notify = useCallback((msg, err) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), 3500);
  }, []);

// Rétablit la session sauvegardée au rechargement (mode hors-ligne).
  useEffect(() => {
    const saved = loadSessionJSON(LS_SESSION, null);
    if (saved && saved.role) {
      // Session expirée : on la purge et on force une nouvelle connexion.
      if (isSessionExpired(saved)) {
        clearSessionJSON(LS_SESSION);
        // Conserve le code école dans LS_SCHOOL_CODE : il servira de repli
        // pour loadSchoolData au prochain rechargement tant que l'utilisateur
        // n'a pas explicitement changé de compte. Le code école n'est pas un
        // jeton d'session — il estBindable à une seule école et ne permet pas
        // d'accéder à d'autres écoles.
        clearJSON(LS_SCHOOL_ID);
        clearJSON(LS_SCHOOL_NAME);
        return;
      }
setSession(saved);
      if (saved.expiresAt) setAbsTarget(new Date(saved.expiresAt).getTime());
      const last = loadJSON(LS_ACTIVE, null);
      const restored = last && allowedPagesFor(saved).has(last) ? last : homePageFor(saved.role);
      if (['school', 'teacher', 'guard', 'accountant', 'secretary', 'ief'].includes(saved.role)) {
        if (saved.role !== 'ief' && saved.schoolId) {
          setActiveSchoolId(saved.schoolId);
          const name = loadJSON(LS_SCHOOL_NAME, '') ||
            (loadJSON(LS_SCHOOLS, []).find((s) => s.id === saved.schoolId) || {}).name ||
            '';
          if (name) setActiveSchoolName(name);
        }
        setActive(restored);
      } else {
        setActive(restored);
      }
      // Restaure le code école depuis localStorage même sans session valide :
      // indispensable pour que loadSchoolData puisse interroger le serveur
      // après un rechargement de page ou une fermeture/ouverture de navigateur
      // (sessionStorage vidé mais localStorage persiste).
      if (!saved || !saved.role) {
        const persistedId = loadJSON(LS_SCHOOL_ID, null);
        if (persistedId && !getActiveSchoolCode()) {
          // Le code peut être dans LS_SCHOOL_CODE (directeur) ou LS_SCHOOLS (admin).
          const fallbackCode =
            (loadJSON(LS_SCHOOL_CODE, '') || '').trim() ||
            cachedSchoolCode(persistedId);
          if (fallbackCode) setActiveSchoolCode(fallbackCode);
        }
      }
    } else {
      setActive(homePageFor(''));
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    if (['school', 'teacher', 'guard', 'accountant', 'secretary', 'ief'].includes(session.role)) {
      setActiveSchoolId(session.schoolId);
    }
  }, [session]);

  // Mémorise la rubrique active pour la restaurer après une actualisation.
  useEffect(() => { saveJSON(LS_ACTIVE, active); }, [active]);

  // Vérification des migrations SQL critiques au démarrage.
  // Essaie d'appeler des RPC qui n'existent que si les migrations sont
  // appliquées. Si elles sont absentes, un avertissement s'affiche.
  const [migrationStatus, setMigrationStatus] = useState({ checked: false, ok: true, missing: [] });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const missing = [];
      // Vérifie check_school_code (migration_securite_rpc.sql)
      try {
        await sb('POST', 'rpc/check_school_code', '', { p_school_id: '00000000-0000-0000-0000-000000000000', p_code: 'test' });
      } catch (e) {
        if (/function|rpc|not found|does not exist/i.test(sbErrMsg(e))) missing.push('migration_securite_rpc');
      }
      // Vérifie search_public_schools (migration_login_search.sql)
      try {
        await sb('POST', 'rpc/search_public_schools', '', { p_query: 'te' });
      } catch (e) {
        if (/function|rpc|not found|does not exist/i.test(sbErrMsg(e))) missing.push('migration_login_search');
      }
      // Vérifie get_school_data (migration_securite_data.sql)
      try {
        await sb('POST', 'rpc/get_school_data', '', { p_school_id: '00000000-0000-0000-0000-000000000000', p_code: 'test' });
      } catch (e) {
        if (/function|rpc|not found|does not exist/i.test(sbErrMsg(e))) missing.push('migration_securite_data');
      }
      // Vérifie la table iefs (migration_multi_ief.sql)
      try {
        await sb('GET', 'iefs', 'select=id&limit=1');
      } catch (e) {
        if (/relation .*iefs.* does not exist|not find the table/i.test(sbErrMsg(e))) missing.push('migration_multi_ief');
      }
      // Vérifie la colonne cycles sur schools (migration_school_cycles.sql)
      try {
        await sb('GET', 'schools', 'select=cycles&limit=1');
      } catch (e) {
        if (/cycles|does not exist|could not find|schema cache/i.test(sbErrMsg(e))) missing.push('migration_school_cycles');
      }
      // Vérifie check_groupe_code (migration_groupes_scolaires.sql) : le login
      // « Groupe scolaire » s'appuie sur cette RPC — s'il manque, abandonner.
      try {
        await sb('POST', 'rpc/check_groupe_code', '', { p_code: '--- migration probe ---' });
      } catch (e) {
        if (/function|rpc|not found|does not exist/i.test(sbErrMsg(e))) missing.push('migration_groupe_login');
      }
      if (!cancelled) setMigrationStatus({ checked: true, ok: missing.length === 0, missing });
    })();
    return () => { cancelled = true; };
  }, []);

  const [syncStatus, setSyncStatus] = useState({ online: true, pendingCount: 0, syncing: false });

  // Initialise la détection de connectivité + la synchro en arrière-plan
  // (une seule fois pour toute la session).
  useEffect(() => {
    initOfflineSync({
      pingUrl: `${SB_URL}/rest/v1/`,
      pingHeaders: { apikey: SB_KEY },
      saveSchoolData,
    });
    const unsub = subscribeSyncStatus(setSyncStatus);
    // Une écriture en attente rejetée définitivement (401/403 — mauvais code
    // ou école hors périmètre) est abandonnée côté syncManager plutôt que
    // retentée à l'infini : on prévient ici pour ne jamais perdre une saisie
    // en silence (l'utilisateur sait qu'il doit refaire l'action après
    // reconnexion).
    const onRejected = (e) => {
      const message = e?.detail?.message || '';
      const rejectedSchoolId = e?.detail?.schoolId;
      if (/conflit de version/i.test(message)) {
        // Quelqu'un d'autre a sauvegardé cette école entretemps : la
        // modification en attente est abandonnée (elle reposait sur des
        // données déjà périmées) et on recharge une version fraîche depuis
        // le serveur — jamais d'écrasement silencieux.
        notify("Ces données ont été modifiées entretemps par quelqu'un d'autre. Rechargement des données à jour — merci de refaire votre dernière action.", true);
        if (rejectedSchoolId && rejectedSchoolId === activeSchoolId) setLoadNonce((n) => n + 1);
        return;
      }
      notify("Une modification n'a pas pu être synchronisée (accès refusé ou code d'accès introuvable). Elle est conservée sur cet appareil et dans la file d'attente : reconnectez-vous avec le bon compte puis appuyez sur « Réessayer » (ou effectuez une nouvelle modification) pour tout renvoyer au serveur.", true);
    };
    window.addEventListener('offline-sync-rejected', onRejected);
    return () => { unsub(); window.removeEventListener('offline-sync-rejected', onRejected); };
  }, [notify, activeSchoolId]);

  // CORRECTIF : quand une save échoue précisément parce qu'aucun code d'accès
  // n'est disponible (élément resté bloqué dans la file, souvent issu d'une
  // ancienne session), on prévient l'utilisateur immédiatement au lieu de
  // re-tenter silencieusement 20 fois : il sait qu'il doit se reconnecter pour
  // débloquer la synchronisation. Une seule alerte par « épisode » (on évite de
  // spammer à chaque cycle de 15 s).
  const lastCodeErrorNotified = useRef('');
  useEffect(() => {
    const err = syncStatus.lastError || '';
    const codeAbsent = /Code d’accès absent|Code d'accès absent|accès introuvable/i.test(err);
    if (codeAbsent && err !== lastCodeErrorNotified.current) {
      lastCodeErrorNotified.current = err;
      notify("Synchronisation en attente : le code d'accès de l'école est introuvable sur cet appareil. Reconnectez-vous avec le bon compte (école ou personnel) pour envoyer les saisies enregistrées.", true);
    }
  }, [syncStatus, notify]);

  // CORRECTIF : dès qu'une synchronisation en arrière-plan a réussi et vidé la
  // file d'attente (pendingCount → 0), on recharge la vue de l'école active.
  // Sans cela, même après une synchro réussie, l'écran restait figé sur
  // l'ancienne version serveur (les saisies semblaient « disparues »).
  const prevPendingRef = useRef(syncStatus.pendingCount);
  useEffect(() => {
    const prev = prevPendingRef.current;
    prevPendingRef.current = syncStatus.pendingCount;
    if (syncStatus.syncing) return;
    const drained = prev > 0 && syncStatus.pendingCount === 0 && prevPendingRef.current === 0;
    if (drained && activeSchoolId) {
      // On ne recharge que si l'école active n'est pas « bloquée » : une école
      // bloquée a des saisies locales restées non synchronisées (rejet serveur)
      // — un rechargement depuis le serveur (ancienne version) les écraserait.
      blockedSchools().then((blocked) => {
        if (!blocked || !blocked.has(activeSchoolId)) {
          setLoadNonce((n) => n + 1);
        }
      }).catch(() => setLoadNonce((n) => n + 1));
    }
  }, [syncStatus, activeSchoolId]);

  const transferSnapshotRef = useRef(null);

  useEffect(() => {
    if (!session || session.role !== 'school' || !activeSchoolId) {
      transferSnapshotRef.current = null;
      return undefined;
    }
    let cancelled = false;
    const loadPending = async () => {
      // Chemin léger : RPC list_pending_transfers (vérifie le code école et
      // renvoie uniquement les demandes en attente — quelques kilo-octets au
      // lieu du payload scolaire complet). Repli sur le chargement complet
      // si la RPC n'est pas encore disponible (migration non appliquée).
      try {
        const sessionNow = loadSessionJSON(LS_SESSION, null);
        const code = (sessionNow && sessionNow.schoolCode) || getActiveSchoolCode();
        if (code) {
          const res = await sb('POST', 'rpc/list_pending_transfers', '', { p_school_id: activeSchoolId, p_code: code });
          if (res && res.ok === true && Array.isArray(res.pending)) {
            return { pending: res.pending, latest: null };
          }
        }
      } catch (_) { /* chute vers le chargement complet */ }
      const latest = await loadSchoolData(activeSchoolId);
      return { pending: (latest && latest.studentTransferRequests || []).filter((request) => request.status === 'pending'), latest };
    };
    const checkForNewTransfers = async () => {
      if (!pageIsVisible()) return;
      try {
        const { pending, latest } = await loadPending();
        if (cancelled) return;
        const knownIds = transferSnapshotRef.current;
        if (knownIds && pending.length) {
          const added = pending.filter((request) => !knownIds.has(request.id));
          if (added.length) {
            const first = added[0];
            notify(`Nouvelle demande de transfert : ${first.studentName || 'un élève'} vers ${first.toClassName || 'une classe'}.`);
            if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
              new Notification('Nouvelle demande de transfert', { body: `${first.studentName || 'Un élève'} — ${first.fromClassName || ''} → ${first.toClassName || ''}` });
            }
            if (latest) setSchoolState((previous) => previous ? { ...previous, studentTransferRequests: latest.studentTransferRequests || [] } : latest);
          }
        }
        transferSnapshotRef.current = new Set(pending.map((request) => request.id));
      } catch (_) {
        // Le chargement principal et le cache local restent prioritaires.
      }
    };
    const firstCheck = window.setTimeout(checkForNewTransfers, 10000);
    const timer = window.setInterval(checkForNewTransfers, 120000); // 2 min (était 30 s)
    return () => { cancelled = true; window.clearTimeout(firstCheck); window.clearInterval(timer); };
  }, [session?.role, activeSchoolId, notify]);

  useEffect(() => {
    if (!activeSchoolId) { setSchoolState(null); setSchoolLoadError(''); return; }
    let cancelled = false;
    setLoadingState(true);
    setSchoolLoadError('');
    // 1) Affichage instantané depuis le cache local, s'il existe (fonctionne
    //    hors ligne, y compris après un redémarrage de l'appareil).
    getInstantCache(activeSchoolId).then((cached) => {
      if (cached && !cancelled) { setSchoolState(cached); setLoadingState(false); }
    });
    // 2) Rafraîchissement réseau en arrière-plan (si disponible). Si on est
    //    hors ligne et qu'on avait un cache, on continue avec le cache sans
    //    afficher d'erreur. Si aucun cache n'existe et pas de réseau, on
    //    affiche alors l'erreur.
    //    CORRECTIF : on capture le cache local AVANT d'interroger le serveur
    //    (loadSchoolData écrit la version serveur dans le cache, donc il faut
    //    mémoriser la version locale au préalable pour la comparaison).
    getInstantCache(activeSchoolId)
      .then(async (localCache) => {
        const st = await loadSchoolData(activeSchoolId);
        if (cancelled) return;
        // Ne jamais écraser une saisie locale plus récente ou encore en attente
        // de synchronisation (ex. saisie hors-ligne puis retour) par l'ancienne
        // version renvoyée par le serveur. Deux signaux indiquent que le local
        // est à conserver :
        //   - le cache local est « plus récent » (__version supérieure) ;
        //   - ou il existe des éléments NON synchronisés dans la file pour
        //     cette école (saisies en attente → la version serveur est périmée).
        // Dans ces cas on garde la version locale (et on re-signe le cache) au
        // lieu de l'écraser — évite la « disparition » des données saisies.
        const localVersion = (localCache && localCache.__version) || 0;
        const serverVersion = (st && st.__version) || 0;
        const [pending, blocked] = await Promise.all([
          pendingSchools().catch(() => new Set()),
          blockedSchools().catch(() => new Set()),
        ]);
        const keepLocal = pending.has(activeSchoolId) || blocked.has(activeSchoolId);
        if (localCache && (localVersion > serverVersion || keepLocal)) {
          setSchoolState(localCache);
          setSchoolLoadError('');
          // Re-prime le cache avec la version locale pour la garantir face à
          // la version serveur plus ancienne déjà écrite par loadSchoolData.
          await primeCacheFromServer(activeSchoolId, localCache).catch(() => {});
        } else {
          setSchoolState(st);
          setSchoolLoadError('');
        }
      })
      .catch((e) => {
        if (cancelled) return;
        const message = sbErrMsg(e);
        getInstantCache(activeSchoolId).then((cached) => {
          if (cached) { setSchoolState(cached); notify('Hors ligne : affichage des dernières données enregistrées sur cet appareil.'); }
          else { setSchoolLoadError(message); notify('Erreur de chargement : ' + message, true); }
        });
      })
      .finally(() => { if (!cancelled) setLoadingState(false); });
    return () => { cancelled = true; };
  }, [activeSchoolId, loadNonce]);

  // TEMPS RÉEL pour les rôles de lecture/administration (IEF, Super Admin) :
  // rechargement périodique de l'école ouverte pour que les saisies faites par
  // les écoles apparaissent sans recharger la page ni rouvrir l'école. Utilise
  // la même protection « keepLocal » que le chargement principal : une saisie
  // locale en attente ou une version locale plus récente ne sont jamais
  // écrasées par l'ancienne version serveur.
  useEffect(() => {
    const readerRole = session && (session.role === 'ief' || session.role === 'admin');
    if (!readerRole || !activeSchoolId) return undefined;
    let cancelled = false;
    const refresh = async () => {
      if (!pageIsVisible()) return;
      try {
        const [localCache, st] = await Promise.all([
          getInstantCache(activeSchoolId),
          loadSchoolData(activeSchoolId),
        ]);
        if (cancelled) return;
        const localVersion = (localCache && localCache.__version) || 0;
        const serverVersion = (st && st.__version) || 0;
        const [pending, blocked] = await Promise.all([
          pendingSchools().catch(() => new Set()),
          blockedSchools().catch(() => new Set()),
        ]);
        const keepLocal = pending.has(activeSchoolId) || blocked.has(activeSchoolId);
        if (st && (keepLocal || localVersion > serverVersion)) {
          if (localCache) await primeCacheFromServer(activeSchoolId, localCache).catch(() => {});
        } else if (st) {
          setSchoolState(st);
        }
      } catch (_) {
        // Le chargement principal et le cache local restent prioritaires :
        // une panne réseau ne doit pas faire disparaître l'affichage.
      }
    };
    const timer = window.setInterval(refresh, 120000); // 2 min (était 30 s : payload complet à chaque fois)
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [session?.role, activeSchoolId]);

  // Mutateur générique : applique la fonction sur l'état local (optimiste,
  // toujours écrit dans IndexedDB immédiatement), puis synchronise avec
  // Supabase dès que possible — immédiatement si en ligne, automatiquement
  // dès le retour du réseau sinon. Aucune saisie n'est jamais perdue.
  const pendingSaveRef = useRef(null);
  const updateState = useCallback((mutator) => {
    if (!activeSchoolId) return;
    setSchoolState((prev) => {
      if (!prev) return prev;
      const draft = mutator(prev);
      pendingSaveRef.current = { schoolId: activeSchoolId, draft };
      return draft;
    });
  }, [activeSchoolId]);

  // Effect qui déclenche la sauvegarde hors de l'updater pour éviter
  // les cascades de re-renders (queueSave appelait setSyncStatus → re-render).
  useEffect(() => {
    if (!pendingSaveRef.current) return;
    const { schoolId, draft } = pendingSaveRef.current;
    pendingSaveRef.current = null;
    queueSave(schoolId, draft, {
      saveSchoolData, loadSchoolData, notify, access: buildAccessSnapshot(),
      onSaved: (version) => setSchoolState((cur) => (cur ? { ...cur, __version: version } : cur)),
    });
  });

function handleLogin(sessionData) {
    // Ajoute une date d'expiration absolue (durée de session limitée) pour
    // forcer une reconnexion régulière et limiter l'accès sur appareil partagé.
    const withExpiry = { ...sessionData, expiresAt: new Date(Date.now() + SESSION_ABS_TIMEOUT_MS).toISOString() };
    setSession(withExpiry);
    saveSessionJSON(LS_SESSION, withExpiry);
    setAbsTarget(Date.now() + SESSION_ABS_TIMEOUT_MS);
    // Nouvelle connexion : on repart de la page d'accueil du rôle.
    setActive(homePageFor(sessionData.role));
    // Reconnexion a priori = credentials possibles valides : on relance
    // immédiatement les saisies en attente (y compris celles SUSPENDUES faute
    // de code d'accès valable — auparavant définitivement perdues pour le
    // serveur). Aucune saisie n'est perdue.
    retrySync().catch(() => {});
    if (['school', 'teacher', 'guard', 'accountant', 'secretary', 'ief'].includes(sessionData.role)) {
      saveJSON(LS_SCHOOL_ID, sessionData.schoolId);
      // Persiste le code d'accès de l'école : indispensable pour que admin-write
      // puisse vérifier l'identité du directeur côté serveur (Mode 2). Sans ça,
      // toute écriture (y compris l'entrée d'audit "Connexion") est rejetée en 401.
      // NB : le compte « IEF » (role ief) reste LECTURE SEULE : on ne
      // persiste jamais son code (session.iefCode) ici, uniquement l'école ouverte.
      if (sessionData.role === 'school' && sessionData.schoolCode) {
        setActiveSchoolCode(sessionData.schoolCode);
      }
      // Affiche le nom de l'école dès la connexion (même hors-ligne, depuis le cache).
      const cachedSchools = loadJSON(LS_SCHOOLS, []);
      const school = cachedSchools.find((s) => s.id === sessionData.schoolId);
      if (school) {
        setActiveSchoolName(school.name);
        saveJSON(LS_SCHOOL_NAME, school.name);
      } else if (sessionData.iefName) {
        // Login « IEF » : le nom du groupe scolaire est renvoyé par la RPC.
        setActiveSchoolName(sessionData.iefName);
        saveJSON(LS_SCHOOL_NAME, sessionData.iefName);
      }
    } else {
      clearJSON(LS_SCHOOL_ID);
      clearJSON(LS_SCHOOL_NAME);
      setActiveSchoolCode(null); // évite qu'un code d'école périmé traîne pour un autre rôle
      setActiveSchoolName('');
    }
    notify('Connecté avec succès');
  }
function handleLogout() {
    // Enregistre la déconnexion dans le journal d'audit de l'école ouverte,
    // si une école est active et ses données chargées.
    if (activeSchoolId && schoolState && session && session.role !== 'ief') {
      updateState((prev) => ({
        ...prev,
        auditLog: pushAuditEntry(prev.auditLog, {
          actor: actorLabel(session, prev),
          role: session.role,
          action: 'Déconnexion',
          details: `Session fermée (${new Date().toLocaleString('fr-FR')})`,
        }),
      }));
    }
    setSession(null);
    setActiveSchoolId(null);
    setActiveSchoolName('');
    setSchoolState(null);
    setAbsTarget(null);
    setIdleTarget(null);
    setActive('dash');
    clearSessionJSON(LS_SESSION);
    clearJSON(LS_SCHOOL_ID);
    clearJSON(LS_SCHOOL_NAME);
    setActiveSchoolCode(null);
  }

  // Déconnexion automatique après inactivité (idle timeout) et expiration
  // absolue de la session.
  //  - `idleTarget` : échéance absolue d'inactivité (rajeunie à chaque action).
  //  - `absTarget`  : échéance absolue de la session (fixée à la connexion).
  //  - `now`        : bat chaque seconde pour déclencher la vérification et
  //    fournir le temps restant affiché dans la barre supérieure.
  const [idleTarget, setIdleTarget] = useState(null);
  const [absTarget, setAbsTarget] = useState(null);
  const [now, setNow] = useState(Date.now());

  // Réinitialise l'échéance d'inactivité à chaque interaction utilisateur.
  const resetIdle = useCallback(() => {
    if (session) setIdleTarget(Date.now() + SESSION_IDLE_TIMEOUT_MS);
  }, [session]);

  useEffect(() => {
    if (!session) { setIdleTarget(null); setAbsTarget(null); return; }
    resetIdle();
    const ev = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    ev.forEach((e) => window.addEventListener(e, resetIdle, { passive: true }));
    return () => { ev.forEach((e) => window.removeEventListener(e, resetIdle)); };
  }, [session, resetIdle]);

  // Batteur : met à jour `now` chaque seconde et déclenche la déconnexion.
  useEffect(() => {
    if (!session) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [session]);

// Déconnexion quand l'une des deux échéances est atteinte.
  useEffect(() => {
    if (!session) return;
    const idleExpired = idleTarget != null && now >= idleTarget;
    const absExpired = absTarget != null && now >= absTarget;
    if (idleExpired || absExpired) {
      handleLogout();
      notify('Session expirée. Veuillez vous reconnecter.', true);
    }
  }, [now, idleTarget, absTarget]);

  // Journalise la connexion réussie dans l'audit de l'école, une seule fois par
  // session (dès que l'école est chargée). `loginAuditedRef` évite de rejournaliser
  // à chaque rechargement de la page pendant la même session.
  const loginAuditedRef = useRef(false);
  useEffect(() => {
    if (!session || session.role === 'ief' || !activeSchoolId || !schoolState || loginAuditedRef.current) return;
    loginAuditedRef.current = true;
    updateState((prev) => ({
      ...prev,
      auditLog: pushAuditEntry(prev.auditLog, {
        actor: actorLabel(session, prev),
        role: session.role,
        action: 'Connexion',
        details: `Ouverture de session (${new Date().toLocaleString('fr-FR')})`,
      }),
    }));
  }, [session, activeSchoolId, schoolState]);
function openSchool(id, name, actif) {
    if (actif === false) {
      notify('Cette école est désactivée. Elle est inaccessible à tous (directeur, enseignants, lecteur de l\'IEF).', true);
      return;
    }
    setActiveSchoolId(id);
    setActiveSchoolName(name);
    setActive('dash');
    saveJSON(LS_SCHOOL_ID, id);
    saveJSON(LS_SCHOOL_NAME, name);
  }

  // Sauvegarde le thème choisi (clair/sombre).
  useEffect(() => { saveJSON(LS_THEME, dark); }, [dark]);

  if (!session) {
    return (
      <>
        <LoginScreen onLogin={handleLogin} dark={dark} setDark={setDark} notify={notify} onBack={connectHome ? onBack : null} />
        <ChesterWidget dark={dark} />
      </>
    );
  }

  const [title, sub] = PAGE_TITLES[active] || ['EduLink Pro', 'La plateforme intelligente de gestion scolaire'];

  // Contrôle d'accès par rôle :
  // - school (Directeur) : lecture/écriture sur SA seule école (déjà garanti par activeSchoolId)
  // - teacher (Enseignant) : lecture/écriture limitée à SA seule classe
  // - ief (Administrateur IEF) : lecture seule sur toutes les écoles, aucune modification
  // - admin (Super Admin) : lecture/écriture sur toutes les écoles
  const readOnly = session.role === 'ief';
  const teacherName = session.role === 'teacher' ? teacherNameFromSession(schoolState, session) : null;
  const isAccountant = session.role === 'accountant';
  const isSecretary = session.role === 'secretary';
  const currentStaff = (schoolState?.personnel || []).find((person) => person.id === session.staffId);
  const authorName = session.role === 'school'
    ? ((schoolState && schoolState.header && schoolState.header.directeur) || 'La direction')
    : session.role === 'admin' ? 'Super Administrateur'
    : session.role === 'ief' ? (session.iefName || 'IEF')
    : personFullName(currentStaff) || teacherName || '';

  let body;
  if (active === 'ief') {
    body = <IEFSchoolsView onOpenSchool={openSchool} session={session} />;
  } else if (active === 'superadmin') {
    body = <SuperAdminView notify={notify} onOpenSchool={openSchool} session={session} migrationStatus={migrationStatus} />;
  } else if (active === 'dash') {
    body = (
      <DashboardView
        state={schoolState}
        loading={loadingState}
        teacherName={teacherName}
        teacherStaffId={session.staffId}
        role={session.role}
        updateState={updateState}
        notify={notify}
        setActive={setActive}
        authorName={authorName}
      />
    );
  } else if (active === 'gate') {
    body = <StudentCardVerification state={schoolState} updateState={updateState} notify={notify} />;
  } else if (active === 'actualites') {
    body = (
      <ActualitesView
        state={schoolState}
        loading={loadingState}
        updateState={updateState}
        notify={notify}
        readOnly={!(session.role === 'school' || session.role === 'admin' || session.role === 'secretary')}
        authorName={authorName}
      />
    );
  } else if (active === 'personnel') {
    body = <PersonnelView state={schoolState} loading={loadingState} updateState={updateState} notify={notify} session={session} readOnly={readOnly} />;
  } else if (active === 'mesdemandes') {
    body = <StaffMyRequestsView state={schoolState} loading={loadingState} updateState={updateState} notify={notify} session={session} readOnly={readOnly} />;
  } else if (active === 'classes' || active === 'saisie') {
    body = <SaisieView state={schoolState} loading={loadingState} updateState={updateState} notify={notify} teacherName={teacherName} teacherStaffId={session.staffId} readOnly={readOnly} />;
  } else if (active === 'synth') {
    body = <SynthView state={schoolState} loading={loadingState} teacherName={teacherName} />;
  } else if (active === 'bull') {
    body = <BulletinView state={schoolState} loading={loadingState} teacherName={teacherName} />;
  } else if (active === 'paiements') {
    body = (
      <PaiementsView
        state={schoolState}
        loading={loadingState}
        updateState={updateState}
        notify={notify}
        activeSchoolId={activeSchoolId}
        activeSchoolName={activeSchoolName}
        role={session.role}
        readOnly={readOnly}
        session={session}
      />
    );
  } else if (active === 'admin') {
    body = <AdminView state={schoolState} loading={loadingState} updateState={updateState} notify={notify} readOnly={readOnly} session={session} />;
  } else if (active === 'data') {
    body = (
      <DataView
        state={schoolState}
        loading={loadingState}
        updateState={updateState}
        notify={notify}
        readOnly={readOnly}
        session={session}
        activeSchoolName={activeSchoolName}
      />
    );
    } else {
    body = <ComingSoonView view={active} />;
  }
  if (['school', 'teacher', 'guard', 'accountant', 'secretary'].includes(session.role) && !schoolState && !loadingState) {
    body = (
      <div className="sygenop-card p-8 max-w-xl mx-auto mt-10 text-center text-ink">
        <AlertCircle size={34} className="mx-auto mb-3" style={{ color: 'var(--red)' }} />
        <h2 className="font-bold mb-2">Les données de l’école ne sont pas disponibles</h2>
        <p className="text-sm mb-4 text-muted">{schoolLoadError || 'La réponse du serveur est vide ou la session ne permet pas d’accéder à cette école.'}</p>
        <button type="button" onClick={() => setLoadNonce((n) => n + 1)} className="px-4 py-2 rounded-lg text-sm font-semibold text-white" style={{ background: 'var(--green-d)' }}>Réessayer le chargement</button>
      </div>
    );
  }
  return (
    <div className={dark ? 'dark' : ''}>
      <GlobalStyles dark={dark} />
      <div className="sygenop-root flex">
        <Sidebar
          session={session}
          active={active}
          setActive={setActive}
          mobileOpen={mobileOpen}
          setMobileOpen={setMobileOpen}
          hasActiveSchool={!!activeSchoolId}
        />
        <div className="flex-1 min-w-0 flex flex-col">
          <Topbar
            title={activeSchoolName && active !== 'ief' ? `${title} — ${activeSchoolName}` : title}
            sub={sub}
            session={session}
            schoolName={activeSchoolName}
            dark={dark}
            setDark={setDark}
            onLogout={handleLogout}
            setMobileOpen={setMobileOpen}
            annee={(schoolState && schoolState.header && schoolState.header.annee) || ''}
            periodeKey={(schoolState && schoolState.header && schoolState.header.periodeActif) || 'T1'}
            periodeLabel={(() => {
              const opts = schoolState ? periodsForSchool(schoolState) : [];
              const k = (schoolState && schoolState.header && schoolState.header.periodeActif) || 'T1';
              const found = opts.find((p) => p.key === k);
              return found ? found.label : k;
            })()}
            periodeOptions={schoolState ? periodsForSchool(schoolState) : []}
            canEditPeriode={session.role === 'school'}
            onPeriodeChange={(k) => updateState((prev) => ({ ...prev, header: { ...(prev.header || {}), periodeActif: k } }))}
            countdownMs={session ? (() => {
              const candidates = [];
              if (idleTarget != null) candidates.push(idleTarget - now);
              if (absTarget != null) candidates.push(absTarget - now);
              return candidates.length ? Math.min(...candidates) : null;
            })() : null}
          />
          <OfflineBanner status={syncStatus} onRetry={retrySync} />
          {schoolState && (
            <ActualitesTicker actualites={schoolState.actualites} onOpen={() => setActive('actualites')} />
          )}
          <main id="sygenop-print-area" className="flex-1 p-4 md:p-6 lg:p-8 max-w-[1500px] w-full">
            <ErrorBoundary>
              <React.Suspense fallback={<div className="flex items-center justify-center p-12"><Loader2 size={24} className="animate-spin" style={{ color: 'var(--accent)' }} /></div>}>
                {body}
              </React.Suspense>
            </ErrorBoundary>
          </main>
        </div>
      </div>
      <Toast toast={toast} />
      <ChesterWidget dark={dark} session={session} />
    </div>
  );
}

/* ============================================================
   BANNIÈRE HORS LIGNE / SYNCHRONISATION
   ============================================================ */
function OfflineBanner({ status, onRetry }) {
  if (status.online && status.pendingCount === 0) return null;
  const offline = !status.online;
  return (
    <div
      className="px-4 py-2 text-xs font-semibold flex items-center gap-2 flex-wrap"
      style={{
        background: offline ? '#fdecea' : 'var(--gold-l)',
        color: offline ? '#8a2f24' : '#92710c',
        borderBottom: '1px solid var(--line)',
      }}
    >
      {offline ? (
        <>
          <AlertCircle size={14} />
          Mode hors ligne — vos saisies sont enregistrées sur cet appareil et seront envoyées automatiquement dès le retour du réseau.
          {status.storagePersistent === false && (
            <span style={{ color: '#8a2f24' }}>
              ⚠ Stockage local non persistant : ne pas effacer les données du site tant que la synchronisation n'est pas faite.
            </span>
          )}
        </>
      ) : status.syncing ? (
        <>
          <Loader2 size={14} className="animate-spin" />
          Synchronisation en cours…
        </>
      ) : status.suspended ? (
        <>
          <AlertTriangle size={14} />
          <span>{status.pendingCount} école(s) dont des saisies n'ont pas pu être envoyées (accès refusé / code d'accès introuvable).</span>
          <span style={{ color: '#8a2f24' }}>Les saisies sont conservées sur cet appareil — reconnectez-vous avec le bon compte puis réessayez.</span>
          {status.lastError && <span style={{ color: '#8a2f24', opacity: .8 }}>Détail : {status.lastError}</span>}
          {onRetry && <button type="button" onClick={onRetry} className="px-2 py-1 rounded font-semibold" style={{ background: 'var(--panel)', color: 'var(--green-d)', border: '1px solid var(--line)' }}>Réessayer</button>}
          <button
            type="button"
            onClick={async () => {
              if (!window.confirm('Abandonner définitivement l\'envoi de ces saisies au serveur ? Elles restent enregistrées sur cet appareil mais ne seront jamais synchronisées.')) return;
              await clearQueue();
              onRetry && onRetry();
            }}
            className="px-2 py-1 rounded font-semibold"
            style={{ background: 'transparent', color: '#8a2f24', border: '1px solid #8a2f24' }}
          >
            Abandonner la synchro
          </button>
        </>
      ) : (
        <>
          <RotateCcw size={14} />
          <span>{status.pendingCount} école(s) avec des données non encore synchronisées — envoi automatique dès que possible.</span>
          {status.lastError && <span style={{ color: '#8a2f24', opacity: .8 }}>Erreur : {status.lastError}</span>}
          {onRetry && <button type="button" onClick={onRetry} className="px-2 py-1 rounded font-semibold" style={{ background: 'var(--panel)', color: 'var(--green-d)', border: '1px solid var(--line)' }}>Réessayer maintenant</button>}
        </>
      )}
    </div>
  );
}
