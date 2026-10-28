'use strict';

const HISTORY_CHAR_BUDGET = 6000;
const MESSAGE_CAP = 2000;

function systemPrompt({ bot, serverName, channelName, dmWith }) {
  const where = dmWith
    ? `You are in a private conversation with ${dmWith}.`
    : `You are in the chat of "${serverName}"${channelName ? `, channel #${channelName}` : ''}. Several people talk here and each of their lines starts with their name.`;
  const base = `You are "${bot.displayName}", an AI assistant. ${where} Answer the latest message concisely. You are an AI and must never claim to be human. Do not use @ to mention anyone.`;
  return bot.persona ? `${bot.persona}\n\n${base}` : base;
}

function toTurns(history, botUserId) {
  const turns = [];
  for (const m of history) {
    if (m.eventType || m.isEncrypted) continue;
    const content = String(m.content || '').trim().slice(0, MESSAGE_CAP);
    if (!content) continue;
    if (m.author.id === botUserId) turns.push({ role: 'assistant', content });
    else turns.push({ role: 'user', content: `${m.author.displayName}: ${content}` });
  }
  return turns;
}

function buildMessages({ bot, serverName, channelName, dmWith, history }) {
  const turns = toTurns(history, bot.userId);
  const kept = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (kept.length && used + turns[i].content.length > HISTORY_CHAR_BUDGET) break;
    kept.unshift(turns[i]);
    used += turns[i].content.length;
  }
  return [{ role: 'system', content: systemPrompt({ bot, serverName, channelName, dmWith }) }, ...kept];
}

module.exports = { buildMessages, HISTORY_CHAR_BUDGET };
