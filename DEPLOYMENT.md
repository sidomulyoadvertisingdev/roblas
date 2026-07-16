# Deployment Production Tanpa Docker

Panduan ini menggunakan Ubuntu/Debian, MySQL lokal atau managed, systemd sebagai process manager, dan Nginx sebagai reverse proxy. Sesuaikan domain, user, dan path dengan server Anda.

## 1. Topologi yang disarankan

```text
Internet -> Nginx :443 -> Node.js 127.0.0.1:3001
                             |-> MySQL
                             |-> Chromium/WhatsApp Web
                             |-> API AI tenant
                             `-> webhook ERP tenant
```

Port `3001` dan `3306` tidak perlu dibuka ke internet. Server membutuhkan akses keluar HTTPS menuju WhatsApp Web, provider AI, Google OAuth, dan webhook tenant.

## 2. Siapkan server

Contoh paket dasar:

```bash
sudo apt update
sudo apt install -y git nginx mysql-client chromium fonts-liberation \
  ca-certificates libasound2t64 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
  libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnss3 libx11-xcb1 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 xdg-utils
```

Nama paket Chromium/library dapat berbeda menurut versi distribusi. Pastikan perintah berikut menghasilkan path valid:

```bash
command -v chromium
node --version
npm --version
```

Gunakan Node.js 20 atau lebih baru. Buat user service non-root:

```bash
sudo useradd --system --create-home --home-dir /opt/rorojongrang --shell /usr/sbin/nologin rorojongrang
sudo mkdir -p /opt/rorojongrang/app /var/lib/rorojongrang/auth
sudo chown -R rorojongrang:rorojongrang /opt/rorojongrang /var/lib/rorojongrang
```

## 3. Siapkan database

Buat database dan user dengan charset `utf8mb4`:

```sql
CREATE DATABASE rorojongrang_wa CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'rorojongrang'@'127.0.0.1' IDENTIFIED BY 'GANTI_PASSWORD_KUAT';
GRANT ALL PRIVILEGES ON rorojongrang_wa.* TO 'rorojongrang'@'127.0.0.1';
FLUSH PRIVILEGES;
```

Migrasi berjalan otomatis saat startup. Aplikasi harus dapat membaca `dist/db/migrations`. Jangan menjalankan lebih dari satu deployment migrasi secara bersamaan.

Backup sebelum upgrade:

```bash
mysqldump --single-transaction --routines --triggers \
  -h 127.0.0.1 -u rorojongrang -p rorojongrang_wa \
  | gzip > rorojongrang_wa-$(date +%F-%H%M).sql.gz
```

## 4. Ambil source dan build

```bash
sudo -u rorojongrang git clone YOUR_REPOSITORY_URL /opt/rorojongrang/app
cd /opt/rorojongrang/app
sudo -u rorojongrang npm ci
sudo -u rorojongrang npm run build
```

Sebelum rilis, jalankan:

```bash
npm run typecheck
npm run lint
npm test
```

## 5. Konfigurasi production

```bash
sudo -u rorojongrang cp .env.example /opt/rorojongrang/app/.env
sudo chmod 600 /opt/rorojongrang/app/.env
```

Nilai minimum yang harus diperiksa:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
API_KEY=GENERATE_SECRET_BERBEDA
ADMIN_KEY=GENERATE_SECRET_BERBEDA
CORS_ORIGIN=https://wa.example.com

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=rorojongrang
DB_PASSWORD=PASSWORD_DATABASE
DB_NAME=rorojongrang_wa

WA_AUTH_PATH=/var/lib/rorojongrang/auth
WA_HEADLESS=true
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

TRUST_PROXY=1
SESSION_SECRET=GENERATE_SECRET_BERBEDA
ENCRYPTION_KEY=64_KARAKTER_HEX

GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL=https://wa.example.com/auth/google/callback

GROQ_API_KEY=GROQ_API_KEY_PLATFORM
```

Generate setiap secret secara terpisah:

```bash
openssl rand -hex 32
```

`ENCRYPTION_KEY` harus tetap sama setelah data secret tenant tersimpan. Kehilangan key tersebut membuat token terenkripsi tidak dapat dibaca.

Di Google Cloud Console, tambahkan callback persis seperti nilai `GOOGLE_CALLBACK_URL` dan origin dashboard production.

## 6. systemd

Buat `/etc/systemd/system/rorojongrang-wa.service`:

