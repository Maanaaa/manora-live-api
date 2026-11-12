// Parc : terminaux, appareils, ingestion des événements, commandes et règles.

import { randomUUID } from 'node:crypto';

import { toIso, type Db } from './db.ts';
import { HttpError, notFound } from './errors.ts';
import { normalizeCapability, normalizeIeee, normalizeTerminalEvents } from './normalize.ts';
import { notifyStaff, type PushSender } from './push.ts';
import type { Hub } from './realtime.ts';
import { RuleEngine } from './rules/engine.ts';
import { addJournal, getDevice, listDevices, listRules, toDevice, toTerminal } from './store.ts';
import type { Device, Rule, Value } from './types.ts';

/** Sans battement depuis 90 s, le terminal passe hors ligne (contrat). */
export const TERMINAL_TIMEOUT_MS = 90_000;
/** Sans nouvelles depuis 2 h, un appareil passe hors ligne (les capteurs sur pile se signalent au moins toutes les heures). */
export const DEVICE_TIMEOUT_MS = 2 * 60 * 60 * 1000;
/** Délai d'attente du retour d'état réel après une commande (contrat). */
export const COMMAND_TIMEOUT_MS = 5000;
/** Les événements plus vieux (file du Pi rejouée) sont enregistrés mais ne déclenchent pas les règles. */
export const RULE_MAX_AGE_MS = 2 * 60 * 1000;

interface Logger {
  error: (obj: unknown, msg?: string) => void;
}

export interface FleetDeps {
  db: Db;
  hub: Hub;
  push: PushSender;
  log: Logger;
  now?: () => Date;
}

const formatValue = (v: Value) => (v === null ? '—' : typeof v === 'boolean' ? (v ? 'oui' : 'non') : String(v));

export class Fleet {
  readonly engine: RuleEngine;
  private readonly db: Db;
  private readonly hub: Hub;
  private readonly push: PushSender;
  private readonly log: Logger;
  private readonly now: () => Date;
  private waiters = new Map<string, Set<() => void>>();

  constructor(deps: FleetDeps) {
    this.db = deps.db;
    this.hub = deps.hub;
    this.push = deps.push;
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
    this.engine = new RuleEngine({ now: this.now });
    this.reloadRules();
  }

  reloadRules() {
    this.engine.setRules(listRules(this.db));
  }

  // ---------- Terminaux ----------

  private broadcastTerminal(id: string) {
    const row = this.db.prepare('SELECT * FROM terminals WHERE id = ?').get(id);
    if (!row) return;
    const t = toTerminal(row);
    this.hub.broadcast('terminal.status', { terminalId: t.id, online: t.online, permitJoinUntil: t.permitJoinUntil }, ['admin']);
  }

  heartbeat(terminalId: string) {
    const row = this.db.prepare('SELECT online FROM terminals WHERE id = ?').get(terminalId);
    this.db.prepare('UPDATE terminals SET last_seen_at = ?, online = 1 WHERE id = ?').run(toIso(this.now()), terminalId);
    if (row?.online !== 1) {
      this.broadcastTerminal(terminalId);
      addJournal(this.db, this.hub, { type: 'online', message: `Terminal ${terminalId} en ligne` });
    }
  }

  permitJoin(terminalId: string, seconds: number): string {
    if (!this.db.prepare('SELECT 1 FROM terminals WHERE id = ?').get(terminalId)) throw notFound('Terminal');
    if (!this.hub.sendToTerminal(terminalId, 'terminal.permit_join', { seconds })) {
      throw new HttpError(504, 'Le terminal ne répond pas.');
    }
    const until = toIso(new Date(this.now().getTime() + seconds * 1000));
    this.db.prepare('UPDATE terminals SET permit_join_until = ? WHERE id = ?').run(until, terminalId);
    this.broadcastTerminal(terminalId);
    return until;
  }

  // ---------- Appareils ----------

