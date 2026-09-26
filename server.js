#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

if (typeof fetch !== 'function') {
  console.error('Node.js 18 이상이 필요합니다. 현재 버전:', process.version);
  process.exit(1);
}

const { DATA_DIR, createConfigStore, publicConfig, readJson, writeJson } = require('./src/config');
const { PROVIDERS, listProviders, createFetcher } = require('./src/providers');
const telegram = require('./src/telegram');
const { Monitor } = require('./src/monitor');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const config = createConfigStore();
const monitor = new Monitor({
  getConfig: config.get,
  fetchRate: createFetcher(),
  notify: (text) => {
    const { token, chatId } = config.get().telegram;
    return telegram.sendMessage(token, chatId, text);
  },
  storage: {
    load: () => readJson(STATE_FILE, null),
    save: (state) => writeJson(STATE_FILE, state),
  },
  providerName: (id) => (PROVIDERS[id] ? PROVIDERS[id].name : id),
});

// ---------- API ----------

function status() {
  const cfg = config.get();
  return {
    running: monitor.running,
    lastTickAt: monitor.lastTickAt,
    nextTickAt: monitor.nextTickAt,
    telegramReady: Boolean(cfg.telegram.token && cfg.telegram.chatId),
    config: publicConfig(cfg),
    providers: listProviders(),
    currencies: monitor.snapshot(),
    alerts: monitor.alerts.slice(0, 50),
  };
}

const routes = {
  'GET /api/status': () => status(),
  'GET /api/config': () => ({ config: publicConfig(config.get()), providers: listProviders() }),
  'POST /api/config': (body) => {
    config.update(body);
    monitor.reschedule();
    return { config: publicConfig(config.get()) };
  },
  'POST /api/monitor/start': () => {
    monitor.start();
    config.update({ autoStart: true });
    return status();
  },
  'POST /api/monitor/stop': () => {
    monitor.stop();
    config.update({ autoStart: false });
    return status();
  },
  'POST /api/check': async () => {
    await monitor.tick();
    return status();
  },
  'DELETE /api/alerts': () => {
    monitor.clearAlerts();
    return { ok: true };
  },
  // 저장 전 입력값으로도 시험해볼 수 있도록 body 의 token/chatId 를 우선 사용
  'POST /api/telegram/test': async (body) => {
    const saved = config.get().telegram;
    const token = (body.token || '').trim() || saved.token;
    const chatId = String(body.chatId || '').trim() || saved.chatId;
    const snap = monitor.snapshot();
    const lines = Object.values(snap)
      .filter((c) => c.latest)
      .map((c) => `${c.flag} ${c.pair}: ${c.latest.rate.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}원`);
    const text = ['✅ <b>환율 알림 테스트</b>', '텔레그램 연결이 정상입니다.', ...(lines.length ? ['', ...lines] : [])].join('\n');
    await telegram.sendMessage(token, chatId, text);
    return { ok: true };
  },
  'POST /api/telegram/chats': async (body) => {
    const token = (body.token || '').trim() || config.get().telegram.token;
    return { chats: await telegram.findChats(token) };
  },
};

function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) {
        reject(new Error('요청이 너무 큽니다.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('잘못된 JSON 입니다.'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- 정적 파일 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, pathname);
  }
  const handler = routes[`${req.method} ${pathname}`];
  if (!handler) return sendJson(res, 404, { error: '알 수 없는 API' });
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    sendJson(res, 200, await handler(body));
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT} 가 이미 사용 중입니다. 이미 실행 중인지 확인하거나 PORT=3001 npm start 처럼 다른 포트를 지정하세요.`);
  } else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log('');
  console.log('  💱 환율 급변동 알림 실행 중');
  console.log(`  👉 브라우저에서 열기: ${url}`);
  console.log('  (종료: Ctrl + C)');
  console.log('');
  if (config.get().autoStart) monitor.start();
  openBrowser(url);
});

function shutdown() {
  monitor.stop();
  monitor.persist();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
