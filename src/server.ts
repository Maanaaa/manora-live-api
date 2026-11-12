// Point d'entrée : amorçage, tâches périodiques et écoute HTTP.

import { buildApp } from './app.ts';
import { bootstrap } from './bootstrap.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const { app, ctx } = await buildApp(config);
await bootstrap(ctx.db, config);
ctx.fleet.reloadRules();

const purge = () => app.log.info(ctx.fleet.purge(config.retentionDays), 'Purge RGPD');
purge();

const timers = [
  setInterval(() => ctx.fleet.tick(), 1000), // règles « tenues N s »
  setInterval(() => ctx.fleet.sweep(), 15_000), // terminaux et appareils hors ligne
  setInterval(() => ctx.hub.ping(), 30_000),
  setInterval(purge, 24 * 60 * 60 * 1000),
];

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    timers.forEach(clearInterval);
    await app.close();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
