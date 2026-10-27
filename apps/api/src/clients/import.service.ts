import { BadRequestException, Injectable } from '@nestjs/common';
import { ENTITY_TYPES, entityHintFromPan, isValidGstin, isValidPan, panFromGstin, type EntityType } from '@worko/domain';
import ExcelJS from 'exceljs';
import type { RequestActor } from '../auth/context.js';
import { DbService } from '../db/db.service.js';
import { clientCreate, type ClientCreate } from './clients.schemas.js';
import { ClientsService } from './clients.service.js';
import { clientScopeSql, Params } from './scope.js';

/** Canonical import fields and the header spellings we recognise (lower-cased, punctuation stripped). */
const ALIASES: Record<string, string[]> = {
  name: ['name', 'client name', 'party name', 'legal name', 'client', 'ledger name', 'account name', 'customer name'],
  tradeName: ['trade name', 'business name', 'brand'],
  fileNo: ['file no', 'file number', 'client code', 'code', 'client id'],
  entityType: ['entity type', 'constitution', 'type', 'status of assessee', 'category'],
  pan: ['pan', 'pan no', 'pan number', 'it pan'],
  gstin: ['gstin', 'gst no', 'gst number', 'gstin uin', 'gst'],
  tan: ['tan', 'tan no'],
  email: ['email', 'email id', 'e mail', 'mail'],
  phone: ['phone', 'mobile', 'mobile no', 'contact no', 'phone no', 'whatsapp'],
  address: ['address', 'address line 1', 'address1', 'street'],
  city: ['city', 'town', 'district'],
  state: ['state'],
  pin: ['pin', 'pincode', 'pin code', 'postal code', 'zip'],
  contactName: ['contact person', 'contact name', 'authorised person', 'authorized person'],
  tags: ['tags', 'labels'],
  notes: ['notes', 'remarks', 'comments'],
};
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const ENTITY_WORDS: Array<[RegExp, EntityType]> = [
  [/\b(pvt|private)\b/, 'PRIVATE_COMPANY'], [/\bopc\b|one person/, 'OPC'], [/\b(public|ltd|limited)\b/, 'PUBLIC_COMPANY'], [/\bllp\b/, 'LLP'],
  [/propriet/, 'PROPRIETORSHIP'], [/partner|firm/, 'PARTNERSHIP'], [/\bhuf\b|hindu undivided/, 'HUF'], [/trust/, 'TRUST'], [/society/, 'SOCIETY'],
  [/\baop\b|\bboi\b|association/, 'AOP_BOI'], [/govt|government/, 'GOVERNMENT'], [/individual|person|salaried/, 'INDIVIDUAL'], [/company/, 'PRIVATE_COMPANY'],
];
export function parseEntity(v: string, pan?: string | null): EntityType | null {
  const s = norm(v).toUpperCase().replace(/ /g, '_');
  if ((ENTITY_TYPES as readonly string[]).includes(s)) return s as EntityType;
  const low = norm(v);
  for (const [re, t] of ENTITY_WORDS) if (low && re.test(low)) return t;
  return pan && isValidPan(pan) ? entityHintFromPan(pan) : null;
}

