# ADR 0005 — Données et RGPD

- Statut : accepté
- Date : 2026-11-12

## Contexte

L'API stocke des comptes, des mesures de capteurs (présence, état de la prise…), un journal d'événements et des photos d'invités. Ces données touchent à la vie privée des clients et des invités ; le sujet demande une durée de conservation.

## Décision

- **Schéma SQLite** (`src/db.ts`, créé au démarrage) : `users`, `events` (événements de soirée : nom, date, code), `guests`, `terminals`, `devices`, `capabilities`, `readings` (mesures), `rules`, `journal`, `photos`, `api_keys`, `push_tokens`.
- **Minimisation** : un invité n'a ni e-mail ni mot de passe, seulement un identifiant lié à l'événement (le nom est facultatif). Les mots de passe sont hachés (scrypt), les clés d'API et du terminal ne sont gardées que sous forme d'empreinte ; une clé de borne n'est montrée qu'à sa création.
- **Conservation** : les mesures et le journal plus vieux que `RETENTION_DAYS` jours (30 par défaut) sont supprimés au démarrage puis chaque jour.
- **Photos** : fichiers JPEG dans `DATA_DIR/photos` (miniatures dans `photos/thumbs`), servis publiquement sur `/media/...` car leur URL est encodée dans le QR de la borne (identifiant aléatoire non devinable). Un invité ne liste que les photos de son événement ; l'auteur, l'hôte ou l'admin peut supprimer une photo, ce qui efface aussi les fichiers.
- **État des appareils** : un terminal est hors ligne après 90 s sans battement ; un appareil est hors ligne après 2 h sans message (les capteurs sur pile se signalent au moins toutes les heures). Le journal ne garde que les changements des capacités binaires et énumérées ; les mesures numériques vont dans l'historique.
- **Transport** : HTTPS par nginx, CORS limité à `CORS_ORIGINS`, taille des photos limitée (`MAX_UPLOAD_MB`), jeton du WebSocket masqué dans les journaux du serveur.

## Conséquences

- Une sauvegarde du volume `manora-live-data` suffit à tout restaurer (base et photos).
- Les photos ne sont pas purgées automatiquement : leur suppression relève de l'hôte, à la fin de l'événement.
