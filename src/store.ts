// Accès aux données : conversion des lignes SQLite vers les formes du contrat.

import { randomUUID } from 'node:crypto';

import { nowIso, type Db } from './db.ts';
import type { Hub } from './realtime.ts';
import type { Capability, Device, EventType, JournalEvent, PartyEvent, Rule, Terminal, User, Value } from './types.ts';

type Row = Record<string, unknown>;

const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function toUser(row: Row): User {
  return { id: String(row.id), name: String(row.name), email: String(row.email), role: row.role as User['role'] };
}

export function toPartyEvent(row: Row): PartyEvent {
  return { id: String(row.id), name: String(row.name), date: String(row.date), code: String(row.code) };
}

export function toTerminal(row: Row): Terminal {
  return {
    id: String(row.id),
    name: String(row.name),
    online: row.online === 1,
    lastSeenAt: String(row.last_seen_at),
    permitJoinUntil: str(row.permit_join_until),
  };
}

export function toRule(row: Row): Rule {
  const rule: Rule = {
    id: String(row.id),
    name: String(row.name),
    enabled: row.enabled === 1,
    trigger: JSON.parse(String(row.trigger)),
    actions: JSON.parse(String(row.actions)),
  };
  if (row.schedule) rule.schedule = JSON.parse(String(row.schedule));
  return rule;
}

function capabilitiesOf(db: Db, deviceId: string): Capability[] {
  const rows = db.prepare('SELECT * FROM capabilities WHERE device_id = ? ORDER BY position, name').all(deviceId);
  return rows.map((r) => {
    const cap: Capability = { name: String(r.name), type: r.type as Capability['type'], access: r.access as Capability['access'] };
    if (r.unit) cap.unit = String(r.unit);
    if (r.enum_values) cap.values = JSON.parse(String(r.enum_values));
    return cap;
  });
}

export function toDevice(db: Db, row: Row): Device {
  return {
    id: String(row.id),
    terminalId: String(row.terminal_id),
    ieee: String(row.ieee),
    model: String(row.model),
    name: String(row.name),
    location: str(row.location),
    enabled: row.enabled === 1,
    online: row.online === 1,
    battery: row.battery === null || row.battery === undefined ? null : Number(row.battery),
    lastSeenAt: String(row.last_seen_at),
    capabilities: capabilitiesOf(db, String(row.id)),
    state: JSON.parse(String(row.state)) as Record<string, Value>,
  };
}

export function getDevice(db: Db, id: string): Device | null {
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
  return row ? toDevice(db, row) : null;
}

export function listDevices(db: Db, terminalId?: string): Device[] {
  const rows = terminalId
    ? db.prepare('SELECT * FROM devices WHERE terminal_id = ? ORDER BY created_at, rowid').all(terminalId)
    : db.prepare('SELECT * FROM devices ORDER BY created_at, rowid').all();
  return rows.map((r) => toDevice(db, r));
}

export function listRules(db: Db): Rule[] {
  return db.prepare('SELECT * FROM rules ORDER BY created_at').all().map(toRule);
}

/** Événement « en cours » : le plus récemment créé. */
export function currentEvent(db: Db): PartyEvent | null {
  const row = db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT 1').get();
  return row ? toPartyEvent(row) : null;
}

const JOURNAL_SELECT = `SELECT j.id, j.ts, j.type, j.device_id, d.name AS device_name, j.message
  FROM journal j LEFT JOIN devices d ON d.id = j.device_id`;

function toJournalEvent(row: Row): JournalEvent {
  return {
    id: String(row.id),
    ts: String(row.ts),
    type: row.type as EventType,
    deviceId: str(row.device_id),
    deviceName: str(row.device_name),
    message: String(row.message),
  };
}

/** Ajoute une entrée au journal et la diffuse (`event.created`) aux administrateurs. */
export function addJournal(db: Db, hub: Hub, entry: { type: EventType; deviceId?: string | null; message: string; ts?: string }) {
  const id = randomUUID();
  db.prepare('INSERT INTO journal (id, ts, type, device_id, message) VALUES (?, ?, ?, ?, ?)').run(
    id,
    entry.ts ?? nowIso(),
    entry.type,
    entry.deviceId ?? null,
    entry.message,
  );
  const event = toJournalEvent(db.prepare(`${JOURNAL_SELECT} WHERE j.id = ?`).get(id) as Row);
  hub.broadcast('event.created', event, ['admin']);
  return event;
}

export function listJournal(db: Db, filters: { deviceId?: string; type?: string; from?: string; to?: string; limit: number }) {
  const where: string[] = [];
  const params: string[] = [];
  const add = (clause: string, value?: string) => {
    if (!value) return;
    where.push(clause);
    params.push(value);
  };
  add('j.device_id = ?', filters.deviceId);
  add('j.type = ?', filters.type);
  add('j.ts >= ?', filters.from);
  add('j.ts <= ?', filters.to);
  const sql = `${JOURNAL_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY j.ts DESC, j.seq DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...params, filters.limit)
    .map(toJournalEvent);
}
