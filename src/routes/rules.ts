import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { requireRole } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { nowIso } from '../db.ts';
import { HttpError, notFound } from '../errors.ts';
import { actionSchema, arrayOf, errorResponses, ref, scheduleSchema, secured, triggerSchema } from '../schemas.ts';
import { listRules, toRule } from '../store.ts';
import type { Rule } from '../types.ts';

type RuleBody = Partial<Omit<Rule, 'id' | 'schedule'>> & { schedule?: Rule['schedule'] | null };

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const bodyProperties = {
  name: { type: 'string', minLength: 1, maxLength: 80 },
  enabled: { type: 'boolean' },
  trigger: triggerSchema,
  schedule: { anyOf: [scheduleSchema, { type: 'null' }] },
  actions: { type: 'array', minItems: 1, maxItems: 10, items: actionSchema },
};

export function rulesRoutes(app: FastifyInstance, { db, fleet }: Ctx) {
  const admin = requireRole('admin');

  /** Les appareils cités par la règle doivent exister. */
  const checkDevices = (rule: Rule) => {
    const ids = [rule.trigger.deviceId, ...rule.actions.flatMap((a) => (a.type === 'command' ? [a.deviceId] : []))];
    for (const id of ids) {
      if (!db.prepare('SELECT 1 FROM devices WHERE id = ?').get(id)) throw new HttpError(400, `Appareil ${id} introuvable.`);
    }
  };

  const save = (rule: Rule, insert: boolean) => {
    checkDevices(rule);
    const values = [rule.name, rule.enabled ? 1 : 0, JSON.stringify(rule.trigger), rule.schedule ? JSON.stringify(rule.schedule) : null, JSON.stringify(rule.actions)];
    if (insert) {
      db.prepare('INSERT INTO rules (name, enabled, trigger, schedule, actions, id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...values, rule.id, nowIso());
    } else {
      db.prepare('UPDATE rules SET name = ?, enabled = ?, trigger = ?, schedule = ?, actions = ? WHERE id = ?').run(...values, rule.id);
    }
    fleet.reloadRules();
    return rule;
  };

  app.get(
    '/rules',
    { preHandler: admin, schema: { tags: ['Règles'], summary: 'Règles', security: secured, response: { 200: arrayOf('Rule'), ...errorResponses } } },
    async () => listRules(db),
  );

  app.post<{ Body: Required<Pick<RuleBody, 'name' | 'trigger' | 'actions'>> & RuleBody }>(
    '/rules',
    {
      preHandler: admin,
      schema: {
        tags: ['Règles'],
        summary: 'Créer une règle',
        security: secured,
        body: { type: 'object', required: ['name', 'trigger', 'actions'], additionalProperties: false, properties: bodyProperties },
        response: { 200: ref('Rule'), ...errorResponses },
      },
    },
    async (request) => {
      const { name, enabled = true, trigger, schedule, actions } = request.body;
      const rule: Rule = { id: randomUUID(), name: name.trim(), enabled, trigger, actions };
      if (schedule) rule.schedule = schedule;
      return save(rule, true);
    },
  );

  app.patch<{ Params: { id: string }; Body: RuleBody }>(
    '/rules/:id',
    {
      preHandler: admin,
      schema: {
        tags: ['Règles'],
        summary: 'Modifier une règle',
        security: secured,
        params: idParams,
        body: { type: 'object', additionalProperties: false, properties: bodyProperties },
        response: { 200: ref('Rule'), ...errorResponses },
      },
    },
    async (request) => {
      const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(request.params.id);
      if (!row) throw notFound('Règle');
      const { schedule, ...changes } = request.body;
      const rule: Rule = { ...toRule(row), ...changes };
      if (changes.name) rule.name = changes.name.trim();
      if (schedule === null) delete rule.schedule;
      else if (schedule) rule.schedule = schedule;
      return save(rule, false);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/rules/:id',
    { preHandler: admin, schema: { tags: ['Règles'], summary: 'Supprimer une règle', security: secured, params: idParams } },
    async (request, reply) => {
      if (!db.prepare('DELETE FROM rules WHERE id = ?').run(request.params.id).changes) throw notFound('Règle');
      fleet.reloadRules();
      return reply.code(204).send();
    },
  );
}
