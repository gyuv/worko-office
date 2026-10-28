import ExcelJS from 'exceljs';

export type Tabular = { name: string; mime: string; body: Buffer };
const cell = (v: unknown) => (Array.isArray(v) ? v.join('; ') : v === null || v === undefined ? '' : String(v));

/**
 * CSV (UTF-8 BOM, CRLF) or XLSX from rows. Formula-looking text cells are prefixed with `'` in CSV so spreadsheets
 * don't execute them (CSV injection); numbers stay numeric. XLSX cells are written as values, never formulas.
 */
export async function tabular(base: string, sheet: string, head: string[], rows: unknown[][], format: 'csv' | 'xlsx'): Promise<Tabular> {
  if (format === 'csv') {
    const esc = (v: unknown) => {
      if (typeof v === 'number') return String(v);
      const s = cell(v); const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const body = [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
    return { name: `${base}.csv`, mime: 'text/csv; charset=utf-8', body: Buffer.from('﻿' + body) };
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(head).font = { bold: true };
  for (const r of rows) ws.addRow(r.map((v) => (typeof v === 'number' ? v : cell(v))));
  ws.columns.forEach((col) => { col.width = 18; });
  return { name: `${base}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from(await wb.xlsx.writeBuffer()) };
}
