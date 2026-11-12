import type { FastifyInstance } from 'fastify';

import { requireRole } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { toIso } from '../db.ts';
import { arrayOf, errorResponses, secured } from '../schemas.ts';
import { listJournal } from '../store.ts';

type Query = { deviceId?: string; type?: string; from?: string; to?: string; limit: number };

const iso = (value?: string) => (value ? toIso(new Date(value)) : undefined);

export function journalRoutes(app: FastifyInstance, { db }: Ctx) {
  app.get<{ Querystring: Query }>(
    '/events',
    {
      preHandler: requireRole('admin'),
      schema: {
        tags: ['Journal'],
        summary: 'Journal (plus récent d’abord)',
        security: secured,
        querystring: {
          type: 'object',
          properties: {
            deviceId: { type: 'string' },
            type: { type: 'string', enum: ['reading', 'joined', 'online', 'offline', 'command', 'rule'] },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
          },
        },
        response: { 200: arrayOf('JournalEvent'), ...errorResponses },
      },
    },
    async (request) => {
      const { from, to, ...rest } = request.query;
      return listJournal(db, { ...rest, from: iso(from), to: iso(to) });
    },
  );
}
