const API = '/dashboard';
const state = { config: null, status: null, health: null, qr: null, history: [] };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const setText = (id, value, root = document) => {
  const el = root.getElementById ? root.getElementById(id) : root.querySelector(`#${id}`);
  if (el) el.textContent = value ?? '—';
};

const request = async (path, options = {}) => {
  const response = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : { raw: await response.text() };
  return { ok: response.ok, status: response.status, body };
};

const toast = (msg, kind = '') => {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, 3200);
  setTimeout(() => el.remove(), 3600);
};

const fmtUptime = (seconds) => {
  if (!Number.isFinite(seconds)) return '—';
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor((seconds / 3600) % 24);
  const d = Math.floor(seconds / 86400);
  return [d && `${d}h`, h && `${h}j`, m && `${m}m`, `${s}d`].filter(Boolean).join(' ');
};

const fmtTime = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return '—'; }
};

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
  } catch { return '—'; }
};

const applyStatePill = (s) => {
  const pill = $('#statePill');
  pill.classList.remove('ready', 'pending', 'error');
  if (s.ready) pill.classList.add('ready');
  else if (s.state === 'qr_pending') pill.classList.add('pending');
  else if (s.state === 'error' || s.state === 'auth_failure') pill.classList.add('error');
  setText('stateLabel', s.state);
};

const refreshData = async () => {
  try {
    const [statusRes, healthRes, qrRes, historyRes] = await Promise.all([
      request('/status'),
      fetch('/health').then((r) => r.json()).catch(() => null),
      request('/qr'),
      request('/send-history'),
    ]);
    if (statusRes.ok) state.status = statusRes.body.data;
    if (healthRes) state.health = healthRes.data;
    if (qrRes.ok) state.qr = qrRes.body.data;
    if (historyRes.ok) state.history = historyRes.body.data;

    if (state.status) applyStatePill(state.status);
    const phone = state.status?.account?.id?.split('@')[0] ?? '';
    setText('botIdentity', phone || state.status?.expectedBotPhone || 'bot');
    const tag = $('#botTag');
    if (tag) {
      tag.textContent = state.status?.ready ? 'ready' : (state.status?.state ?? 'idle');
      tag.style.background = state.status?.ready ? 'rgba(22,163,74,0.15)' : '';
      tag.style.color = state.status?.ready ? 'var(--ok)' : '';
    }

    const name = getRoute();
    const route = routes[name];
    if (route?.refresh) route.refresh($('#content'));

  } catch (e) {
    console.error(e);
  }
};

const loadConfig = async () => {
  const res = await request('/config');
  if (res.ok) state.config = res.body.data;
};

/* ===== Router ===== */

const routes = {
  overview: { title: 'Ringkasan', subtitle: 'Status koneksi WhatsApp gateway', render: renderOverview, refresh: renderOverview },
  send: { title: 'Kirim Pesan', subtitle: 'Kirim pesan WhatsApp langsung dari dashboard', render: renderSend },
  history: { title: 'Riwayat Terkirim', subtitle: 'Log semua pesan yang dikirim melalui gateway', render: renderHistory, refresh: renderHistory },
  contacts: { title: 'Validasi Nomor', subtitle: 'Cek nomor terdaftar WhatsApp & whitelist', render: renderContacts },
  webhook: { title: 'Webhook', subtitle: 'Konfigurasi forward pesan masuk ke ERP', render: renderWebhook },
  logs: { title: 'Log Live', subtitle: 'Streaming log server real-time', render: renderLogs },
  settings: { title: 'Pengaturan', subtitle: 'Konfigurasi environment layanan', render: renderSettings },
  api: { title: 'Dokumentasi API', subtitle: 'Endpoint yang dikonsumsi ERP', render: renderApi },
};

const getRoute = () => (location.hash.replace('#/', '') || 'overview');

