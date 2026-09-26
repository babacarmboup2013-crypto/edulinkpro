import { describe, it, expect } from 'vitest';
import {
  normalizePaymentRubriques,
  feeForLevel,
  schoolYearMonths,
  studentFeesFor,
  studentInscriptionDue,
  studentMonthlyDue,
  studentAnnualDue,
  studentTotalDue,
  studentTotalPaid,
  studentPaidByType,
  paymentTypeKey,
  normalizeCasSocial,
  studentDueByType,
  studentReliquatByType,
  paymentStatus,
  nextRecuNumero,
  schoolPaymentsSummary,
  PAYMENT_RUBRIQUE_DEFAULTS,
} from './finance.js';

/* ============================================================
   FIXTURES
   ============================================================ */

function makeState(overrides = {}) {
  return {
    header: { annee: '2026/2027', ...overrides.header },
    fees: overrides.fees || {
      CE2: {
        mensualites: 10,
        rubriques: [
          { id: 'inscription', label: "Frais d'inscription", montant: 25000, nature: 'entree', actif: true },
          { id: 'scolarite', label: 'Scolarité', montant: 100000, nature: 'annuel', actif: true },
        ],
      },
    },
    classes: overrides.classes || {},
  };
}

function makeStudent(overrides = {}) {
  return {
    id: 'stu-1',
    nom: 'Diallo',
    prenom: 'Aminata',
    paiements: overrides.paiements || [],
    casSocial: overrides.casSocial || 0,
    rubriquesMois: overrides.rubriquesMois || {},
  };
}

/* ============================================================
   TESTS — schoolYearMonths
   ============================================================ */

describe('schoolYearMonths', () => {
  it('returns 12 months from Oct to Jul for 2026/2027', () => {
    const state = makeState({ header: { annee: '2026/2027' } });
    const months = schoolYearMonths(state);
    expect(months).toEqual([
      '2026-10', '2026-11', '2026-12',
      '2027-01', '2027-02', '2027-03', '2027-04',
      '2027-05', '2027-06', '2027-07',
    ]);
  });
});

/* ============================================================
   TESTS — feeForLevel
   ============================================================ */

describe('feeForLevel', () => {
  it('returns rubriques and mensualites from state', () => {
    const state = makeState();
    const result = feeForLevel(state, 'CE2');
    expect(result.mensualites).toBe(10);
    expect(result.rubriques.length).toBeGreaterThan(0);
    expect(result.rubriques.find((r) => r.id === 'scolarite').montant).toBe(100000);
  });

  it('defaults mensualites to 10', () => {
    const state = makeState({ fees: { CE2: { rubriques: [{ id: 'scolarite', montant: 50000, nature: 'annuel', actif: true }] } } });
    const result = feeForLevel(state, 'CE2');
    expect(result.mensualites).toBe(10);
  });

  it('returns default rubriques with zero montant for unknown level', () => {
    const result = feeForLevel(makeState(), 'UNKNOWN');
    expect(result.rubriques.length).toBe(PAYMENT_RUBRIQUE_DEFAULTS.length);
    expect(result.rubriques.every((r) => r.montant === 0)).toBe(true);
  });
});

/* ============================================================
   TESTS — studentAnnualDue (LE BUG CORRIGÉ)
   ============================================================ */

