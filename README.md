# RoroJonggrang WhatsApp Service

Standalone Node.js/TypeScript REST service built with Express and WhatsApp Web.js. It is designed for later integration with the RoroJonggrang Flask CRM while keeping browser automation isolated from the Python application.

## Requirements

- Node.js 20 or newer
- npm
- Chrome/Chromium (WhatsApp Web.js downloads a compatible browser during normal npm installation)

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env`.
3. Replace `API_KEY` with a random secret of at least 32 characters.
4. Set `CORS_ORIGIN` to the Flask CRM origin. Multiple origins can be comma-separated.
5. Start development mode: `npm run dev`
6. Scan the QR printed in the terminal using WhatsApp's **Linked devices** screen.

Authentication is persisted by `LocalAuth` under `data/auth`. Never copy or commit this directory because it contains an active WhatsApp session.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Run with TypeScript watch mode |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled service |
| `npm test` | Run Vitest tests without Chromium |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Check strict TypeScript types |

## Authentication

`GET /health` is public for container health checks. Every `/api/*` endpoint requires the configured secret in the `x-api-key` header. Use HTTPS between systems in production and rotate the API key if exposed.

## Endpoints

### `GET /health`

Returns HTTP service health and the current WhatsApp readiness state.

### `GET /api/status`

Returns lifecycle state (`initializing`, `qr_pending`, `authenticated`, `ready`, `disconnected`, `auth_failure`, `error`, or `stopped`) and connected account metadata.

### `GET /api/qr`

Returns the current raw QR value and state. The QR is `null` after authentication or before one is generated.

### `POST /api/validate-number`

Request body: `{ "phone": "081234567890" }`. Indonesian numbers starting with `0` are normalized to country code `62`; international numbers can start with `+`.

### `POST /api/send`

Request body: `{ "phone": "081234567890", "message": "Halo dari RoroJonggrang" }`. The service validates registration before sending. A stricter per-IP limiter protects this endpoint.

Example request:

    curl -X POST http://localhost:3001/api/send \
      -H "content-type: application/json" \
      -H "x-api-key: YOUR_API_KEY" \
      -d '{"phone":"081234567890","message":"Halo"}'

## Operational notes

- A healthy HTTP response does not mean WhatsApp is ready; check `whatsappReady` or `/api/status`.
- Graceful shutdown closes the HTTP server and Chromium client on `SIGINT`/`SIGTERM`.
- Logs are newline-delimited JSON and redact API-key headers.
- Apply conservative sending rates, consent rules, opt-outs, retries, and observability before CRM production integration.

## Important warning

WhatsApp Web.js is an unofficial automation library and is not guaranteed to comply with WhatsApp's Terms of Service. Automated or bulk messaging can cause account restrictions or bans. Obtain recipient consent, avoid spam, respect opt-outs, and consider the official WhatsApp Business Platform for production-critical messaging.
