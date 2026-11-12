# ADR 0006 — Page publique de récupération des photos

- Statut : accepté
- Date : 2026-11-12

## Contexte

À la fin d'une photo, la borne affiche un QR code. Il pointait vers le fichier JPEG brut (`/media/photos/<id>.jpg`) : sur un téléphone, l'invité tombait sur une image seule, sans repère ni bouton, et ne savait pas toujours comment l'enregistrer (surtout sur iPhone).

## Décision

- L'API sert une page publique **`/p/:id`**, pensée pour le téléphone et aux couleurs de Manora (Plus Jakarta Sans servie en local sous `/assets`) : nom de l'événement, date et heure (Europe/Paris), la photo, un bouton **Télécharger la photo** (`download`, fichier `manora-<date>.jpg`) et un bouton **Enregistrer ou partager** (Web Share API avec le fichier : sur iPhone, « Enregistrer l'image » l'ajoute à Photos). Une astuce s'affiche sur iPhone.
- Les photos exposent `pageUrl` (contrat ADR 0002, aussi renvoyé par `POST /photos`) ; c'est cette adresse que le QR de la borne encode. `url` reste l'image JPEG, utilisée par l'app.
- Page rendue côté serveur, sans framework : une seule requête, rien à déployer en plus.
- Protections : identifiant UUID vérifié avant toute requête, contenu échappé (nom d'événement), page « Photo introuvable » en 404, `noindex` (balise et en-tête `X-Robots-Tag`), `Cache-Control: no-store` ; seuls deux fichiers sont servis sous `/assets` (liste fermée).

## Conséquences

- Toute photo existante a sa page, y compris celles prises avant cette décision.
- La page est publique pour qui possède le lien (identifiant non devinable) : c'est le principe du QR. La suppression d'une photo rend la page introuvable.
- Testé dans `tests/photo-page.test.ts`.
