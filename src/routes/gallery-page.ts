// Galerie en direct sur le web (`/g/:code`), ouverte en scannant le QR affiché sur l'accueil de la borne.
// Aucun téléchargement d'app : l'invité voit les photos de la soirée en temps réel et ajoute les siennes.
// La page utilise l'API publique comme l'app : jeton invité (`POST /auth/guest`), `GET /photos`,
// WebSocket `/ws` et `POST /photos`.

import type { FastifyInstance } from 'fastify';

import { requireRole } from '../auth.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { errorResponses, secured } from '../schemas.ts';
import { currentEvent } from '../store.ts';
import { escape, jsValue, renderMissingPage, shell } from './photo-page.ts';

const GALLERY_STYLE = `
.head{display:flex;flex-direction:column;gap:4px}
.live{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:var(--muted)}
.live i{width:9px;height:9px;border-radius:50%;background:#c9b48f}
.live.on i{background:#136d66;box-shadow:0 0 0 4px rgba(19,109,102,.15)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.grid a{display:block;aspect-ratio:1;border-radius:14px;overflow:hidden;background:var(--sand)}
.grid img{width:100%;height:100%;object-fit:cover;display:block}
.grid a.new{animation:pop .5s ease}
@keyframes pop{from{transform:scale(.85);opacity:0}to{transform:none;opacity:1}}
.empty,.error{text-align:center;color:var(--muted);background:var(--paper);border:1px dashed var(--sand);border-radius:20px;padding:28px 16px;margin:0}
.add{position:sticky;bottom:16px;z-index:2}
.toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:var(--ink);color:#fff;border-radius:999px;padding:10px 18px;font-size:14px;font-weight:700;max-width:90vw;text-align:center}
#more{margin-top:4px}
@media (min-width:700px){.grid{grid-template-columns:repeat(4,1fr)}}
body.noscroll{overflow:hidden}
.viewer{position:fixed;inset:0;z-index:10;background:#0b1622;color:#fff;display:flex;flex-direction:column}
.vbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:max(12px,env(safe-area-inset-top)) 12px 8px}
.vbar button{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.12);color:#fff;border:0;border-radius:999px;padding:10px 16px 10px 12px;font:inherit;font-size:16px;font-weight:700;cursor:pointer}
.vbar button svg{width:22px;height:22px}
#vcount{font-size:15px;font-weight:700;color:rgba(255,255,255,.75)}
.track{flex:1;min-height:0;display:flex;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.track::-webkit-scrollbar{display:none}
.slide{flex:0 0 100%;scroll-snap-align:center;scroll-snap-stop:always;display:flex;align-items:center;justify-content:center;padding:6px 10px}
.slide img{max-width:100%;max-height:100%;object-fit:contain;border-radius:16px;background:rgba(255,255,255,.05)}
.nav{display:none}
@media (hover:hover){.nav{display:flex;position:fixed;top:50%;transform:translateY(-50%);width:48px;height:48px;border-radius:50%;border:0;background:rgba(255,255,255,.14);color:#fff;font-size:30px;line-height:1;align-items:center;justify-content:center;cursor:pointer}.nav.prev{left:16px}.nav.next{right:16px}.nav:disabled{opacity:.25;cursor:default}}
.vfoot{padding:10px 16px max(16px,env(safe-area-inset-bottom))}
.vfoot .btn{max-width:520px;margin:0 auto}
.vbar button:focus-visible,.nav:focus-visible{outline:3px solid #fff;outline-offset:2px}
`;

const ICON_ADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

