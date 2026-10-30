import PDFDocument from 'pdfkit';
import type { ColumnType, ReportGroup } from '@worko/domain';
import { tabular, type Tabular } from '../common/export.js';
import type { RunResult } from './engine.js';

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type ExportMode = 'rows' | 'groups';

/** Paise → rupees for people-facing files (JSON keeps integer paise); everything else as is. */
const cellOut = (v: unknown, t: ColumnType | 'agg_paise' | 'agg') => (v === null || v === undefined ? '' : t === 'paise' || t === 'agg_paise' ? Number(v) / 100 : v);
const head = (label: string, t: ColumnType | 'agg_paise' | 'agg') => (t === 'paise' || t === 'agg_paise' ? `${label} (Rs.)` : label);

/** Header + body of a run as a table: the rows, or (for grouped reports) one line per group/sub-group with its aggregates. */
export function table(r: RunResult, mode: ExportMode): { head: string[]; rows: unknown[][] } {
  const aggType = (alias: string) => {
    const a = r.definition.aggregates.find((x) => x.as === alias);
    const t = a?.column ? r.columns.find((c) => c.key === a.column)?.type : undefined;
    return a && a.fn !== 'count' && (t === 'paise' || (!t && /Paise$/.test(a.column ?? ''))) ? 'agg_paise' as const : 'agg' as const;
  };
  if (mode === 'groups' && r.definition.groupBy.length) {
    const keys = r.definition.groupBy; const aliases = r.definition.aggregates.map((a) => a.as);
    const label = (k: string) => r.columns.find((c) => c.key === k)?.label ?? k;
    const flat: ReportGroup[] = r.groups.flatMap((g) => [g, ...(g.children ?? [])]);
    return {
      head: [...keys.map(label), ...aliases.map((a) => head(a, aggType(a)))],
      rows: [...flat.map((g) => [...keys.map((k) => (k in g.key ? g.key[k] ?? '(none)' : 'All')), ...aliases.map((a) => cellOut(g.values[a], aggType(a)))]),
        [...keys.map((_, i) => (i === 0 ? 'Total' : '')), ...aliases.map((a) => cellOut(r.totals[a], aggType(a)))]],
    };
  }
  return { head: r.columns.map((c) => head(c.label, c.type)), rows: r.rows.map((x) => r.columns.map((c) => cellOut(x.values[c.key], c.type))) };
}

/** CSV/XLSX through the shared formula-injection-safe helper; PDF as a plain table (standard fonts: "Rs." not ₹). */
export async function renderRun(r: RunResult, format: ExportFormat, title: string, mode: ExportMode): Promise<Tabular> {
  const t = table(r, mode);
  const base = title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
  if (format !== 'pdf') return tabular(`${base}-${r.asOf}`, title.slice(0, 31).replace(/[*?:\\/[\]]/g, ' ') || 'Report', t.head, t.rows, format);
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((res) => doc.on('end', () => res()));
  doc.font('Helvetica-Bold').fontSize(13).text(title).font('Helvetica').fontSize(8).fillColor('#555')
    .text(`${r.explanation}. As of ${r.asOf} (IST). ${r.rowCount} row(s).${r.hiddenColumns.length ? ` Hidden for you: ${r.hiddenColumns.join(', ')}.` : ''}`).moveDown(0.5).fillColor('#000');
  const width = doc.page.width - 60; const cols = Math.max(1, t.head.length); const w = width / cols;
  const line = (cells: unknown[], bold = false) => {
    if (doc.y > doc.page.height - 50) doc.addPage();
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
    cells.forEach((v, i) => doc.text(typeof v === 'number' ? v.toLocaleString('en-IN') : String(v ?? ''), 30 + i * w, y, { width: w - 4, height: 10, ellipsis: true, lineBreak: false, align: typeof v === 'number' ? 'right' : 'left' }));
    doc.x = 30; doc.y = y + 11;
  };
  line(t.head, true);
  for (const row of t.rows.slice(0, 5000)) line(row);
  doc.end();
  await done;
  return { name: `${base}-${r.asOf}.pdf`, mime: 'application/pdf', body: Buffer.concat(chunks) };
}
