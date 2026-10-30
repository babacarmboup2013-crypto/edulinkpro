import { describe, it, expect } from 'vitest';
import { buildInvoicesPdf, invoiceFileName, fmtMoney } from './invoicePdf.js';

const item = (name) => ({
  school: { name: 'GS TEST', ief: 'GRAND DAKAR', annee: '2026/2027', logo: '' },
  invoiceNo: 'FAC-202611-A1B2C', monthKey: '2026-11', monthLabel: 'Novembre 2026',
  issueDate: '30/10/2026', dueDate: '05/11/2026',
  student: { name, className: 'CM1' }, parent: { name: 'M. Fall', tel: '77 000 00 00' },
  lines: [{ label: 'Scolarité', amount: 15000 }, { label: 'Cantine', amount: 5000 }],
  paidThisMonth: 5000, arrears: 10000, inscription: 0, total: 25000,
});

describe('facture PDF', () => {
  it('formate les montants sans espace insécable', () => {
    expect(fmtMoney(1234567)).toBe('1 234 567 FCFA');
    expect(fmtMoney(1234567)).not.toMatch(/[  ]/);
  });
  it('nomme le fichier proprement', () => {
    expect(invoiceFileName(item('Aïssatou Ndiaye'))).toBe('Facture_Aissatou_Ndiaye_2026_11.pdf');
  });
  it('génère un PDF, une page par élève', async () => {
    const doc = await buildInvoicesPdf([item('A B'), item('C D'), item('E F')]);
    expect(doc.getNumberOfPages()).toBe(3);
    const head = new TextDecoder().decode(new Uint8Array(doc.output('arraybuffer')).slice(0, 5));
    expect(head).toBe('%PDF-');
  });
});
