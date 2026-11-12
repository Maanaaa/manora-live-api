import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { requireRole, TOKEN_TTL } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { nowIso } from '../db.ts';
import { HttpError } from '../errors.ts';
import { errorResponses, ref, secured } from '../schemas.ts';
import { verifyPassword } from '../security.ts';
import { toPartyEvent, toUser } from '../store.ts';

export function authRoutes(app: FastifyInstance, { db }: Ctx) {
  app.post<{ Body: { email: string; password: string } }>(
    '/auth/login',
    {
      schema: {
        tags: ['Authentification'],
        summary: 'Connexion administrateur ou hôte',
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: { email: { type: 'string', minLength: 1 }, password: { type: 'string', minLength: 1 } },
        },
        response: { 200: { type: 'object', properties: { token: { type: 'string' }, user: ref('User') } }, ...errorResponses },
      },
    },
    async (request) => {
      const row = db.prepare('SELECT * FROM users WHERE email = ?').get(request.body.email.trim());
      if (!row || !(await verifyPassword(request.body.password, String(row.password_hash)))) {
        throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
      }
      const user = toUser(row);
      return { token: app.jwt.sign({ sub: user.id, role: user.role }, { expiresIn: TOKEN_TTL }), user };
    },
  );

  app.get(
    '/auth/me',
    {
      preHandler: requireRole('admin', 'host'),
      schema: { tags: ['Authentification'], summary: 'Utilisateur connecté', security: secured, response: { 200: ref('User'), ...errorResponses } },
    },
    async (request) => toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(request.principal!.id)!),
  );

  app.post<{ Body: { code: string } }>(
    '/auth/guest',
    {
      schema: {
        tags: ['Authentification'],
        summary: "Rejoindre un événement avec son code (invité)",
        body: { type: 'object', required: ['code'], properties: { code: { type: 'string', minLength: 1, maxLength: 64 } } },
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              guest: { type: 'object', properties: { id: { type: 'string' }, name: { type: ['string', 'null'] } } },
              event: ref('Event'),
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      const row = db.prepare('SELECT * FROM events WHERE code = ?').get(request.body.code.trim());
      if (!row) throw new HttpError(404, 'Ce code ne correspond à aucun événement.');
      const event = toPartyEvent(row);
      const id = randomUUID();
      db.prepare('INSERT INTO guests (id, event_id, name, created_at) VALUES (?, ?, NULL, ?)').run(id, event.id, nowIso());
      return { token: app.jwt.sign({ sub: id, role: 'guest' }, { expiresIn: TOKEN_TTL }), guest: { id, name: null }, event };
    },
  );
}
