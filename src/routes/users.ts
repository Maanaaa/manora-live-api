import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { requireRole } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { nowIso } from '../db.ts';
import { HttpError, notFound } from '../errors.ts';
import { arrayOf, errorResponses, ref, secured } from '../schemas.ts';
import { hashPassword } from '../security.ts';
import { toUser } from '../store.ts';
import type { User } from '../types.ts';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const fields = {
  name: { type: 'string', minLength: 1, maxLength: 80 },
  email: { type: 'string', format: 'email', maxLength: 120 },
  password: { type: 'string', minLength: 8, maxLength: 200 },
  // Les invités entrent par code et les bornes par clé d'API : seuls les comptes admin et host existent.
  role: { type: 'string', enum: ['admin', 'host'] },
};

type UserBody = { name: string; email: string; password: string; role: User['role'] };

export function usersRoutes(app: FastifyInstance, { db }: Ctx) {
  const admin = requireRole('admin');

  const emailTaken = (email: string, exceptId = '') =>
    db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, exceptId) !== undefined;

  const adminCount = () => Number(db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get()!.n);

  app.get(
    '/users',
    { preHandler: admin, schema: { tags: ['Utilisateurs'], summary: 'Comptes', security: secured, response: { 200: arrayOf('User'), ...errorResponses } } },
    async () => db.prepare('SELECT * FROM users ORDER BY created_at').all().map(toUser),
  );

  app.post<{ Body: UserBody }>(
    '/users',
    {
      preHandler: admin,
      schema: {
        tags: ['Utilisateurs'],
        summary: 'Créer un compte',
        security: secured,
        body: { type: 'object', required: ['name', 'email', 'password', 'role'], additionalProperties: false, properties: fields },
        response: { 200: ref('User'), ...errorResponses },
      },
    },
    async (request) => {
      const { name, password, role } = request.body;
      const email = request.body.email.trim().toLowerCase();
      if (emailTaken(email)) throw new HttpError(409, 'Un compte existe déjà avec cet e-mail.');
      const id = randomUUID();
      db.prepare('INSERT INTO users (id, name, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        name.trim(),
        email,
        role,
        await hashPassword(password),
        nowIso(),
      );
      return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)!);
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<UserBody> }>(
    '/users/:id',
    {
      preHandler: admin,
      schema: {
        tags: ['Utilisateurs'],
        summary: 'Modifier un compte',
        security: secured,
        params: idParams,
        body: { type: 'object', additionalProperties: false, properties: fields },
        response: { 200: ref('User'), ...errorResponses },
      },
    },
    async (request) => {
      const { id } = request.params;
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      if (!row) throw notFound('Compte');
      const { name, email, password, role } = request.body;
      if (role === 'host' && row.role === 'admin' && adminCount() <= 1) throw new HttpError(409, 'Il doit rester au moins un administrateur.');
      if (name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name.trim(), id);
      if (email !== undefined) {
        const normalized = email.trim().toLowerCase();
        if (emailTaken(normalized, id)) throw new HttpError(409, 'Un compte existe déjà avec cet e-mail.');
        db.prepare('UPDATE users SET email = ? WHERE id = ?').run(normalized, id);
      }
      if (password !== undefined) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), id);
      if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
      return toUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)!);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: admin, schema: { tags: ['Utilisateurs'], summary: 'Supprimer un compte', security: secured, params: idParams } },
    async (request, reply) => {
      const row = db.prepare('SELECT role FROM users WHERE id = ?').get(request.params.id);
      if (!row) throw notFound('Compte');
      if (request.params.id === request.principal!.id) throw new HttpError(409, 'Vous ne pouvez pas supprimer votre propre compte.');
      db.prepare('DELETE FROM users WHERE id = ?').run(request.params.id);
      db.prepare('DELETE FROM push_tokens WHERE owner_id = ?').run(request.params.id);
      return reply.code(204).send();
    },
  );
}
