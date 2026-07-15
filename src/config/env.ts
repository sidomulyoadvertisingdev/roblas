import 'dotenv/config';
import { z } from 'zod';

const booleanString = z
  .union([z.enum(['true', 'false']), z.boolean()])
  .transform((value) => value === true || value === 'true');

const optionalString = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  API_KEY: z.string().min(16, 'API_KEY must contain at least 16 characters'),
  CORS_ORIGIN: z.string().default('http://localhost:5001'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Single-tenant only (ignored in multi-tenant mode — per-tenant from DB)
  WA_CLIENT_ID: optionalString(z.string().regex(/^[\w-]+$/)),
  WA_BOT_PHONE: optionalString(z.string().trim().min(7).max(30)),
  // Global (shared by all tenants)
  WA_AUTH_PATH: z.string().default('./data/auth'),
  WA_HEADLESS: booleanString.default(true),
  PUPPETEER_EXECUTABLE_PATH: optionalString(z.string()),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  SEND_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
  WEBHOOK_URL: optionalString(z.string().url()),
  WEBHOOK_SECRET: optionalString(z.string().min(16)),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  WEBHOOK_ALLOWED_SENDERS: z.string().default(''),
  WEBHOOK_IGNORE_GROUPS: booleanString.default(true),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().default('rorojongrang_wa'),
  // Bot config (single-tenant fallback only — multi-tenant uses per-tenant AI config)
  BOT_ENABLED: booleanString.default(false),
  GROQ_API_KEY: optionalString(z.string().min(1)),
  GROQ_MODEL: z.string().default('llama-3.1-8b-instant'),
  ADMIN_KEY: optionalString(z.string().min(16)),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = parsed.data;
export type Environment = typeof env;
