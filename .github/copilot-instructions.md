# RoroJonggrang WhatsApp Service

- Use strict TypeScript and native ECMAScript modules.
- Keep Express app creation separate from server startup for testability.
- Access environment variables only through `src/config/env.ts`.
- Keep WhatsApp Web.js behind the `WhatsAppGateway` interface so tests never launch Chromium.
- Validate all request payloads with Zod and pass errors to centralized error middleware.
- Never commit `.env` or WhatsApp LocalAuth session data under `data/`.
- Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run lint` after changes.
