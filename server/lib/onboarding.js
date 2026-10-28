'use strict';

const { db } = require('../db');
const { PERMISSIONS } = require('./permissions');
const { singleLine } = require('./textSanitize');

const MAX_RULES_CHARS = 4000;
const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 10;

// A role that questions, reaction roles or similar self-service features may hand out must not carry
// any power over the server: those features are open to every member.
const POWER_BITS = PERMISSIONS.ADMINISTRATOR | PERMISSIONS.MANAGE_ROLES | PERMISSIONS.MANAGE_SERVER | PERMISSIONS.MANAGE_CHANNELS
  | PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.KICK_MEMBERS | PERMISSIONS.BAN_MEMBERS | PERMISSIONS.MODERATE_MEMBERS
  | PERMISSIONS.MANAGE_NICKNAMES | PERMISSIONS.VIEW_AUDIT_LOG | PERMISSIONS.PRUNE_CONTENT | PERMISSIONS.MANAGE_BOTS;

const isSelfAssignableRole = (role) => !!role && !role.is_default && (role.permissions & POWER_BITS) === 0;

class OnboardingError extends Error {
  constructor(status, message) { super(message); this.name = 'OnboardingError'; this.status = status; }
}

function loadQuestions(serverId) {
  return db.prepare('SELECT * FROM onboarding_questions WHERE server_id = ? ORDER BY position ASC, id ASC').all(serverId).map((q) => ({
    id: q.id,
    title: q.title,
    multi: !!q.multi,
    options: db.prepare('SELECT o.id, o.label, o.role_id, r.name AS role_name FROM onboarding_options o LEFT JOIN roles r ON r.id = o.role_id WHERE o.question_id = ? ORDER BY o.position ASC, o.id ASC').all(q.id)
      .map((o) => ({ id: o.id, label: o.label, roleId: o.role_id, roleName: o.role_name })),
  }));
}

function getConfig(serverId) {
  const server = db.prepare('SELECT screening_enabled, rules_text FROM servers WHERE id = ?').get(serverId);
  return { enabled: !!server?.screening_enabled, rules: server?.rules_text || '', questions: loadQuestions(serverId) };
}

// What a pending member sees: the rules, and the questions without the role wiring.
function publicConfig(serverId) {
  const c = getConfig(serverId);
  return { rules: c.rules, questions: c.questions.map((q) => ({ id: q.id, title: q.title, multi: q.multi, options: q.options.map((o) => ({ id: o.id, label: o.label })) })) };
}

function saveConfig(serverId, body) {
  const b = body || {};
  const rules = String(b.rules ?? '').replace(/\r\n/g, '\n').slice(0, MAX_RULES_CHARS + 1);
  if (rules.length > MAX_RULES_CHARS) throw new OnboardingError(400, `the rules can be at most ${MAX_RULES_CHARS} characters`);
  const enabled = !!b.enabled;
  if (enabled && !rules.trim()) throw new OnboardingError(400, 'write the rules before turning screening on');
  const questions = Array.isArray(b.questions) ? b.questions : [];
  if (questions.length > MAX_QUESTIONS) throw new OnboardingError(400, `at most ${MAX_QUESTIONS} questions`);

  const clean = questions.map((q) => {
    const title = singleLine(String(q?.title ?? ''), 100).trim();
    if (!title) throw new OnboardingError(400, 'every question needs a title');
    const options = (Array.isArray(q.options) ? q.options : []).map((o) => {
      const label = singleLine(String(o?.label ?? ''), 80).trim();
      if (!label) throw new OnboardingError(400, 'every option needs a label');
      let roleId = null;
      if (o.roleId !== null && o.roleId !== undefined && o.roleId !== '') {
        const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(Number(o.roleId), serverId);
        if (!role) throw new OnboardingError(400, 'an option points at a role that does not exist');
        if (!isSelfAssignableRole(role)) throw new OnboardingError(400, `the role ${role.name} has moderation or management powers and cannot be handed out by a question`);
        roleId = role.id;
      }
      return { label, roleId };
    });
    if (options.length < 1 || options.length > MAX_OPTIONS) throw new OnboardingError(400, `a question needs 1 to ${MAX_OPTIONS} options`);
    return { title, multi: q.multi ? 1 : 0, options };
  });

  db.exec('BEGIN');
  try {
    const wasEnabled = !!db.prepare('SELECT screening_enabled FROM servers WHERE id = ?').get(serverId)?.screening_enabled;
    db.prepare('UPDATE servers SET screening_enabled = ?, rules_text = ? WHERE id = ?').run(enabled ? 1 : 0, rules, serverId);
    // Turning screening on never locks out the people who are already here.
    if (enabled && !wasEnabled) db.prepare('UPDATE server_members SET screened_at = ? WHERE server_id = ? AND screened_at IS NULL').run(new Date().toISOString(), serverId);
    db.prepare('DELETE FROM onboarding_questions WHERE server_id = ?').run(serverId);
    clean.forEach((q, qi) => {
      const qid = Number(db.prepare('INSERT INTO onboarding_questions (server_id, title, multi, position) VALUES (?, ?, ?, ?)').run(serverId, q.title, q.multi, qi).lastInsertRowid);
      q.options.forEach((o, oi) => db.prepare('INSERT INTO onboarding_options (question_id, label, role_id, position) VALUES (?, ?, ?, ?)').run(qid, o.label, o.roleId, oi));
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getConfig(serverId);
}

// Marks the member as having accepted and hands out the roles their answers chose. Returns the role
// ids that were added. Roles are re-checked here, in case a role gained power after the question was saved.
function accept(serverId, userId, answers) {
  const questions = loadQuestions(serverId);
  const given = answers && typeof answers === 'object' ? answers : {};
  const roleIds = [];
  for (const q of questions) {
    const raw = given[q.id] ?? given[String(q.id)] ?? [];
    const picked = [...new Set((Array.isArray(raw) ? raw : [raw]).map(Number))];
    if (!q.multi && picked.length > 1) throw new OnboardingError(400, `pick only one answer for "${q.title}"`);
    for (const id of picked) {
      const option = q.options.find((o) => o.id === id);
      if (!option) throw new OnboardingError(400, 'an answer does not belong to its question');
      if (option.roleId) roleIds.push(option.roleId);
    }
  }
  const granted = [];
  for (const roleId of [...new Set(roleIds)]) {
    const role = db.prepare('SELECT * FROM roles WHERE id = ? AND server_id = ?').get(roleId, serverId);
    if (!isSelfAssignableRole(role)) continue;
    db.prepare('INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)').run(serverId, userId, roleId);
    granted.push(roleId);
  }
  db.prepare('UPDATE server_members SET screened_at = ? WHERE server_id = ? AND user_id = ? AND screened_at IS NULL').run(new Date().toISOString(), serverId, userId);
  return granted;
}

module.exports = { OnboardingError, getConfig, publicConfig, saveConfig, accept, isSelfAssignableRole, POWER_BITS, MAX_QUESTIONS, MAX_OPTIONS };
