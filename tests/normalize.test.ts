import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeCapability, normalizeReadings, normalizeTerminalEvents } from '../src/normalize.ts';

const now = new Date('2026-11-12T10:00:00Z');
const event = (overrides: Record<string, unknown> = {}) => ({
  terminal: 'pi',
  device: ' 0x00158D0001 ',
  model: 'RTCGQ11LM',
  readings: { occupancy: true },
  ts: '2026-11-12T09:59:00.123Z',
  ...overrides,
});

describe('normalizeTerminalEvents', () => {
  it('normalise ieee, date et modèle', () => {
    const { events, rejected } = normalizeTerminalEvents([event()], 'pi', now);
    assert.equal(rejected, 0);
    assert.deepEqual(events, [{ ieee: '0x00158d0001', model: 'RTCGQ11LM', readings: { occupancy: true }, ts: '2026-11-12T09:59:00Z' }]);
  });

  it("rejette un autre terminal, un appareil absent, une date illisible ou l'absence de mesure", () => {
    const { events, rejected } = normalizeTerminalEvents(
      [event({ terminal: 'autre' }), event({ device: '' }), event({ ts: 'hier' }), event({ readings: { 'pas valide': 1 } }), 'texte', null],
      'pi',
      now,
    );
    assert.equal(events.length, 0);
    assert.equal(rejected, 6);
  });

  it('trie la file rejouée par date et ramène les dates futures à maintenant', () => {
    const { events } = normalizeTerminalEvents(
      [event({ ts: '2026-11-12T09:58:00Z' }), event({ ts: '2026-11-12T09:00:00Z' }), event({ ts: '2026-11-13T00:00:00Z' })],
      'pi',
      now,
    );
    assert.deepEqual(
      events.map((e) => e.ts),
      ['2026-11-12T09:00:00Z', '2026-11-12T09:58:00Z', '2026-11-12T10:00:00Z'],
    );
  });

  it("ignore une entrée qui n'est pas une liste", () => {
    assert.deepEqual(normalizeTerminalEvents({ foo: 1 }, 'pi', now), { events: [], rejected: 0 });
  });
});

describe('normalizeReadings', () => {
  it('garde les valeurs simples et écarte le reste', () => {
    assert.deepEqual(
      normalizeReadings({ temperature: 21.5, state: 'ON', contact: false, battery: null, nan: Number.NaN, obj: { a: 1 }, list: [1], 'bad key': 1 }),
      { temperature: 21.5, state: 'ON', contact: false, battery: null },
    );
  });
});

describe('normalizeCapability', () => {
  it('valide type et accès', () => {
    assert.deepEqual(normalizeCapability({ name: 'temperature', type: 'numeric', unit: '°C', access: 'read' }), {
      name: 'temperature',
      type: 'numeric',
      unit: '°C',
      access: 'read',
    });
    assert.deepEqual(normalizeCapability({ name: 'action', type: 'enum', values: ['single', 2], access: 'bizarre' }), {
      name: 'action',
      type: 'enum',
      access: 'read',
      values: ['single'],
    });
    assert.equal(normalizeCapability({ name: 'x', type: 'composite', access: 'read' }), null);
  });
});
