// Page publique de récupération d'une photo (`/p/:id`), ouverte en scannant le QR de la borne.
// Pensée pour le téléphone : voir la photo, la télécharger, l'enregistrer ou la partager.

import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';

import type { Ctx } from '../context.ts';

const UUID = '^[0-9a-f-]{36}$';
const ASSETS: Record<string, string> = {
  'PlusJakartaSans.woff2': 'font/woff2',
  'manora-logo.png': 'image/png',
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface PhotoPageData {
  publicUrl: string;
  imageUrl: string;
  thumbUrl: string;
  eventName: string | null;
  createdAt: string;
  fileName: string;
}

const STYLE = `
@font-face{font-family:'Plus Jakarta Sans';src:url('/assets/PlusJakartaSans.woff2') format('woff2');font-weight:200 800;font-display:swap}
:root{--ink:#132537;--muted:#475569;--terracotta:#b83a22;--terracotta-dark:#9c2e19;--cream:#fffaf1;--paper:#fffefb;--sand:#ead8bd}
*{box-sizing:border-box}
html,body{margin:0}
body{font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif;background:var(--cream);color:var(--ink);min-height:100vh;-webkit-font-smoothing:antialiased}
main{max-width:560px;margin:0 auto;padding:20px 16px 40px;display:flex;flex-direction:column;gap:18px}
header{display:flex;align-items:center;justify-content:space-between}
header img{height:40px;width:auto}
.badge{font-size:13px;font-weight:700;color:var(--terracotta);background:#fff1ee;border-radius:999px;padding:6px 12px}
h1{font-size:30px;line-height:1.1;font-weight:800;margin:6px 0 0}
.meta{color:var(--muted);font-size:15px;margin:0}
.photo{margin:0;border-radius:28px;overflow:hidden;background:var(--paper);border:1px solid var(--sand);box-shadow:0 24px 48px -12px rgba(19,37,55,.18)}
.photo img{display:block;width:100%;height:auto}
.actions{display:grid;gap:10px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;min-height:56px;border-radius:999px;font:inherit;font-size:17px;font-weight:800;text-decoration:none;border:1.5px solid transparent;cursor:pointer;width:100%}
.btn svg{width:22px;height:22px;flex:none}
.primary{background:var(--terracotta);color:#fff}
.primary:active{background:var(--terracotta-dark)}
.secondary{background:var(--paper);color:var(--ink);border-color:var(--sand)}
.btn:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
.tip{font-size:14px;line-height:1.5;color:var(--muted);background:var(--paper);border:1px dashed var(--sand);border-radius:18px;padding:12px 14px;margin:0}
footer{font-size:13px;line-height:1.5;color:var(--muted);text-align:center;margin-top:6px}
[hidden]{display:none!important}
@media (min-width:700px){main{padding-top:40px}h1{font-size:36px}}
`;

const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';

function shell(title: string, head: string, body: string) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#fffaf1">
<title>${escape(title)}</title>
${head}
<style>${STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

export function renderPhotoPage(d: PhotoPageData): string {
  const when = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'long', timeStyle: 'short' }).format(new Date(d.createdAt));
  const event = d.eventName ? escape(d.eventName) : 'Manora Live';
  const head = `<meta property="og:title" content="Ma photo — ${event}">
<meta property="og:image" content="${escape(d.thumbUrl)}">
<meta property="og:type" content="website">`;
  const body = `<main>
<header>
  <img src="/assets/manora-logo.png" alt="Manora Photobooth">
  <span class="badge">Manora Live</span>
</header>
<div>
  <h1>Votre photo est prête</h1>
  <p class="meta">${event} · ${escape(when)}</p>
</div>
<figure class="photo"><img src="${escape(d.imageUrl)}" alt="Votre photo prise à la borne Manora"></figure>
<div class="actions">
  <a class="btn primary" id="save" href="${escape(d.imageUrl)}" download="${escape(d.fileName)}">${ICON_DOWNLOAD}Enregistrer dans ma galerie</a>
</div>
<p class="tip" id="tip-ios" hidden>Sur iPhone, choisissez ensuite « Enregistrer l’image » : la photo arrive dans vos Photos.</p>
<footer>Photo prise à la borne Manora Live. Elle est visible par les invités de l’événement ; pour la faire supprimer, adressez-vous à l’organisateur.</footer>
</main>
<script>
(() => {
  // Un seul bouton. Sur téléphone, la feuille de partage avec le fichier propose « Enregistrer l'image »
  // (iPhone → Photos). Ailleurs, le lien télécharge le fichier (Android : visible dans la galerie).
  // L'image est préparée dès l'ouverture : sur iPhone, attendre le réseau après le toucher bloque le partage.
  const save = document.getElementById('save');
  const name = ${JSON.stringify(d.fileName)};
  if (/iPhone|iPad|iPod/.test(navigator.userAgent)) document.getElementById('tip-ios').hidden = false;
  let file = null;
  fetch(${JSON.stringify(d.imageUrl)})
    .then((r) => r.blob())
    .then((blob) => {
      const f = new File([blob], name, { type: 'image/jpeg' });
      if (navigator.canShare && navigator.canShare({ files: [f] })) file = f;
    })
    .catch(() => {});
  save.addEventListener('click', async (event) => {
    if (!file) return; // pas de partage de fichier : le lien télécharge la photo
    event.preventDefault();
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e && e.name !== 'AbortError') location.href = save.href;
    }
  });
})();
</script>`;
  return shell(`Votre photo — ${d.eventName ?? 'Manora Live'}`, head, body);
}

