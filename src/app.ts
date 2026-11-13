// Construction de l'application Fastify (utilisée par le serveur et par les tests).

import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';

import { authenticate, bearer } from './auth.ts';
import type { Config } from './config.ts';
import type { Ctx } from './context.ts';
import { openDb, type Db } from './db.ts';
import { HttpError } from './errors.ts';
import { Fleet } from './fleet.ts';
import { PhotoNotifier } from './photo-notifier.ts';
import { expoPush, type PushSender } from './push.ts';
import { Hub } from './realtime.ts';
import { authRoutes } from './routes/auth.ts';
import { fleetRoutes } from './routes/fleet.ts';
import { journalRoutes } from './routes/journal.ts';
import { keysRoutes } from './routes/keys.ts';
import { galleryPageRoutes } from './routes/gallery-page.ts';
import { photoPageRoutes } from './routes/photo-page.ts';
import { photosRoutes } from './routes/photos.ts';
import { rulesRoutes } from './routes/rules.ts';
import { terminalRoutes } from './routes/terminal.ts';
import { usersRoutes } from './routes/users.ts';
import { registerSchemas } from './schemas.ts';

const GENERIC_ERRORS: Record<number, string> = {
  400: 'Requête invalide.',
  401: 'Authentification requise.',
  403: 'Accès refusé.',
  404: 'Ressource introuvable.',
  406: 'Format de réponse non pris en charge.',
  413: 'Fichier trop volumineux.',
  415: 'Format de contenu non pris en charge.',
};

export interface BuildOptions {
  db?: Db;
  push?: PushSender;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(config: Config, options: BuildOptions = {}) {
  const app = Fastify({
    trustProxy: true,
    ajv: { customOptions: { allowUnionTypes: true } },
    logger: options.logger ?? {
      level: 'info',
      // Le jeton du WebSocket passe dans l'URL : il ne doit pas finir dans les journaux.
      serializers: { req: (req) => ({ method: req.method, url: req.url.replace(/token=[^&]+/, 'token=***') }) },
    },
  });

  const db = options.db ?? openDb(config.dataDir);
  const hub = new Hub();
  const fleet = new Fleet({ db, hub, push: options.push ?? expoPush, log: app.log });
  const photoNotifier = new PhotoNotifier({
    db,
    send: options.push ?? expoPush,
    onError: (err) => app.log.error(err, 'Échec de la notification « nouvelles photos »'),
  });
  app.addHook('onClose', async () => photoNotifier.stop());
  const ctx: Ctx = { config, db, hub, fleet, photoNotifier };

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) return reply.code(400).send({ error: `Requête invalide : ${error.message}` });
    const status = error.statusCode ?? 500;
    if (error instanceof HttpError) return reply.code(status).send({ error: error.message });
    if (status >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Erreur interne du serveur.' });
    }
    return reply.code(status).send({ error: GENERIC_ERRORS[status] ?? 'Requête refusée.' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Route introuvable.' }));

  await app.register(cors, { origin: config.corsOrigins.length ? config.corsOrigins : false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5 } });
  await app.register(websocket);
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Manora Live API',
        version: '1.0.0',
        description:
          'API de la borne photo connectée Manora Live (contrat : docs/adr/0002-contrat-api.md).\n\n' +
          'Temps réel : WebSocket `/ws?token=<jeton>` ; messages `{ type, data }` filtrés selon le rôle.',
      },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    },
    refResolver: { buildLocalReference: (json, _baseUri, _fragment, i) => String(json.$id ?? `def-${i}`) },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  registerSchemas(app);

  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request) => {
    const token = bearer(request) || (request.url.startsWith('/ws') ? ((request.query as { token?: string }).token ?? '') : '');
    request.principal = token ? authenticate(app, db, token) : null;
  });

  app.get('/health', { schema: { tags: ['Système'], summary: 'État du service', response: { 200: { type: 'object', properties: { status: { type: 'string' } } } } } }, async () => ({
    status: 'ok',
  }));

  app.get(
    '/ws',
    {
      websocket: true,
      schema: { hide: true },
      preValidation: async (request, reply) => {
        if (!request.principal) return reply.code(401).send({ error: 'Jeton invalide.' });
      },
    },
    (socket, request) => hub.add(socket, request.principal!),
  );

  for (const routes of [authRoutes, fleetRoutes, rulesRoutes, usersRoutes, journalRoutes, photosRoutes, photoPageRoutes, galleryPageRoutes, keysRoutes, terminalRoutes]) {
    routes(app, ctx);
  }

  app.addHook('onClose', async () => {
    hub.closeAll();
    if (!options.db) db.close();
  });

  return { app, ctx };
}
