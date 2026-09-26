'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Monitor, findBaseline, formatAlert } = require('../src/monitor');
const { applyUpdate, DEFAULTS } = require('../src/config');
const { createFetcher, normalize } = require('../src/providers');

const MIN = 60000;

function setup({ rates, config = {} }) {
  let now = 1_000_000_000_000;
  const cfg = applyUpdate(JSON.parse(JSON.stringify(DEFAULTS)), config);
  const sent = [];
  const queue = { USD: [...rates.USD], JPY: [...rates.JPY] };
  const monitor = new Monitor({
    getConfig: () => cfg,
    fetchRate: async (code) => ({ rate: queue[code].shift(), provider: 'test' }),
    notify: async (text) => sent.push(text),
    now: () => now,
    log: { log() {}, warn() {}, error() {} },
  });
  return {
    monitor,
    sent,
    advance: (ms) => (now += ms),
  };
}

async function runMinutes(ctx, n) {
  for (let i = 0; i < n; i++) {
    await ctx.monitor.tick();
    ctx.advance(MIN);
  }
}

test('5분 전 대비 기준 이상 오르면 알림을 보낸다', async () => {
  // 0~5분: 1380 유지, 5분 시점에 1385 (+0.36%)
  const ctx = setup({
    rates: { USD: [1380, 1380, 1380, 1380, 1380, 1385], JPY: [930, 930, 930, 930, 930, 930] },
  });
  await runMinutes(ctx, 6);
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0], /달러 환율 급등/);
  assert.match(ctx.sent[0], /1,385\.00원/);
  const a = ctx.monitor.alerts[0];
  assert.equal(a.code, 'USD');
  assert.equal(a.baseRate, 1380);
  assert.ok(a.sent);
});

test('하락도 감지하고, 기준 미만이면 알리지 않는다', async () => {
  const ctx = setup({
    rates: { USD: [1380, 1380, 1380, 1380, 1380, 1378], JPY: [930, 930, 930, 930, 930, 926] }, // USD -0.14%, JPY -0.43%
  });
  await runMinutes(ctx, 6);
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0], /엔화 환율 급락/);
});

test('재알림 대기 시간 동안에는 다시 보내지 않는다', async () => {
  const usd = [1380, 1380, 1380, 1380, 1380, 1390, 1400, 1410, 1420];
  const ctx = setup({ rates: { USD: usd, JPY: usd.map(() => 930) }, config: { cooldownMinutes: 10 } });
  await runMinutes(ctx, usd.length);
  assert.equal(ctx.sent.length, 1);
});

test('비교할 5분 전 데이터가 없으면 알리지 않는다', async () => {
  const ctx = setup({ rates: { USD: [1380, 1500], JPY: [930, 930] } });
  await runMinutes(ctx, 2);
  assert.equal(ctx.sent.length, 0);
  assert.equal(ctx.monitor.state.USD.pct, null);
});

test('꺼진 통화는 알리지 않는다', async () => {
  const ctx = setup({
    rates: { USD: [1380, 1380, 1380, 1380, 1380, 1400], JPY: [930, 930, 930, 930, 930, 930] },
    config: { currencies: { USD: { enabled: false } } },
  });
  await runMinutes(ctx, 6);
  assert.equal(ctx.sent.length, 0);
});

test('텔레그램 전송 실패도 기록한다', async () => {
  const ctx = setup({ rates: { USD: [1380, 1380, 1380, 1380, 1380, 1400], JPY: Array(6).fill(930) } });
  ctx.monitor.notify = async () => {
    throw new Error('boom');
  };
  await runMinutes(ctx, 6);
  assert.equal(ctx.monitor.alerts[0].sent, false);
  assert.equal(ctx.monitor.alerts[0].error, 'boom');
});

test('findBaseline: 다른 출처나 너무 먼 표본은 무시한다', () => {
  const h = [
    { t: 0, rate: 1, provider: 'a' },
    { t: 5 * MIN, rate: 2, provider: 'b' },
    { t: 10 * MIN, rate: 3, provider: 'a' },
  ];
  assert.equal(findBaseline(h, 5 * MIN, 'a', MIN, 10 * MIN), null);
  assert.equal(findBaseline(h, 5 * MIN, 'b', MIN, 10 * MIN).rate, 2);
  assert.equal(findBaseline(h, 0, 'a', MIN, 10 * MIN).rate, 1);
});

test('formatAlert 메시지 형식', () => {
  const text = formatAlert({ code: 'JPY', t: 0, rate: 925.5, baseRate: 930, change: -4.5, pct: -0.4839, threshold: 0.3, windowMinutes: 5, provider: 'x' }, 'X');
  assert.match(text, /🔻 <b>엔화 환율 급락<\/b>/);
  assert.match(text, /-0\.48%/);
  assert.match(text, /100엔/);
});

test('설정 검증', () => {
  const base = JSON.parse(JSON.stringify(DEFAULTS));
  assert.throws(() => applyUpdate(base, { currencies: { USD: { threshold: 0 } } }));
  assert.throws(() => applyUpdate(base, { telegram: { token: 'abc' } }));
  assert.throws(() => applyUpdate(base, { windowMinutes: 1, pollSeconds: 120 }));
  const withToken = applyUpdate(base, { telegram: { token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ', chatId: '-100123' } });
  assert.equal(applyUpdate(withToken, { telegram: { token: '' } }).telegram.token, '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
});

test('auto 출처: 실패하면 다음 출처로 넘어가고 성공한 출처를 기억한다', async () => {
  const calls = [];
  const fetchRate = createFetcher({
    yahoo: { name: 'Y', fetch: async () => (calls.push('yahoo'), Promise.reject(new Error('down'))) },
    naver: { name: 'N', fetch: async () => (calls.push('naver'), 1390) },
    dunamu: { name: 'D', fetch: async () => (calls.push('dunamu'), 1391) },
  });
  assert.deepEqual(await fetchRate('USD'), { rate: 1390, provider: 'naver' });
  assert.deepEqual(await fetchRate('USD'), { rate: 1390, provider: 'naver' });
  assert.deepEqual(calls, ['yahoo', 'naver', 'naver']);
});

test('normalize: 엔화 1엔 기준 값은 100엔 기준으로 변환', () => {
  assert.equal(Math.round(normalize('JPY', 9.3)), 930);
  assert.equal(normalize('JPY', 930), 930);
  assert.throws(() => normalize('USD', 13));
});
