'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.FX_DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = Object.freeze({
  telegram: { token: '', chatId: '' },
  currencies: {
    USD: { enabled: true, threshold: 3 },
    JPY: { enabled: true, threshold: 3 },
  },
  windowMinutes: 5, // 몇 분 전과 비교할지
  pollSeconds: 60, // 환율 조회 주기
  cooldownMinutes: 10, // 같은 통화 재알림 최소 간격
  provider: 'auto',
  autoStart: true, // 프로그램 실행 시 바로 모니터링 시작
});

const PROVIDER_IDS = ['auto', 'yahoo', 'naver', 'dunamu', 'demo'];

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) continue;
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

function numberIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${label} 값은 ${min} ~ ${max} 사이여야 합니다.`);
  }
  return n;
}

/**
 * 사용자가 보낸 설정(부분)을 검증해 현재 설정과 합친 새 설정을 반환한다.
 * 토큰은 빈 값이면 기존 값을 유지하고, clearToken 이 true 일 때만 지운다.
 */
function applyUpdate(current, input) {
  const next = clone(current);
  input = input || {};

  if (input.telegram) {
    const token = typeof input.telegram.token === 'string' ? input.telegram.token.trim() : '';
    if (input.telegram.clearToken) next.telegram.token = '';
    else if (token) {
      if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error('텔레그램 봇 토큰 형식이 올바르지 않습니다. (예: 123456789:ABC...)');
      next.telegram.token = token;
    }
    if (input.telegram.chatId !== undefined) {
      const chatId = String(input.telegram.chatId).trim();
      if (chatId && !/^(-?\d+|@\w{4,})$/.test(chatId)) throw new Error('채팅 ID는 숫자(예: 123456789, -100...) 또는 @채널이름 형식이어야 합니다.');
      next.telegram.chatId = chatId;
    }
  }

  if (input.currencies) {
    for (const code of Object.keys(next.currencies)) {
      const c = input.currencies[code];
      if (!c) continue;
      if (c.enabled !== undefined) next.currencies[code].enabled = Boolean(c.enabled);
      if (c.threshold !== undefined) next.currencies[code].threshold = numberIn(c.threshold, 0.01, 50, `${code} 기준 %`);
    }
  }

  if (input.windowMinutes !== undefined) next.windowMinutes = numberIn(input.windowMinutes, 1, 240, '비교 시간(분)');
  if (input.pollSeconds !== undefined) next.pollSeconds = Math.round(numberIn(input.pollSeconds, 10, 600, '확인 주기(초)'));
  if (input.cooldownMinutes !== undefined) next.cooldownMinutes = numberIn(input.cooldownMinutes, 0, 1440, '재알림 대기(분)');
  if (input.autoStart !== undefined) next.autoStart = Boolean(input.autoStart);
  if (input.provider !== undefined) {
    if (!PROVIDER_IDS.includes(input.provider)) throw new Error('알 수 없는 데이터 출처입니다.');
    next.provider = input.provider;
  }

  if (next.pollSeconds > next.windowMinutes * 60) {
    throw new Error('확인 주기(초)는 비교 시간(분)보다 짧아야 합니다.');
  }
  return next;
}

function maskToken(token) {
  if (!token) return '';
  const [id, secret = ''] = token.split(':');
  return `${id}:${secret.slice(0, 3)}…${secret.slice(-3)}`;
}

/** 브라우저로 내보낼 설정 (토큰은 가림) */
function publicConfig(cfg) {
  const out = clone(cfg);
  out.telegram = {
    chatId: cfg.telegram.chatId,
    tokenSet: Boolean(cfg.telegram.token),
    tokenMasked: maskToken(cfg.telegram.token),
  };
  return out;
}

function createConfigStore(file = CONFIG_FILE) {
  let current = merge(clone(DEFAULTS), readJson(file, {}));
  return {
    get: () => current,
    update(input) {
      current = applyUpdate(current, input);
      writeJson(file, current);
      return current;
    },
  };
}

module.exports = { DATA_DIR, DEFAULTS, applyUpdate, publicConfig, createConfigStore, readJson, writeJson };