export function renderGalleryPage(eventName: string, code: string, publicUrl: string): string {
  const name = escape(eventName);
  const body = `<main>
<header>
  <img src="/assets/manora-logo.png" alt="Manora Photobooth">
  <span class="badge">Manora Live</span>
</header>
<div class="head">
  <h1>La galerie en direct</h1>
  <p class="meta">${name}</p>
  <span class="live" id="live"><i></i><span>Connexion…</span></span>
</div>
<section id="grid" class="grid" aria-live="polite" aria-label="Photos de la soirée"></section>
<p class="empty" id="empty" hidden>Pas encore de photo. Passez devant la borne ou ajoutez les vôtres !</p>
<p class="error" id="error" hidden></p>
<button type="button" class="btn secondary" id="more" hidden>Voir plus de photos</button>
<div class="add">
  <label class="btn primary" for="files">${ICON_ADD}Ajouter mes photos</label>
  <input id="files" type="file" accept="image/*" multiple hidden>
</div>
<footer>Les photos sont visibles par les invités de l’événement. Touchez une photo pour l’afficher en grand, faites défiler et enregistrez celles que vous aimez.</footer>
</main>
<div class="viewer" id="viewer" role="dialog" aria-modal="true" aria-label="Photo en grand" hidden>
  <div class="vbar">
    <button type="button" id="vback" aria-label="Retour à la galerie"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>Galerie</button>
    <span id="vcount" aria-live="polite"></span>
  </div>
  <div class="track" id="track"></div>
  <button type="button" class="nav prev" id="vprev" aria-label="Photo précédente">‹</button>
  <button type="button" class="nav next" id="vnext" aria-label="Photo suivante">›</button>
  <div class="vfoot"><button type="button" class="btn primary" id="vsave">Enregistrer dans ma galerie</button></div>
</div>
<div class="toast" id="toast" role="status" hidden></div>
<script>
(() => {
  const API = ${jsValue(publicUrl)};
  const CODE = ${jsValue(code)};
  const KEY = 'manora.guest.' + CODE.toUpperCase();
  const $ = (id) => document.getElementById(id);
  const grid = $('grid'), more = $('more'), live = $('live');
  const seen = new Set();
  let token = null, oldest = null;

  const toast = (text, ms = 2500) => { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), ms); };
  const fail = (text) => { const e = $('error'); e.textContent = text; e.hidden = false; };
  const setLive = (on) => { live.classList.toggle('on', on); live.lastElementChild.textContent = on ? 'En direct' : 'Reconnexion…'; };

  async function getToken(force) {
    if (!force) { try { token = localStorage.getItem(KEY); } catch {} }
    if (token && !force) return token;
    const r = await fetch(API + '/auth/guest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: CODE }) });
    if (!r.ok) throw new Error('code');
    token = (await r.json()).token;
    try { localStorage.setItem(KEY, token); } catch {}
    return token;
  }

  async function api(path, options = {}) {
    for (const force of [false, true]) {
      const t = await getToken(force);
      const r = await fetch(API + path, { ...options, headers: { ...(options.headers || {}), authorization: 'Bearer ' + t } });
      if (r.status !== 401) return r;
    }
    throw new Error('auth');
  }

  const byId = new Map();
  function tile(photo, atTop) {
    if (seen.has(photo.id)) return;
    seen.add(photo.id);
    byId.set(photo.id, photo);
    const a = document.createElement('a');
    a.href = photo.pageUrl || photo.url;
    a.dataset.id = photo.id;
    a.setAttribute('aria-label', 'Ouvrir la photo');
    const img = document.createElement('img');
    img.src = photo.thumbUrl; img.alt = ''; img.loading = 'lazy';
    a.append(img);
    a.addEventListener('click', (e) => { e.preventDefault(); openViewer([...grid.children].indexOf(a)); });
    if (atTop) { a.className = 'new'; grid.prepend(a); } else grid.append(a);
    $('empty').hidden = true;
  }

  async function load() {
    const r = await api('/photos?limit=30' + (oldest ? '&after=' + encodeURIComponent(oldest) : ''));
    if (!r.ok) throw new Error('photos');
    const list = await r.json();
    list.forEach((p) => tile(p, false));
    if (list.length) oldest = list[list.length - 1].id;
    more.hidden = list.length < 30;
    if (!seen.size) $('empty').hidden = false;
  }

  let attempt = 0;
  function connect() {
    const ws = new WebSocket(API.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token));
    ws.onopen = () => { attempt = 0; setLive(true); };
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'photo.created') tile(msg.data, true);
      if (msg.type === 'photo.deleted') { const el = grid.querySelector('[data-id="' + CSS.escape(msg.data.id) + '"]'); if (el) el.remove(); seen.delete(msg.data.id); byId.delete(msg.data.id); }
    };
    ws.onclose = () => { setLive(false); attempt++; setTimeout(connect, Math.min(30000, 1000 * 2 ** attempt)); };
  }

  // Photos du téléphone → JPEG (l'API n'accepte que le JPEG ; l'iPhone peut fournir du HEIC), 2048 px au plus.
  async function toJpeg(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('jpeg'))), 'image/jpeg', 0.85));
  }

  $('files').addEventListener('change', async (event) => {
    const files = [...event.target.files]; event.target.value = '';
    let ok = 0;
    for (const [i, file] of files.entries()) {
      toast('Envoi ' + (i + 1) + ' / ' + files.length + '…', 60000);
      try {
        const form = new FormData();
        form.append('source', 'guest');
        form.append('photo', await toJpeg(file), 'photo.jpg');
        const r = await api('/photos', { method: 'POST', body: form });
        if (r.ok) ok++;
      } catch {}
    }
    toast(ok === files.length ? (ok > 1 ? ok + ' photos ajoutées à la galerie' : 'Photo ajoutée à la galerie') : (files.length - ok) + ' photo(s) non envoyée(s), réessayez', 3500);
  });

  // ---------- Visionneuse : plein écran, défilement horizontal, retour ----------
  const viewer = $('viewer'), track = $('track');
  let slides = [], current = 0;
  const files = new Map(); // fichiers préparés pour la feuille de partage (iPhone)

  function prepare(photo) {
    if (!photo || files.has(photo.id)) return;
    files.set(photo.id, null);
    fetch(photo.url).then((r) => r.blob()).then((blob) => {
      const f = new File([blob], 'manora-' + photo.id.slice(0, 8) + '.jpg', { type: 'image/jpeg' });
      files.set(photo.id, navigator.canShare && navigator.canShare({ files: [f] }) ? f : null);
    }).catch(() => files.delete(photo.id));
  }

  function show(index) {
    current = Math.max(0, Math.min(slides.length - 1, index));
    $('vcount').textContent = (current + 1) + ' / ' + slides.length;
    $('vprev').disabled = current === 0;
    $('vnext').disabled = current === slides.length - 1;
    // Charge la photo affichée et ses voisines en pleine définition.
    for (const i of [current - 1, current, current + 1]) {
      const img = track.children[i] && track.children[i].firstElementChild;
      if (img && img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
    }
    prepare(slides[current]);
  }

  function goTo(index, smooth) {
    track.scrollTo({ left: index * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    show(index);
  }

  function openViewer(index) {
    slides = [...grid.children].map((a) => byId.get(a.dataset.id)).filter(Boolean);
    track.replaceChildren(...slides.map((photo) => {
      const slide = document.createElement('div');
      slide.className = 'slide';
      const img = document.createElement('img');
      img.src = photo.thumbUrl; img.dataset.src = photo.url; img.alt = 'Photo de la soirée';
      slide.append(img);
      return slide;
    }));
    viewer.hidden = false;
    document.body.classList.add('noscroll');
    history.pushState({ viewer: true }, '');
    requestAnimationFrame(() => goTo(index, false));
    $('vback').focus();
  }

  function hideViewer() {
    viewer.hidden = true;
    document.body.classList.remove('noscroll');
  }

  // Le bouton retour (ou le geste retour du téléphone) ferme la visionneuse sans quitter la galerie.
  $('vback').addEventListener('click', () => (history.state && history.state.viewer ? history.back() : hideViewer()));
  window.addEventListener('popstate', () => { if (!viewer.hidden) hideViewer(); });

  let scrollTimer;
  track.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => show(Math.round(track.scrollLeft / track.clientWidth)), 60);
  });
  $('vprev').addEventListener('click', () => goTo(current - 1, true));
  $('vnext').addEventListener('click', () => goTo(current + 1, true));
  window.addEventListener('resize', () => { if (!viewer.hidden) goTo(current, false); });
  document.addEventListener('keydown', (e) => {
    if (viewer.hidden) return;
    if (e.key === 'ArrowRight') goTo(current + 1, true);
    else if (e.key === 'ArrowLeft') goTo(current - 1, true);
    else if (e.key === 'Escape') $('vback').click();
  });

  $('vsave').addEventListener('click', async () => {
    const photo = slides[current];
    if (!photo) return;
    const file = files.get(photo.id);
    if (file) {
      try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = photo.url; a.download = 'manora-' + photo.id.slice(0, 8) + '.jpg';
    document.body.append(a); a.click(); a.remove();
  });

  more.addEventListener('click', () => load().catch(() => toast('Impossible de charger la suite')));

  getToken(false)
    .then(load)
    .then(connect)
    .catch((e) => fail(e.message === 'code' ? 'Cette galerie n’existe plus.' : 'Impossible de charger la galerie. Vérifiez votre connexion et rechargez la page.'));
})();
</script>`;
  return shell(`Galerie en direct — ${eventName}`, `<style>${GALLERY_STYLE}</style>`, body);
}

