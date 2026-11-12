// Authentification : jeton JWT (admin, host, guest), clé d'API de borne (booth) ou clé de terminal.

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { nowIso, type Db } from './db.ts';
import { HttpError } from './errors.ts';
import { hashKey } from './security.ts';
import type { Principal } from './types.ts';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: 'admin' | 'host' | 'guest' };
  }
}

export const TOKEN_TTL = '7d';

/** Retrouve l'appelant à partir d'un jeton ; `null` si le jeton est invalide. */
export function authenticate(app: FastifyInstance, db: Db, token: string): Principal | null {
  if (!token) return null;
  if (token.split('.').length === 3) {
    let payload: { sub: string; role: string };
    try {
      payload = app.jwt.verify(token);
    } catch {
      return null;
    }
    if (payload.role === 'guest') {
      const guest = db.prepare('SELECT id, name, event_id FROM guests WHERE id = ?').get(payload.sub);
      return guest ? { role: 'guest', id: String(guest.id), name: (guest.name as string | null) ?? null, eventId: String(guest.event_id) } : null;
    }
    // Le rôle est relu en base : un changement de rôle ou une suppression prend effet tout de suite.
    const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(payload.sub);
    return user ? { role: user.role as 'admin' | 'host', id: String(user.id), name: String(user.name) } : null;
  }

  const hash = hashKey(token);
  const key = db.prepare('SELECT id, name FROM api_keys WHERE key_hash = ?').get(hash);
  if (key) {
    db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), String(key.id));
    return { role: 'booth', id: String(key.id), name: String(key.name) };
  }
  const terminal = db.prepare('SELECT id FROM terminals WHERE key_hash = ?').get(hash);
  return terminal ? { role: 'terminal', id: String(terminal.id) } : null;
}

export function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/** Garde de route : exige l'un des rôles donnés (401 sans jeton valide, 403 sinon). */
export function requireRole(...roles: Principal['role'][]) {
  return async (request: FastifyRequest) => {
    if (!request.principal) throw new HttpError(401, 'Authentification requise.');
    if (!roles.includes(request.principal.role)) throw new HttpError(403, "Vous n'avez pas accès à cette ressource.");
  };
}
