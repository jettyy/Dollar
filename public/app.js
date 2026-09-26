'use strict';

const $ = (sel) => document.querySelector(sel);
const form = $('#settingsForm');
let last = null;

// ---------- 유틸 ----------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmt = (n, d = 2) =>
  n == null ? '—' : Number(n).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (n, d = 2) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n), d);
const clock = (t) => (t ? new Date(t).toLocaleTimeString('ko-KR', { hour12: false }) : '—');
const stamp = (t) =>
  new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dir = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), isError ? 5000 : 2500);
}

async function withBusy(btn, fn) {
  btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- 차트 ----------

function sparkline(series, base, threshold) {
  if (series.length < 2) return '<div class="spark-empty">차트 데이터 수집 중…</div>';
  const W = 600, H = 150, P = 8;
  const t0 = series[0][0], t1 = series[series.length - 1][0];
  const rates = series.map((s) => s[1]);
  let lo = Math.min(...rates), hi = Math.max(...rates);
  let band = null;
  if (base && threshold) {
    band = [base.rate * (1 - threshold / 100), base.rate * (1 + threshold / 100)];
    lo = Math.min(lo, band[0]);
    hi = Math.max(hi, band[1]);
  }
  if (hi - lo < 1e-9) { hi += 0.5; lo -= 0.5; }
  const x = (t) => P + ((t - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = (r) => H - P - ((r - lo) / (hi - lo)) * (H - 2 * P);
  const pts = series.map(([t, r]) => `${x(t).toFixed(1)},${y(r).toFixed(1)}`).join(' ');
  const lastPt = series[series.length - 1];
  const color = base ? (lastPt[1] >= base.rate ? 'var(--up)' : 'var(--down)') : 'var(--accent)';
  let extra = '';
  if (band) {
    extra += `<line x1="${P}" x2="${W - P}" y1="${y(band[1])}" y2="${y(band[1])}" stroke="var(--up)" stroke-dasharray="4 4" opacity=".55"/>`;
    extra += `<line x1="${P}" x2="${W - P}" y1="${y(band[0])}" y2="${y(band[0])}" stroke="var(--down)" stroke-dasharray="4 4" opacity=".55"/>`;
    if (base.t >= t0) extra += `<circle cx="${x(base.t)}" cy="${y(base.rate)}" r="4" fill="var(--panel)" stroke="var(--muted)" stroke-width="2"/>`;
  }
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="최근 60분 환율 추이">
    ${extra}
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(lastPt[0])}" cy="${y(lastPt[1])}" r="4.5" fill="${color}"/>
  </svg>`;
}

// ---------- 렌더링 ----------

function providerName(id) {
  const p = last && last.providers.find((x) => x.id === id);
  return p ? p.name : id || '—';
}

function renderCards(s) {
  const cfg = s.config;
  $('#cards').innerHTML = Object.entries(s.currencies)
    .map(([code, c]) => {
      const rule = cfg.currencies[code];
      const d = dir(c.change);
      const ratio = c.pct == null ? 0 : Math.min(1, Math.abs(c.pct) / rule.threshold);
      const delta = c.latest
        ? c.base
          ? `${cfg.windowMinutes}분 전 ${fmt(c.base.rate)}원 → <b class="${d}">${signed(c.change)}원 (${signed(c.pct)}%)</b>`
          : `${cfg.windowMinutes}분 전 기준 데이터 수집 중… (${cfg.windowMinutes}분 후부터 비교)`
        : '환율을 불러오는 중…';
      return `<article class="card">
        <div class="card-head">
          <span class="card-title">${c.flag} ${c.label} <small>${c.pair} · ${c.unit}</small></span>
          <span class="badge ${rule.enabled ? '' : 'off'}">${rule.enabled ? `알림 ±${rule.threshold}%` : '알림 꺼짐'}</span>
        </div>
        <div class="rate">${c.latest ? fmt(c.latest.rate) : '—'}<small>원</small></div>
        <div class="delta">${delta}</div>
        <div class="meter ${ratio >= 1 ? d : ''}" title="알림 기준까지 얼마나 왔는지"><i style="width:${(ratio * 100).toFixed(1)}%"></i></div>
        <div class="meter-label"><span>알림 기준 대비</span><span>${c.pct == null ? '—' : `${Math.round(ratio * 100)}%`}</span></div>
        ${sparkline(c.series, c.base, rule.enabled ? rule.threshold : 0)}
        <div class="card-foot">
          <span>최근 60분 · 점선: 알림 기준선</span>
          <span>${c.latest ? `${esc(providerName(c.latest.provider))} · ${clock(c.latest.t)}` : ''}</span>
        </div>
        ${c.error ? `<div class="err">⚠ ${esc(c.error)}</div>` : ''}
      </article>`;
    })
    .join('');
}

function renderLog(s) {
  if (!s.alerts.length) {
    $('#log').innerHTML = '<li class="empty">아직 알림이 없어요.<br />조건을 만족하면 여기에 기록돼요.</li>';
    return;
  }
  $('#log').innerHTML = s.alerts
    .map((a) => {
      const c = s.currencies[a.code];
      const d = dir(a.change);
      return `<li>
        <div class="row">
          <b>${c.flag} ${c.label} <span class="${d}">${a.change > 0 ? '급등' : '급락'} ${signed(a.pct)}%</span></b>
          <span class="meta">${stamp(a.t)}</span>
        </div>
        <div class="row meta">
          <span>${fmt(a.baseRate)} → ${fmt(a.rate)}원 (${signed(a.change)}원, ${a.windowMinutes}분)</span>
          ${a.sent ? '<span class="sent">✓ 전송됨</span>' : '<span class="failed">✕ 전송 실패</span>'}
        </div>
        ${a.error ? `<div class="err">${esc(a.error)}</div>` : ''}
      </li>`;
    })
    .join('');
}

function renderStatus(s) {
  const el = $('#status');
  el.classList.toggle('on', s.running);
  el.querySelector('.text').textContent = s.running
    ? `모니터링 중 · 다음 확인 ${clock(s.nextTickAt)}`
    : '중지됨';
  const btn = $('#toggleBtn');
  btn.textContent = s.running ? '중지' : '시작';
  btn.className = `btn ${s.running ? 'danger' : 'primary'}`;
  $('#tgBanner').hidden = s.telegramReady;
}

function render(s) {
  last = s;
  renderStatus(s);
  renderCards(s);
  renderLog(s);
}

// ---------- 설정 폼 ----------

function fillForm(cfg, providers) {
  $('#provider').innerHTML = providers.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  form.token.value = '';
  form.token.placeholder = cfg.telegram.tokenSet ? `저장됨 (${cfg.telegram.tokenMasked}) — 바꿀 때만 입력` : '123456789:ABCdef...';
  $('#tokenHint').textContent = cfg.telegram.tokenSet ? '토큰이 저장되어 있어요.' : '';
  form.chatId.value = cfg.telegram.chatId;
  for (const code of ['USD', 'JPY']) {
    form[`${code}_enabled`].checked = cfg.currencies[code].enabled;
    form[`${code}_threshold`].value = cfg.currencies[code].threshold;
  }
  form.windowMinutes.value = cfg.windowMinutes;
  form.pollSeconds.value = cfg.pollSeconds;
  form.cooldownMinutes.value = cfg.cooldownMinutes;
  form.provider.value = cfg.provider;
  updateRuleText();
}

function updateRuleText() {
  const w = form.windowMinutes.value || '?';
  $('#ruleText').textContent = `${w}분 전과 비교해 위 % 이상 오르거나 내리면 텔레그램으로 알려드려요. 같은 통화는 재알림 대기 시간 동안 다시 보내지 않아요.`;
}

function readForm() {
  return {
    telegram: { token: form.token.value.trim(), chatId: form.chatId.value.trim() },
    currencies: Object.fromEntries(
      ['USD', 'JPY'].map((c) => [c, { enabled: form[`${c}_enabled`].checked, threshold: Number(form[`${c}_threshold`].value) }])
    ),
    windowMinutes: Number(form.windowMinutes.value),
    pollSeconds: Number(form.pollSeconds.value),
    cooldownMinutes: Number(form.cooldownMinutes.value),
    provider: form.provider.value,
  };
}

form.addEventListener('input', (e) => {
  if (e.target.name === 'windowMinutes') updateRuleText();
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  withBusy(form.querySelector('[type=submit]'), async () => {
    const { config } = await api('/api/config', { method: 'POST', body: readForm() });
    fillForm(config, last ? last.providers : []);
    toast('설정을 저장했어요.');
    refresh();
  });
});

$('#testBtn').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    await api('/api/telegram/test', { method: 'POST', body: { token: form.token.value, chatId: form.chatId.value } });
    toast('테스트 메시지를 보냈어요. 텔레그램을 확인하세요!');
  })
);

$('#findChatBtn').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const { chats } = await api('/api/telegram/chats', { method: 'POST', body: { token: form.token.value } });
    const list = $('#chatList');
    if (!chats.length) {
      list.innerHTML = '';
      toast('찾은 채팅이 없어요. 봇에게 먼저 아무 메시지나 보낸 뒤 다시 눌러주세요.', true);
      return;
    }
    list.innerHTML = chats
      .map((c) => `<button type="button" class="chip" data-id="${esc(c.id)}">${esc(c.name || c.type)} · ${esc(c.id)}</button>`)
      .join('');
    if (chats.length === 1) form.chatId.value = chats[0].id;
    toast(chats.length === 1 ? '채팅 ID를 입력했어요. 설정 저장을 눌러주세요.' : '사용할 채팅을 선택하세요.');
  })
);

$('#chatList').addEventListener('click', (e) => {
  const id = e.target.dataset && e.target.dataset.id;
  if (id) form.chatId.value = id;
});

$('#toggleBtn').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    render(await api(last && last.running ? '/api/monitor/stop' : '/api/monitor/start', { method: 'POST' }));
  })
);

$('#checkBtn').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    render(await api('/api/check', { method: 'POST' }));
    toast('환율을 새로 확인했어요.');
  })
);

$('#clearBtn').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    if (!confirm('알림 기록을 모두 지울까요?')) return;
    await api('/api/alerts', { method: 'DELETE' });
    refresh();
  })
);

// ---------- 주기적 갱신 ----------

let offline = false;
async function refresh() {
  try {
    render(await api('/api/status'));
    if (offline) toast('서버에 다시 연결됐어요.');
    offline = false;
  } catch {
    if (!offline) toast('서버에 연결할 수 없어요. 터미널에서 npm start 가 실행 중인지 확인하세요.', true);
    offline = true;
    const el = $('#status');
    el.classList.remove('on');
    el.querySelector('.text').textContent = '서버 연결 끊김';
  }
}

(async function init() {
  try {
    const s = await api('/api/status');
    render(s);
    fillForm(s.config, s.providers);
  } catch (e) {
    toast(e.message, true);
  }
  setInterval(refresh, 3000);
})();