export function galleryPageRoutes(app: FastifyInstance, { db, config }: Ctx) {
  app.get<{ Params: { code: string } }>(
    '/g/:code',
    { schema: { hide: true, params: { type: 'object', properties: { code: { type: 'string', maxLength: 64 } } } } },
    async (request, reply) => {
      reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex');
      const row = db.prepare('SELECT name, code FROM events WHERE code = ?').get(request.params.code.trim()) as { name: string; code: string } | undefined;
      if (!row) {
        return reply
          .code(404)
          .send(renderMissingPage('Galerie introuvable', 'Ce code ne correspond à aucun événement.', 'Scannez à nouveau le QR code affiché sur la borne.'));
      }
      return reply.send(renderGalleryPage(row.name, row.code, config.publicUrl));
    },
  );

  // La borne récupère l'événement en cours pour afficher le QR de la galerie en direct.
  app.get(
    '/booth/event',
    {
      preHandler: requireRole('booth'),
      schema: {
        tags: ['Photos'],
        summary: 'Événement en cours et adresse de sa galerie en direct (borne)',
        security: secured,
        response: {
          200: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' }, code: { type: 'string' }, galleryUrl: { type: 'string' } },
          },
          ...errorResponses,
        },
      },
    },
    async () => {
      const event = currentEvent(db);
      if (!event) throw notFound('Événement');
      return { id: event.id, name: event.name, code: event.code, galleryUrl: `${config.publicUrl}/g/${encodeURIComponent(event.code)}` };
    },
  );
}
