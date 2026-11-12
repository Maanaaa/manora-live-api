import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Fleet } from './fleet.ts';
import type { Hub } from './realtime.ts';

/** Dépendances partagées par les routes. */
export interface Ctx {
  config: Config;
  db: Db;
  hub: Hub;
  fleet: Fleet;
}
