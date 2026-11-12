// Moteur de règles « si … alors … » (module pur : horloge injectable, aucun effet de bord).
// Il dit quelles règles se déclenchent ; l'exécution des actions est faite ailleurs.

import type { Operator, Rule, Value } from '../types.ts';

export const TIME_ZONE = 'Europe/Paris';

interface RuleState {
  /** La condition est vraie depuis `since` (ms). */
  since: number;
  /** La règle a déjà été évaluée pour ce front (déclenchée, ou ignorée hors fenêtre horaire). */
  done: boolean;
}

/** Interprète une valeur binaire (booléen, ON/OFF, 1/0, "true"). */
export function toBoolean(value: Value | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const v = value.trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(v)) return true;
  if (['off', 'false', '0', 'no'].includes(v)) return false;
  return null;
}

/** Compare la valeur reçue à celle de la règle, selon le type de la valeur attendue. */
export function compare(actual: Value | undefined, operator: Operator, expected: boolean | number | string): boolean {
  if (actual === null || actual === undefined) return false;
  if (operator === 'gt' || operator === 'lt') {
    const a = Number(actual);
    const b = Number(expected);
    if (typeof actual === 'boolean' || !Number.isFinite(a) || !Number.isFinite(b)) return false;
    return operator === 'gt' ? a > b : a < b;
  }
  let equal: boolean;
  if (typeof expected === 'boolean') equal = toBoolean(actual) === expected;
  else if (typeof expected === 'number') equal = Number(actual) === expected;
  else equal = String(actual).toLowerCase() === expected.toLowerCase();
  return operator === 'eq' ? equal : !equal;
}

/** Minutes écoulées depuis minuit dans le fuseau donné. */
export function minutesOfDay(date: Date, timeZone = TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** Fenêtre horaire `after`–`before` (bornes optionnelles ; `after > before` = fenêtre de nuit). */
export function inSchedule(schedule: Rule['schedule'], date: Date, timeZone = TIME_ZONE): boolean {
  if (!schedule || (!schedule.after && !schedule.before)) return true;
  const now = minutesOfDay(date, timeZone);
  const after = schedule.after ? toMinutes(schedule.after) : null;
  const before = schedule.before ? toMinutes(schedule.before) : null;
  if (after !== null && before !== null) {
    return after <= before ? now >= after && now < before : now >= after || now < before;
  }
  if (after !== null) return now >= after;
  return now < (before as number);
}

export class RuleEngine {
  private rules: Rule[] = [];
  private states = new Map<string, RuleState>();
  private readonly now: () => Date;
  private readonly timeZone: string;

  constructor(options: { now?: () => Date; timeZone?: string } = {}) {
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? TIME_ZONE;
  }

  /** Remplace les règles. L'état d'une règle modifiée (ou supprimée) est oublié. */
  setRules(rules: Rule[]) {
    const previous = new Map(this.rules.map((r) => [r.id, JSON.stringify(r)]));
    for (const rule of rules) {
      if (previous.get(rule.id) !== JSON.stringify(rule)) this.states.delete(rule.id);
    }
    const ids = new Set(rules.map((r) => r.id));
    for (const id of this.states.keys()) if (!ids.has(id)) this.states.delete(id);
    this.rules = rules;
  }

  /**
   * Nouvelle valeur d'une capacité d'un appareil. Renvoie les règles à déclencher maintenant
   * (front montant de la condition, sans `forSeconds`, dans la fenêtre horaire).
   */
  handleReading(deviceId: string, capability: string, value: Value): Rule[] {
    const now = this.now();
    const fired: Rule[] = [];
    for (const rule of this.rules) {
      if (!rule.enabled || rule.trigger.deviceId !== deviceId || rule.trigger.capability !== capability) continue;
      const matches = compare(value, rule.trigger.operator, rule.trigger.value);
      if (!matches) {
        this.states.delete(rule.id);
        continue;
      }
      if (this.states.has(rule.id)) continue; // condition déjà vraie : pas de nouveau front
      const state: RuleState = { since: now.getTime(), done: false };
      this.states.set(rule.id, state);
      if (!rule.trigger.forSeconds) {
        state.done = true;
        if (inSchedule(rule.schedule, now, this.timeZone)) fired.push(rule);
      }
    }
    return fired;
  }

  /** À appeler régulièrement : déclenche les règles dont la condition est tenue depuis `forSeconds`. */
  tick(): Rule[] {
    const now = this.now();
    const fired: Rule[] = [];
    for (const rule of this.rules) {
      const state = this.states.get(rule.id);
      const hold = rule.trigger.forSeconds;
      if (!rule.enabled || !state || state.done || !hold) continue;
      if (now.getTime() - state.since < hold * 1000) continue;
      state.done = true;
      if (inSchedule(rule.schedule, now, this.timeZone)) fired.push(rule);
    }
    return fired;
  }
}
