# ADR 0001 — Stack de l'API

- Statut : accepté
- Date : 2026-11-12

## Contexte

L'API tourne sur le VPS de Manora, à côté des autres services, dans un conteneur Docker géré par Portainer. Elle doit servir un contrat REST + WebSocket déjà consommé par deux clients (ADR 0002), recevoir les mesures du Raspberry Pi, stocker des photos et rester simple à maintenir par une seule personne. Le rendu de la SAÉ est proche : peu de dépendances, rien de natif à compiler.

## Décision

- **Node 24 + TypeScript (ESM)**. Node exécute directement les fichiers `.ts` (suppression des types) : `npm run dev` n'a besoin d'aucun outil supplémentaire ; `tsc` compile vers `dist/` pour l'image Docker.
- **Fastify** : schémas JSON pour valider les corps et générer la documentation OpenAPI (`@fastify/swagger`, Swagger UI sur `/docs`), plugins officiels pour le WebSocket, le multipart, CORS et JWT.
- **SQLite via `node:sqlite`** (module intégré) : un seul fichier dans `DATA_DIR`, aucune dépendance native, aucun service de base de données à gérer. Requêtes SQL écrites à la main, sans ORM.
- **Mots de passe** hachés avec `scrypt` de `node:crypto` ; clés d'API (bornes, terminal) stockées sous forme d'empreinte SHA-256.
- **sharp** pour vérifier les JPEG et produire les miniatures (480 px).
- **Jetons** : JWT HS256 de 7 jours pour `admin`, `host` et `guest` ; le rôle est relu en base à chaque requête (un compte supprimé perd l'accès tout de suite). Les bornes et le terminal utilisent une clé longue envoyée dans le même en-tête `Authorization: Bearer`.

## Conséquences

- Démarrage local en quelques minutes (`npm install`, `.env`, `npm run dev`).
- SQLite limite l'API à une seule instance : suffisant pour une borne et un terminal par soirée.
- `node:sqlite` évolue encore selon les versions de Node : l'image fixe Node 24 (`node:24-slim`) et la CI teste sur Node 24.
