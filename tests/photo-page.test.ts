// Page publique de récupération d'une photo (QR de la borne).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import { buildApp } from '../src/app.ts';
import { bootstrap } from '../src/bootstrap.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { renderGalleryPage } from '../src/routes/gallery-page.ts';
import { renderPhotoPage } from '../src/routes/photo-page.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'manora-live-page-'));
const config = loadConfig({
  JWT_SECRET: 'secret-de-test-suffisamment-long-0123456789',
  DATA_DIR: dataDir,
  PUBLIC_URL: 'https://api.test',
  ADMIN_EMAIL: 'admin@test.fr',
  ADMIN_PASSWORD: 'motdepasse-admin',
  TERMINAL_ID: 'pi-test',
  TERMINAL_KEY: 'cle-terminal-de-test',
  EVENT_NAME: 'Mariage de Léa & Tom',
  EVENT_CODE: 'MANORA',
});

let app: FastifyInstance;
let boothKey = '';

function multipart(jpeg: Buffer) {
  const boundary = '----manora-test';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\nbooth\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpeg,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

before(async () => {
  const db = openDb(dataDir, ':memory:');
  await bootstrap(db, config);
  ({ app } = await buildApp(config, { db, logger: false, push: async () => {} }));
  await app.ready();
  const admin = (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'admin@test.fr', password: 'motdepasse-admin' } })).json().token;
  boothKey = (await app.inject({ method: 'POST', url: '/api-keys', payload: { name: 'Borne' }, headers: { authorization: `Bearer ${admin}` } })).json().key;
});

after(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('page de récupération', () => {
  it('la borne reçoit l’adresse de la page, qui affiche la photo et les boutons', async () => {
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#fff3df' } }).jpeg().toBuffer();
    const { body, contentType } = multipart(jpeg);
    const res = await app.inject({ method: 'POST', url: '/photos', payload: body, headers: { authorization: `Bearer ${boothKey}`, 'content-type': contentType } });
    assert.equal(res.statusCode, 200);
    const { id, url, pageUrl } = res.json();
    assert.equal(pageUrl, `https://api.test/p/${id}`);

    const page = await app.inject({ method: 'GET', url: `/p/${id}` });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'] as string, /text\/html/);
    assert.equal(page.headers['x-robots-tag'], 'noindex');
    assert.ok(page.body.includes(`src="${url}"`));
    assert.ok(page.body.includes('Enregistrer dans ma galerie'));
    assert.ok(!page.body.includes('Enregistrer ou partager'), 'un seul bouton');
    assert.ok(page.body.includes('Mariage de Léa &amp; Tom'), 'nom de l’événement échappé');
  });

  it('une photo inconnue ou un identifiant invalide donnent une page 404 lisible', async () => {
    for (const id of ['00000000-0000-0000-0000-000000000000', '../etc/passwd']) {
      const page = await app.inject({ method: 'GET', url: `/p/${encodeURIComponent(id)}` });
      assert.equal(page.statusCode, 404);
      assert.ok(page.body.includes('Photo introuvable'));
    }
  });

  it('police et logo sont servis, les autres fichiers non', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/assets/PlusJakartaSans.woff2' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/assets/manora-logo.png' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/assets/..%2Fpackage.json' })).statusCode, 404);
  });

  it('le rendu échappe le contenu injecté', () => {
    const html = renderPhotoPage({
      publicUrl: 'https://api.test',
      imageUrl: 'https://api.test/media/photos/x.jpg',
      thumbUrl: 'https://api.test/media/thumbs/x.jpg',
      eventName: '<script>alert(1)</script>',
      createdAt: '2026-11-12T19:30:00Z',
      fileName: 'manora.jpg',
    });
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('12 novembre 2026'));
  });
});

describe('galerie en direct', () => {
  it('la borne obtient l’adresse de la galerie de l’événement en cours', async () => {
    const res = await app.inject({ method: 'GET', url: '/booth/event', headers: { authorization: `Bearer ${boothKey}` } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual({ name: res.json().name, galleryUrl: res.json().galleryUrl }, { name: 'Mariage de Léa & Tom', galleryUrl: 'https://api.test/g/MANORA' });
  });

  it('seule une borne peut demander l’événement en cours', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/booth/event' })).statusCode, 401);
  });

  it('la page de galerie s’ouvre avec le code (sans tenir compte de la casse)', async () => {
    const page = await app.inject({ method: 'GET', url: '/g/manora' });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('La galerie en direct'));
    assert.ok(page.body.includes('Ajouter mes photos'));
    assert.ok(page.body.includes('Mariage de Léa &amp; Tom'));
  });

  it('un code inconnu donne une page « Galerie introuvable »', async () => {
    const page = await app.inject({ method: 'GET', url: '/g/INCONNU' });
    assert.equal(page.statusCode, 404);
    assert.ok(page.body.includes('Galerie introuvable'));
  });

  it('le rendu échappe le nom et injecte le code en JSON', () => {
    const html = renderGalleryPage('<img src=x onerror=alert(1)>', 'A"B', 'https://api.test');
    assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
    assert.ok(html.includes('const CODE = "A\\"B"'));
    assert.ok(!renderGalleryPage('x', '</script><b>', 'https://api.test').includes('</script><b>'));
  });
});
