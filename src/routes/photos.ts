import { randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import { requireRole } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { nowIso } from '../db.ts';
import { HttpError, notFound } from '../errors.ts';
import { arrayOf, errorResponses, secured } from '../schemas.ts';
import { currentEvent } from '../store.ts';
import type { Photo, Principal } from '../types.ts';

const THUMB_SIZE = 480;
const PAGE_SIZE = 30;

type Row = Record<string, unknown>;

export function photosRoutes(app: FastifyInstance, { db, config, hub, photoNotifier }: Ctx) {
  const dirs = { photos: join(config.dataDir, 'photos'), thumbs: join(config.dataDir, 'photos', 'thumbs') };
  mkdirSync(dirs.thumbs, { recursive: true });

  const toPhoto = (row: Row, viewer: Principal): Photo => ({
    id: String(row.id),
    url: `${config.publicUrl}/media/photos/${String(row.id)}.jpg`,
    thumbUrl: `${config.publicUrl}/media/thumbs/${String(row.id)}.jpg`,
    pageUrl: `${config.publicUrl}/p/${String(row.id)}`,
    source: row.source as Photo['source'],
    authorName: (row.author_name as string | null) ?? null,
    mine: row.author_id === viewer.id,
    createdAt: String(row.created_at),
  });

  app.get<{ Querystring: { after?: string; mine?: string; limit: number } }>(
    '/photos',
    {
      preHandler: requireRole('guest', 'host', 'admin'),
      schema: {
        tags: ['Photos'],
        summary: 'Galerie (plus récentes d’abord, `after` = plus anciennes que cet id)',
        security: secured,
        querystring: {
          type: 'object',
          properties: {
            after: { type: 'string' },
            mine: { type: 'string', enum: ['0', '1', 'true', 'false'] },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: PAGE_SIZE },
          },
        },
        response: { 200: arrayOf('Photo'), ...errorResponses },
      },
    },
    async (request) => {
      const viewer = request.principal!;
      const where: string[] = [];
      const params: string[] = [];
      const add = (clause: string, value?: string) => {
        if (!value) return;
        where.push(clause);
        params.push(value);
      };
      // Un invité ne voit que la galerie de son événement.
      if (viewer.role === 'guest') add('event_id = ?', viewer.eventId);
      if (request.query.mine === '1' || request.query.mine === 'true') add('author_id = ?', viewer.id);
      add('seq < (SELECT seq FROM photos WHERE id = ?)', request.query.after);
      const sql = `SELECT * FROM photos ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`;
      return db
        .prepare(sql)
        .all(...params, request.query.limit)
        .map((row) => toPhoto(row, viewer));
    },
  );

  app.post(
    '/photos',
    {
      preHandler: requireRole('booth', 'guest'),
      schema: {
        tags: ['Photos'],
        summary: 'Envoyer une photo (multipart : `photo` JPEG, `source`)',
        security: secured,
        consumes: ['multipart/form-data'],
        response: { 200: { type: 'object', properties: { id: { type: 'string' }, url: { type: 'string' }, pageUrl: { type: 'string' } } }, ...errorResponses },
      },
    },
    async (request) => {
      const author = request.principal as Extract<Principal, { role: 'booth' | 'guest' }>;
      let source: string | null = null;
      let image: Buffer | null = null;
      for await (const part of request.parts()) {
        if (part.type === 'file' && part.fieldname === 'photo') image = await part.toBuffer();
        else if (part.type === 'file') await part.toBuffer();
        else if (part.fieldname === 'source') source = String(part.value);
      }
      if (!image) throw new HttpError(400, 'Photo manquante (champ « photo »).');
      if (source && source !== author.role) throw new HttpError(400, `Source « ${source} » incompatible avec ce jeton.`);

      let format: string | undefined;
      try {
        format = (await sharp(image).metadata()).format;
      } catch {
        format = undefined;
      }
      if (format !== 'jpeg') throw new HttpError(415, 'La photo doit être une image JPEG.');

      const id = randomUUID();
      await writeFile(join(dirs.photos, `${id}.jpg`), image);
      await sharp(image).rotate().resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(join(dirs.thumbs, `${id}.jpg`));

      const eventId = author.role === 'guest' ? author.eventId : (currentEvent(db)?.id ?? null);
      db.prepare('INSERT INTO photos (id, event_id, source, author_id, author_name, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        eventId,
        author.role,
        author.id,
        author.name,
        nowIso(),
      );
      const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id)!;
      hub.broadcast('photo.created', (viewer) => (viewer.role === 'guest' && viewer.eventId !== eventId ? null : toPhoto(row, viewer)), [
        'guest',
        'host',
        'admin',
      ]);
      photoNotifier.photoAdded(eventId, author.id);
      const photo = toPhoto(row, author);
      return { id, url: photo.url, pageUrl: photo.pageUrl };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/photos/:id',
    {
      preHandler: requireRole('guest', 'booth', 'host', 'admin'),
      schema: { tags: ['Photos'], summary: 'Supprimer une photo (auteur, host, admin)', security: secured, params: { type: 'object', properties: { id: { type: 'string' } } } },
    },
    async (request, reply) => {
      const viewer = request.principal!;
      const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(request.params.id);
      if (!row) throw notFound('Photo');
      if (viewer.role !== 'admin' && viewer.role !== 'host' && row.author_id !== viewer.id) {
        throw new HttpError(403, 'Seul l’auteur peut supprimer cette photo.');
      }
      db.prepare('DELETE FROM photos WHERE id = ?').run(request.params.id);
      await Promise.all([rm(join(dirs.photos, `${request.params.id}.jpg`), { force: true }), rm(join(dirs.thumbs, `${request.params.id}.jpg`), { force: true })]);
      hub.broadcast('photo.deleted', { id: request.params.id }, ['guest', 'host', 'admin']);
      return reply.code(204).send();
    },
  );

  // Fichiers publics : `pageUrl` (page de récupération) est encodée dans le QR de la borne.
  app.get<{ Params: { kind: 'photos' | 'thumbs'; file: string } }>(
    '/media/:kind/:file',
    {
      schema: {
        tags: ['Photos'],
        summary: 'Image JPEG publique (photo ou miniature)',
        params: {
          type: 'object',
          properties: { kind: { type: 'string', enum: ['photos', 'thumbs'] }, file: { type: 'string', pattern: '^[0-9a-f-]{36}\\.jpg$' } },
        },
      },
    },
    async (request, reply) => {
      const id = request.params.file.slice(0, -4);
      if (!db.prepare('SELECT 1 FROM photos WHERE id = ?').get(id)) throw notFound('Photo');
      return reply
        .type('image/jpeg')
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(createReadStream(join(dirs[request.params.kind], request.params.file)));
    },
  );
}
