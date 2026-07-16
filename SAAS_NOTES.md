# SaaS WhatsApp Gateway — Catatan Arsitektur

## VISI
Gateway WhatsApp multi-tenant. Satu service, banyak klien. Tenant A pakai untuk absensi, Tenant B untuk ticketing, Tenant C untuk CS bot. Semua dinamis dari database.

---

## STATUS SEKARANG (Current State)

- ✅ Multi-tenant schema + migration (tenants, tenant_wa_accounts, tenant_config, tenant_ai_config, tenant_api_keys)
- ✅ Tenant resolver (dari phone number, client ID, atau API key)
- ✅ Config loader (tenant_config + tenant_ai_config dari DB)
- ✅ Generic bot handler (AI provider + backend client + template engine)
- ✅ Dashboard auth (Google OAuth + session)
- ✅ Tenant-scoped data (contacts, send_log, incoming_log, agents semua punya tenant_id)
- ✅ User → Tenant linking (user baru daftar otomatis dapat tenant sendiri, jadi admin)
- ✅ API key management (create, list, revoke, rotate)
- ✅ Production gateway (routing AI, webhook tenant, guardrail, retry, memory percakapan)
- ✅ Secret webhook terenkripsi dan redaksi log
- ✅ Rate limiting dan usage metering dasar per tenant
- ⚠️ Knowledge/discovery webhook belum selesai; masih memerlukan regression test lintas domain
- ❌ Tenant selector lintas-organisasi di dashboard (belum ada)
- ❌ Billing dan enforcement quota komersial (belum ada)

---

## YANG PERLU DITAMBAH (Roadmap)

### 1. Multi-Tenant Database Schema

```
tenants
├── id (PK, UUID)
├── name (string) — "Toko Roti Maju"
├── slug (string, unique) — "toko-roti-maju"
├── is_active (boolean)
├── plan (enum: free, pro, enterprise)
├── created_at, updated_at

tenant_wa_accounts
├── id (PK)
├── tenant_id (FK)
├── client_id (string, unique) — "toko-roti-maju"
├── phone (string)
├── display_name (string)
├── is_active (boolean)
├── auth_session_path (string) — "./data/auth/session-{slug}"
├── last_ready_at (timestamp)

tenant_config
├── tenant_id (FK)
├── config_key (string) — "webhook_url", "bot_enabled", "greeting", dll
├── config_value (text)
├── is_secret (boolean)
├── updated_at

tenant_ai_config
├── tenant_id (FK)
├── provider (enum: groq, openai, custom)
├── api_key (encrypted text)
├── model (string) — "llama-3.1-8b-instant"
├── system_prompt (text) — prompt kustom per tenant
├── response_template (text) — template respons

tenant_api_keys
├── id (PK)
├── tenant_id (FK)
├── key_hash (string, unique) — hashed, bukan plain
├── key_prefix (string) — "sk_live_abc..." (untuk display)
├── permissions (json) — ["send", "read", "admin"]
├── expires_at (timestamp, nullable)
├── created_at
```

### 2. Bot Logic → Generic Gateway

**Sekarang:**
```
User message → Groq (attendance prompt) → attendance API → format response → reply
```

**Target:**
```
User message → Tenant AI config (prompt + provider) → Tenant backend API → Tenant response template → reply
```

Yang harus jadi dinamis:

| Field | Sekarang | Target |
|-------|----------|--------|
| AI Provider | Groq hardcoded | Per-tenant (Groq/OpenAI/custom) |
| System Prompt | Attendance-specific | Per-tenant custom prompt |
| Backend API | Attendance API only | Per-tenant webhook URL |
| Response Format | Attendance template only | Per-tenant template (Handlebars/Mustache) |
| Keywords | Attendance keywords | Per-tenant trigger keywords |
| Button Actions | Download Excel only | Per-tenant configured buttons |
| Excel Template | Attendance columns only | Per-tenant column mapping |

### 3. Tenant Config Keys (di `tenant_config`)