/** RFC 4180-ish CSV (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export type PreviewRow = { row: number; data: ClientCreate | null; errors: string[]; warnings: string[] };
const MAX_ROWS = 5000;

@Injectable()
export class ImportService {
  constructor(private db: DbService, private clients: ClientsService) {}

  async readTable(file: { buffer: Buffer; originalname: string }): Promise<string[][]> {
    if (/\.csv$/i.test(file.originalname)) return parseCsv(file.buffer.toString('utf8').replace(/^﻿/, ''));
    if (!/\.xlsx$/i.test(file.originalname)) throw new BadRequestException('Upload a .xlsx or .csv file');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new BadRequestException('The workbook has no sheets');
    const out: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals = (r.values as unknown[]).slice(1).map((v) => {
        if (v === null || v === undefined) return '';
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'object' && v && 'text' in v) return String((v as { text: unknown }).text);
        if (typeof v === 'object' && v && 'result' in v) return String((v as { result: unknown }).result ?? '');
        return String(v);
      });
      out.push(vals);
    });
    return out;
  }

  /** Maps headers → fields; returns the mapping so the UI can show and adjust it. */
  mapHeaders(headers: string[], override: Record<string, string> = {}): Record<number, string> {
    const map: Record<number, string> = {};
    headers.forEach((h, i) => {
      const n = norm(h);
      const field = override[h] ?? Object.entries(ALIASES).find(([, al]) => al.includes(n))?.[0];
      if (field && !Object.values(map).includes(field)) map[i] = field;
    });
    return map;
  }

  async preview(a: RequestActor, table: string[][], override: Record<string, string> = {}) {
    if (table.length < 2) throw new BadRequestException('The file needs a header row and at least one client');
    if (table.length - 1 > MAX_ROWS) throw new BadRequestException(`At most ${MAX_ROWS} rows per import`);
    const headers = table[0]!.map((h) => h.trim());
    const map = this.mapHeaders(headers, override);
    if (!Object.values(map).includes('name')) throw new BadRequestException('No client-name column found (e.g. "Client Name" or "Party Name")');
    const seenPan = new Map<string, number>(); const seenGstin = new Map<string, number>();
    const rows: PreviewRow[] = table.slice(1).map((cells, k) => {
      const raw: Record<string, string> = {};
      for (const [i, f] of Object.entries(map)) raw[f] = (cells[Number(i)] ?? '').trim();
      const errors: string[] = []; const warnings: string[] = [];
      const gstins = (raw.gstin ?? '').split(/[,;\s]+/).map((g) => g.toUpperCase()).filter(Boolean);
      for (const g of gstins) if (!isValidGstin(g)) errors.push(`Invalid GSTIN ${g}`);
      let pan = (raw.pan ?? '').toUpperCase() || null;
      if (pan && !isValidPan(pan)) { errors.push(`Invalid PAN ${pan}`); pan = null; }
      const validG = gstins.filter(isValidGstin);
      if (!pan && validG[0]) { pan = panFromGstin(validG[0]); warnings.push('PAN taken from GSTIN'); }
      if (pan && validG.some((g) => panFromGstin(g) !== pan)) warnings.push('A GSTIN does not match the PAN');
      const entityType = parseEntity(raw.entityType ?? '', pan);
      if (!entityType) errors.push('Entity type missing (add a "Constitution" column or a PAN)');
      const phone = (raw.phone ?? '').replace(/[^\d+]/g, '');
      const candidate = {
        name: raw.name, tradeName: raw.tradeName || null, fileNo: raw.fileNo || null, entityType: entityType ?? 'OTHER', pan,
        tan: raw.tan?.toUpperCase() || null, email: raw.email || null, phone: phone ? (phone.length === 10 ? `+91${phone}` : phone) : null,
        addresses: raw.address && raw.city && raw.state && /^\d{6}$/.test(raw.pin ?? '') ? [{ kind: 'registered', line1: raw.address, city: raw.city, state: raw.state, pin: raw.pin! }] : undefined,
        tags: raw.tags ? raw.tags.split(/[,;]/).map((t) => t.trim()).filter(Boolean) : undefined, notes: raw.notes || null,
        registrations: validG.map((g, n) => ({ kind: 'GSTIN' as const, number: g, isPrimary: n === 0 })),
        contacts: raw.contactName ? [{ name: raw.contactName, phone: phone ? (phone.length === 10 ? `+91${phone}` : phone) : null, email: raw.email || null, isPrimary: true }] : [],
      };
      const parsed = clientCreate.safeParse(candidate);
      if (!parsed.success) for (const i of parsed.error.issues) errors.push(`${i.path.join('.') || 'row'}: ${i.message}`);
      if (raw.address && !candidate.addresses) warnings.push('Address skipped (needs address, city, state and a 6-digit PIN)');
      const rowNo = k + 2;
      if (pan) { if (seenPan.has(pan)) warnings.push(`Same PAN as row ${seenPan.get(pan)}`); else seenPan.set(pan, rowNo); }
      for (const g of validG) { if (seenGstin.has(g)) errors.push(`GSTIN ${g} repeats row ${seenGstin.get(g)}`); else seenGstin.set(g, rowNo); }
      return { row: rowNo, data: parsed.success && !errors.length ? parsed.data : null, errors: [...new Set(errors)], warnings };
    });
    // Existing clients with the same PAN/GSTIN (only visible ones are named; others just flagged).
    await this.db.tenantTx(a.tenantId, async (tx) => {
      const pans = [...seenPan.keys()]; const gs = [...seenGstin.keys()];
      if (!pans.length && !gs.length) return;
      const p = new Params([pans, gs]);
      const vis = clientScopeSql(a, 'clients', 'view', p);
      const hits = (await tx.query(`SELECT c.pan, r.number AS gstin, c.name, (${vis}) AS visible FROM client c
        LEFT JOIN client_registration r ON r.client_id = c.id AND r.deleted_at IS NULL AND r.number = ANY($2)
        WHERE c.deleted_at IS NULL AND (c.pan = ANY($1) OR r.number IS NOT NULL)`, p.values)).rows;
      for (const r of rows) {
        if (!r.data) continue;
        const gst = r.data.registrations.map((x) => x.number);
        for (const h of hits) {
          if (h.gstin && gst.includes(h.gstin)) r.errors.push(h.visible ? `GSTIN already belongs to "${h.name}"` : 'GSTIN already belongs to another client');
          else if (h.pan && h.pan === r.data.pan) r.warnings.push(h.visible ? `Existing client with this PAN: "${h.name}"` : 'An existing client has this PAN');
        }
        if (r.errors.length) r.data = null;
      }
    });
    return {
      headers, mapping: Object.fromEntries(Object.entries(map).map(([i, f]) => [headers[Number(i)]!, f])),
      rows, summary: { total: rows.length, valid: rows.filter((r) => r.data).length, withErrors: rows.filter((r) => !r.data).length, withWarnings: rows.filter((r) => r.warnings.length).length },
    };
  }

  /** Creates the confirmed rows one by one; a failing row never blocks the rest. */
  async commit(a: RequestActor, rows: ClientCreate[]) {
    const created: string[] = []; const failed: Array<{ index: number; error: string }> = [];
    for (const [i, r] of rows.entries()) {
      try { created.push((await this.clients.create(a, r)).id); } catch (e) { failed.push({ index: i, error: (e as Error).message }); }
    }
    return { created: created.length, ids: created, failed };
  }

  async export(a: RequestActor, format: 'csv' | 'xlsx'): Promise<{ name: string; mime: string; body: Buffer }> {
    const { items } = await this.clients.list(a, { limit: 100_000, offset: 0 }, 'export');
    await this.clients.auditExport(a, format, items.length);
    const cols = ['fileNo', 'name', 'tradeName', 'entityType', 'pan', 'primaryGstin', 'tan', 'email', 'phone', 'status', 'tags'] as const;
    const head = ['File no', 'Name', 'Trade name', 'Entity type', 'PAN', 'GSTIN', 'TAN', 'Email', 'Phone', 'Status', 'Tags'];
    const cell = (v: unknown) => (Array.isArray(v) ? v.join('; ') : v === null || v === undefined ? '' : String(v));
    const date = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      // Prefix formula-looking cells so spreadsheets don't execute them (CSV injection).
      const esc = (s: string) => { const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
      const body = [head, ...items.map((c) => cols.map((k) => cell(c[k])))].map((r) => r.map(esc).join(',')).join('\r\n');
      return { name: `clients-${date}.csv`, mime: 'text/csv; charset=utf-8', body: Buffer.from('﻿' + body) };
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Clients');
    ws.addRow(head).font = { bold: true };
    for (const c of items) ws.addRow(cols.map((k) => cell(c[k])));
    ws.columns.forEach((col) => { col.width = 18; });
    return { name: `clients-${date}.xlsx`, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: Buffer.from(await wb.xlsx.writeBuffer()) };
  }
}
