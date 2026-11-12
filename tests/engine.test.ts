import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compare, inSchedule, RuleEngine } from '../src/rules/engine.ts';
import type { Rule } from '../src/types.ts';

const rule = (overrides: Partial<Rule> = {}, trigger: Partial<Rule['trigger']> = {}): Rule => ({
  id: 'r1',
  name: 'Présence',
  enabled: true,
  trigger: { deviceId: 'd1', capability: 'occupancy', operator: 'eq', value: true, ...trigger },
  actions: [{ type: 'booth', event: 'countdown' }],
  ...overrides,
});

/** Horloge manipulable : 12 nov. 2026, 14:00 à Paris (13:00 UTC). */
function clock(iso = '2026-11-12T13:00:00Z') {
  let t = new Date(iso).getTime();
  return { now: () => new Date(t), advance: (s: number) => (t += s * 1000) };
}

describe('compare', () => {
  it('compare les binaires de façon souple (booléen, ON/OFF, 1/0)', () => {
    assert.equal(compare(true, 'eq', true), true);
    assert.equal(compare('ON', 'eq', true), true);
    assert.equal(compare(0, 'eq', false), true);
    assert.equal(compare('OFF', 'neq', true), true);
  });
  it('compare les nombres et les textes', () => {
    assert.equal(compare(25.2, 'gt', 25), true);
    assert.equal(compare(18, 'lt', 19), true);
    assert.equal(compare('single', 'eq', 'SINGLE'), true);
    assert.equal(compare('abc', 'gt', 3), false);
    assert.equal(compare(null, 'eq', true), false);
  });
});

describe('inSchedule (Europe/Paris)', () => {
  it('sans fenêtre, toujours vrai', () => assert.equal(inSchedule(undefined, new Date()), true));
  it('fenêtre de jour', () => {
    // 13:00 UTC = 14:00 à Paris en novembre
    assert.equal(inSchedule({ after: '09:00', before: '18:00' }, new Date('2026-11-12T13:00:00Z')), true);
    assert.equal(inSchedule({ after: '15:00' }, new Date('2026-11-12T13:00:00Z')), false);
    assert.equal(inSchedule({ before: '14:00' }, new Date('2026-11-12T13:00:00Z')), false);
  });
  it('fenêtre de nuit (after > before)', () => {
    const window = { after: '22:00', before: '06:00' };
    assert.equal(inSchedule(window, new Date('2026-11-12T22:30:00Z')), true); // 23:30 Paris
    assert.equal(inSchedule(window, new Date('2026-11-12T04:00:00Z')), true); // 05:00 Paris
    assert.equal(inSchedule(window, new Date('2026-11-12T12:00:00Z')), false);
  });
});

describe('RuleEngine', () => {
  it('se déclenche sur le front montant, une seule fois tant que la condition reste vraie', () => {
    const engine = new RuleEngine(clock());
    engine.setRules([rule()]);
    assert.equal(engine.handleReading('d1', 'occupancy', true).length, 1);
    assert.equal(engine.handleReading('d1', 'occupancy', true).length, 0);
    assert.equal(engine.handleReading('d1', 'occupancy', false).length, 0);
    assert.equal(engine.handleReading('d1', 'occupancy', true).length, 1);
  });

  it('ignore les autres appareils, capacités et règles désactivées', () => {
    const engine = new RuleEngine(clock());
    engine.setRules([rule(), rule({ id: 'r2', enabled: false })]);
    assert.equal(engine.handleReading('d2', 'occupancy', true).length, 0);
    assert.equal(engine.handleReading('d1', 'contact', true).length, 0);
    assert.deepEqual(
      engine.handleReading('d1', 'occupancy', true).map((r) => r.id),
      ['r1'],
    );
  });

  it('forSeconds : attend que la condition soit tenue', () => {
    const c = clock();
    const engine = new RuleEngine(c);
    engine.setRules([rule({}, { forSeconds: 30 })]);
    assert.equal(engine.handleReading('d1', 'occupancy', true).length, 0);
    c.advance(29);
    assert.equal(engine.tick().length, 0);
    c.advance(1);
    assert.equal(engine.tick().length, 1);
    c.advance(60);
    assert.equal(engine.tick().length, 0, 'pas de second déclenchement');
  });

  it('forSeconds : la condition retombée annule le déclenchement', () => {
    const c = clock();
    const engine = new RuleEngine(c);
    engine.setRules([rule({}, { forSeconds: 10 })]);
    engine.handleReading('d1', 'occupancy', true);
    c.advance(5);
    engine.handleReading('d1', 'occupancy', false);
    c.advance(10);
    assert.equal(engine.tick().length, 0);
  });

  it('hors de la fenêtre horaire, le front est ignoré', () => {
    const engine = new RuleEngine(clock('2026-11-12T13:00:00Z'));
    engine.setRules([rule({ schedule: { after: '20:00', before: '23:00' } })]);
    assert.equal(engine.handleReading('d1', 'occupancy', true).length, 0);
  });

  it("une règle modifiée repart d'un état neuf", () => {
    const engine = new RuleEngine(clock());
    engine.setRules([rule()]);
    engine.handleReading('d1', 'occupancy', true);
    engine.setRules([rule({ name: 'Renommée' })]);
    assert.equal(engine.handleReading('d1', 'occupancy', true).length, 1);
  });

  it('seuil numérique', () => {
    const engine = new RuleEngine(clock());
    engine.setRules([rule({}, { capability: 'temperature', operator: 'gt', value: 26 })]);
    assert.equal(engine.handleReading('d1', 'temperature', 25.9).length, 0);
    assert.equal(engine.handleReading('d1', 'temperature', 26.4).length, 1);
    assert.equal(engine.handleReading('d1', 'temperature', 27).length, 0);
  });
});
