// Amorçage idempotent : crée l'administrateur, le terminal et l'événement s'ils n'existent pas.

import { randomUUID } from 'node:crypto';

import type { Config } from './config.ts';
import { nowIso, type Db } from './db.ts';
import { hashKey, hashPassword } from './security.ts';

export async function bootstrap(db: Db, config: Config) {
  const now = nowIso();
  if (config.admin) {
    const email = config.admin.email.trim().toLowerCase();
    if (!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      db.prepare("INSERT INTO users (id, name, email, role, password_hash, created_at) VALUES (?, ?, ?, 'admin', ?, ?)").run(
        randomUUID(),
        'Administrateur',
        email,
        await hashPassword(config.admin.password),
        now,
      );
    }
  }
  if (config.terminal && !db.prepare('SELECT 1 FROM terminals WHERE id = ?').get(config.terminal.id)) {
    db.prepare('INSERT INTO terminals (id, name, key_hash, online, last_seen_at) VALUES (?, ?, ?, 0, ?)').run(
      config.terminal.id,
      config.terminal.id,
      hashKey(config.terminal.key),
      now,
    );
  }
  if (config.event && !db.prepare('SELECT 1 FROM events WHERE code = ?').get(config.event.code)) {
    db.prepare('INSERT INTO events (id, name, date, code, created_at) VALUES (?, ?, ?, ?, ?)').run(
      randomUUID(),
      config.event.name,
      now,
      config.event.code,
      now,
    );
  }
}
