// Configuration lue dans les variables d'environnement (voir .env.example).

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  publicUrl: string;
  jwtSecret: string;
  corsOrigins: string[];
  retentionDays: number;
  maxUploadBytes: number;
  admin: { email: string; password: string } | null;
  terminal: { id: string; key: string } | null;
  event: { name: string; code: string } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET doit contenir au moins 32 caractères.');

  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    dataDir: env.DATA_DIR ?? './data',
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/+$/, ''),
    jwtSecret,
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    retentionDays: Number(env.RETENTION_DAYS ?? 30),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 15) * 1024 * 1024,
    admin: env.ADMIN_EMAIL && env.ADMIN_PASSWORD ? { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD } : null,
    terminal: env.TERMINAL_ID && env.TERMINAL_KEY ? { id: env.TERMINAL_ID, key: env.TERMINAL_KEY } : null,
    event: env.EVENT_NAME && env.EVENT_CODE ? { name: env.EVENT_NAME, code: env.EVENT_CODE } : null,
  };
}
