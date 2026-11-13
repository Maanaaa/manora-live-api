// Notifications « nouvelles photos » : regroupement, destinataires, jetons invalides.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it, mock } from 'node:test';

import { openDb, type Db } from '../src/db.ts';
import { PhotoNotifier, photoMessage } from '../src/photo-notifier.ts';
import type { PushMessage } from '../src/push.ts';

const WINDOW = 5 * 60 * 1000;
let db: Db;
let sent: PushMessage[][];
let clock: number;
let invalidNext: string[];

function seed() {
  db = openDb(mkdtempSync(join(tmpdir(), 'manora-notif-')), ':memory:');
  const now = new Date().toISOString();
  db.prepare('INSERT INTO events (id, name, date, code, created_at) VALUES (?, ?, ?, ?, ?)').run('e1', 'Mariage', now, 'A1', now);
  db.prepare('INSERT INTO events (id, name, date, code, created_at) VALUES (?, ?, ?, ?, ?)').run('e2', 'Autre', now, 'B2', now);
  for (const [id, event] of [['g1', 'e1'], ['g2', 'e1'], ['g3', 'e2']] as const) {
    db.prepare('INSERT INTO guests (id, event_id, name, created_at) VALUES (?, ?, NULL, ?)').run(id, event, now);
    db.prepare("INSERT INTO push_tokens (token, owner_id, owner_role, created_at) VALUES (?, ?, 'guest', ?)").run(`ExpoPushToken[${id}]`, id, now);
  }
}

function notifier() {
  return new PhotoNotifier({
    db,
    windowMs: WINDOW,
    now: () => clock,
    send: async (messages) => {
      sent.push(messages);
      const invalid = invalidNext;
      invalidNext = [];
      return invalid;
    },
  });
}

const flushPromises = () => new Promise((r) => setImmediate(r));

describe('notifications « nouvelles photos »', () => {
  beforeEach(() => {
    seed();
    sent = [];
    clock = 1_000_000;
    invalidNext = [];
    mock.timers.reset();
    mock.timers.enable({ apis: ['setTimeout'] });
  });

  it('prévient les invités de l’événement, sauf l’auteur et les autres événements', () => {
    notifier().photoAdded('e1', 'g1');
    assert.deepEqual(sent.flat().map((m) => m.to), ['ExpoPushToken[g2]']);
    assert.deepEqual(sent[0]![0]!.data, { url: '/gallery' });
  });

  it('regroupe une rafale de photos en une seule notification par fenêtre', () => {
    const n = notifier();
    n.photoAdded('e1', 'borne'); // envoi immédiat (première photo)
    n.photoAdded('e1', 'borne');
    n.photoAdded('e1', 'borne');
    n.photoAdded('e1', 'borne');
    assert.equal(sent.length, 2, 'une notification par invité, pas plus');
    clock += WINDOW;
    mock.timers.tick(WINDOW);
    assert.equal(sent.length, 4, 'un seul envoi groupé par invité à la fin de la fenêtre');
    assert.match(sent[2]![0]!.body, /^3 nouvelles photos/);
  });

  it('sans nouvelle photo, rien n’est envoyé à la fin de la fenêtre', () => {
    notifier().photoAdded('e1', 'borne');
    mock.timers.tick(WINDOW * 3);
    assert.equal(sent.length, 2);
  });

  it('un jeton signalé invalide par Expo est supprimé', async () => {
    invalidNext = ['ExpoPushToken[g2]'];
    notifier().photoAdded('e1', 'g1');
    await flushPromises();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_tokens WHERE token = ?').get('ExpoPushToken[g2]')!.n, 0);
  });

  it('photo sans événement : aucune notification', () => {
    notifier().photoAdded(null, 'borne');
    assert.equal(sent.length, 0);
  });

  it('textes au singulier et au pluriel', () => {
    assert.equal(photoMessage(1, 'Mariage').body, 'Une nouvelle photo dans la galerie « Mariage ».');
    assert.equal(photoMessage(4, 'Mariage').body, '4 nouvelles photos dans la galerie « Mariage ».');
  });
});
