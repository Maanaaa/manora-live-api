import type { FastifyInstance } from 'fastify';

import { requireRole } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { toIso } from '../db.ts';
import { notFound } from '../errors.ts';
import { arrayOf, errorResponses, ref, secured } from '../schemas.ts';
import { getDevice, listDevices, toTerminal } from '../store.ts';
import type { Value } from '../types.ts';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const RANGES: Record<string, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000 };

export function fleetRoutes(app: FastifyInstance, { db, fleet }: Ctx) {
  const admin = requireRole('admin');
  const staff = requireRole('admin', 'host');

  app.get(
    '/terminals',
    { preHandler: admin, schema: { tags: ['Parc'], summary: 'Terminaux', security: secured, response: { 200: arrayOf('Terminal'), ...errorResponses } } },
    async () => db.prepare('SELECT * FROM terminals ORDER BY id').all().map(toTerminal),
  );

  app.post<{ Params: { id: string }; Body: { seconds?: number } }>(
    '/terminals/:id/permit-join',
    {
      preHandler: admin,
      schema: {
        tags: ['Parc'],
        summary: "Ouvrir l'appairage Zigbee",
        security: secured,
        params: idParams,
        body: { type: ['object', 'null'], properties: { seconds: { type: 'integer', minimum: 1, maximum: 254, default: 120 } } },
        response: { 200: { type: 'object', properties: { until: { type: 'string', format: 'date-time' } } }, ...errorResponses },
      },
    },
    async (request) => ({ until: fleet.permitJoin(request.params.id, request.body?.seconds ?? 120) }),
  );

  app.get(
    '/devices',
    { preHandler: staff, schema: { tags: ['Parc'], summary: 'Appareils', security: secured, response: { 200: arrayOf('Device'), ...errorResponses } } },
    async () => listDevices(db),
  );

  app.get<{ Params: { id: string } }>(
    '/devices/:id',
    {
      preHandler: staff,
      schema: { tags: ['Parc'], summary: 'Un appareil', security: secured, params: idParams, response: { 200: ref('Device'), ...errorResponses } },
    },
    async (request) => {
      const device = getDevice(db, request.params.id);
      if (!device) throw notFound('Appareil');
      return device;
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; location?: string | null; enabled?: boolean } }>(
    '/devices/:id',
    {
      preHandler: admin,
      schema: {
        tags: ['Parc'],
        summary: 'Renommer, placer ou désactiver un appareil',
        security: secured,
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            location: { type: ['string', 'null'], maxLength: 80 },
            enabled: { type: 'boolean' },
          },
        },
        response: { 200: ref('Device'), ...errorResponses },
      },
    },
    async (request) => {
      const { id } = request.params;
      if (!getDevice(db, id)) throw notFound('Appareil');
      const { name, location, enabled } = request.body;
      if (name !== undefined) db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name.trim(), id);
      if (location !== undefined) db.prepare('UPDATE devices SET location = ? WHERE id = ?').run(location?.trim() || null, id);
      if (enabled !== undefined) db.prepare('UPDATE devices SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
      return getDevice(db, id);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { capability: string; range: '24h' | '7d' } }>(
    '/devices/:id/readings',
    {
      preHandler: staff,
      schema: {
        tags: ['Parc'],
        summary: "Historique d'une capacité",
        security: secured,
        params: idParams,
        querystring: {
          type: 'object',
          required: ['capability'],
          properties: { capability: { type: 'string' }, range: { type: 'string', enum: ['24h', '7d'], default: '24h' } },
        },
        response: {
          200: { type: 'array', items: { type: 'object', properties: { ts: { type: 'string' }, value: { type: ['boolean', 'number', 'string', 'null'] } } } },
          ...errorResponses,
        },
      },
    },
    async (request) => {
      if (!getDevice(db, request.params.id)) throw notFound('Appareil');
      const from = toIso(new Date(Date.now() - (RANGES[request.query.range] ?? RANGES['24h']!)));
      return db
        .prepare('SELECT ts, value FROM readings WHERE device_id = ? AND capability = ? AND ts >= ? ORDER BY ts')
        .all(request.params.id, request.query.capability, from)
        .map((r) => ({ ts: String(r.ts), value: JSON.parse(String(r.value)) as Value }));
    },
  );

  app.post<{ Params: { id: string }; Body: { capability: string; value: boolean | number | string } }>(
    '/devices/:id/commands',
    {
      preHandler: staff,
      schema: {
        tags: ['Parc'],
        summary: 'Commander un appareil (attend son état réel, 504 après 5 s)',
        security: secured,
        params: idParams,
        body: {
          type: 'object',
          required: ['capability', 'value'],
          properties: { capability: { type: 'string' }, value: { type: ['boolean', 'number', 'string'] } },
        },
        response: { 200: ref('Device'), ...errorResponses },
      },
    },
    async (request) => fleet.sendCommand(request.params.id, request.body.capability, request.body.value, true),
  );
}