```env
# Webhook Backend
webhook_url=https://api.client.com/webhook
webhook_auth_mode=bearer|hmac|none
webhook_secret=xxx
webhook_bearer_token=xxx
webhook_timeout_ms=8000

# Bot AI
bot_enabled=true
ai_provider=groq|openai|custom
ai_api_key=encrypted
ai_model=llama-3.1-8b-instant
ai_system_prompt="Kamu adalah asisten untuk toko roti..."
ai_max_tokens=256

# Bot Behavior
bot_trigger_keywords=pesan,pesanan,order,pembelian
bot_greeting="Halo! Selamat datang di Toko Roti Maju. Ketik 'menu' untuk mulai."
bot_unknown_reply="Maaf, saya tidak mengerti. Ketik 'menu' untuk bantuan."
bot_group_behavior=skip|forward|reply

# Response Template (Mustache/Handlebars)
response_template={{#each items}}{{name}}: {{status}}{{/each}}

# Button Actions (JSON array)
bot_buttons=[
  {"id":"order","label":"Buat Pesanan"},
  {"id":"status","label":"Cek Status"},
  {"id":"help","label":"Bantuan"}
]

# Excel Export (column mapping JSON)
excel_columns=[
  {"field":"name","header":"Nama","width":20},
  {"field":"status","header":"Status","width":15},
  {"field":"amount","header":"Total","width":15}
]
```

### 4. Message Handler Chain (Updated)

```
WhatsApp Message
  │
  ├─ Is Group?
  │   ├─ tenant bot_group_behavior = "skip" → skip
  │   ├─ tenant bot_group_behavior = "forward" → webhook forwarder
  │   └─ tenant bot_group_behavior = "reply" → process as normal
  │
  ├─ Bot Enabled?
  │   ├─ Yes → route to tenant AI handler
  │   │   ├─ Match trigger keywords? → process
  │   │   └─ No match → forward to webhook
  │   └─ No → forward to webhook
  │
  ├─ Tenant AI Handler:
  │   ├─ Load tenant ai_config (prompt, provider, model)
  │   ├─ Call AI provider with tenant's system prompt
  │   ├─ Parse intent from AI response
  │   ├─ If intent needs backend data → call tenant webhook
  │   ├─ Format response using tenant template
  │   ├─ Send reply with tenant buttons
  │   └─ Log to tenant's audit trail
  │
  └─ Webhook Forwarder (fallback):
      ├─ POST to tenant webhook_url
      ├─ With tenant auth (bearer/hmac)
      └─ Log delivery status
```

### 5. API Routes (Updated)

```
/api/v1/:tenant_slug/...
├── GET  /status
├── GET  /qr
├── POST /send
├── POST /validate-number
├── POST /typing
└── POST /webhook/test       ← test tenant webhook

/api/admin/...
├── GET    /tenants                ← list tenants
├── POST   /tenants                ← create tenant
├── PATCH  /tenants/:id            ← update tenant
├── DELETE /tenants/:id            ← delete tenant
├── GET    /tenants/:id/config     ← get tenant config
├── PUT    /tenants/:id/config     ← update tenant config
├── POST   /tenants/:id/rotate-key ← rotate API key
└── POST   /tenants/:id/reconnect  ← reconnect WA session
```

### 6. Dashboard (Updated)

- **Login page** — admin auth (basic auth atau JWT)
- **Tenant selector** — switch between tenants
- **Per-tenant view:**
  - WA status + QR
  - Config editor (webhook, AI, bot behavior)
  - Live logs (filtered by tenant)
  - Send/receive history
  - Contacts management
  - API key management

### 7. File Structure (Updated)

```
src/
├── tenant/
│   ├── resolver.ts          ← resolve tenant dari request/phone/api-key
│   ├── config-loader.ts     ← load tenant config dari DB
│   ├── middleware.ts         ← tenant-aware middleware
│   ├── types.ts              ← tenant types
│   ├── routes.ts             ← tenant CRUD + config + API key routes
│   ├── ai-provider.ts        ← unified AI interface (Groq/OpenAI/custom)
│   ├── backend-client.ts     ← generic HTTP client ke tenant backend
│   ├── bot-handler.ts        ← GENERIC handler (uses tenant config)
│   └── template-engine.ts    ← template renderer (Mustache/Handlebars)
├── auth/
│   ├── passport.ts           ← Google OAuth strategy + user/tenant creation
│   ├── routes.ts             ← auth routes (login, callback, logout)
│   ├── middleware.ts          ← requireAuth, requireAdmin
│   ├── session.ts            ← session store (connect-session-knex)
│   └── index.ts              ← barrel export
├── db/
│   ├── migrations/           ← SQL migrations (001-007)
│   ├── repositories/         ← tenant-scoped repositories
│   └── index.ts              ← repository factory
├── routes/
│   ├── api.ts                ← public API routes
│   └── dashboard.ts          ← dashboard routes (tenant-scoped data)
├── whatsapp/
│   ├── manager.ts            ← multi-client WhatsApp manager
│   └── types.ts              ← WhatsApp gateway interface
├── config/
│   └── env.ts                ← environment variables schema
├── middleware/
│   ├── api-key.ts            ← API key validation
│   ├── error-handler.ts      ← error handling
│   └── validate.ts           ← request validation
├── observability/
│   └── buffers.ts            ← log + send history buffers
├── logger.ts                 ← pino logger
├── server.ts                 ← server startup
└── app.ts                    ← Express app setup
```