const setActiveMenu = (name) => {
  $$('#menu a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
};

const renderCurrentRoute = () => {
  const name = getRoute();
  const route = routes[name] ?? routes.overview;
  setText('pageTitle', route.title);
  setText('pageSubtitle', route.subtitle);
  setActiveMenu(name);
  const content = $('#content');
  content.innerHTML = '';
  const tpl = $(`#tpl-${name}`);
  if (tpl) content.appendChild(tpl.content.cloneNode(true));
  route.render(content);
};

/* ===== Pages ===== */

function renderOverview(root) {
  const s = state.status;
  if (s) {
    setText('statBotState', s.state, root);
    setText('statBotReady', `ready: ${s.ready}`, root);
    setText('statBotPhone', s.account?.id?.split('@')[0] ?? '—', root);
    setText(
      'statBotMatch',
      s.expectedBotPhone === null
        ? 'expected: tidak diset'
        : s.botPhoneMatches
          ? `expected: ${s.expectedBotPhone} ✓`
          : `expected: ${s.expectedBotPhone} ✗`,
      root,
    );
    setText('statUpdated', s.updatedAt ? fmtTime(s.updatedAt) : '—', root);
  }
  setText('statUptime', state.health?.uptimeSeconds ? fmtUptime(state.health.uptimeSeconds) : '—', root);

  const env = state.config?.env ?? {};
  const runtimeWebhook = state.config?.runtime?.webhook ?? null;
  const webhookOn = Boolean(runtimeWebhook?.url ?? env.WEBHOOK_URL);
  const allowedSenders = runtimeWebhook?.allowedSenders?.length
    ? runtimeWebhook.allowedSenders.length
    : env.WEBHOOK_ALLOWED_SENDERS
      ? env.WEBHOOK_ALLOWED_SENDERS.split(',').filter(Boolean).length
      : 0;
  const ignoreGroups = runtimeWebhook?.ignoreGroups ?? env.WEBHOOK_IGNORE_GROUPS;
  setText('statWebhook', webhookOn ? 'Aktif' : 'Nonaktif', root);
  setText(
    'statWebhookMode',
    webhookOn
      ? `${allowedSenders > 0 ? `${allowedSenders} whitelist` : '⚠ terbuka'} · groups=${ignoreGroups ? 'skip' : 'terima'}`
      : 'Belum dikonfigurasi',
    root,
  );

  setText('quickPublicUrl', location.origin, root);
  setText('quickClient', env.WA_CLIENT_ID ?? '—', root);
  setText('quickRate', `${env.SEND_RATE_LIMIT_MAX ?? '—'} / menit`, root);
  setText('quickExpected', env.WA_BOT_PHONE ?? '(tidak diset)', root);

  const qrCard = root.querySelector('#qrCard');
  const qrHost = root.querySelector('#qrHost');
  if (state.qr?.qr) {
    qrCard.classList.remove('hidden');
    qrHost.innerHTML = '';
    const img = document.createElement('img');
    img.width = 220; img.height = 220;
    img.alt = 'WhatsApp QR';
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(state.qr.qr)}`;
    qrHost.appendChild(img);
  } else {
    qrCard.classList.add('hidden');
  }

  const mini = root.querySelector('#miniHistory');
  const recent = [...state.history].slice(-5).reverse();
  if (recent.length === 0) {
    mini.innerHTML = '<p class="muted empty">Belum ada pesan yang dikirim.</p>';
  } else {
    mini.innerHTML = '';
    for (const entry of recent) {
      const div = document.createElement('div');
      div.className = `item${entry.ok ? '' : ' err'}`;
      div.innerHTML = `
        <span class="dot-status"></span>
        <div class="info">
          <div class="phone">${entry.phone}</div>
          <div class="preview">${entry.message.replace(/</g, '&lt;')}</div>
        </div>
        <span class="time">${fmtTime(entry.time)}</span>`;
      mini.appendChild(div);
    }
  }
}

function renderSend(root) {
  const form = root.querySelector('#sendForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const res = await request('/send', { method: 'POST', body: JSON.stringify(data) });
    if (res.ok) {
      toast(`Pesan terkirim ke ${res.body.data.to}`, 'ok');
      form.reset();
      refreshData();
    } else {
      toast(res.body.error?.message ?? 'Gagal mengirim', 'err');
    }
  });

  root.querySelector('#btnQuickTest').addEventListener('click', () => {
    const bot = state.status?.expectedBotPhone ?? state.status?.account?.id?.split('@')[0];
    if (!bot) return toast('Nomor bot belum diketahui', 'err');
    form.phone.value = bot;
    form.message.value = 'Test kirim ke diri sendiri dari dashboard 🟡';
  });

  const typing = root.querySelector('#typingForm');
  typing.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-state]');
    if (!btn) return;
    const phone = typing.phone.value.trim();
    if (!phone) return toast('Isi nomor dulu', 'err');
    const payload = { phone, state: btn.dataset.state === 'true' };
    const res = await request('/typing', { method: 'POST', body: JSON.stringify(payload) });
    if (res.ok) toast(`Typing ${payload.state ? 'aktif' : 'berhenti'}`, 'ok');
    else toast(res.body.error?.message ?? 'Gagal', 'err');
  });
}

function renderHistory(root) {
  const tbody = root.querySelector('#historyTable tbody');
  tbody.innerHTML = '';
  const list = [...state.history].reverse();
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted center">Belum ada data.</td></tr>';
    return;
  }
  for (const entry of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtDateTime(entry.time)}</td>
      <td><code>${entry.phone}</code></td>
      <td>${(entry.message ?? '').slice(0, 80).replace(/</g, '&lt;')}${entry.message && entry.message.length > 80 ? '…' : ''}</td>
      <td>${entry.ok ? '<span class="badge ok">terkirim</span>' : `<span class="badge err" title="${entry.error ?? ''}">gagal</span>`}</td>
      <td><code>${entry.messageId ?? '—'}</code></td>`;
    tbody.appendChild(tr);
  }
}

