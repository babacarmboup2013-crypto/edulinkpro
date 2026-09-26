/**
 * Fonctions financières pures — extraites du monolithe pour testabilité.
 * Aucune dépendance React ni side-effect.
 */

export const PAYMENT_RUBRIQUE_DEFAULTS = [
  { id: 'inscription', label: "Frais d'inscription", nature: 'entree' },
  { id: 'scolarite', label: 'Scolarité', nature: 'annuel' },
  { id: 'cantine', label: 'Cantine', nature: 'annuel' },
  { id: 'car', label: 'Car / transport scolaire', nature: 'annuel' },
  { id: 'tenue', label: 'Tenue scolaire', nature: 'entree' },
  { id: 'bibliotheque', label: 'Bibliothèque', nature: 'annuel' },
  { id: 'informatique', label: 'Informatique', nature: 'annuel' },
];

export function normalizePaymentRubriques(f = {}) {
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
  existing.filter((item) => !used.has(item) && !PAYMENT_RUBRIQUE_DEFAULTS.some((d) => d.id === item.id)).forEach((item) => normalized.push({ ...item, id: item.id || `fee_${Date.now()}`, montant: Number(item.montant) || 0, actif: item.actif !== false }));
  return normalized;
}

export function feeForLevel(state, level) {
  const f = (state && state.fees && state.fees[level]) || {};
  const rubriques = normalizePaymentRubriques(f);
  return { rubriques: rubriques.filter((r) => r.actif !== false).map((r) => ({ ...r, montant: Number(r.montant) || 0 })), mensualites: Math.max(1, Number(f.mensualites) || 10) };
}

export function schoolYearMonths(state) {
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

export function studentFeesFor(state, level, student) {
  const f = feeForLevel(state, level);
  const remise = Math.max(0, Math.min(100, Number(student && student.casSocial) || 0));
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

export function studentInscriptionDue(state, level, student) {
  const fe = student ? studentFeesFor(state, level, student) : feeForLevel(state, level);
  return fe.rubriques.filter((r) => r.nature === 'entree' && (student ? r.activeMonths.length > 0 : true)).reduce((sum, r) => sum + r.montant, 0);
}

export function studentMonthlyDue(state, level, student, month) {
  const fe = student ? studentFeesFor(state, level, student) : feeForLevel(state, level);
  return fe.rubriques.filter((r) => r.nature !== 'entree' && (student ? (month ? r.activeMonths.includes(month) : true) : true)).reduce((sum, r) => sum + Math.round((Number(r.montant) || 0) / fe.mensualites), 0);
}

export function studentAnnualDue(state, level, student) {
  if (!student) return feeForLevel(state, level).rubriques.filter((r) => r.nature !== 'entree').reduce((sum, r) => sum + r.montant, 0);
  const fe = studentFeesFor(state, level, student);
  return fe.rubriques.filter((r) => r.nature !== 'entree' && r.activeMonths.length > 0).reduce((sum, r) => sum + r.montant, 0);
}

export function studentTotalDue(state, level, student) {
  if (student) return studentInscriptionDue(state, level, student) + studentAnnualDue(state, level, student);
  return feeForLevel(state, level).rubriques.reduce((sum, rubrique) => sum + rubrique.montant, 0);
}

export function studentPaiements(student) {
  return (student && student.paiements) || [];
}

export function studentTotalPaid(student) {
  return studentPaiements(student).reduce((s, p) => s + (Number(p.montant) || 0), 0);
}

// Paiements hérités (avant l'ajout du champ type_paiement) : on déduit la
// nature à partir des lignes cochées du reçu (rubriques « À l'entrée »), sinon
// on considère qu'il s'agit d'une mensualité (caisse mensuelle).
const INSCRIPTION_LINE_KEYS = ["frais d'inscription", 'inscription', 'tenue scolaire', 'tenu scolaire', 'ass', 'ape'];
export function paymentTypeKey(p) {
  if (p && (p.type_paiement === 'inscription' || p.type_paiement === 'mensualite')) return p.type_paiement;
  const lignes = Array.isArray(p && p.lignes) ? p.lignes.filter((l) => l && l.checked) : [];
  const text = lignes.map((l) => `${l.label || ''} ${l.id || ''}`).join(' ').toLowerCase();
  if (text && INSCRIPTION_LINE_KEYS.some((k) => text.includes(k))) return 'inscription';
  return 'mensualite';
}

export function studentPaidByType(student, type) {
  return studentPaiements(student).reduce((s, p) => s + (paymentTypeKey(p) === type ? (Number(p.montant) || 0) : 0), 0);
}

export function studentDueByType(state, level, student) {
  const inscriptionDue = studentInscriptionDue(state, level, student);
  const mensualiteDue = studentAnnualDue(state, level, student);
  return { inscription: inscriptionDue, mensualite: mensualiteDue, total: inscriptionDue + mensualiteDue };
}

export function studentReliquatByType(state, level, student) {
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

export function paymentStatus(due, paid) {
  if (due <= 0) return { key: 'sans_frais', label: 'Frais non définis', tone: 'muted' };
  if (paid <= 0) return { key: 'retard', label: 'Aucun versement', tone: 'red' };
  if (paid >= due) return { key: 'a_jour', label: 'À jour', tone: 'green' };
  return { key: 'partiel', label: 'Partiel', tone: 'gold' };
}

export function nextRecuNumero(state) {
  const seq = (Number(state && state.recuSeq) || 0) + 1;
  const annee = (state && state.header && state.header.annee) || String(new Date().getFullYear());
  const anneeShort = String(annee).replace(/\D/g, '').slice(0, 4) || new Date().getFullYear();
  return { numero: `REC-${anneeShort}-${String(seq).padStart(4, '0')}`, seq };
}

export function schoolPaymentsSummary(state) {
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
