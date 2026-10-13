// PDF generation (works offline, on the phone). Uses jsPDF + AutoTable.
const PDFGen = (() => {
  const BRAND = [122, 31, 43], GOLD = [201, 162, 74], GREY = [110, 100, 92];
  const money = n => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyf = n => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const dmy = s => s ? s.slice(0, 10).split('-').reverse().join('-') : '';

  // Shrink photos so the PDF stays small enough for WhatsApp
  function shrink(dataUrl, max = 420) {
    return new Promise(res => {
      if (!dataUrl) return res(null);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        res({ src: c.toDataURL('image/jpeg', 0.75), w: c.width, h: c.height });
      };
      img.onerror = () => res(null);
      img.src = dataUrl;
    });
  }

  async function thumbs(photoMap, ids) {
    const out = {};
    for (const id of ids) if (id && photoMap[id]) out[id] = await shrink(photoMap[id]);
    return out;
  }

  function drawPhoto(doc, cell, t) {
    if (!t) { doc.setFontSize(7); doc.setTextColor(150); doc.text('No photo', cell.x + 3, cell.y + 8); return; }
    const pad = 1.5, bw = cell.width - pad * 2, bh = cell.height - pad * 2;
    const k = Math.min(bw / t.w, bh / t.h), w = t.w * k, h = t.h * k;
    doc.addImage(t.src, 'JPEG', cell.x + pad + (bw - w) / 2, cell.y + pad + (bh - h) / 2, w, h);
  }

  function header(doc, title, cfg, rightLines) {
    const W = doc.internal.pageSize.getWidth();
    doc.setFillColor(...BRAND); doc.rect(0, 0, W, 26, 'F');
    doc.setTextColor(...GOLD); doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text(cfg.company || 'Mechery Silks', 12, 12);
    doc.setTextColor(255); doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(cfg.companyLine || '', 12, 18);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text(title, W - 12, 11, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    rightLines.forEach((l, i) => doc.text(l, W - 12, 16.5 + i * 4.5, { align: 'right' }));
  }

  function infoBlock(doc, y, left, right) {
    const W = doc.internal.pageSize.getWidth();
    doc.setDrawColor(220); doc.setLineWidth(0.2);
    const h = Math.max(left.length, right.length) * 5 + 6;
    doc.roundedRect(12, y, W - 24, h, 2, 2);
    doc.setFontSize(9);
    const col = (rows, x) => rows.forEach(([k, v], i) => {
      doc.setTextColor(...GREY); doc.setFont('helvetica', 'normal'); doc.text(k, x, y + 6 + i * 5);
      doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.text(String(v || '-'), x + 26, y + 6 + i * 5, { maxWidth: W / 2 - 44 });
    });
    col(left, 16); col(right, W / 2 + 4);
    return y + h + 4;
  }

  function footer(doc, note) {
    const n = doc.internal.getNumberOfPages(), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(140); doc.setFont('helvetica', 'normal');
      doc.text(note, 12, H - 6);
      doc.text('Page ' + i + ' of ' + n, W - 12, H - 6, { align: 'right' });
    }
  }

  function signBoxes(doc, y, labels) {
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    if (y + 30 > H - 12) { doc.addPage(); y = 16; }
    const bw = (W - 24 - (labels.length - 1) * 6) / labels.length;
    labels.forEach((l, i) => {
      const x = 12 + i * (bw + 6);
      doc.setDrawColor(190); doc.roundedRect(x, y, bw, 24, 2, 2);
      doc.setFontSize(8.5); doc.setTextColor(...GREY); doc.text(l, x + 3, y + 5);
      doc.text('Name / Sign / Date', x + 3, y + 21);
    });
    return y + 28;
  }

  function remarksBox(doc, y, title, text, minH = 18) {
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    doc.setFontSize(9);
    const lines = text ? doc.splitTextToSize(text, W - 32) : [];
    const h = Math.max(minH, lines.length * 4.5 + 10);
    if (y + h > H - 12) { doc.addPage(); y = 16; }
    doc.setDrawColor(190); doc.roundedRect(12, y, W - 24, h, 2, 2);
    doc.setTextColor(...GREY); doc.setFont('helvetica', 'bold'); doc.text(title, 16, y + 5.5);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(30);
    if (lines.length) doc.text(lines, 16, y + 11);
    return y + h + 4;
  }

  async function poPdf(d, photoMap, cfg) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const po = d.po, sup = d.supplier || {};
    const items = d.items.filter(i => i.active !== false);
    const th = await thumbs(photoMap, items.map(i => i.photoId));
    const right = ['PO No: ' + po.poNo + (po.rev ? '  (Rev ' + po.rev + ')' : ''), 'PO Date: ' + dmy(po.poDate)];
    header(doc, 'PURCHASE ORDER', cfg, right);
    let y = infoBlock(doc, 31,
      [['Supplier', sup.name || po.supplierName], ['Place', sup.place], ['Phone', sup.phone], ['GSTIN', sup.gstin]],
      [['Purchased by', po.purchaserName], ['Status', po.pending ? 'Not yet uploaded' : po.status], ['Items', items.length], ['Total Qty', qtyf(po.totalQty)]]);

    const body = items.map((it, i) => ({
      no: i + 1, photo: '', item: [it.itemName, it.description, it.remarks ? 'Note: ' + it.remarks : ''].filter(Boolean).join('\n') || '-',
      qty: qtyf(it.qty) + ' ' + (it.unit || ''), rate: money(it.rate), mrp: money(it.mrp), value: money(it.value != null ? it.value : it.qty * it.rate), recd: '', _p: it.photoId
    }));
    doc.autoTable({
      startY: y, margin: { left: 12, right: 12, bottom: 14 },
      columns: [{ header: '#', dataKey: 'no' }, { header: 'Photo', dataKey: 'photo' }, { header: 'Item / Description', dataKey: 'item' },
        { header: 'Qty', dataKey: 'qty' }, { header: 'Rate', dataKey: 'rate' }, { header: 'MRP', dataKey: 'mrp' },
        { header: 'Value', dataKey: 'value' }, { header: 'Recd Qty', dataKey: 'recd' }],
      body,
      foot: [{ no: '', photo: '', item: 'TOTAL', qty: qtyf(po.totalQty), rate: '', mrp: '', value: money(po.totalValue), recd: '' }],
      theme: 'grid', styles: { fontSize: 8.5, cellPadding: 1.8, valign: 'middle', lineColor: 200, lineWidth: 0.2, textColor: 20 },
      headStyles: { fillColor: BRAND, textColor: 255, fontStyle: 'bold' },
      footStyles: { fillColor: [243, 232, 216], textColor: 20, fontStyle: 'bold' },
      columnStyles: { no: { cellWidth: 7, halign: 'center' }, photo: { cellWidth: 30, minCellHeight: 30 }, item: { cellWidth: 'auto' },
        qty: { cellWidth: 18, halign: 'right' }, rate: { cellWidth: 19, halign: 'right' }, mrp: { cellWidth: 19, halign: 'right' },
        value: { cellWidth: 22, halign: 'right' }, recd: { cellWidth: 15 } },
      didDrawCell: c => { if (c.section === 'body' && c.column.dataKey === 'photo') drawPhoto(doc, c.cell, th[c.row.raw._p]); }
    });
    y = doc.lastAutoTable.finalY + 6;
    y = remarksBox(doc, y, 'Order remarks', po.remarks || '', 14);
    if (d.revisions && d.revisions.length) {
      const txt = d.revisions.map(r => 'Rev ' + r.rev + (r.itemNo ? ' / Item ' + r.itemNo : '') + ': ' + r.field + ' ' + (r.oldValue || '-') + ' -> ' + (r.newValue || '-') + '  (' + r.changedBy + ', ' + dmy(r.changedAt) + ': ' + r.reason + ')').join('\n');
      y = remarksBox(doc, y, 'Corrections made after submission', txt);
    }
    y = remarksBox(doc, y, 'Godown verification remarks', '', 22);
    signBoxes(doc, y, ['Purchased by', 'Received by (Godown)', 'Verified by']);
    footer(doc, (cfg.company || 'Mechery Silks') + ' | ' + po.poNo + ' | Generated ' + new Date().toLocaleString('en-IN'));
    return doc.output('blob');
  }

  async function grnPdf(d, photoMap, cfg) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const po = d.po, sup = d.supplier || {}, rc = d.receipt;
    const items = d.items.filter(i => i.active !== false);
    const ids = items.map(i => i.photoId).concat(rc.extras.map(x => x.photoId));
    const th = await thumbs(photoMap, ids);
    header(doc, 'GOODS RECEIVING REPORT', cfg, ['PO No: ' + po.poNo + (po.rev ? '  (Rev ' + po.rev + ')' : ''), 'PO Date: ' + dmy(po.poDate)]);
    const last = d.grns[d.grns.length - 1] || {};
    let y = infoBlock(doc, 31,
      [['Supplier', sup.name || po.supplierName], ['Place', sup.place], ['Purchased by', po.purchaserName]],
      [['Deliveries', d.grns.map(g => g.grnNo).join(', ') || '-'], ['Last received', dmy(last.grnDate) + (last.receivedBy ? ' by ' + last.receivedBy : '')], ['PO Status', po.status]]);
    const byNo = {}; rc.items.forEach(r => { byNo[r.itemNo] = r; });
    const body = items.map((it, i) => {
      const r = byNo[it.itemNo] || {};
      return { no: i + 1, photo: '', item: [it.itemName, it.description].filter(Boolean).join('\n') || '-', ord: qtyf(it.qty) + ' ' + (it.unit || ''),
        rec: qtyf(r.received), bal: qtyf(r.balance), st: r.status + (r.conditions && r.conditions.length ? '\n' + r.conditions.join(', ') : ''), _p: it.photoId, _s: r.status, _c: (r.conditions || []).length };
    });
    doc.autoTable({
      startY: y, margin: { left: 12, right: 12, bottom: 14 },
      columns: [{ header: '#', dataKey: 'no' }, { header: 'Ordered photo', dataKey: 'photo' }, { header: 'Item', dataKey: 'item' },
        { header: 'Ordered', dataKey: 'ord' }, { header: 'Received', dataKey: 'rec' }, { header: 'Balance', dataKey: 'bal' }, { header: 'Result', dataKey: 'st' }],
      body, theme: 'grid', styles: { fontSize: 8.5, cellPadding: 1.8, valign: 'middle', lineColor: 200, lineWidth: 0.2, textColor: 20 },
      headStyles: { fillColor: BRAND, textColor: 255 },
      columnStyles: { no: { cellWidth: 7, halign: 'center' }, photo: { cellWidth: 28, minCellHeight: 28 }, ord: { cellWidth: 20, halign: 'right' },
        rec: { cellWidth: 18, halign: 'right' }, bal: { cellWidth: 17, halign: 'right' }, st: { cellWidth: 32, fontStyle: 'bold' } },
      didParseCell: c => {
        if (c.section === 'body' && c.column.dataKey === 'st') {
          const s = c.row.raw._s, bad = c.row.raw._c || s === 'Short' || s === 'Excess' || s === 'Not Received';
          c.cell.styles.textColor = bad ? [179, 38, 30] : s === 'Matched' ? [31, 122, 63] : [154, 98, 0];
        }
      },
      didDrawCell: c => { if (c.section === 'body' && c.column.dataKey === 'photo') drawPhoto(doc, c.cell, th[c.row.raw._p]); }
    });
    y = doc.lastAutoTable.finalY + 6;
    if (rc.extras.length) {
      doc.setFontSize(11); doc.setTextColor(179, 38, 30); doc.setFont('helvetica', 'bold');
      doc.text('Items received that are NOT in this PO', 12, y + 2);
      doc.autoTable({
        startY: y + 5, margin: { left: 12, right: 12, bottom: 14 },
        columns: [{ header: 'Photo', dataKey: 'photo' }, { header: 'Item', dataKey: 'item' }, { header: 'Qty', dataKey: 'qty' }, { header: 'Note', dataKey: 'note' }],
        body: rc.extras.map(x => ({ photo: '', item: x.itemName, qty: qtyf(x.receivedQty), note: [x.condition, x.remarks].filter(Boolean).join(' - '), _p: x.photoId })),
        theme: 'grid', styles: { fontSize: 8.5, cellPadding: 1.8, valign: 'middle' }, headStyles: { fillColor: [179, 38, 30] },
        columnStyles: { photo: { cellWidth: 28, minCellHeight: 28 }, qty: { cellWidth: 18, halign: 'right' } },
        didDrawCell: c => { if (c.section === 'body' && c.column.dataKey === 'photo') drawPhoto(doc, c.cell, th[c.row.raw._p]); }
      });
      y = doc.lastAutoTable.finalY + 6;
    }
    const probs = [];
    d.grns.forEach(g => g.lines.forEach(l => { if (l.lineType === 'ORDERED' && (l.condition !== 'OK' || l.photoId)) probs.push(Object.assign({ grnNo: g.grnNo }, l)); }));
    if (probs.length) {
      const pth = await thumbs(photoMap, probs.map(l => l.photoId));
      const H = doc.internal.pageSize.getHeight();
      if (y + 40 > H - 14) { doc.addPage(); y = 16; }
      doc.setFontSize(11); doc.setTextColor(179, 38, 30); doc.setFont('helvetica', 'bold');
      doc.text('Problems found while checking', 12, y + 2);
      doc.autoTable({
        startY: y + 5, margin: { left: 12, right: 12, bottom: 14 },
        columns: [{ header: 'Photo of goods received', dataKey: 'photo' }, { header: 'Item', dataKey: 'item' }, { header: 'Recd', dataKey: 'qty' }, { header: 'Problem', dataKey: 'note' }],
        body: probs.map(l => ({ photo: '', item: 'Item ' + l.itemNo + ': ' + (l.itemName || '') + '\n' + l.grnNo, qty: qtyf(l.receivedQty), note: [l.condition, l.remarks].filter(Boolean).join(' - '), _p: l.photoId })),
        theme: 'grid', styles: { fontSize: 8.5, cellPadding: 1.8, valign: 'middle' }, headStyles: { fillColor: [179, 38, 30] },
        columnStyles: { photo: { cellWidth: 32, minCellHeight: 28 }, qty: { cellWidth: 16, halign: 'right' } },
        didDrawCell: c => { if (c.section === 'body' && c.column.dataKey === 'photo') drawPhoto(doc, c.cell, pth[c.row.raw._p]); }
      });
      y = doc.lastAutoTable.finalY + 6;
    }
    const notes = d.grns.map(g => g.grnNo + ' (' + dmy(g.grnDate) + ')' + (g.invoiceNo ? ' Inv: ' + g.invoiceNo : '') + (g.transport ? ' LR: ' + g.transport : '') + (g.finalDelivery ? ' [Final delivery]' : '') + (g.remarks ? ' - ' + g.remarks : '')).join('\n');
    y = remarksBox(doc, y, 'Delivery details', notes);
    signBoxes(doc, y, ['Received by (Godown)', 'Checked by Purchaser', 'Approved by']);
    footer(doc, (cfg.company || 'Mechery Silks') + ' | Receiving report ' + po.poNo + ' | Generated ' + new Date().toLocaleString('en-IN'));
    return doc.output('blob');
  }

  return { poPdf, grnPdf, money, qtyf, dmy };
})();
