# ADR 0007 — Galerie en direct sur le web

- Statut : accepté
- Date : 2026-11-12

## Contexte

L'accueil de la borne doit afficher un QR pour rejoindre la galerie en direct. La galerie n'existait que dans l'app mobile, ouverte par le lien `manoralive://join?code=…` : il ne fonctionne qu'avec l'app installée (ni dans Expo Go, ni pour un invité qui scanne avec l'appareil photo de son téléphone).

## Décision

- L'API sert une page publique **`/g/:code`** (charte Manora), sans installation : photos de l'événement en grille, mises à jour en temps réel, toucher une photo ouvre sa page de récupération (ADR 0006), bouton **« Ajouter mes photos »** pour envoyer celles du téléphone.
- La page consomme l'API comme l'app : jeton invité obtenu avec le code (`POST /auth/guest`, gardé dans le navigateur pour ne pas recréer un invité à chaque visite), `GET /photos` paginé, WebSocket `/ws` (`photo.created`, `photo.deleted`) avec reconnexion, `POST /photos`.
- Les photos du téléphone sont converties en JPEG (2048 px au plus) dans le navigateur avant l'envoi : l'API n'accepte que le JPEG et l'iPhone fournit souvent du HEIC.
- La borne obtient l'adresse par **`GET /booth/event`** (rôle `booth`) et affiche le QR sur son accueil, avec le logo Manora au centre.
- Protections : code d'événement inconnu → page « Galerie introuvable » (404), `noindex`, contenu échappé, valeurs insérées dans le script encodées en JSON avec `<` échappé.

## Conséquences

- Les invités rejoignent la galerie d'un simple scan ; l'app reste disponible pour ceux qui l'ont.
- Quiconque possède le code de l'événement voit sa galerie : c'est le principe du QR affiché sur la borne.
- Testé dans `tests/photo-page.test.ts`.
