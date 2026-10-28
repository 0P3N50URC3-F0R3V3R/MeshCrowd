import { t } from './i18n.js';

export const EVENT_GROUPS = [
  { label: 'serverLog.groupMembers', types: ['member_join', 'member_greeting', 'member_leave'] },
  { label: 'serverLog.groupModeration', types: ['member_kick', 'member_ban', 'member_unban', 'member_timeout', 'member_timeout_clear'] },
  { label: 'serverLog.groupChannels', types: ['channel_create', 'channel_rename', 'channel_topic', 'channel_delete', 'category_create', 'category_rename', 'category_delete'] },
  { label: 'serverLog.groupServer', types: ['role_create', 'role_delete', 'member_role_add', 'member_role_remove', 'server_rename'] },
];

const NO_ACTOR_VARIANT = new Set(['member_kick', 'member_ban', 'member_unban', 'member_timeout', 'member_timeout_clear']);
const LEGACY_TYPES = new Set(['member_join', 'member_leave', 'member_kick', 'member_ban']);

function formatDuration(minutes) {
  const m = Number(minutes) || 0;
  if (m >= 1440 && m % 1440 === 0) return t('serverLog.durationDays', { n: m / 1440 });
  if (m >= 60 && m % 60 === 0) return t('serverLog.durationHours', { n: m / 60 });
  return t('serverLog.durationMinutes', { n: m });
}

// Plain-text, localized description of an auto-posted server-log entry, or null when the caller
// should fall back to the stored English `content` (custom greeting, unknown/legacy entries).
export function serverEventText(msg) {
  const type = msg.eventType;
  let data = msg.eventData;
  if (!data && LEGACY_TYPES.has(type)) data = { target: msg.author?.displayName || '' };
  if (!data || data.custom) return null;
  let key = type;
  if (NO_ACTOR_VARIANT.has(type) && !data.actor) key += 'NoActor';
  if (type === 'channel_topic' && !data.topic) key = 'channel_topicCleared';
  const path = `serverLog.${key}`;
  let text = t(path, { ...data, duration: formatDuration(data.minutes) });
  if (text === path) return null;
  if (type === 'member_ban' && data.reason) text += ` ${t('serverLog.reasonSuffix', { reason: data.reason })}`;
  return text;
}
