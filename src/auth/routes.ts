import { Router, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import passport from 'passport';
import type { Pool } from 'mysql2/promise';
import type { Logger } from '../logger.js';
import { configurePassport } from './passport.js';
import type { WhatsAppManager } from '../whatsapp/manager.js';

export interface AuthRoutesOptions {
  pool: Pool;
  logger: Logger;
  googleClientId: string;
  googleClientSecret: string;
  googleCallbackUrl: string;
  sessionSecret: string;
  sessionMaxAgeMs: number;
  frontendUrl?: string;
  authBasePath: string;
  whatsappManager?: WhatsAppManager;
}

export function createAuthRoutes(options: AuthRoutesOptions): Router {
  const {
    pool,
    logger,
    googleClientId,
    googleClientSecret,
    googleCallbackUrl,
    frontendUrl,
    authBasePath,
    whatsappManager,
  } = options;

  const router = Router();

  // Configure passport
  configurePassport({
    pool,
    logger,
    googleClientId,
    googleClientSecret,
    googleCallbackUrl,
    authBasePath,
    whatsappManager,
  });

  router.use(passport.initialize());

  // GET /auth/me — current user info
  router.get('/me', (req, res) => {
    if (req.isAuthenticated()) {
      res.json({ user: req.user });
    } else {
      res.json({ user: null });
    }
  });

  // GET /auth/login — initiate Google OAuth
  const googleAuth = passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
  }) as RequestHandler;
  router.get('/login', googleAuth);

  // GET /auth/google/callback — OAuth callback
  const googleCallback = (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('google', (err: unknown, user: unknown, info: unknown) => {
      if (err) {
        logger.error({ event: 'oauth_callback_error', err }, 'Google OAuth callback error');
        res.redirect(`${frontendUrl ?? ''}/login?error=auth_error`);
        return;
      }
      if (!user) {
        logger.error({ event: 'oauth_callback_failed', info, hasSession: Boolean(req.session), hasPassport: Boolean((req.session as { passport?: unknown } | undefined)?.passport) }, 'Google OAuth callback failed (no user)');
        res.redirect(`${frontendUrl ?? ''}/login?error=oauth_failed`);
        return;
      }
      req.logIn(user as Express.User, (loginErr) => {
        if (loginErr) {
          logger.error({ event: 'oauth_login_error', err: loginErr }, 'Google OAuth login error');
          res.redirect(`${frontendUrl ?? ''}/login?error=login_error`);
          return;
        }
        logger.info({ event: 'oauth_callback_success' }, 'Google OAuth callback successful');
        res.redirect(frontendUrl ?? '/');
      });
    })(req, res, next);
  };
  router.get('/google/callback', googleCallback as RequestHandler);

  const handleLogout = (req: Request, res: Response) => {
    const userId = (req.user as { id: string } | undefined)?.id;
    req.logout((err) => {
      if (err) {
        logger.error({ err: err }, 'Logout error');
        res.status(500).json({ error: 'Logout failed' });
        return;
      }
      req.session.destroy((sessionErr) => {
        if (sessionErr) {
          logger.error({ err: sessionErr }, 'Session destroy error');
        }
        res.clearCookie('sid');
        logger.info({ event: 'user_logout', userId }, 'User logged out');
        if (req.method === 'GET') {
          res.redirect('/login');
        } else {
          res.json({ success: true });
        }
      });
    });
  };

  router.get('/logout', handleLogout as RequestHandler);
  router.post('/logout', handleLogout as RequestHandler);

  return router;
}
