import { NotFoundException } from '@nestjs/common';
import { PORTAL_INBOX_CATEGORY, portalGrantsSchema, portalSettingsSchema, type PortalArea, type PortalGrants, type PortalSettings, portalAllows } from '@worko/domain';
import type { PortalActor, RequestActor } from '../auth/context.js';
import type { Tx } from '../db/db.service.js';
import { insertNotifications, type NotifyInput } from '../notifications/insert.js';
import { systemActor } from '../tasks/system-actor.js';

export type Access = { id: string; clientId: string; contactId: string | null; grants: PortalGrants; client: Record<string, unknown> & { id: string; name: string } };

/** Server-side identity for writes made on behalf of a portal user (audited with a null staff actor and `portal:<session>` device). */
export function portalWriter(p: PortalActor): RequestActor {
  return { ...systemActor(p.tenantId), deviceId: `portal:${p.sessionId}` };
}

/**
 * The portal user's live access to a client: an un-revoked grant row, a portal-enabled, non-deleted client. Everything the
 * portal shows is scoped from here — the clientId in the URL is never trusted on its own. Anything else = 404.
 */
export async function loadAccess(tx: Tx, p: PortalActor, clientId: string, area?: PortalArea): Promise<Access> {
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new NotFoundException();
  const r = (await tx.query(`SELECT a.id, a.contact_id, a.grants, row_to_json(c) AS client FROM portal_access a JOIN client c ON c.id = a.client_id
    WHERE a.portal_user_id = $1 AND a.client_id = $2 AND a.revoked_at IS NULL AND c.portal_enabled AND c.deleted_at IS NULL`, [p.portalUserId, clientId])).rows[0];
  if (!r) throw new NotFoundException();
  const grants = portalGrantsSchema.parse(r.grants ?? {});
  if (area && !portalAllows(grants, area)) throw new NotFoundException();
  return { id: r.id, clientId, contactId: r.contact_id, grants, client: r.client };
}

export async function loadPortalSettings(tx: Tx): Promise<PortalSettings> {
  const r = (await tx.query('SELECT settings FROM portal_settings WHERE tenant_id = current_tenant()')).rows[0];
  return portalSettingsSchema.parse(r?.settings ?? {});
}

/**
 * SQL predicate (alias `d`) for documents a portal user may see: staff-shared (`client_visible`) documents inside the category/FY
 * grants, plus the user's OWN uploads while they are still in the "From client" inbox (once staff re-file one, normal rules apply) — D137.
 */
export function portalDocSql(g: PortalGrants, add: (v: unknown) => string, portalUserId: string): string {
  if (!g.documents.enabled) return 'FALSE';
  const cats = g.documents.categories.includes('*') ? 'TRUE' : `lower(d.category) = ANY(${add(g.documents.categories.map((c) => c.toLowerCase()))}::text[])`;
  const fys = g.documents.fys.includes('*') ? 'TRUE' : `d.fy = ANY(${add(g.documents.fys)}::text[])`;
  const own = `(d.source = 'portal' AND d.portal_user_id = ${add(portalUserId)}::uuid AND d.category = ${add(PORTAL_INBOX_CATEGORY)})`;
  return `d.deleted_at IS NULL AND d.scan_status = 'clean' AND (${own} OR (d.client_visible AND ${cats} AND ${fys}))`;
}

/** Staff responsible for a client (partner, manager, else assigned staff) — who hears about portal activity. */
export function clientStaff(c: Record<string, unknown>): string[] {
  const ids = [c.partner_id, c.manager_id].filter((x): x is string => typeof x === 'string');
  return ids.length ? ids : ((c.staff_ids as string[]) ?? []);
}

export async function notifyStaff(tx: Tx, tenantId: string, userIds: Array<string | null | undefined>, i: Omit<NotifyInput, 'userIds'>) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return 0;
  // Only active staff (never a deactivated user).
  const live = (await tx.query(`SELECT id FROM app_user WHERE id = ANY($1::uuid[]) AND status = 'active' AND deleted_at IS NULL AND kind = 'staff'`, [ids])).rows.map((r) => r.id as string);
  if (!live.length) return 0;
  return (await insertNotifications(tx, tenantId, { ...i, userIds: live })).cursor;
}

export const portalUrl = (slug: string) => `${process.env.PORTAL_PUBLIC_URL ?? 'http://localhost:5173/#/portal'}/${encodeURIComponent(slug)}`;
