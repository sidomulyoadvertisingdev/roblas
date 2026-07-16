import { randomUUID } from 'node:crypto';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import type { WhatsAppManager } from '../whatsapp/manager.js';

interface UserRow extends RowDataPacket {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  google_id: string;
  role: string;
  tenant_id: string | null;
  is_active: number;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  tenantId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface User {
      id: string;
      email: string;
      name: string;
      avatarUrl: string | null;
      role: string;
      tenantId: string | null;
    }
  }
}

export interface PassportConfigOptions {
  pool: Pool;
  logger: Logger;
  googleClientId: string;
  googleClientSecret: string;
  googleCallbackUrl: string;
  authBasePath: string;
  whatsappManager?: WhatsAppManager | undefined;
}

export function configurePassport(options: PassportConfigOptions): void {
  const { pool, logger, googleClientId, googleClientSecret, googleCallbackUrl, authBasePath, whatsappManager } = options;

  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const [rows] = await pool.execute<UserRow[]>(
        `SELECT * FROM users WHERE id = ? AND is_active = 1`,
        [id],
      );
      const row = rows[0];
      if (!row) {
        done(null, false);
        return;
      }
      done(null, {
        id: row.id,
        email: row.email,
        name: row.name,
        avatarUrl: row.avatar_url,
        role: row.role,
        tenantId: row.tenant_id,
      });
    } catch (error) {
      done(error);
    }
  });

  passport.use(
    new GoogleStrategy(
      {
        clientID: googleClientId,
        clientSecret: googleClientSecret,
        callbackURL: googleCallbackUrl,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const googleId = profile.id;
          const email = profile.emails?.[0]?.value ?? '';
          const name = profile.displayName;
          const avatarUrl = profile.photos?.[0]?.value ?? null;

          // Check if user exists
          const [existing] = await pool.execute<UserRow[]>(
            `SELECT * FROM users WHERE google_id = ?`,
            [googleId],
          );

          if (existing[0]) {
            // Update last login + profile
            await pool.execute(
              `UPDATE users SET last_login_at = NOW(), name = ?, avatar_url = ? WHERE id = ?`,
              [name, avatarUrl, existing[0].id],
            );
            logger.info({ event: 'user_login', userId: existing[0].id, email }, 'User logged in');
            done(null, {
              id: existing[0].id,
              email: existing[0].email,
              name,
              avatarUrl: avatarUrl ?? null,
              role: existing[0].role,
              tenantId: existing[0].tenant_id,
            });
            return;
          }

          // First login — create tenant + user + WA account (user is admin of own tenant)
          const userId = randomUUID();
          const tenantId = randomUUID();
          const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${randomUUID().slice(0, 6)}`;
          const displayName = name || email.split('@')[0];
          const waClientId = `wa-${tenantId.slice(0, 8)}`;
          const authPath = `${authBasePath}/${tenantId}`;

          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();

            await conn.execute<ResultSetHeader>(
              `INSERT INTO tenants (id, name, slug, is_active, plan) VALUES (?, ?, ?, 1, 'free')`,
              [tenantId, displayName, slug] as never,
            );

            await conn.execute<ResultSetHeader>(
              `INSERT INTO users (id, email, name, avatar_url, google_id, role, tenant_id, last_login_at) VALUES (?, ?, ?, ?, ?, 'admin', ?, NOW())`,
              [userId, email, name, avatarUrl, googleId, tenantId] as never,
            );

            await conn.execute<ResultSetHeader>(
              `INSERT INTO tenant_wa_accounts (id, tenant_id, client_id, phone, display_name, is_active, auth_session_path) VALUES (?, ?, ?, ?, ?, 1, ?)`,
              [randomUUID(), tenantId, waClientId, '0000000000', displayName, authPath] as never,
            );

            await conn.commit();
          } catch (err) {
            await conn.rollback();
            throw err;
          } finally {
            conn.release();
          }

          // Start WA client immediately so QR is available
          if (whatsappManager) {
            try {
              await whatsappManager.addClient({
                id: randomUUID(),
                tenantId,
                clientId: waClientId,
                phone: '0000000000',
                displayName: displayName ?? null,
                isActive: true,
                authSessionPath: authPath,
                lastReadyAt: null,
              });
              logger.info({ event: 'wa_client_started', tenantId, clientId: waClientId }, 'WA client started for new tenant');
            } catch (waError) {
              logger.error({ err: waError, tenantId }, 'Failed to start WA client for new tenant; QR will be available on next restart');
            }
          }

          logger.info({ event: 'user_registered', userId, tenantId, email }, 'New user + tenant created via Google OAuth');
          done(null, { id: userId, email, name, avatarUrl: avatarUrl ?? null, role: 'admin', tenantId });
        } catch (error) {
          logger.error({ err: error }, 'Google OAuth callback error');
          done(error);
        }
      },
    ),
  );
}
