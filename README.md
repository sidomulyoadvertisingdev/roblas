# RoroJonggrang WhatsApp Service

Gateway WhatsApp multi-tenant berbasis Node.js, TypeScript, Express, MySQL, dan `whatsapp-web.js`. Setiap tenant dapat memiliki sesi WhatsApp, konfigurasi webhook, whitelist pengirim, autentikasi webhook, konfigurasi AI, dan konteks bisnis sendiri.

> Status: tahap pra-production. Fondasi multi-tenant, dashboard, webhook, dan AI gateway sudah berjalan, tetapi pemahaman knowledge serta seleksi respons AI masih dalam penyempurnaan. Lihat [Batasan saat ini](#batasan-saat-ini) sebelum digunakan oleh pelanggan.

## Fitur saat ini

- Sesi WhatsApp terpisah per tenant dengan `LocalAuth`.
- Dashboard web untuk status, QR, pengiriman, riwayat, kontak, webhook, dan konfigurasi.
- Login Google OAuth dan session store di MySQL.
- Isolasi data tenant untuk kontak serta log pesan masuk/keluar.
- Webhook tenant dengan mode autentikasi `none`, Bearer token, atau HMAC.
- Whitelist nomor pengirim dan opsi mengabaikan pesan grup.
- Provider AI Groq, OpenAI-compatible, dan custom endpoint.
- Routing pesan: percakapan biasa tidak memanggil webhook; permintaan data diteruskan sesuai domain tenant.
- Discovery profil sistem dari struktur respons webhook.
- Penyaringan domain, periode, dan record respons sebelum jawaban dikirim.
- Memori percakapan singkat yang dipisahkan berdasarkan tenant dan pengirim.
- Redaksi secret, pembatasan ukuran respons webhook, timeout, retry, rate limit, serta usage metering dasar.
- Migrasi database otomatis saat service dimulai.

## Arsitektur singkat

```text
Pesan WhatsApp
  -> resolve tenant dan pengirim
  -> cek grup, whitelist, bot, dan rate limit
  -> AI mengekstrak intent serta filter
  -> validasi domain tenant
  -> webhook tenant
  -> validasi relevansi/periode/filter respons
  -> jawaban WhatsApp terformat
```

Konfigurasi global dan secret platform berasal dari `.env`. Konfigurasi bisnis, WhatsApp, webhook, dan AI masing-masing tenant disimpan di MySQL.

## Persyaratan

- Node.js 20 atau lebih baru
- npm
- MySQL 8 atau MariaDB yang kompatibel
- Chrome/Chromium beserta library sistem yang diperlukan Puppeteer
- Nomor WhatsApp khusus untuk setiap sesi tenant
- API key provider AI jika fitur bot AI diaktifkan

## Menjalankan secara lokal

```bash
npm ci
cp .env.example .env
npm run dev
```

Isi koneksi database dan secret di `.env`. Database harus sudah dibuat; tabel dan perubahan schema diterapkan otomatis dari `src/db/migrations` saat startup.

Untuk build production lokal:

```bash
npm run build
npm start
```

Hasil build berada di `dist/`. Script build juga menyalin seluruh file migrasi ke `dist/db/migrations`.

## Konfigurasi environment

| Variabel | Keterangan |
| --- | --- |
| `NODE_ENV` | Gunakan `production` di server. |
| `HOST`, `PORT` | Alamat bind dan port internal service. |
| `API_KEY` | Secret untuk endpoint `/api/*`; minimum 32 karakter di production. |
| `ADMIN_KEY` | Secret administratif tenant; gunakan nilai berbeda dari `API_KEY`. |
| `CORS_ORIGIN` | Daftar origin frontend, dipisahkan koma. Jangan gunakan `*` di production. |
| `DB_*` | Koneksi MySQL. User database memerlukan akses schema aplikasi. |
| `WA_AUTH_PATH` | Direktori persisten sesi WhatsApp. Wajib dibackup dan dibatasi permission-nya. |
| `WA_HEADLESS` | Umumnya `true` di server. |
| `PUPPETEER_EXECUTABLE_PATH` | Path Chromium sistem jika tidak memakai browser bawaan. |
| `GROQ_API_KEY` / `AI_API_KEY` | API key AI default platform. Tenant dapat memakai key terenkripsi sendiri. |
| `ENCRYPTION_KEY` | Tepat 64 karakter hex untuk mengenkripsi secret tenant. Jangan pernah diganti tanpa rencana migrasi. |
| `SESSION_SECRET` | Secret cookie minimum 32 karakter di production. |
| `GOOGLE_*` | OAuth Google untuk login dashboard. Callback harus memakai URL HTTPS publik. |
| `TRUST_PROXY` | Gunakan `1` jika tepat satu reverse proxy berada di depan aplikasi. |

Gunakan generator berikut untuk secret, lalu simpan hanya di secret manager atau `.env` server:

```bash
openssl rand -hex 32
```

Jangan commit `.env`, isi token webhook, API key AI, cookie, database dump, atau folder sesi WhatsApp.

## Script

| Perintah | Fungsi |
| --- | --- |
| `npm run dev` | Menjalankan source TypeScript. |
| `npm run dev:watch` | Development mode dengan watch. |
| `npm run build` | Compile TypeScript dan salin migrasi. |
| `npm start` | Menjalankan `dist/server.js`. |
| `npm run typecheck` | Pemeriksaan tipe tanpa menghasilkan file. |
| `npm run lint` | ESLint seluruh project. |
| `npm test` | Menjalankan Vitest. |

## Endpoint utama

- `GET /health` — health HTTP dan status WhatsApp default.
- `GET /api/status` — status lifecycle WhatsApp.
- `GET /api/qr` — QR pairing aktif.
- `POST /api/validate-number` — validasi nomor WhatsApp.
- `POST /api/send` — kirim pesan; dilindungi `x-api-key`.
- `/dashboard` — dashboard utama.
- `/tenant/*` — konfigurasi tenant dan API administratif.
- `/auth/*` — Google OAuth jika dikonfigurasi.

Contoh:

```bash
curl https://wa.example.com/api/status \
  -H "x-api-key: YOUR_API_KEY"
```

## Deployment tanpa Docker

Panduan Ubuntu/Debian dengan systemd, Nginx, HTTPS, MySQL, backup, rollback, dan checklist pairing tersedia di [DEPLOYMENT.md](DEPLOYMENT.md).

Ringkasnya:

1. Siapkan user Linux non-root, Node.js, Chromium, MySQL, Nginx, dan TLS.
2. Clone repository, jalankan `npm ci` dan `npm run build`.
3. Buat `.env` production dan direktori sesi persisten.
4. Jalankan service melalui systemd.
5. Pastikan migrasi berhasil dari log startup.
6. Buka dashboard, login, dan scan QR setiap tenant.
7. Uji health, pengiriman, webhook, whitelist, pemfilteran respons, serta restart recovery.

## Batasan saat ini

- Knowledge/discovery AI belum dianggap selesai. Variasi schema webhook baru masih memerlukan pengujian dan tuning.
- Pemfilteran jawaban AI sudah memiliki guardrail, tetapi perlu regression test lebih luas untuk banyak domain dan pola bahasa.
- `whatsapp-web.js` adalah otomasi tidak resmi; perubahan WhatsApp Web dapat memutus sesi atau menyebabkan pembatasan akun.
- Satu proses Chromium digunakan per akun aktif sehingga kebutuhan RAM bertambah seiring jumlah tenant.
- Rate limit dan usage meter tersedia, tetapi kebijakan quota/billing production masih perlu difinalkan.
- Monitoring eksternal, alerting, backup terjadwal, restore drill, dan strategi high availability belum disediakan oleh repository ini.
- Startup saat database gagal tetap dapat membuka HTTP dalam mode terbatas. Di production, deployment harus dianggap gagal bila log memuat `db_bootstrap_failed`.

## Keamanan dan operasional

- Hanya expose Nginx pada port 80/443; port Node dan MySQL tidak boleh terbuka ke internet.
- Gunakan HTTPS untuk dashboard dan semua webhook production.
- Batasi akses file `.env` dan `WA_AUTH_PATH` ke user service.
- Jangan log body pesan, token, header autentikasi, atau data personal mentah.
- Gunakan consent, opt-out, pembatasan frekuensi, dan nomor WhatsApp resmi untuk pesan bisnis.
- Pertimbangkan WhatsApp Business Platform resmi untuk layanan yang kritis atau berskala besar.

Catatan arsitektur dan roadmap internal tersedia di [SAAS_NOTES.md](SAAS_NOTES.md).
