import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import { bootstrap } from '../src/bootstrap.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'manora-live-api-'));
const TERMINAL_KEY = 'cle-terminal-de-test';
const config = loadConfig({
  JWT_SECRET: 'secret-de-test-suffisamment-long-0123456789',
  DATA_DIR: dataDir,
  PUBLIC_URL: 'https://api.test',
  ADMIN_EMAIL: 'admin@test.fr',
  ADMIN_PASSWORD: 'motdepasse-admin',
  TERMINAL_ID: 'pi-test',
  TERMINAL_KEY,
  EVENT_NAME: 'Mariage test',
  EVENT_CODE: 'MANORA',
});

let app: FastifyInstance;
let adminToken = '';

const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, token?: string, payload?: object) =>
  app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => {
  const db = openDb(dataDir, ':memory:');
  await bootstrap(db, config);
  await bootstrap(db, config); // idempotent
  ({ app } = await buildApp(config, { db, logger: false, push: async () => {} }));
  await app.ready();
  adminToken = (await call('POST', '/auth/login', undefined, { email: 'admin@test.fr', password: 'motdepasse-admin' })).json().token;
});

after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('authentification', () => {
  it('/health est public', async () => {
    assert.deepEqual((await call('GET', '/health')).json(), { status: 'ok' });
  });

  it('refuse un mauvais mot de passe avec une erreur lisible', async () => {
    const res = await call('POST', '/auth/login', undefined, { email: 'admin@test.fr', password: 'faux' });
    assert.equal(res.statusCode, 401);
    assert.equal(typeof res.json().error, 'string');
  });

  it('connecte l’administrateur amorcé', async () => {
    const res = await call('GET', '/auth/me', adminToken);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.json()).sort(), ['email', 'id', 'name', 'role']);
    assert.equal(res.json().role, 'admin');
  });

  it('rejoint un événement avec son code', async () => {
    const res = await call('POST', '/auth/guest', undefined, { code: 'MANORA' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().event.name, 'Mariage test');
    assert.equal((await call('POST', '/auth/guest', undefined, { code: 'INCONNU' })).statusCode, 404);
  });
});

describe('rôles', () => {
  it('exige un jeton', async () => {
    assert.equal((await call('GET', '/devices')).statusCode, 401);
  });

  it('un hôte voit le parc mais pas les règles', async () => {
    const created = await call('POST', '/users', adminToken, { name: 'Hôte', email: 'hote@test.fr', password: 'motdepasse', role: 'host' });
    assert.equal(created.statusCode, 200);
    const hostToken = (await call('POST', '/auth/login', undefined, { email: 'hote@test.fr', password: 'motdepasse' })).json().token;
    assert.equal((await call('GET', '/devices', hostToken)).statusCode, 200);
    assert.equal((await call('GET', '/rules', hostToken)).statusCode, 403);
    assert.equal((await call('GET', '/users', hostToken)).statusCode, 403);
  });

  it('un invité ne voit que les photos', async () => {
    const guestToken = (await call('POST', '/auth/guest', undefined, { code: 'MANORA' })).json().token;
    assert.equal((await call('GET', '/photos', guestToken)).statusCode, 200);
    assert.equal((await call('GET', '/devices', guestToken)).statusCode, 403);
  });

  it('la clé de terminal ne sert qu’aux routes du terminal', async () => {
    assert.equal((await call('GET', '/devices', TERMINAL_KEY)).statusCode, 403);
    assert.equal((await call('POST', '/terminal/heartbeat', adminToken, {})).statusCode, 403);
  });

  it('une clé de borne créée par l’admin authentifie la borne', async () => {
    const { key } = (await call('POST', '/api-keys', adminToken, { name: 'Borne 1' })).json();
    assert.equal((await call('GET', '/photos', key)).statusCode, 403);
    const keys = (await call('GET', '/api-keys', adminToken)).json();
    assert.equal(keys.length, 1);
    assert.equal(keys[0].key, undefined);
  });
});

describe('passerelle du terminal', () => {
  it('battement, appareils et événements mettent à jour le parc', async () => {
    assert.deepEqual((await call('POST', '/terminal/heartbeat', TERMINAL_KEY, {})).json(), { ok: true });
    const terminals = (await call('GET', '/terminals', adminToken)).json();
    assert.equal(terminals[0].online, true);

    const devices = await call('PUT', '/terminal/devices', TERMINAL_KEY, {
      devices: [
        {
          ieee: '0xABC',
          model: 'SNZB-02',
          capabilities: [
            { name: 'temperature', type: 'numeric', unit: '°C', access: 'read' },
            { name: 'battery', type: 'numeric', unit: '%', access: 'read' },
          ],
        },
        { ieee: '0xPLUG', model: 'Prise', capabilities: [{ name: 'state', type: 'binary', access: 'readwrite' }] },
      ],
    });
    assert.equal(devices.statusCode, 200);
    const device = devices.json()[0];
    assert.equal(device.ieee, '0xabc');

    const ts = new Date().toISOString();
    const res = await call('POST', '/terminal/events', TERMINAL_KEY, {
      events: [
        { terminal: 'pi-test', device: '0xabc', model: 'SNZB-02', readings: { temperature: 21.4, battery: 90 }, ts },
        { terminal: 'pi-test', device: '0xinconnu', model: 'X', readings: { a: 1 }, ts },
      ],
    });
    assert.deepEqual(res.json(), { accepted: 1 });

    const after = (await call('GET', `/devices/${device.id}`, adminToken)).json();
    assert.deepEqual(after.state, { temperature: 21.4, battery: 90 });
    assert.equal(after.battery, 90);
    const readings = (await call('GET', `/devices/${device.id}/readings?capability=temperature&range=24h`, adminToken)).json();
    assert.equal(readings.length, 1);
    assert.equal(readings[0].value, 21.4);

    const readOnly = await call('POST', `/devices/${device.id}/commands`, adminToken, { capability: 'temperature', value: 1 });
    assert.equal(readOnly.statusCode, 400, 'capacité en lecture seule');
    // Terminal non connecté au WebSocket : la commande échoue en 504.
    const plug = devices.json()[1];
    const command = await call('POST', `/devices/${plug.id}/commands`, adminToken, { capability: 'state', value: true });
    assert.equal(command.statusCode, 504);
  });

  it('les règles se créent et se valident', async () => {
    const device = (await call('GET', '/devices', adminToken)).json()[0];
    const body = {
      name: 'Trop chaud',
      trigger: { deviceId: device.id, capability: 'temperature', operator: 'gt', value: 26, forSeconds: 60 },
      schedule: { after: '18:00', before: '02:00' },
      actions: [{ type: 'notify', message: 'Il fait chaud' }],
    };
    const created = await call('POST', '/rules', adminToken, body);
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().enabled, true);
    const patched = await call('PATCH', `/rules/${created.json().id}`, adminToken, { enabled: false, schedule: null });
    assert.equal(patched.json().enabled, false);
    assert.equal(patched.json().schedule, undefined);
    assert.equal((await call('POST', '/rules', adminToken, { ...body, schedule: { after: '25:00' } })).statusCode, 400);
    assert.equal((await call('DELETE', `/rules/${created.json().id}`, adminToken)).statusCode, 204);
  });
});