function renderContacts(root) {
  const form = root.querySelector('#validateForm');
  const result = root.querySelector('#validateResult');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const res = await request('/validate-number', { method: 'POST', body: JSON.stringify(data) });
    if (res.ok) {
      const d = res.body.data;
      result.className = `result ${d.registered ? 'ok' : 'err'}`;
      result.innerHTML = `
        <div><b>${d.registered ? '✓ Terdaftar' : '✗ Tidak terdaftar'} di WhatsApp</b></div>
        <div class="muted">Input: <code>${d.input}</code></div>
        <div class="muted">Normalized: <code>${d.normalized}</code></div>
        <div class="muted">WA ID: <code>${d.whatsappId}</code></div>`;
    } else {
      result.className = 'result err';
      result.textContent = res.body.error?.message ?? 'Gagal validasi';
    }
  });

  const box = root.querySelector('#whitelistBox');
  const allowed = (state.config?.env?.WEBHOOK_ALLOWED_SENDERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) {
    box.innerHTML = '<span class="chip empty">Kosong — semua nomor diizinkan (tidak aman)</span>';
  } else {
    box.innerHTML = allowed.map((n) => `<span class="chip">${n}</span>`).join('');
  }
}

function renderWebhook(root) {
  const form = root.querySelector('#webhookForm');
  const authSelect = root.querySelector('#authModeSelect');
  const secretField = root.querySelector('#secretField');
  const bearerField = root.querySelector('#bearerField');
  const authHint = root.querySelector('#authModeHint');

  const applyMode = (mode) => {
    secretField.classList.toggle('hidden', mode !== 'hmac');
    bearerField.classList.toggle('hidden', mode !== 'bearer');
    if (mode === 'hmac') authHint.textContent = 'ERP hitung ulang HMAC dari body + secret, bandingkan dengan header x-wa-signature.';
    else if (mode === 'bearer') authHint.textContent = 'Token dikirim di header Authorization: Bearer <token>. Cocok untuk Laravel Sanctum, JWT, API key custom.';
    else authHint.textContent = '⚠ Tanpa auth — ERP menerima payload apa adanya. Hanya untuk testing.';
  };

  const populate = (data) => {
    const w = data.webhook ?? {};
    const modeLabels = { hmac: 'HMAC signature', bearer: 'Bearer token', none: 'Tanpa auth' };
    setText('whUrl', w.url ?? '(belum diset)', root);
    setText('whAuthMode', modeLabels[w.authMode] ?? '—', root);
    setText('whSecret', w.hasSecret ? '••••••• (aktif)' : '(belum diset)', root);
    setText('whBearer', w.hasBearerToken ? '••••••• (aktif)' : '(belum diset)', root);
    setText('whTimeout', w.timeoutMs ? `${w.timeoutMs} ms` : '—', root);
    setText('whGroups', w.ignoreGroups ? 'diabaikan' : 'diterima', root);
    setText('whAllowed', w.allowedSenders?.length ? w.allowedSenders.join(', ') : '(kosong — terbuka)', root);
    form.url.value = w.url ?? '';
    form.timeoutMs.value = w.timeoutMs ?? '';
    form.ignoreGroups.checked = Boolean(w.ignoreGroups);
    form.allowedSenders.value = (w.allowedSenders ?? []).join(', ');
    form.secret.value = '';
    form.bearerToken.value = '';
    authSelect.value = w.authMode ?? 'none';
    applyMode(authSelect.value);
    root.querySelector('#secretHint').textContent = w.hasSecret
      ? 'Secret tersimpan. Kosongkan untuk tetap gunakan yang aktif; isi baru untuk mengganti.'
      : 'Minimal 16 karakter. Wajib untuk verifikasi HMAC di sisi ERP.';
    root.querySelector('#bearerHint').textContent = w.hasBearerToken
      ? 'Token tersimpan. Kosongkan untuk tetap gunakan yang aktif; isi baru untuk mengganti.'
      : 'Contoh Laravel Sanctum: 1606|hgRLAZM... Akan dikirim sebagai Authorization: Bearer <token>.';
  };

  const load = async () => {
    const res = await request('/settings/webhook');
    if (!res.ok) return toast('Gagal memuat setting webhook', 'err');
    populate(res.body.data);
  };

  authSelect.addEventListener('change', () => applyMode(authSelect.value));

  root.querySelector('#btnGenSecret').addEventListener('click', async () => {
    const res = await request('/settings/webhook/generate-secret', { method: 'POST' });
    if (res.ok) {
      form.secret.type = 'text';
      form.secret.value = res.body.data.secret;
      toast('Secret di-generate. Klik Simpan untuk menyimpan.', 'ok');
    } else {
      toast('Gagal generate secret', 'err');
    }
  });

  root.querySelector('#btnClearSecret').addEventListener('click', async () => {
    if (!confirm('Hapus secret HMAC? Verifikasi HMAC akan dinonaktifkan.')) return;
    const res = await request('/settings/webhook', { method: 'PUT', body: JSON.stringify({ clearSecret: true }) });
    if (res.ok) { toast('Secret dihapus', 'ok'); load(); }
    else toast(res.body.error?.message ?? 'Gagal hapus secret', 'err');
  });

  root.querySelector('#btnClearBearer').addEventListener('click', async () => {
    if (!confirm('Hapus Bearer token?')) return;
    const res = await request('/settings/webhook', { method: 'PUT', body: JSON.stringify({ clearBearerToken: true }) });
    if (res.ok) { toast('Bearer token dihapus', 'ok'); load(); }
    else toast(res.body.error?.message ?? 'Gagal hapus token', 'err');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const payload = {
      url: data.get('url') || '',
      authMode: authSelect.value,
      timeoutMs: Number(data.get('timeoutMs')) || undefined,
      ignoreGroups: form.ignoreGroups.checked,
      allowedSenders: (data.get('allowedSenders') ?? '')
        .toString()
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const secret = (data.get('secret') ?? '').toString().trim();
    if (secret) payload.secret = secret;
    const bearer = (data.get('bearerToken') ?? '').toString().trim();
    if (bearer) payload.bearerToken = bearer;
    const res = await request('/settings/webhook', { method: 'PUT', body: JSON.stringify(payload) });
    if (res.ok) { toast('Setting webhook disimpan', 'ok'); load(); }
    else toast(res.body.error?.message ?? 'Gagal menyimpan', 'err');
  });

  load();
}

let logStream = null;
let logFilter = 'all';

function renderLogs(root) {
  const viewer = root.querySelector('#logViewer');
  const autoscroll = root.querySelector('#logAutoscroll');
  const filter = root.querySelector('#logFilter');
  const clearBtn = root.querySelector('#btnClearLogs');

  const levelOrder = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };
  const passesFilter = (lvl) => logFilter === 'all' || (levelOrder[lvl] ?? 0) >= (levelOrder[logFilter] ?? 0);

  const append = (entry) => {
    if (!passesFilter(entry.level)) return;
    const line = document.createElement('div');
    line.className = `log-line ${entry.level}`;
    line.innerHTML = `<span class="lvl">${entry.level.toUpperCase()}</span><span class="ts">${fmtTime(entry.time)}</span><span class="msg">${entry.msg.replace(/</g, '&lt;')}${entry.extra ? ` <span style="color:var(--brown-500)">${JSON.stringify(entry.extra).replace(/</g, '&lt;').slice(0, 200)}</span>` : ''}</span>`;
    viewer.appendChild(line);
    if (autoscroll.checked) viewer.scrollTop = viewer.scrollHeight;
    while (viewer.children.length > 500) viewer.removeChild(viewer.firstChild);
  };

  filter.value = logFilter;
  filter.addEventListener('change', () => { logFilter = filter.value; viewer.innerHTML = ''; if (logStream) restartStream(); });
  clearBtn.addEventListener('click', () => (viewer.innerHTML = ''));

  const restartStream = () => {
    if (logStream) logStream.close();
    logStream = new EventSource(`${API}/logs/stream`);
    logStream.onmessage = (ev) => {
      try { append(JSON.parse(ev.data)); } catch { /* ignore */ }
    };
    logStream.onerror = () => {
      toast('Log stream terputus, mencoba reconnect...', 'err');
    };
  };
  restartStream();
}

function renderSettings(root) {
  const tbody = root.querySelector('#settingsTable tbody');
  tbody.innerHTML = '';
  const env = state.config?.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    const tr = document.createElement('tr');
    const displayed = value === null || value === '' ? '(kosong)' : String(value);
    tr.innerHTML = `<td><code>${key}</code></td><td><code>${displayed}</code></td>`;
    tbody.appendChild(tr);
  }
}

function renderApi() { /* static content */ }

/* ===== Init ===== */

window.addEventListener('hashchange', renderCurrentRoute);
document.addEventListener('click', (e) => {
  const link = e.target.closest('.menu a');
  if (link) return; // hashchange will handle it
});

$('#btnReload').addEventListener('click', () => refreshData());
$('#btnBack').addEventListener('click', () => history.back());
$('#btnCopyUrl').addEventListener('click', async () => {
  await navigator.clipboard.writeText(location.origin);
  toast('URL disalin', 'ok');
});

const boot = async () => {
  await loadConfig();
  await refreshData();
  if (!location.hash) location.hash = '#/overview';
  else renderCurrentRoute();
  setInterval(() => {
    if (getRoute() !== 'logs') refreshData();
  }, 5000);
};

boot();
