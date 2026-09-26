'use strict';

const API = 'https://api.telegram.org';

async function call(token, method, body) {
  if (!token) throw new Error('텔레그램 봇 토큰이 설정되지 않았습니다.');
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`텔레그램 오류: ${data.description || `HTTP ${res.status}`}`);
  }
  return data.result;
}

async function sendMessage(token, chatId, text) {
  if (!chatId) throw new Error('텔레그램 채팅 ID가 설정되지 않았습니다.');
  return call(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

/** 봇에게 최근 메시지를 보낸 채팅 목록 (채팅 ID 찾기용) */
async function findChats(token) {
  const updates = await call(token, 'getUpdates', { limit: 100 });
  const chats = new Map();
  for (const u of updates) {
    const msg = u.message || u.channel_post || u.edited_message || u.my_chat_member;
    const chat = msg && msg.chat;
    if (!chat) continue;
    const name =
      chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || (chat.username ? `@${chat.username}` : '');
    chats.set(chat.id, { id: String(chat.id), name, type: chat.type });
  }
  return [...chats.values()];
}

module.exports = { sendMessage, findChats };
