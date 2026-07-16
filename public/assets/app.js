const API = '/dashboard';
const state = { config: null, status: null, health: null, qr: null, history: [], analytics: null };
let sendChart = null;

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

const fmtDate = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' });
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
    const [statusRes, healthRes, qrRes, historyRes, analyticsRes] = await Promise.all([
      request('/status'),
      fetch('/health').then((r) => r.json()).catch(() => null),
      request('/qr'),
      request('/send-history'),
      request('/analytics'),
    ]);
    if (statusRes.ok) state.status = statusRes.body.data;
    if (healthRes) state.health = healthRes.data;
    if (qrRes.ok) state.qr = qrRes.body.data;
    if (historyRes.ok) state.history = historyRes.body.data;
    if (analyticsRes.ok) state.analytics = analyticsRes.body.data;

    if (state.status) applyStatePill(state.status);
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
  overview: { title: 'Ringkasan', subtitle: 'Status koneksi dan analitik WhatsApp', render: renderOverview, refresh: renderOverview },
  send: { title: 'Kirim Pesan', subtitle: 'Kirim pesan WhatsApp langsung dari dashboard', render: renderSend },
  history: { title: 'Riwayat Terkirim', subtitle: 'Semua pesan yang telah dikirim', render: renderHistory, refresh: renderHistory },
  contacts: { title: 'Validasi Nomor', subtitle: 'Cek apakah nomor terdaftar di WhatsApp', render: renderContacts },
  webhook: { title: 'Webhook', subtitle: 'Konfigurasi forward pesan masuk ke ERP', render: renderWebhook },
  api: { title: 'Dokumentasi API', subtitle: 'Endpoint untuk integrasi ERP', render: renderApi },
};

