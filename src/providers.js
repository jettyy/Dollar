'use strict';

// 환율 데이터 출처. 모든 함수는 원화 기준 환율을 반환한다.
//   USD: 1달러당 원, JPY: 100엔당 원

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const SANE_RANGE = { USD: [500, 5000], JPY: [300, 3000] };

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function toNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`숫자가 아닌 응답: ${v}`);
  return n;
}

function normalize(code, rate) {
  // 엔화가 1엔 기준으로 왔으면 100엔 기준으로 변환
  if (code === 'JPY' && rate < 50) rate *= 100;
  const [lo, hi] = SANE_RANGE[code];
  if (rate < lo || rate > hi) throw new Error(`비정상 환율 값: ${rate}`);
  return rate;
}

function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function tryInOrder(fns) {
  const errors = [];
  for (const fn of fns) {
    try {
      return await fn();
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(errors.join(', '));
}

// Yahoo Finance: 24시간(평일) 실시간에 가까운 시세
async function fetchYahoo(code) {
  const symbol = code === 'USD' ? 'KRW=X' : 'JPYKRW=X';
  const data = await tryInOrder(
    ['query1', 'query2'].map((host) => () =>
      getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d`)
    )
  );
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(data?.chart?.error?.description || '응답 형식 오류');
  return normalize(code, toNumber(meta.regularMarketPrice));
}

// 네이버 금융 (하나은행 고시 기준, 엔화는 100엔 기준)
async function fetchNaver(code) {
  const reuters = `FX_${code}KRW`;
  const data = await tryInOrder([
    () => getJson(`https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=${reuters}`),
    () => getJson(`https://api.stock.naver.com/marketindex/exchange/${reuters}`),
  ]);
  return normalize(code, toNumber(findKey(data, 'closePrice')));
}

// 두나무(업비트) 환율 API (하나은행 고시 기준)
async function fetchDunamu(code) {
  const data = await getJson(`https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRW${code}`);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error('응답 형식 오류');
  const perUnit = toNumber(row.basePrice) / (Number(row.currencyUnit) || 1);
  return normalize(code, code === 'JPY' ? perUnit * 100 : perUnit);
}

// 모의 데이터: 인터넷 없이 알림/화면을 시험해 볼 때 사용
const demoState = { USD: 1385, JPY: 930 };
async function fetchDemo(code) {
  const jump = Math.random() < 0.08 ? (Math.random() < 0.5 ? -1 : 1) * 0.004 : 0;
  const noise = (Math.random() - 0.5) * 0.0008;
  demoState[code] *= 1 + noise + jump;
  return Math.round(demoState[code] * 100) / 100;
}

const PROVIDERS = {
  yahoo: { name: 'Yahoo Finance', fetch: fetchYahoo },
  naver: { name: '네이버 금융', fetch: fetchNaver },
  dunamu: { name: '두나무(업비트)', fetch: fetchDunamu },
  demo: { name: '모의 데이터(테스트용)', fetch: fetchDemo },
};
const AUTO_ORDER = ['yahoo', 'naver', 'dunamu'];

function listProviders() {
  return [
    { id: 'auto', name: '자동 (Yahoo → 네이버 → 두나무)' },
    ...Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name })),
  ];
}

/**
 * 통화별 환율 조회 함수를 만든다. 'auto' 모드에서는 마지막으로 성공한 출처를 우선 사용해
 * 출처가 자주 바뀌지 않게 한다 (출처가 다르면 비교하지 않으므로).
 */
function createFetcher(providers = PROVIDERS) {
  const preferred = {};
  return async function fetchRate(code, providerId = 'auto') {
    if (providerId !== 'auto') {
      const p = providers[providerId];
      if (!p) throw new Error(`알 수 없는 출처: ${providerId}`);
      return { rate: await p.fetch(code), provider: providerId };
    }
    const order = AUTO_ORDER.filter((id) => providers[id]);
    if (preferred[code]) order.sort((a, b) => (b === preferred[code]) - (a === preferred[code]));
    const errors = [];
    for (const id of order) {
      try {
        const rate = await providers[id].fetch(code);
        preferred[code] = id;
        return { rate, provider: id };
      } catch (e) {
        errors.push(`${providers[id].name}: ${e.message}`);
      }
    }
    throw new Error(`환율 조회 실패 (${errors.join(' / ')})`);
  };
}

module.exports = { PROVIDERS, listProviders, createFetcher, normalize };
