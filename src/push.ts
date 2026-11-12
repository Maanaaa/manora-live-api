// Notifications Expo Push vers les téléphones des administrateurs et des hôtes.

import type { Db } from './db.ts';

export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export type PushSender = (messages: { to: string; title: string; body: string }[]) => Promise<void>;

/** Envoi réel vers Expo, par paquets de 100 (limite du service). */
export const expoPush: PushSender = async (messages) => {
  for (let i = 0; i < messages.length; i += 100) {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages.slice(i, i + 100).map((m) => ({ ...m, sound: 'default' }))),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Expo Push a répondu ${res.status}`);
  }
};

export async function notifyStaff(db: Db, send: PushSender, body: string) {
  const tokens = db.prepare("SELECT token FROM push_tokens WHERE owner_role IN ('admin', 'host')").all();
  if (!tokens.length) return;
  await send(tokens.map((t) => ({ to: String(t.token), title: 'Manora Live', body })));
}