const getRoute = () => {
  const path = location.pathname.replace(/^\//, '').replace(/\/$/, '');
  return path || 'overview';
};

const navigate = (name) => {
  if (getRoute() === name) return;
  history.pushState(null, '', `/${name === 'overview' ? '' : name}`);
  renderCurrentRoute();
};

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
        ? ''
        : s.botPhoneMatches
          ? `${s.expectedBotPhone} ✓`
          : `${s.expectedBotPhone} ✗`,
      root,
    );
    setText('statUpdated', s.updatedAt ? fmtTime(s.updatedAt) : '—', root);
  }
  setText('statUptime', state.health?.uptimeSeconds ? fmtUptime(state.health.uptimeSeconds) : '—', root);

  // Analytics metrics
  const a = state.analytics;
  if (a) {
    setText('statTodayTotal', a.today.total, root);
    setText('statTodayTime', 'hari ini', root);
    setText('statTodaySuccess', a.today.success, root);
    setText('statSuccessRate', a.today.total > 0 ? `${Math.round((a.today.success / a.today.total) * 100)}%` : '—', root);
    setText('statTodayFailed', a.today.failed, root);
    setText('statFailedRate', a.today.total > 0 ? `${Math.round((a.today.failed / a.today.total) * 100)}%` : '—', root);
    setText('statAllTime', a.allTime, root);
  }

  // QR / WA connection card
  const qrCard = root.querySelector('#qrCard');
  const qrHost = root.querySelector('#qrHost');
  const btnDisconnect = root.querySelector('#btnDisconnect');
  const btnReconnect = root.querySelector('#btnReconnect');
  const waCardTitle = root.querySelector('#waCardTitle');
  const waCardHint = root.querySelector('#waCardHint');
  if (qrCard) {
    const needsQr = s && !s.ready && (s.state === 'qr_pending' || s.state === 'auth_failure' || s.state === 'disconnected' || s.state === 'error' || s.state === 'stopped');
    const isReady = s && s.ready;

    if (needsQr || isReady) {
      qrCard.classList.remove('hidden');
    } else {
      qrCard.classList.add('hidden');
    }

    if (qrHost) {
      qrHost.innerHTML = '';
      if (state.qr?.qr) {
        const img = document.createElement('img');
        img.width = 220; img.height = 220;
        img.alt = 'WhatsApp QR';
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(state.qr.qr)}`;
        qrHost.appendChild(img);
      } else if (needsQr) {
        qrHost.innerHTML = '<p class="muted">Menunggu QR code...</p>';
      }
    }

    if (waCardTitle && waCardHint) {
      if (isReady) {
        waCardTitle.textContent = 'WhatsApp Terhubung';
        waCardHint.textContent = `Terhubung sebagai ${s.account?.id?.split('@')[0] ?? '—'}.`;
      } else if (s.state === 'qr_pending') {
        waCardTitle.textContent = 'Perlu Scan QR';
        waCardHint.innerHTML = 'Buka WhatsApp → <b>Setelan</b> → <b>Perangkat tertaut</b> → <b>Tautkan perangkat</b>.';
      } else if (s.state === 'auth_failure') {
        waCardTitle.textContent = 'Koneksi Gagal';
        waCardHint.textContent = 'Sesi tidak valid. Klik "Sambungkan Ulang" untuk QR baru.';
      } else if (s.state === 'disconnected') {
        waCardTitle.textContent = 'Terputus';
        waCardHint.textContent = 'WhatsApp terputus. Klik "Sambungkan Ulang".';
      } else {
        waCardTitle.textContent = 'Menunggu Koneksi';
        waCardHint.textContent = 'WhatsApp belum terhubung.';
      }
    }

    if (btnDisconnect && btnReconnect) {
      if (isReady) {
        btnDisconnect.classList.remove('hidden');
        btnReconnect.classList.add('hidden');
      } else {
        btnDisconnect.classList.add('hidden');
        btnReconnect.classList.remove('hidden');
      }
    }
  }

  // Chart
  const canvas = root.querySelector('#chartSendVolume');
  if (canvas && a?.last7days) {
    const labels = a.last7days.map((d) => fmtDate(d.day));
    const successData = a.last7days.map((d) => d.success);
    const failedData = a.last7days.map((d) => d.failed);

    if (sendChart) sendChart.destroy();
    sendChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Berhasil', data: successData, backgroundColor: 'rgba(22,163,74,0.7)', borderRadius: 4 },
          { label: 'Gagal', data: failedData, backgroundColor: 'rgba(220,38,38,0.7)', borderRadius: 4 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 11 } } },
          y: { beginAtZero: true, ticks: { stepSize: 1, font: { size: 11 } } },
        },
      },
    });
  }

  // Mini history
  const mini = root.querySelector('#miniHistory');
  if (mini) {
    const recent = [...state.history].slice(-5).reverse();
    if (recent.length === 0) {
      mini.innerHTML = '<p class="muted empty">Belum ada pesan.</p>';
    } else {
      mini.innerHTML = '';
      for (const entry of recent) {
        const div = document.createElement('div');
        div.className = `item${entry.ok ? '' : ' err'}`;
        div.innerHTML = `
          <span class="dot-status"></span>
          <div class="info">
            <div class="phone">${entry.phone}</div>
            <div class="preview">${(entry.message ?? '').slice(0, 60).replace(/</g, '&lt;')}</div>
          </div>
          <span class="time">${fmtTime(entry.time)}</span>`;
        mini.appendChild(div);
      }
    }
  }

  // Disconnect / Reconnect buttons
  if (btnDisconnect) {
    btnDisconnect.onclick = async () => {
      if (!confirm('Putuskan koneksi WhatsApp? Anda perlu scan QR lagi untuk menyambungkan.')) return;
      btnDisconnect.disabled = true;
      btnDisconnect.textContent = 'Memutuskan...';
      const res = await request('/disconnect', { method: 'POST' });
      if (res.ok) {
        toast('WhatsApp diputuskan', 'ok');
        await refreshData();
      } else {
        toast(res.body.error?.message ?? 'Gagal memutuskan', 'err');
      }
      btnDisconnect.disabled = false;
      btnDisconnect.textContent = 'Putuskan Koneksi';
    };
  }
  if (btnReconnect) {
    btnReconnect.onclick = async () => {
      btnReconnect.disabled = true;
      btnReconnect.textContent = 'Menyambungkan...';
      const res = await request('/reconnect', { method: 'POST' });
      if (res.ok) {
        toast('Menyambungkan WhatsApp... tunggu QR code', 'ok');
        await refreshData();
      } else {
        toast(res.body.error?.message ?? 'Gagal menyambungkan', 'err');
      }
      btnReconnect.disabled = false;
      btnReconnect.textContent = 'Sambungkan Ulang';
    };
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
    const phone = state.status?.account?.id?.split('@')[0];
    if (!phone) return toast('Nomor WhatsApp belum diketahui', 'err');
    form.phone.value = phone;
    form.message.value = 'Test kirim dari dashboard';
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

let historyFilterValue = 'all';

function renderHistory(root) {
  const tbody = root.querySelector('#historyTable tbody');
  const filterSelect = root.querySelector('#historyFilter');

  const renderTable = () => {
    tbody.innerHTML = '';
    let list = [...state.history].reverse();
    if (historyFilterValue === 'success') list = list.filter((e) => e.ok);
    else if (historyFilterValue === 'failed') list = list.filter((e) => !e.ok);

    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted center">Belum ada data.</td></tr>';
      return;
    }
    for (const entry of list) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${fmtDateTime(entry.time)}</td>
        <td><code>${entry.phone}</code></td>
        <td>${(entry.message ?? '').slice(0, 80).replace(/</g, '&lt;')}${entry.message && entry.message.length > 80 ? '…' : ''}</td>
        <td>${entry.ok ? '<span class="badge ok">berhasil</span>' : `<span class="badge err" title="${entry.error ?? ''}">gagal</span>`}</td>`;
      tbody.appendChild(tr);
    }
  };

  if (filterSelect) {
    filterSelect.value = historyFilterValue;
    filterSelect.addEventListener('change', () => {
      historyFilterValue = filterSelect.value;
      renderTable();
    });
  }
  renderTable();
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
    if (mode === 'hmac') authHint.textContent = 'ERP menghitung HMAC dari body + secret, membandingkan dengan header x-wa-signature.';
    else if (mode === 'bearer') authHint.textContent = 'Token dikirim di header Authorization: Bearer <token>.';
    else authHint.textContent = 'Tanpa autentikasi — ERP menerima payload apa adanya.';
  };

  const populate = (data) => {
    const w = data.webhook ?? {};
    const modeLabels = { hmac: 'HMAC Signature', bearer: 'Bearer Token', none: 'Tanpa Auth' };
    setText('whUrl', w.url ?? '(belum diset)', root);
    setText('whAuthMode', modeLabels[w.authMode] ?? '—', root);
    setText('whSecret', w.hasSecret ? '••••••• (aktif)' : '(belum diset)', root);
    setText('whBearer', w.hasBearerToken ? '••••••• (aktif)' : '(belum diset)', root);
    setText('whTimeout', w.timeoutMs ? `${w.timeoutMs} ms` : '—', root);
    setText('whGroups', w.ignoreGroups ? 'Diatasi' : 'Diterima', root);
    setText('whAllowed', w.allowedSenders?.length ? w.allowedSenders.join(', ') : '(semua nomor)', root);
    form.url.value = w.url ?? '';
    form.timeoutMs.value = w.timeoutMs ?? '';
    form.ignoreGroups.checked = Boolean(w.ignoreGroups);
    form.allowedSenders.value = (w.allowedSenders ?? []).join(', ');
    form.secret.value = '';
    form.bearerToken.value = w.bearerToken ?? '';
    authSelect.value = w.authMode ?? 'none';
    applyMode(authSelect.value);
    root.querySelector('#secretHint').textContent = w.hasSecret
      ? 'Secret tersimpan. Kosongkan untuk tetap gunakan yang aktif.'
      : 'Minimal 16 karakter. Untuk verifikasi HMAC.';
    root.querySelector('#bearerHint').textContent = w.hasBearerToken
      ? 'Token tersimpan. Kosongkan untuk tetap gunakan yang aktif.'
      : 'Token akan dikirim di header Authorization.';
  };

  const load = async () => {
    const res = await request('/settings/webhook');
    if (!res.ok) return toast('Gagal memuat setting webhook', 'err');
    populate(res.body.data);
  };

  authSelect.addEventListener('change', () => applyMode(authSelect.value));

  root.querySelector('#btnToggleBearer').addEventListener('click', (event) => {
    const input = form.bearerToken;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    event.currentTarget.textContent = showing ? 'Tampilkan' : 'Sembunyikan';
    event.currentTarget.setAttribute('aria-label', showing ? 'Tampilkan Bearer Token' : 'Sembunyikan Bearer Token');
  });

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
    if (!confirm('Hapus secret HMAC?')) return;
    const res = await request('/settings/webhook', { method: 'PUT', body: JSON.stringify({ clearSecret: true }) });
    if (res.ok) { toast('Secret dihapus', 'ok'); load(); }
    else toast(res.body.error?.message ?? 'Gagal', 'err');
  });

  root.querySelector('#btnClearBearer').addEventListener('click', async () => {
    if (!confirm('Hapus Bearer token?')) return;
    const res = await request('/settings/webhook', { method: 'PUT', body: JSON.stringify({ clearBearerToken: true }) });
    if (res.ok) { toast('Bearer token dihapus', 'ok'); load(); }
    else toast(res.body.error?.message ?? 'Gagal', 'err');
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
    if (res.ok) { toast('Webhook disimpan', 'ok'); load(); }
    else toast(res.body.error?.message ?? 'Gagal menyimpan', 'err');
  });

  load();
}

