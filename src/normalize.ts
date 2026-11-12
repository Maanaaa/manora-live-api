// Normalisation et validation des messages envoyés par le terminal (module pur, sans effet de bord).

import { toIso } from './db.ts';
import type { Capability, Value } from './types.ts';

export interface NormalizedEvent {
  ieee: string;
  model: string;
  readings: Record<string, Value>;
  ts: string;
}

export interface NormalizeResult {
  events: NormalizedEvent[];
  rejected: number;
}

/** Tolérance d'avance de l'horloge du Pi : au-delà, l'horodatage est ramené à « maintenant ». */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_STRING = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function normalizeIeee(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ieee = value.trim().toLowerCase();
  return ieee.length > 0 && ieee.length <= 64 ? ieee : null;
}

/** Garde les valeurs simples (booléen, nombre fini, texte court, null) dont le nom est valide. */
export function normalizeReadings(input: unknown): Record<string, Value> {
  const out: Record<string, Value> = {};
  if (!isObject(input)) return out;
  for (const [key, raw] of Object.entries(input)) {
    if (!NAME_RE.test(key)) continue;
    if (raw === null || typeof raw === 'boolean') out[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
    else if (typeof raw === 'string' && raw.length <= MAX_STRING) out[key] = raw;
  }
  return out;
}

/**
 * Valide un lot `TerminalEvent[]` reçu sur `POST /terminal/events`.
 * Rejette les événements d'un autre terminal, sans appareil, sans date lisible ou sans mesure valide.
 * Les événements gardés sont triés par date (la file locale du Pi peut arriver dans le désordre).
 */
export function normalizeTerminalEvents(input: unknown, terminalId: string, now: Date = new Date()): NormalizeResult {
  const list = Array.isArray(input) ? input : [];
  const events: NormalizedEvent[] = [];
  let rejected = 0;

  for (const raw of list) {
    const event = isObject(raw) ? raw : null;
    const ieee = normalizeIeee(event?.device);
    const date = typeof event?.ts === 'string' ? new Date(event.ts) : null;
    const readings = normalizeReadings(event?.readings);

    if (!event || event.terminal !== terminalId || !ieee || !date || Number.isNaN(date.getTime()) || !Object.keys(readings).length) {
      rejected += 1;
      continue;
    }
    const ts = date.getTime() - now.getTime() > MAX_CLOCK_SKEW_MS ? now : date;
    events.push({ ieee, model: typeof event.model === 'string' ? event.model.trim() : '', readings, ts: toIso(ts) });
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return { events, rejected };
}

/** Valide une capacité déclarée par le terminal ; `null` si elle est inutilisable. */
export function normalizeCapability(input: unknown): Capability | null {
  if (!isObject(input) || typeof input.name !== 'string' || !NAME_RE.test(input.name)) return null;
  if (input.type !== 'binary' && input.type !== 'numeric' && input.type !== 'enum') return null;
  const access = input.access === 'write' || input.access === 'readwrite' ? input.access : 'read';
  const cap: Capability = { name: input.name, type: input.type, access };
  if (typeof input.unit === 'string' && input.unit) cap.unit = input.unit;
  if (input.type === 'enum') {
    cap.values = Array.isArray(input.values) ? input.values.filter((v): v is string => typeof v === 'string') : [];
  }
  return cap;
}
