# Manora Live — API

API REST et temps réel de Manora Live, la borne photo connectée de Manora. Elle relie la passerelle Zigbee du Raspberry Pi (le « terminal »), l'app mobile (borne et invités) et le back-office.

- Contrat d'API (référence des deux clients) : [docs/adr/0002-contrat-api.md](docs/adr/0002-contrat-api.md)
- Documentation interactive (Swagger UI) : `/docs` — en production <https://api.live.manora-photo.fr/docs>, spécification OpenAPI sur `/docs/json`
- Temps réel : WebSocket `/ws?token=<jeton>`
- Décisions d'architecture : [docs/adr/](docs/adr/README.md)

Stack : Node 24, TypeScript, Fastify, SQLite (`node:sqlite`), sharp.

## Démarrage local (≈ 5 min)

Prérequis : Node 24 ou plus récent.

```bash
npm install
cp .env.example .env
# Renseigner au minimum JWT_SECRET (32 caractères ou plus), ADMIN_PASSWORD et TERMINAL_KEY :
#   openssl rand -base64 48
npm run dev
```

L'API écoute sur <http://localhost:3000> (Swagger : <http://localhost:3000/docs>). Au premier démarrage, elle crée le compte administrateur, le terminal et l'événement décrits dans `.env`. La base et les photos sont dans `DATA_DIR` (`./data` par défaut).

Vérification rapide :

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<ADMIN_PASSWORD>"}'
```

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur avec rechargement (TypeScript exécuté directement par Node) |
| `npm run lint` | ESLint |
| `npm run typecheck` | Vérification des types |
| `npm test` | Tests (moteur de règles, normalisation, HTTP) + rapport `junit.xml` |
| `npm run build` puis `npm start` | Compilation vers `dist/` et lancement |

## Docker (≈ 5 min)

```bash
cp .env.example .env   # renseigner les secrets ; PUBLIC_URL=http://127.0.0.1:10015 pour un essai local
docker compose --env-file .env up -d --build
curl http://127.0.0.1:10015/health
```

Le conteneur écoute sur `127.0.0.1:10015` (le port n'est pas exposé hors de la machine) et garde ses données dans le volume nommé `manora-live-data` (`/data`). L'image tourne avec un utilisateur non root et vérifie `/health` toutes les 30 s.

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `JWT_SECRET` | — (obligatoire) | Secret de signature des jetons, 32 caractères minimum |
| `PORT` | `3000` | Port HTTP |
| `DATA_DIR` | `./data` (`/data` en conteneur) | Base SQLite et photos |
| `PUBLIC_URL` | `http://localhost:3000` (`https://api.live.manora-photo.fr` dans `compose.yaml`) | Base des URL publiques des photos |
| `CORS_ORIGINS` | vide (aucune origine) | Origines autorisées, séparées par des virgules |
| `RETENTION_DAYS` | `30` | Conservation des mesures et du journal (RGPD) |
| `MAX_UPLOAD_MB` | `15` | Taille maximale d'une photo |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | Compte administrateur créé au démarrage s'il n'existe pas |
| `TERMINAL_ID`, `TERMINAL_KEY` | — | Terminal (Raspberry Pi) et sa clé, créés s'ils n'existent pas |
| `EVENT_NAME`, `EVENT_CODE` | — | Événement en cours et son code (QR de la borne) |

L'amorçage ne modifie jamais un élément existant : pour changer le mot de passe administrateur ou la clé du terminal après coup, passer par l'API ou repartir d'un volume vide.

## Déploiement (Portainer)

1. Dans Portainer, créer une stack depuis le dépôt Git (`compose.yaml`, branche `main`) et définir les variables ci-dessus dans l'onglet *Environment variables*.
2. Activer le webhook de la stack et copier son URL dans le secret GitHub `PORTAINER_WEBHOOK_URL`.
3. Sur le VPS, nginx publie `api.live.manora-photo.fr` vers `127.0.0.1:10015`, avec la mise à niveau WebSocket pour `/ws` (voir [ADR 0003](docs/adr/0003-ci-et-deploiement.md)).

À chaque push sur `main`, la CI tourne ; si elle réussit, le workflow *Deploy to Portainer* appelle le webhook et Portainer reconstruit la stack.

## Rôles

| Rôle | Jeton | Accès principal |
| --- | --- | --- |
| `admin` | JWT (`/auth/login`) | Tout |
| `host` | JWT (`/auth/login`) | Parc en lecture et commandes, photos |
| `guest` | JWT (`/auth/guest` avec le code de l'événement) | Galerie de son événement |
| `booth` | Clé d'API créée dans le back-office | Envoi de photos, messages `booth.*` |
| terminal | Clé `TERMINAL_KEY` | Routes `/terminal/*`, commandes par WebSocket |
