// Schémas JSON partagés : validation des corps et documentation OpenAPI (/docs).

import type { FastifyInstance } from 'fastify';

const scalar = { type: ['boolean', 'number', 'string'] };
const nullableScalar = { type: ['boolean', 'number', 'string', 'null'] };
const date = { type: 'string', format: 'date-time' };
const nullableDate = { type: ['string', 'null'], format: 'date-time' };
const hhmm = { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' };

export const capabilitySchema = {
  type: 'object',
  required: ['name', 'type', 'access'],
  properties: {
    name: { type: 'string' },
    type: { type: 'string', enum: ['binary', 'numeric', 'enum'] },
    unit: { type: 'string' },
    values: { type: 'array', items: { type: 'string' } },
    access: { type: 'string', enum: ['read', 'write', 'readwrite'] },
  },
};

export const triggerSchema = {
  type: 'object',
  required: ['deviceId', 'capability', 'operator', 'value'],
  additionalProperties: false,
  properties: {
    deviceId: { type: 'string' },
    capability: { type: 'string' },
    operator: { type: 'string', enum: ['eq', 'neq', 'gt', 'lt'] },
    value: scalar,
    forSeconds: { type: 'integer', minimum: 1, maximum: 86400 },
  },
};

export const scheduleSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { after: hhmm, before: hhmm },
};

export const actionSchema = {
  anyOf: [
    {
      type: 'object',
      required: ['type', 'message'],
      additionalProperties: false,
      properties: { type: { const: 'notify' }, message: { type: 'string', minLength: 1, maxLength: 200 } },
    },
    {
      type: 'object',
      required: ['type', 'deviceId', 'capability', 'value'],
      additionalProperties: false,
      properties: { type: { const: 'command' }, deviceId: { type: 'string' }, capability: { type: 'string' }, value: scalar },
    },
    {
      type: 'object',
      required: ['type', 'event'],
      additionalProperties: false,
      properties: { type: { const: 'booth' }, event: { type: 'string', enum: ['countdown', 'sleep', 'wake'] } },
    },
  ],
};

const models = {
  Error: { type: 'object', properties: { error: { type: 'string' } } },
  User: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' } },
  },
  Event: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' }, date: { type: 'string' }, code: { type: 'string' } },
  },
  Terminal: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      online: { type: 'boolean' },
      lastSeenAt: date,
      permitJoinUntil: nullableDate,
    },
  },
  Capability: capabilitySchema,
  Device: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      terminalId: { type: 'string' },
      ieee: { type: 'string' },
      model: { type: 'string' },
      name: { type: 'string' },
      location: { type: ['string', 'null'] },
      enabled: { type: 'boolean' },
      online: { type: 'boolean' },
      battery: { type: ['number', 'null'] },
      lastSeenAt: date,
      capabilities: { type: 'array', items: { $ref: 'Capability#' } },
      state: { type: 'object', additionalProperties: nullableScalar },
    },
  },
  Rule: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      enabled: { type: 'boolean' },
      trigger: triggerSchema,
      schedule: scheduleSchema,
      actions: { type: 'array', items: actionSchema },
    },
  },
  JournalEvent: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      ts: date,
      type: { type: 'string', enum: ['reading', 'joined', 'online', 'offline', 'command', 'rule'] },
      deviceId: { type: ['string', 'null'] },
      deviceName: { type: ['string', 'null'] },
      message: { type: 'string' },
    },
  },
  Photo: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      url: { type: 'string' },
      thumbUrl: { type: 'string' },
      source: { type: 'string', enum: ['booth', 'guest'] },
      authorName: { type: ['string', 'null'] },
      mine: { type: 'boolean' },
      createdAt: date,
    },
  },
  ApiKey: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' }, createdAt: date, lastUsedAt: nullableDate },
  },
};

export function registerSchemas(app: FastifyInstance) {
  for (const [id, schema] of Object.entries(models)) app.addSchema({ $id: id, title: id, ...schema });
}

export const ref = (id: keyof typeof models) => ({ $ref: `${id}#` });
export const arrayOf = (id: keyof typeof models) => ({ type: 'array', items: ref(id) });
export const errorResponses = { 400: ref('Error'), 401: ref('Error'), 403: ref('Error'), 404: ref('Error') };
export const secured = [{ bearerAuth: [] }];
