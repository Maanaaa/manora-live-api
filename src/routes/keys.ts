import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { requireRole } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { nowIso } from '../db.ts';
import { notFound } from '../errors.ts';
import { arrayOf, errorResponses, secured } from '../schemas.ts';
import { generateKey, hashKey } from '../security.ts';

export function keysRoutes(app: FastifyInstance, { db }: Ctx) {
  const admin = requireRole('admin');

  app.get(
    '/api-keys',
    { preHandler: admin, schema: { tags: ['Clés des bornes'], summary: 'Clés d’API des bornes', security: secured, response: { 200: arrayOf('ApiKey'), ...errorResponses } } },
    async () =>
      db
        .prepare('SELECT id, name, created_at, last_used_at FROM api_keys ORDER BY created_at')
        .all()
        .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null })),
  );

  app.post<{ Body: { name: string } }>(
    '/api-keys',
    {
      preHandler: admin,
      schema: {
        tags: ['Clés des bornes'],
        summary: 'Créer une clé (renvoyée une seule fois)',
        security: secured,
        body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 } } },
        response: { 200: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, key: { type: 'string' } } }, ...errorResponses },
      },
    },
    async (request) => {
      const id = randomUUID();
      const key = generateKey('mlb');
      const name = request.body.name.trim();
      db.prepare('INSERT INTO api_keys (id, name, key_hash, created_at) VALUES (?, ?, ?, ?)').run(id, name, hashKey(key), nowIso());
      return { id, name, key };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api-keys/:id',
    { preHandler: admin, schema: { tags: ['Clés des bornes'], summary: 'Révoquer une clé', security: secured } },
    async (request, reply) => {
      if (!db.prepare('DELETE FROM api_keys WHERE id = ?').run(request.params.id).changes) throw notFound('Clé');
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { token: string } }>(
    '/push-tokens',
    {
      preHandler: requireRole('admin', 'host', 'guest'),
      schema: {
        tags: ['Notifications'],
        summary: 'Enregistrer un jeton Expo Push',
        security: secured,
        body: { type: 'object', required: ['token'], properties: { token: { type: 'string', pattern: '^Expo(nent)?PushToken\\[.+\\]$' } } },
      },
    },
    async (request, reply) => {
      const { id, role } = request.principal!;
      db.prepare(
        `INSERT INTO push_tokens (token, owner_id, owner_role, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET owner_id = excluded.owner_id, owner_role = excluded.owner_role`,
      ).run(request.body.token, id, role, nowIso());
      return reply.code(204).send();
    },
  );
}
