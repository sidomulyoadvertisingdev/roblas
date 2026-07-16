import session from 'express-session';
import knex from 'knex';
import { ConnectSessionKnexStore } from 'connect-session-knex';
import type { Logger } from '../logger.js';

export interface SessionConfig {
  secret: string;
  maxAgeMs: number;
  db: { host: string; port: number; user: string; password: string; database: string };
  logger: Logger;
}

export function createSessionMiddleware(config: SessionConfig): ReturnType<typeof session> {
  const knexInstance = knex({
    client: 'mysql2',
    connection: config.db,
    pool: { min: 0, max: 1 },
  });

  const store = new ConnectSessionKnexStore({
    knex: knexInstance,
    tableName: 'sessions',
    sidFieldName: 'sid',
    createTable: false,
    cleanupInterval: 60 * 60 * 1000,
  });

  return session({
    secret: config.secret,
    resave: false,
    saveUninitialized: false,
    name: 'sid',
    store,
    cookie: {
      maxAge: config.maxAgeMs,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  });
}
