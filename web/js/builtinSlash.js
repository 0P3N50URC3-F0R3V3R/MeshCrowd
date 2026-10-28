import { t } from './i18n.js';

// Backslash-escaped so the markdown renderer (utils.js) shows ¯\_(ツ)_/¯ instead of eating the underscores.
export const SHRUG = '¯\\\\_(ツ)\\_/¯';

// Command names/usage stay untranslated (literal syntax the user types), only descriptions localize.
export function builtinSlashCommands() {
  return [
    { name: 'afk', usage: '/afk [message]', description: t('chat.slashAfkDesc') },
    { name: 'dm', usage: '/dm <username> [message]', description: t('chat.slashDmDesc') },
    { name: 'help', usage: '/help', description: t('chat.slashHelpDesc') },
    { name: 'invite', usage: '/invite', description: t('chat.slashInviteDesc') },
    { name: 'me', usage: '/me <action>', description: t('chat.slashMeDesc') },
    { name: 'msg', usage: '/msg <username> [message]', description: t('chat.slashMsgDesc') },
    { name: 'nick', usage: '/nick [name]', description: t('chat.slashNickDesc') },
    { name: 'ping', usage: '/ping', description: t('chat.slashPingDesc') },
    { name: 'shrug', usage: '/shrug [message]', description: t('chat.slashShrugDesc') },
    { name: 'spoiler', usage: '/spoiler <text>', description: t('chat.slashSpoilerDesc') },
    { name: 'tableflip', usage: '/tableflip [message]', description: t('chat.slashTableflipDesc') },
    { name: 'thread', usage: '/thread <name>', description: t('chat.slashThreadDesc') },
    { name: 'topic', usage: '/topic [text]', description: t('chat.slashTopicDesc') },
    { name: 'unflip', usage: '/unflip [message]', description: t('chat.slashUnflipDesc') },
  ];
}