describe('studentAnnualDue', () => {
  it('without student returns raw annual total', () => {
    const state = makeState();
    const due = studentAnnualDue(state, 'CE2');
    expect(due).toBe(100000);
  });

  it('with student returns montant, NOT montant*12/mensualites', () => {
    const state = makeState();
    const student = makeStudent();
    const due = studentAnnualDue(state, 'CE2', student);
    // With mensualites=10 and montant=100000: correct is 100000, NOT 120000
    expect(due).toBe(100000);
  });

  it('with mensualites=8, montant=100000 → due=100000 (not 150000)', () => {
    const state = makeState({
      fees: { CE2: { mensualites: 8, rubriques: [
        { id: 'scolarite', montant: 100000, nature: 'annuel', actif: true },
      ] } },
    });
    const due = studentAnnualDue(state, 'CE2', makeStudent());
    expect(due).toBe(100000);
  });

  it('with casSocial=20% discount, montant=100000 → due=80000', () => {
    const state = makeState();
    const student = makeStudent({ casSocial: 20 });
    const due = studentAnnualDue(state, 'CE2', student);
    expect(due).toBe(80000);
  });

  it('with partial months (only 6 months active), due=montant', () => {
    const state = makeState();
    const student = makeStudent({
      rubriquesMois: { scolarite: ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'] },
    });
    const due = studentAnnualDue(state, 'CE2', student);
    // Even with partial months, the full montant is the annual due
    expect(due).toBe(100000);
  });
});

/* ============================================================
   TESTS — studentMonthlyDue
   ============================================================ */

describe('studentMonthlyDue', () => {
  it('without student returns montant/mensualites', () => {
    const state = makeState();
    const monthly = studentMonthlyDue(state, 'CE2');
    expect(monthly).toBe(10000); // 100000/10
  });

  it('with student, for a specific active month', () => {
    const state = makeState();
    const student = makeStudent();
    const monthly = studentMonthlyDue(state, 'CE2', student, '2026-10');
    expect(monthly).toBe(10000);
  });

  it('with student, for an inactive month returns 0', () => {
    const state = makeState();
    const student = makeStudent({
      rubriquesMois: { scolarite: ['2026-10', '2026-11'] },
    });
    const monthly = studentMonthlyDue(state, 'CE2', student, '2027-05');
    expect(monthly).toBe(0);
  });
});

/* ============================================================
   TESTS — studentTotalDue
   ============================================================ */

describe('studentTotalDue', () => {
  it('with student = inscription + annual', () => {
    const state = makeState();
    const student = makeStudent();
    const total = studentTotalDue(state, 'CE2', student);
    expect(total).toBe(125000); // 25000 inscription + 100000 annual
  });

  it('without student = sum of all rubriques', () => {
    const state = makeState();
    const total = studentTotalDue(state, 'CE2');
    expect(total).toBe(125000);
  });
});

/* ============================================================
   TESTS — studentReliquatByType
   ============================================================ */

describe('studentReliquatByType', () => {
  it('no payments → reliquat = total due', () => {
    const state = makeState();
    const student = makeStudent();
    const r = studentReliquatByType(state, 'CE2', student);
    expect(r.inscription).toBe(25000);
    expect(r.mensualite).toBe(100000);
    expect(r.total).toBe(125000);
  });

  it('full payment → reliquat = 0', () => {
    const state = makeState();
    const student = makeStudent({
      paiements: [
        { montant: 25000, type_paiement: 'inscription' },
        { montant: 100000, type_paiement: 'mensualite' },
      ],
    });
    const r = studentReliquatByType(state, 'CE2', student);
    expect(r.inscription).toBe(0);
    expect(r.mensualite).toBe(0);
    expect(r.total).toBe(0);
  });

  it('partial payment → reliquat = due - paid', () => {
    const state = makeState();
    const student = makeStudent({
      paiements: [
        { montant: 25000, type_paiement: 'inscription' },
        { montant: 50000, type_paiement: 'mensualite' },
      ],
    });
    const r = studentReliquatByType(state, 'CE2', student);
    expect(r.inscription).toBe(0);
    expect(r.mensualite).toBe(50000);
    expect(r.total).toBe(50000);
  });

  it('legacy payment without type_paiement counts as mensualite', () => {
    const state = makeState();
    const student = makeStudent({
      paiements: [
        { montant: 25000, type_paiement: 'inscription' },
        { montant: 40000 }, // hérité, sans type
      ],
    });
    const r = studentReliquatByType(state, 'CE2', student);
    expect(r.mensualite).toBe(60000);
    expect(r.total).toBe(60000);
  });

  it('legacy payment with inscription lines counts as inscription', () => {
    const state = makeState();
    const student = makeStudent({
      paiements: [
        { montant: 25000, lignes: [{ id: 'inscription', label: "Frais d'inscription", checked: true, montant: 25000 }] },
      ],
    });
    const r = studentReliquatByType(state, 'CE2', student);
    expect(r.inscription).toBe(0);
    expect(r.mensualite).toBe(100000);
    expect(r.total).toBe(100000);
  });

  it('inscription overpayment is imputed onto scolarite', () => {
    const state = makeState();
    const student = makeStudent({
      paiements: [
        { montant: 40000, type_paiement: 'inscription' },
        { montant: 50000, type_paiement: 'mensualite' },
      ],
    });
    const r = studentReliquatByType(state, 'CE2', student);
    expect(r.inscription).toBe(0);
    expect(r.mensualite).toBe(50000 - 15000); // 15000 d'excédent inscription imputé
    expect(r.total).toBe(35000);
  });

  it('mensualite overpayment reduces inscription reliquat', () => {
    const state = makeState();
    const student = makeStudent({
      paiements: [
        { montant: 10000, type_paiement: 'inscription' },
        { montant: 120000, type_paiement: 'mensualite' },
      ],
    });
    const r = studentReliquatByType(state, 'CE2', student);
    expect(r.inscription).toBe(0);
    expect(r.mensualite).toBe(0);
    expect(r.total).toBe(0);
  });
});

/* ============================================================
   TESTS — paymentTypeKey (paiements hérités sans type)
   ============================================================ */

describe('paymentTypeKey', () => {
  it('explicit types pass through', () => {
    expect(paymentTypeKey({ type_paiement: 'inscription' })).toBe('inscription');
    expect(paymentTypeKey({ type_paiement: 'mensualite' })).toBe('mensualite');
  });
  it('legacy without lines → mensualite', () => {
    expect(paymentTypeKey({ montant: 47000 })).toBe('mensualite');
  });
  it('legacy with inscription line → inscription', () => {
    expect(paymentTypeKey({ lignes: [{ label: "Frais d'inscription", checked: true, montant: 26500 }] })).toBe('inscription');
    expect(paymentTypeKey({ lignes: [{ id: 'tenue', label: 'Tenue scolaire', checked: true, montant: 8000 }] })).toBe('inscription');
  });
  it('legacy with only scolarite line → mensualite', () => {
    expect(paymentTypeKey({ lignes: [{ id: 'scolarite', label: 'Scolarité', checked: true, montant: 12000 }] })).toBe('mensualite');
  });
});

/* ============================================================
   TESTS — normalizeCasSocial (modèle unique % tous cycles)
   ============================================================ */

describe('normalizeCasSocial', () => {
  it('numbers pass through clamped to 0-100', () => {
    expect(normalizeCasSocial(0)).toBe(0);
    expect(normalizeCasSocial(50)).toBe(50);
    expect(normalizeCasSocial(100)).toBe(100);
    expect(normalizeCasSocial(-5)).toBe(0);
    expect(normalizeCasSocial(150)).toBe(100);
    expect(normalizeCasSocial('30')).toBe(30);
  });
  it('legacy Oui → 50 by default', () => {
    expect(normalizeCasSocial('Oui')).toBe(50);
  });
  it('legacy Non / empty / missing → 0', () => {
    expect(normalizeCasSocial('Non')).toBe(0);
    expect(normalizeCasSocial('')).toBe(0);
    expect(normalizeCasSocial(undefined)).toBe(0);
    expect(normalizeCasSocial(null)).toBe(0);
  });
  it('garbage → 0', () => {
    expect(normalizeCasSocial('abc')).toBe(0);
  });
});

describe('studentFeesFor — remise legacy casSocial', () => {
  it('legacy "Oui" applies a 50% reduction on every rubrique', () => {
    const state = makeState();
    const student = makeStudent({ casSocial: 'Oui' });
    const fe = studentFeesFor(state, 'CE2', student);
    expect(fe.remise).toBe(50);
    expect(fe.rubriques.find((r) => r.id === 'inscription').montant).toBe(12500);
    expect(fe.rubriques.find((r) => r.id === 'scolarite').montant).toBe(50000);
  });
  it('legacy "Non" applies no reduction', () => {
    const state = makeState();
    const student = makeStudent({ casSocial: 'Non' });
    const fe = studentFeesFor(state, 'CE2', student);
    expect(fe.remise).toBe(0);
    expect(fe.rubriques.find((r) => r.id === 'scolarite').montant).toBe(100000);
  });
});

/* ============================================================
   TESTS — paymentStatus
   ============================================================ */

describe('paymentStatus', () => {
  it('due=0 → sans_frais', () => {
    expect(paymentStatus(0, 0).key).toBe('sans_frais');
  });
  it('paid=0 → retard', () => {
    expect(paymentStatus(100000, 0).key).toBe('retard');
  });
  it('paid >= due → a_jour', () => {
    expect(paymentStatus(100000, 100000).key).toBe('a_jour');
    expect(paymentStatus(100000, 120000).key).toBe('a_jour');
  });
  it('0 < paid < due → partiel', () => {
    expect(paymentStatus(100000, 50000).key).toBe('partiel');
  });
});

/* ============================================================
   TESTS — nextRecuNumero
   ============================================================ */

describe('nextRecuNumero', () => {
  it('generates receipt number from state', () => {
    const state = makeState({ header: { annee: '2026/2027' } });
    state.recuSeq = 5;
    const { numero, seq } = nextRecuNumero(state);
    expect(numero).toBe('REC-2026-0006');
    expect(seq).toBe(6);
  });

  it('pads to 4 digits', () => {
    const state = makeState({ header: { annee: '2026/2027' } });
    state.recuSeq = 0;
    const { numero } = nextRecuNumero(state);
    expect(numero).toBe('REC-2026-0001');
  });
});

/* ============================================================
   TESTS — schoolPaymentsSummary
   ============================================================ */

describe('schoolPaymentsSummary', () => {
  it('aggregates across all classes', () => {
    const state = makeState({
      classes: {
        CE2_A: { level: 'CE2', students: [
          makeStudent({ paiements: [{ montant: 50000, type_paiement: 'mensualite' }] }),
          makeStudent({ paiements: [] }),
        ] },
      },
    });
    const summary = schoolPaymentsSummary(state);
    expect(summary.effectif).toBe(2);
    expect(summary.totalDue).toBe(250000); // 2 × 125000
    expect(summary.totalPaid).toBe(50000);
    expect(summary.aJour).toBe(0);
  });
});

/* ============================================================
   TESTS — normalizePaymentRubriques
   ============================================================ */

describe('normalizePaymentRubriques', () => {
  it('returns all default rubriques for empty input', () => {
    const result = normalizePaymentRubriques({});
    expect(result.length).toBe(PAYMENT_RUBRIQUE_DEFAULTS.length);
  });

  it('preserves custom montants', () => {
    const result = normalizePaymentRubriques({
      rubriques: [
        { id: 'inscription', montant: 30000 },
        { id: 'scolarite', montant: 120000 },
      ],
    });
    expect(result.find((r) => r.id === 'inscription').montant).toBe(30000);
    expect(result.find((r) => r.id === 'scolarite').montant).toBe(120000);
  });
});