export function renderMissingPage(): string {
  return shell(
    'Photo introuvable — Manora Live',
    '',
    `<main>
<header><img src="/assets/manora-logo.png" alt="Manora Photobooth"><span class="badge">Manora Live</span></header>
<div><h1>Photo introuvable</h1><p class="meta">Elle a peut-être été supprimée, ou le lien est incomplet.</p></div>
<p class="tip">Rapprochez-vous de la borne pour reprendre une photo, ou demandez le lien à l’organisateur.</p>
</main>`,
  );
}

export function photoPageRoutes(app: FastifyInstance, { db, config }: Ctx) {
  const assetsDir = join(process.cwd(), 'assets');

  app.get<{ Params: { id: string } }>(
    '/p/:id',
    { schema: { hide: true, params: { type: 'object', properties: { id: { type: 'string' } } } } },
    async (request, reply) => {
      reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex');
      const id = request.params.id;
      const row = new RegExp(UUID).test(id)
        ? (db.prepare('SELECT p.id, p.created_at, e.name AS event_name FROM photos p LEFT JOIN events e ON e.id = p.event_id WHERE p.id = ?').get(id) as
            | { id: string; created_at: string; event_name: string | null }
            | undefined)
        : undefined;
      if (!row) return reply.code(404).send(renderMissingPage());
      const stamp = row.created_at.slice(0, 16).replace(/[:T]/g, '-');
      return reply.send(
        renderPhotoPage({
          publicUrl: config.publicUrl,
          imageUrl: `${config.publicUrl}/media/photos/${row.id}.jpg`,
          thumbUrl: `${config.publicUrl}/media/thumbs/${row.id}.jpg`,
          eventName: row.event_name,
          createdAt: row.created_at,
          fileName: `manora-${stamp}.jpg`,
        }),
      );
    },
  );

  app.get<{ Params: { file: string } }>('/assets/:file', { schema: { hide: true } }, async (request, reply) => {
    const type = ASSETS[request.params.file];
    const path = join(assetsDir, request.params.file);
    if (!type || !existsSync(path)) return reply.code(404).send();
    return reply.type(type).header('Cache-Control', 'public, max-age=604800').send(createReadStream(path));
  });
}