  /** `PUT /terminal/devices` : crée les appareils inconnus, met à jour les autres, ne supprime rien. */
  syncDevices(terminalId: string, devices: unknown[]): Device[] {
    const now = toIso(this.now());
    for (const input of devices) {
      const d = (input ?? {}) as Record<string, unknown>;
      const ieee = normalizeIeee(d.ieee);
      if (!ieee || typeof d.model !== 'string') continue;
      const vendor = typeof d.vendor === 'string' ? d.vendor : null;
      const description = typeof d.description === 'string' ? d.description : null;
      const caps = (Array.isArray(d.capabilities) ? d.capabilities : []).map(normalizeCapability).filter((c) => c !== null);

      const existing = this.db.prepare('SELECT id FROM devices WHERE ieee = ?').get(ieee);
      const id = existing ? String(existing.id) : randomUUID();
      if (existing) {
        this.db
          .prepare('UPDATE devices SET terminal_id = ?, model = ?, vendor = ?, description = ? WHERE id = ?')
          .run(terminalId, d.model, vendor, description, id);
      } else {
        this.db
          .prepare(
            `INSERT INTO devices (id, terminal_id, ieee, model, vendor, description, name, online, last_seen_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(id, terminalId, ieee, d.model, vendor, description, description || d.model, now, now);
      }
      this.db.prepare('DELETE FROM capabilities WHERE device_id = ?').run(id);
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO capabilities (device_id, name, type, unit, enum_values, access, position) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      caps.forEach((c, i) => insert.run(id, c.name, c.type, c.unit ?? null, c.values ? JSON.stringify(c.values) : null, c.access, i));

      if (!existing) {
        const device = getDevice(this.db, id) as Device;
        this.hub.broadcast('device.joined', device, ['admin']);
        addJournal(this.db, this.hub, { type: 'joined', deviceId: id, message: `Nouvel appareil : ${device.name} (${device.model})` });
      }
    }
    return listDevices(this.db, terminalId);
  }

  /** `POST /terminal/events` : enregistre les mesures, met l'état à jour, diffuse et évalue les règles. */
  ingest(terminalId: string, input: unknown): number {
    const now = this.now();
    const { events } = normalizeTerminalEvents(input, terminalId, now);
    let accepted = 0;

    for (const event of events) {
      const row = this.db.prepare('SELECT * FROM devices WHERE ieee = ? AND terminal_id = ?').get(event.ieee, terminalId);
      if (!row) continue; // appareil pas encore déclaré par PUT /terminal/devices
      const before = toDevice(this.db, row);
      const types = new Map(before.capabilities.map((c) => [c.name, c.type]));
      const state = { ...before.state, ...event.readings };
      const lastSeenAt = event.ts > before.lastSeenAt ? event.ts : before.lastSeenAt;
      const online = now.getTime() - new Date(lastSeenAt).getTime() < DEVICE_TIMEOUT_MS;
      const battery = typeof event.readings.battery === 'number' ? event.readings.battery : before.battery;

      this.db
        .prepare('UPDATE devices SET state = ?, last_seen_at = ?, online = ?, battery = ? WHERE id = ?')
        .run(JSON.stringify(state), lastSeenAt, online ? 1 : 0, battery, before.id);
      const insert = this.db.prepare('INSERT INTO readings (device_id, capability, ts, value) VALUES (?, ?, ?, ?)');
      for (const [cap, value] of Object.entries(event.readings)) insert.run(before.id, cap, event.ts, JSON.stringify(value));
      accepted += 1;

      this.hub.broadcast('device.reading', { deviceId: before.id, state, ts: event.ts }, ['admin', 'host']);
      if (online !== before.online || battery !== before.battery) {
        this.hub.broadcast('device.status', { deviceId: before.id, online, battery }, ['admin', 'host']);
        if (online && !before.online) addJournal(this.db, this.hub, { type: 'online', deviceId: before.id, message: `${before.name} en ligne` });
      }

      // Journal : changements d'état des capacités binaires et énumérées (les mesures numériques vont dans l'historique).
      for (const [cap, value] of Object.entries(event.readings)) {
        const type = types.get(cap);
        if ((type === 'binary' || type === 'enum') && before.state[cap] !== value) {
          addJournal(this.db, this.hub, { type: 'reading', deviceId: before.id, message: `${cap} : ${formatValue(value)}`, ts: event.ts });
        }
      }

      this.resolveWaiters(before.id, Object.keys(event.readings));
      if (before.enabled && now.getTime() - new Date(event.ts).getTime() < RULE_MAX_AGE_MS) {
        for (const [cap, value] of Object.entries(event.readings)) {
          for (const rule of this.engine.handleReading(before.id, cap, value)) this.runRule(rule);
        }
      }
    }
    return accepted;
  }

  // ---------- Commandes ----------

  private resolveWaiters(deviceId: string, capabilities: string[]) {
    for (const cap of capabilities) {
      const key = `${deviceId}:${cap}`;
      this.waiters.get(key)?.forEach((resolve) => resolve());
      this.waiters.delete(key);
    }
  }

  private waitForState(deviceId: string, capability: string): Promise<boolean> {
    const key = `${deviceId}:${capability}`;
    return new Promise((resolve) => {
      const set = this.waiters.get(key) ?? new Set();
      this.waiters.set(key, set);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        set.delete(done);
        if (!set.size) this.waiters.delete(key);
        resolve(false);
      }, COMMAND_TIMEOUT_MS);
      set.add(done);
    });
  }

  /** Envoie `terminal.command` ; avec `wait`, attend le retour d'état réel (504 au-delà de 5 s). */
  async sendCommand(deviceId: string, capability: string, value: boolean | number | string, wait: boolean): Promise<Device> {
    const device = getDevice(this.db, deviceId);
    if (!device) throw notFound('Appareil');
    if (!device.enabled) throw new HttpError(409, 'Cet appareil est désactivé.');
    const cap = device.capabilities.find((c) => c.name === capability);
    if (!cap || cap.access === 'read') throw new HttpError(400, `La capacité « ${capability} » ne peut pas être commandée.`);
    if (cap.type === 'numeric' && typeof value !== 'number') throw new HttpError(400, 'Valeur numérique attendue.');
    if (cap.type === 'enum' && !cap.values?.includes(String(value))) throw new HttpError(400, 'Valeur non autorisée pour cette capacité.');

    const pending = wait ? this.waitForState(deviceId, capability) : null;
    const sent = this.hub.sendToTerminal(device.terminalId, 'terminal.command', {
      commandId: randomUUID(),
      ieee: device.ieee,
      capability,
      value,
    });
    if (!sent) {
      this.resolveWaiters(deviceId, [capability]);
      throw new HttpError(504, 'Le terminal ne répond pas.');
    }
    addJournal(this.db, this.hub, { type: 'command', deviceId, message: `Commande ${capability} → ${formatValue(value)}` });
    if (pending && !(await pending)) throw new HttpError(504, "L'appareil n'a pas confirmé la commande à temps.");
    return getDevice(this.db, deviceId) as Device;
  }

  // ---------- Règles ----------

  runRule(rule: Rule) {
    const notes = rule.actions.filter((a) => a.type === 'notify').map((a) => a.message);
    addJournal(this.db, this.hub, {
      type: 'rule',
      deviceId: rule.trigger.deviceId,
      message: `Règle « ${rule.name} » déclenchée${notes.length ? ` : ${notes.join(' — ')}` : ''}`,
    });
    for (const action of rule.actions) {
      if (action.type === 'notify') {
        notifyStaff(this.db, this.push, action.message).catch((err) => this.log.error(err, 'Échec de la notification push'));
      } else if (action.type === 'command') {
        this.sendCommand(action.deviceId, action.capability, action.value, false).catch((err) =>
          this.log.error(err, `Règle « ${rule.name} » : commande impossible`),
        );
      } else {
        this.hub.broadcast(`booth.${action.event}`, {}, ['booth']);
      }
    }
  }

  /** Règles avec `forSeconds` : à appeler chaque seconde. */
  tick() {
    for (const rule of this.engine.tick()) this.runRule(rule);
  }

  // ---------- Surveillance ----------

  /** Passe hors ligne les terminaux et appareils silencieux. */
  sweep() {
    const now = this.now().getTime();
    const terminalLimit = toIso(new Date(now - TERMINAL_TIMEOUT_MS));
    for (const t of this.db.prepare('SELECT id FROM terminals WHERE online = 1 AND last_seen_at < ?').all(terminalLimit)) {
      this.db.prepare('UPDATE terminals SET online = 0 WHERE id = ?').run(t.id as string);
      this.broadcastTerminal(String(t.id));
      addJournal(this.db, this.hub, { type: 'offline', message: `Terminal ${String(t.id)} hors ligne` });
    }
    const deviceLimit = toIso(new Date(now - DEVICE_TIMEOUT_MS));
    for (const d of this.db.prepare('SELECT id, name, battery FROM devices WHERE online = 1 AND last_seen_at < ?').all(deviceLimit)) {
      this.db.prepare('UPDATE devices SET online = 0 WHERE id = ?').run(d.id as string);
      this.hub.broadcast('device.status', { deviceId: d.id, online: false, battery: d.battery ?? null }, ['admin', 'host']);
      addJournal(this.db, this.hub, { type: 'offline', deviceId: String(d.id), message: `${String(d.name)} hors ligne` });
    }
  }

  /** RGPD : supprime les mesures et le journal plus vieux que `days` jours. */
  purge(days: number) {
    const limit = toIso(new Date(this.now().getTime() - days * 86_400_000));
    const readings = this.db.prepare('DELETE FROM readings WHERE ts < ?').run(limit).changes;
    const journal = this.db.prepare('DELETE FROM journal WHERE ts < ?').run(limit).changes;
    return { readings: Number(readings), journal: Number(journal) };
  }
}
