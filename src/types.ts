// Formes du contrat d'API (docs/adr/0002-contrat-api.md).

export type Role = 'admin' | 'host' | 'guest' | 'booth';
export type Value = boolean | number | string | null;

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'host';
}

export interface PartyEvent {
  id: string;
  name: string;
  date: string;
  code: string;
}

export interface Terminal {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string;
  permitJoinUntil: string | null;
}

export interface Capability {
  name: string;
  type: 'binary' | 'numeric' | 'enum';
  unit?: string;
  values?: string[];
  access: 'read' | 'write' | 'readwrite';
}

export interface Device {
  id: string;
  terminalId: string;
  ieee: string;
  model: string;
  name: string;
  location: string | null;
  enabled: boolean;
  online: boolean;
  battery: number | null;
  lastSeenAt: string;
  capabilities: Capability[];
  state: Record<string, Value>;
}

export type Operator = 'eq' | 'neq' | 'gt' | 'lt';

export type RuleAction =
  | { type: 'notify'; message: string }
  | { type: 'command'; deviceId: string; capability: string; value: boolean | number | string }
  | { type: 'booth'; event: 'countdown' | 'sleep' | 'wake' };

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: {
    deviceId: string;
    capability: string;
    operator: Operator;
    value: boolean | number | string;
    forSeconds?: number;
  };
  schedule?: { after?: string; before?: string };
  actions: RuleAction[];
}

export type EventType = 'reading' | 'joined' | 'online' | 'offline' | 'command' | 'rule';

export interface JournalEvent {
  id: string;
  ts: string;
  type: EventType;
  deviceId: string | null;
  deviceName: string | null;
  message: string;
}

export interface Photo {
  id: string;
  url: string;
  thumbUrl: string;
  /** Page publique de récupération (`/p/:id`), encodée dans le QR de la borne. */
  pageUrl: string;
  source: 'booth' | 'guest';
  authorName: string | null;
  mine: boolean;
  createdAt: string;
}

/** Appelant authentifié, déduit du jeton `Authorization: Bearer`. */
export type Principal =
  | { role: 'admin' | 'host'; id: string; name: string }
  | { role: 'guest'; id: string; name: string | null; eventId: string }
  | { role: 'booth'; id: string; name: string }
  | { role: 'terminal'; id: string };