function renderApi() { /* static content */ }

/* ===== Init ===== */

window.addEventListener('popstate', renderCurrentRoute);
document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-route]');
  if (link) {
    e.preventDefault();
    const name = link.dataset.route;
    if (name) navigate(name);
    return;
  }
  const anchor = e.target.closest('a[href]');
  if (anchor && anchor.origin === location.origin && !anchor.hasAttribute('target')) {
    const routeAnchor = anchor.closest('[data-route]');
    if (!routeAnchor) {
      e.preventDefault();
      history.pushState(null, '', anchor.pathname);
      renderCurrentRoute();
    }
  }
});

$('#btnLogout').addEventListener('click', () => {
  location.href = '/auth/logout';
});

const checkAuth = async () => {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    if ('user' in data) {
      return { configured: true, user: data.user };
    }
  } catch { /* auth not configured (404) */ }
  return { configured: false, user: null };
};

const boot = async () => {
  const { configured, user } = await checkAuth();

  if (configured && !user) {
    location.href = '/login';
    return;
  }

  if (user) {
    $('#userCard').style.display = '';
    $('#userName').textContent = user.name || user.email || user.id;
    const avatarEl = $('#userAvatar');
    const initialsEl = $('#userInitials');
    if (user.avatarUrl) {
      avatarEl.src = user.avatarUrl;
      avatarEl.alt = user.name || '';
      avatarEl.style.display = '';
      initialsEl.style.display = 'none';
    } else {
      initialsEl.textContent = (user.name || user.email || 'U').slice(0, 2).toUpperCase();
    }
  } else {
    $('#userCard').style.display = 'none';
  }

  await loadConfig();
  await refreshData();
  const name = getRoute();
  if (!routes[name]) {
    history.replaceState(null, '', '/');
  }
  renderCurrentRoute();
  const poll = () => {
    const needsFastPoll = state.status && !state.status.ready && state.status.state === 'qr_pending';
    const interval = needsFastPoll ? 2000 : 5000;
    setTimeout(async () => {
      if (getRoute() !== 'logs') await refreshData();
      poll();
    }, interval);
  };
  poll();
};

boot();
