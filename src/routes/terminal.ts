// Routes de la passerelle du Raspberry Pi (clé de terminal).

import type { FastifyInstance } from 'fastify';

import { requireRole } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { arrayOf, capabilitySchema, errorResponses, secured } from '../schemas.ts';

export function terminalRoutes(app: FastifyInstance, { fleet }: Ctx) {
  const terminal = requireRole('terminal');

  app.post(
    '/terminal/heartbeat',
    {
      preHandler: terminal,
      schema: {
        tags: ['Terminal'],
        summary: 'Battement (toutes les 30 s ; hors ligne après 90 s)',
        security: secured,
        response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, ...errorResponses },
      },
    },
    async (request) => {
      fleet.heartbeat(request.principal!.id);
      return { ok: true };
    },
  );

  app.put<{ Body: { devices: unknown[] } }>(
    '/terminal/devices',
    {
      preHandler: terminal,
      schema: {
        tags: ['Terminal'],
        summary: 'Liste complète des appareils (déduite des exposes Zigbee2MQTT)',
        security: secured,
        body: {
          type: 'object',
          required: ['devices'],
          properties: {
            devices: {
              type: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                required: ['ieee', 'model', 'capabilities'],
                properties: {
                  ieee: { type: 'string', minLength: 1 },
                  model: { type: 'string' },
                  vendor: { type: 'string' },
                  description: { type: 'string' },
                  capabilities: { type: 'array', items: capabilitySchema },
                },
              },
            },
          },
        },
        response: { 200: arrayOf('Device'), ...errorResponses },
      },
    },
    async (request) => fleet.syncDevices(request.principal!.id, request.body.devices),
  );

  app.post<{ Body: { events: unknown[] } }>(
    '/terminal/events',
    {
      preHandler: terminal,
      schema: {
        tags: ['Terminal'],
        summary: 'Lot d’événements (file locale renvoyée au retour du réseau)',
        security: secured,
        body: {
          type: 'object',
          required: ['events'],
          properties: { events: { type: 'array', maxItems: 5000, items: { type: 'object' } } },
        },
        response: { 200: { type: 'object', properties: { accepted: { type: 'integer' } } }, ...errorResponses },
      },
    },
    async (request) => ({ accepted: fleet.ingest(request.principal!.id, request.body.events) }),
  );
}
