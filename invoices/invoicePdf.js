// Génération du PDF de « facture à payer » destinée aux parents.
// Module volontairement indépendant de l'interface : il reçoit des données
// déjà calculées (voir buildInvoiceData dans EduLink Pro V1.jsx) et dessine
// une page A4 par élève. jsPDF est chargé à la demande (import dynamique).

export function fmtMoney(n) {
  const v = Math.round(Number(n) || 0);
  // L'espace fine insécable de Intl n'existe pas dans l'encodage PDF standard.
  return new Intl.NumberFormat('fr-FR').format(v).replace(/[  ]/g, ' ') + ' FCFA';
}

// Les polices PDF standard ne connaissent que le Latin-1/WinAnsi.
function clean(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E -ÿ]/g, '');
}

export function invoiceFileName(item) {
  const slug = (s) => clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `Facture_${slug(item.student.name)}_${slug(item.monthKey || item.monthLabel)}.pdf`;
}

const INK = [23, 37, 63];
const GREEN = [10, 30, 61];
const MUTED = [100, 116, 139];
const LINE = [203, 213, 225];

function drawInvoice(doc, item) {
  const W = 210;
  const M = 16;
  let y = 16;
  const text = (s, x, yy, opts) => doc.text(clean(s), x, yy, opts);

  // En-tête : logo + école
  let textX = M;
  if (item.school.logo) {
    try {
      const props = doc.getImageProperties(item.school.logo);
      const h = 22;
      const w = Math.min(34, (props.width / props.height) * h);
      doc.addImage(item.school.logo, props.fileType || 'PNG', M, y - 4, w, h, undefined, 'FAST');
      textX = M + w + 5;
    } catch (_) { /* logo illisible : on continue sans */ }
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...INK);
  text(String(item.school.name || 'ÉCOLE').toUpperCase(), textX, y + 2);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  text('République du Sénégal', textX, y + 8);
  text(`IEF ${item.school.ief || ''}  -  Année scolaire ${item.school.annee || ''}`, textX, y + 13);

  // Titre
  y = 46;
  doc.setFillColor(...GREEN);
  doc.rect(M, y, W - 2 * M, 11, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(255, 255, 255);
  text(`FACTURE N° ${item.invoiceNo}`, W / 2, y + 7.4, { align: 'center' });

  // Blocs d'information
  y += 20;
  doc.setTextColor(...INK);
  const col2 = W / 2 + 4;
  const field = (label, value, x, yy) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
    text(label.toUpperCase(), x, yy);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK);
    text(value || '-', x, yy + 5.5);
  };
  field('Parent / tuteur', item.parent.name || 'Parent ou tuteur', M, y);
  field('Période facturée', item.monthLabel, col2, y);
  y += 15;
  field('Élève', item.student.name, M, y);
  field('Date d\'émission', item.issueDate, col2, y);
  y += 15;
  field('Classe', item.student.className, M, y);
  field('À régler avant le', item.dueDate, col2, y);
  y += 15;
  if (item.parent.tel) { field('Téléphone', item.parent.tel, M, y); y += 15; }

  // Tableau des lignes
  y += 3;
  const tx = M, tw = W - 2 * M, amountX = W - M - 3;
  doc.setFillColor(241, 245, 249);
  doc.rect(tx, y, tw, 9, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...INK);
  text('DÉSIGNATION', tx + 3, y + 6);
  text('MONTANT', amountX, y + 6, { align: 'right' });
  y += 9;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
  const row = (label, amount, opts = {}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    doc.setTextColor(...(opts.color || INK));
    text(label, tx + 3, y + 6.5);
    text(opts.negative ? '- ' + fmtMoney(amount) : fmtMoney(amount), amountX, y + 6.5, { align: 'right' });
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2);
    doc.line(tx, y + 9, tx + tw, y + 9);
    y += 9;
  };
  (item.lines || []).forEach((l) => row(l.label, l.amount));
  if (item.paidThisMonth > 0) row('Déjà versé pour ce mois', item.paidThisMonth, { negative: true, color: [21, 128, 61] });
  if (item.arrears > 0) row('Arriérés des mois précédents', item.arrears, { color: [185, 28, 28] });
  if (item.inscription > 0) row('Reliquat des frais d\'inscription', item.inscription, { color: [185, 28, 28] });

  // Total
  y += 3;
  doc.setFillColor(255, 248, 207);
  doc.rect(tx, y, tw, 12, 'F');
  doc.setDrawColor(255, 209, 0); doc.setLineWidth(0.6); doc.rect(tx, y, tw, 12);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5); doc.setTextColor(...INK);
  text('TOTAL À PAYER', tx + 3, y + 8);
  text(fmtMoney(item.total), amountX, y + 8, { align: 'right' });
  y += 22;

  // Modalités
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...INK);
  const note = item.note || 'Merci de régler ce montant auprès de la comptabilité de l\'école (espèces, Wave, Orange Money ou virement). Un reçu vous sera remis à chaque paiement.';
  const wrapped = doc.splitTextToSize(clean(note), W - 2 * M);
  doc.text(wrapped, M, y);
  y += wrapped.length * 5 + 6;

  // Signature
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5);
  text('La Direction / La Comptabilite', W - M, y, { align: 'right' });

  // Pied de page
  doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.line(M, 276, W - M, 276);
  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(...MUTED);
  text('Facture à payer - ce document n\'est pas un reçu et ne vaut pas quittance.', M, 281);
  doc.setFont('helvetica', 'normal');
  text(`Édité via EduLink Pro le ${item.issueDate}`, W - M, 281, { align: 'right' });
}

// items : tableau de données de facture. Renvoie le document jsPDF.
export async function buildInvoicesPdf(items) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  items.forEach((item, i) => {
    if (i > 0) doc.addPage();
    drawInvoice(doc, item);
  });
  return doc;
}

export async function invoicesPdfBlob(items) {
  const doc = await buildInvoicesPdf(items);
  return doc.output('blob');
}
