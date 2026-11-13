// Notifications « nouvelles photos dans la galerie » pour les invités d'un événement.
// Regroupées par téléphone : au plus une notification par fenêtre (5 min par défaut),
// qui annonce le nombre de photos ajoutées depuis la précédente. L'auteur de la photo n'est pas prévenu.

import type { Db } from './db.ts';
import { forgetTokens, type PushSender } from './push.ts';

interface Pending {
  count: number;
  eventName: string;
  lastSent: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface PhotoNotifierDeps {
  db: Db;
  send: PushSender;
  onError?: (err: unknown) => void;
  windowMs?: number;
  now?: () => number;
}

export function photoMessage(count: number, eventName: string) {
  return {
    title: 'Nouvelles photos 📸',
    body:
      count > 1
        ? `${count} nouvelles photos dans la galerie « ${eventName} ».`
        : `Une nouvelle photo dans la galerie « ${eventName} ».`,
    data: { url: '/gallery' },
  };
}

export class PhotoNotifier {
  private readonly pending = new Map<string, Pending>();
  private readonly deps: Required<Omit<PhotoNotifierDeps, 'onError'>> & Pick<PhotoNotifierDeps, 'onError'>;

  constructor(deps: PhotoNotifierDeps) {
    this.deps = { windowMs: 5 * 60 * 1000, now: Date.now, ...deps };
  }

  /** Une photo vient d'être ajoutée à la galerie d'un événement. */
  photoAdded(eventId: string | null, authorId: string) {
    if (!eventId) return;
    const event = this.deps.db.prepare('SELECT name FROM events WHERE id = ?').get(eventId) as { name: string } | undefined;
    if (!event) return;
    const rows = this.deps.db
      .prepare(
        `SELECT pt.token FROM push_tokens pt JOIN guests g ON g.id = pt.owner_id
         WHERE pt.owner_role = 'guest' AND g.event_id = ? AND pt.owner_id != ?`,
      )
      .all(eventId, authorId) as { token: string }[];

    const now = this.deps.now();
    for (const { token } of rows) {
      const p = this.pending.get(token) ?? { count: 0, eventName: event.name, lastSent: 0 };
      p.count += 1;
      p.eventName = event.name;
      this.pending.set(token, p);
      if (p.timer) continue; // un envoi groupé est déjà prévu
      const wait = p.lastSent + this.deps.windowMs - now;
      if (wait <= 0) this.flush(token);
      else p.timer = setTimeout(() => this.flush(token), wait);
    }
  }

  private flush(token: string) {
    const p = this.pending.get(token);
    if (!p || !p.count) return;
    const message = { to: token, ...photoMessage(p.count, p.eventName) };
    p.count = 0;
    p.lastSent = this.deps.now();
    p.timer = undefined;
    this.deps
      .send([message])
      .then((invalid) => {
        forgetTokens(this.deps.db, invalid);
        if (invalid?.includes(token)) this.pending.delete(token);
      })
      .catch((err) => this.deps.onError?.(err));
  }

  /** Arrête les envois en attente (fermeture du serveur, tests). */
  stop() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
