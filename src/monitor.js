'use strict';

const CURRENCIES = {
  USD: { label: '달러', pair: 'USD/KRW', unit: '1달러', flag: '🇺🇸' },
  JPY: { label: '엔화', pair: 'JPY/KRW', unit: '100엔', flag: '🇯🇵' },
};

const HISTORY_MS = 6 * 60 * 60 * 1000; // 6시간치 보관
const MAX_ALERTS = 200;

function fmt(n, digits = 2) {
  return n.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signed(n, digits = 2) {
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmt(Math.abs(n), digits)}`;
}

function kstString(t) {
  return new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
}

/**
 * 목표 시각(target)에 가장 가까운 과거 표본을 찾는다. 같은 출처의 표본만 비교하고,
 * tolerance 보다 멀리 떨어진 표본은 무시한다 (프로그램이 꺼져 있던 경우 등).
 */
function findBaseline(history, target, provider, tolerance, before) {
  let best = null;
  let bestGap = Infinity;
  for (const s of history) {
    if (s.provider !== provider || s.t >= before) continue;
    const gap = Math.abs(s.t - target);
    if (gap < bestGap) {
      best = s;
      bestGap = gap;
    }
  }
  return best && bestGap <= tolerance ? best : null;
}

function formatAlert(a, providerName) {
  const c = CURRENCIES[a.code];
  const up = a.change > 0;
  return [
    `${up ? '🔺' : '🔻'} <b>${c.label} 환율 ${up ? '급등' : '급락'}</b> ${c.flag} ${c.pair}`,
    '',
    `현재: <b>${fmt(a.rate)}원</b> (${c.unit})`,
    `${a.windowMinutes}분 전: ${fmt(a.baseRate)}원`,
    `변동: ${signed(a.change)}원 (<b>${signed(a.pct)}%</b>)`,
    '',
    `알림 기준: ±${a.threshold}% · 출처: ${providerName || a.provider}`,
    `🕒 ${kstString(a.t)}`,
  ].join('\n');
}

class Monitor {
  /**
   * @param {object} opts
   * @param {() => object} opts.getConfig 현재 설정
   * @param {(code, provider) => Promise<{rate, provider}>} opts.fetchRate
   * @param {(text) => Promise<void>} opts.notify 텔레그램 전송
   * @param {{load: () => object|null, save: (state) => void}} [opts.storage]
   * @param {(id) => string} [opts.providerName]
   */
  constructor({ getConfig, fetchRate, notify, storage, providerName, now = Date.now, log = console }) {
    this.getConfig = getConfig;
    this.fetchRate = fetchRate;
    this.notify = notify;
    this.storage = storage || { load: () => null, save: () => {} };
    this.providerName = providerName || ((id) => id);
    this.now = now;
    this.log = log;

    this.running = false;
    this.timer = null;
    this.ticking = null;
    this.lastTickAt = null;
    this.nextTickAt = null;
    this.state = {};
    this.alerts = [];
    for (const code of Object.keys(CURRENCIES)) {
      this.state[code] = { history: [], latest: null, base: null, change: null, pct: null, error: null, lastAlertAt: null };
    }
    this.restore();
  }

  restore() {
    const saved = this.storage.load();
    if (!saved) return;
    for (const code of Object.keys(CURRENCIES)) {
      const s = saved.currencies && saved.currencies[code];
      if (!s) continue;
      this.state[code].history = Array.isArray(s.history) ? s.history : [];
      this.state[code].lastAlertAt = s.lastAlertAt || null;
    }
    this.alerts = Array.isArray(saved.alerts) ? saved.alerts.slice(0, MAX_ALERTS) : [];
  }

  persist() {
    const currencies = {};
    for (const [code, s] of Object.entries(this.state)) {
      currencies[code] = { history: s.history, lastAlertAt: s.lastAlertAt };
    }
    try {
      this.storage.save({ currencies, alerts: this.alerts });
    } catch (e) {
      this.log.error('데이터 저장 실패:', e.message);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log.log('▶ 모니터링 시작');
    this.schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextTickAt = null;
    this.log.log('■ 모니터링 중지');
  }

  /** 설정 변경 시 다음 확인 시각을 다시 계산 */
  reschedule() {
    if (!this.running) return;
    const interval = this.getConfig().pollSeconds * 1000;
    const due = this.lastTickAt ? this.lastTickAt + interval - this.now() : 0;
    this.schedule(Math.max(0, due));
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.nextTickAt = this.now() + delay;
    this.timer = setTimeout(async () => {
      await this.tick();
      if (this.running) this.schedule(this.getConfig().pollSeconds * 1000);
    }, delay);
  }

  /** 한 번 환율을 조회하고 필요하면 알림을 보낸다. 동시에 두 번 실행되지 않는다. */
  tick() {
    if (!this.ticking) {
      this.ticking = this.runTick().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  async runTick() {
    const cfg = this.getConfig();
    const now = this.now();
    await Promise.all(Object.keys(CURRENCIES).map((code) => this.checkCurrency(code, cfg, now)));
    for (const s of Object.values(this.state)) {
      s.history = s.history.filter((h) => now - h.t <= Math.max(HISTORY_MS, cfg.windowMinutes * 3 * 60000));
    }
    this.lastTickAt = now;
    this.persist();
  }

  async checkCurrency(code, cfg, now) {
    const st = this.state[code];
    let quote;
    try {
      quote = await this.fetchRate(code, cfg.provider);
    } catch (e) {
      st.error = e.message;
      st.errorAt = now;
      this.log.warn(`[${code}] ${e.message}`);
      return;
    }
    st.error = null;

    const sample = { t: now, rate: Math.round(quote.rate * 10000) / 10000, provider: quote.provider };
    st.history.push(sample);
    st.latest = sample;

    const windowMs = cfg.windowMinutes * 60000;
    const tolerance = Math.max(cfg.pollSeconds * 1500, 60000);
    const base = findBaseline(st.history, now - windowMs, sample.provider, tolerance, now);
    st.base = base;
    if (!base) {
      st.change = st.pct = null;
      return;
    }
    const change = sample.rate - base.rate;
    const pct = (change / base.rate) * 100;
    st.change = change;
    st.pct = pct;

    const setting = cfg.currencies[code];
    if (!setting || !setting.enabled) return;
    if (Math.abs(pct) + 1e-9 < setting.threshold) return;
    if (st.lastAlertAt && now - st.lastAlertAt < cfg.cooldownMinutes * 60000) return;

    st.lastAlertAt = now;
    const alert = {
      id: `${now}-${code}`,
      t: now,
      code,
      rate: sample.rate,
      baseRate: base.rate,
      baseTime: base.t,
      change,
      pct,
      threshold: setting.threshold,
      windowMinutes: cfg.windowMinutes,
      provider: sample.provider,
      sent: false,
      error: null,
    };
    try {
      await this.notify(formatAlert(alert, this.providerName(sample.provider)));
      alert.sent = true;
      this.log.log(`🔔 [${code}] ${signed(pct)}% 알림 전송`);
    } catch (e) {
      alert.error = e.message;
      this.log.warn(`🔔 [${code}] ${signed(pct)}% 알림 전송 실패: ${e.message}`);
    }
    this.alerts.unshift(alert);
    this.alerts.length = Math.min(this.alerts.length, MAX_ALERTS);
  }

  /** 화면 표시용 요약. series 는 최근 chartMinutes 분, 현재 출처의 표본만. */
  snapshot(chartMinutes = 60) {
    const now = this.now();
    const out = {};
    for (const [code, s] of Object.entries(this.state)) {
      const provider = s.latest ? s.latest.provider : null;
      out[code] = {
        ...CURRENCIES[code],
        latest: s.latest,
        base: s.base,
        change: s.change,
        pct: s.pct,
        error: s.error,
        errorAt: s.errorAt || null,
        lastAlertAt: s.lastAlertAt,
        series: s.history
          .filter((h) => h.provider === provider && now - h.t <= chartMinutes * 60000)
          .map((h) => [h.t, h.rate]),
      };
    }
    return out;
  }

  clearAlerts() {
    this.alerts = [];
    this.persist();
  }
}

module.exports = { Monitor, CURRENCIES, findBaseline, formatAlert };