### 8. Data Flow Example: "Toko Roti Maju"

**Tenant Config:**
```
bot_trigger_keywords=pesan,order,pembelian,menu
ai_system_prompt="Kamu adalah AI Toko Roti Maju. Jawab pertanyaan tentang menu, harga, dan pesanan."
webhook_url=https://api.tokoroti.com/whatsapp/webhook
bot_buttons=[
  {"id":"menu","label":"Lihat Menu"},
  {"id":"order","label":"Pesan Sekarang"},
  {"id":"status","label":"Cek Pesanan"}
]
```

**User sends:** "mau pesan roti"

**Bot response:**
```
TOKO ROTI MAJU

Berikut menu kami:
1. Roti Tawar — Rp 15.000
2. Roti Gandum — Rp 18.000
3. Croissant — Rp 22.000

Ketik nama roti untuk pesan.
```

**Buttons:** [Lihat Menu] [Pesan Sekarang] [Cek Pesanan]

---

## IMPLEMENTASI PRIORITY

### Phase 1: Foundation (Minggu 1-2) ✅
- [x] Multi-tenant schema + migration
- [x] Tenant resolver (dari phone number atau API key)
- [x] Update SettingsManager → TenantConfigLoader
- [x] Update webhook forwarder → tenant-aware
- [x] Dashboard auth + tenant selector

### Phase 2: Generic Bot (Minggu 3-4) ✅
- [x] AI provider abstraction (Groq/OpenAI interface)
- [x] Template engine untuk response
- [x] Dynamic button builder
- [x] Generic backend client
- [x] Per-tenant keyword matching

### Phase 3: Admin & API (Minggu 5) ✅
- [x] Tenant CRUD API
- [x] Tenant config API
- [x] API key management
- [ ] Tenant-scoped rate limiting
- [ ] Tenant-scoped logging

### Phase 4: Production (Minggu 6) 🔄
- [x] Tenant data isolation
- [x] Deployment guide tanpa Docker
- [x] Secret encryption + log redaction
- [x] Basic rate limit + usage metering
- [ ] Backup/restore per tenant
- [ ] Billing hooks + quota enforcement
- [ ] Health monitoring per tenant
- [x] Documentation
- [ ] Knowledge/discovery regression suite lintas domain

---

## TEKNOLOGI YANG DIPAKAI

| Component | Current | Target |
|-----------|---------|--------|
| AI | Groq only | Groq + OpenAI + Custom |
| Template | Hardcoded | Mustache/Handlebars |
| DB | MySQL (single tenant) | MySQL (multi-tenant) |
| Auth | API key only | API key + JWT (admin) |
| WA Sessions | Single | Multi (per tenant) |
| Config | .env + DB | DB only (per tenant) |
| Dashboard | Public | Auth + tenant-scoped |

---

## RISIKO & MITIGASI

| Risk | Impact | Mitigation |
|------|--------|------------|
| WA session limit | 1 session per phone number | Each tenant needs own phone |
| Memory usage | Puppeteer per session | Limit concurrent sessions, use headless |
| DB performance | Many config reads | Cache tenant config in memory (TTL 5 min) |
| Tenant isolation | Data leakage | Query always filtered by tenant_id |
| API abuse | Rate limit bypass | Per-tenant rate limiting |
| Cost | Groq/OpenAI per request | Per-tenant usage tracking, quota limits |
