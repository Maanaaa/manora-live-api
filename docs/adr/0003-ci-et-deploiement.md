# ADR 0003 — CI et déploiement

- Statut : accepté
- Date : 2026-11-12

## Contexte

Les autres projets de Manora sont déployés sur le VPS par Portainer, déclenché par un webhook depuis GitHub, derrière nginx. L'API doit suivre le même schéma et la CI doit vérifier la qualité exigée par la SAÉ (tests, rapport JUnit, sécurité).

## Décision

- **CI** (`.github/workflows/ci.yml`, sur push `main` et pull requests) : ESLint, vérification des types, tests `node --test` avec rapport `junit.xml` en artefact, construction de l'image Docker (sans publication), OSV-Scanner sur `package-lock.json` (informatif, non bloquant), gitleaks, et SonarCloud (`Maanaaa_manora-live-api`) seulement si le secret `SONAR_TOKEN` existe.
- **Déploiement** (`.github/workflows/deploy.yml`) : déclenché par la fin de la CI sur `main` (`workflow_run`), seulement si elle a réussi. Il appelle le webhook Portainer (`PORTAINER_WEBHOOK_URL`) ; sans ce secret, l'étape s'arrête proprement.
- **Conteneur** : `Dockerfile` multi-étapes `node:24-slim`, utilisateur `node` non root, healthcheck sur `GET /health`. `compose.yaml` : service `api`, conteneur `manora-live-api`, `restart: unless-stopped`, port `127.0.0.1:10015:3000`, volume nommé `manora-live-data` monté sur `/data`, variables `${VAR}` définies dans la stack Portainer.
- **Reverse proxy** : nginx sur le VPS publie `api.live.manora-photo.fr` (HTTPS) vers `127.0.0.1:10015`, avec la mise à niveau WebSocket :

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:10015;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      client_max_body_size 16m;
  }
  ```

  L'API envoie un ping WebSocket toutes les 30 s pour rester sous le délai d'inactivité de nginx (60 s).

## Conséquences

- Un push sur `main` qui casse la CI n'est jamais déployé.
- Le port n'écoute que sur la boucle locale : seul nginx l'expose, avec TLS.
- Les secrets ne sont que dans Portainer et GitHub ; le dépôt ne contient que `.env.example`.
