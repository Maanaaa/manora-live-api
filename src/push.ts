// Notifications Expo Push vers les téléphones des administrateurs et des hôtes.

import type { Db } from './db.ts';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Données transmises à l'app, ex. `{ url: '/gallery' }` pour ouvrir la galerie au toucher. */
  data?: Record<string, string>;
}

/** Envoie les messages et renvoie les jetons à oublier (appareil désinstallé ou jeton révoqué). */
export type PushSender = (messages: PushMessage[]) => Promise<string[] | void>;

/** Envoi réel vers Expo, par paquets de 100 (limite du service). */
export const expoPush: PushSender = async (messages) => {
  const invalid: string[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(batch.map((m) => ({ ...m, sound: 'default', channelId: 'default' }))),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Expo Push a répondu ${res.status}`);
    // Un ticket par message, dans le même ordre : « DeviceNotRegistered » = jeton à supprimer.
    const tickets = ((await res.json().catch(() => ({}))) as { data?: { status?: string; details?: { error?: string } }[] }).data ?? [];
    tickets.forEach((t, j) => {
      if (t?.status === 'error' && t.details?.error === 'DeviceNotRegistered' && batch[j]) invalid.push(batch[j].to);
    });
  }
  return invalid;
};

/** Supprime les jetons signalés invalides par Expo. */
export function forgetTokens(db: Db, tokens: string[] | void) {
  for (const token of tokens ?? []) db.prepare('DELETE FROM push_tokens WHERE token = ?').run(token);
}

export async function notifyStaff(db: Db, send: PushSender, body: string) {
  const tokens = db.prepare("SELECT token FROM push_tokens WHERE owner_role IN ('admin', 'host')").all();
  if (!tokens.length) return;
  forgetTokens(db, await send(tokens.map((t) => ({ to: String(t.token), title: 'Manora Live', body }))));
}