```ini
[Unit]
Description=RoroJonggrang WhatsApp Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=rorojongrang
Group=rorojongrang
WorkingDirectory=/opt/rorojongrang/app
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/rorojongrang/app/dist/server.js
Restart=on-failure
RestartSec=10
TimeoutStopSec=20
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/rorojongrang/auth /opt/rorojongrang/app

[Install]
WantedBy=multi-user.target
```

Pastikan path Node benar dengan `command -v node`. Kemudian:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rorojongrang-wa
sudo systemctl status rorojongrang-wa
sudo journalctl -u rorojongrang-wa -f
```

Startup production dianggap berhasil hanya jika log menunjukkan database terhubung dan tidak memuat `db_bootstrap_failed` atau `db_migration_failed`.

## 7. Nginx dan HTTPS

Contoh `/etc/nginx/sites-available/rorojongrang-wa`:

```nginx
server {
    listen 80;
    server_name wa.example.com;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

Aktifkan dan uji konfigurasi:

```bash
sudo ln -s /etc/nginx/sites-available/rorojongrang-wa /etc/nginx/sites-enabled/rorojongrang-wa
sudo nginx -t
sudo systemctl reload nginx
```

Pasang sertifikat TLS, misalnya menggunakan Certbot sesuai kebijakan server Anda. Cookie login production memakai atribut `secure`, sehingga dashboard OAuth harus diakses melalui HTTPS.

## 8. Verifikasi setelah deploy

```bash
curl --fail https://wa.example.com/health
curl --fail https://wa.example.com/api/status \
  -H "x-api-key: YOUR_API_KEY"
```

Checklist manual:

- Login Google berhasil dan kembali ke dashboard.
- Tenant baru terbuat hanya satu kali.
- QR muncul dan pairing WhatsApp berhasil.
- Status kembali `ready` setelah restart service.
- Pengiriman pesan dan validasi nomor bekerja.
- Nomor di luar whitelist tidak diproses bot.
- Token webhook benar-benar terkirim tetapi tidak muncul di log.
- Chat biasa tidak memanggil webhook.
- Permintaan di luar domain tenant ditolak.
- Filter nama/ID/periode hanya menampilkan data relevan.
- Respons dengan periode berbeda tidak ditampilkan.
- Folder `/var/lib/rorojongrang/auth` tetap ada setelah deploy ulang.

## 9. Prosedur update

```bash
cd /opt/rorojongrang/app
sudo -u rorojongrang git fetch origin
sudo -u rorojongrang git checkout YOUR_BRANCH
sudo -u rorojongrang git pull --ff-only
sudo -u rorojongrang npm ci
sudo -u rorojongrang npm run build
sudo systemctl restart rorojongrang-wa
sudo journalctl -u rorojongrang-wa -n 100 --no-pager
```

Lakukan backup database sebelum update yang membawa migrasi baru. Jangan hapus direktori auth saat mengganti source.

## 10. Rollback

1. Hentikan service.
2. Kembalikan source ke commit/tag sebelumnya.
3. Jalankan `npm ci` dan build ulang.
4. Restore database hanya bila migrasi baru tidak kompatibel; repository belum menyediakan migrasi turun otomatis.
5. Jalankan service dan cek log, health, OAuth, serta status WhatsApp.

Jangan melakukan rollback database tanpa backup terverifikasi. Session WhatsApp dan `ENCRYPTION_KEY` harus dipertahankan.

## 11. Backup dan monitoring minimum

Backup terenkripsi yang disarankan:

- Database MySQL harian.
- `/var/lib/rorojongrang/auth` setelah pairing atau perubahan akun.
- `.env`/secret manager, khususnya `ENCRYPTION_KEY`.

Monitor minimal:

- HTTP `/health`.
- Log `db_bootstrap_failed`, `db_migration_failed`, `auth_failure`, dan error webhook/AI.
- Disk, RAM, CPU, jumlah proses Chromium, restart systemd, serta masa berlaku TLS.
- Backup success dan uji restore berkala.

## Catatan kesiapan production

Deployment secara teknis dapat dijalankan tanpa Docker, tetapi knowledge dan pemilihan data AI masih berstatus pengembangan. Mulai dari tenant internal atau pilot terbatas, simpan contoh percakapan gagal sebagai regression test, dan jangan menjanjikan jawaban AI bebas kesalahan sebelum cakupan pengujiannya memadai.
