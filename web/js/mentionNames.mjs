// Names that count as a real @mention in a scope: usernames, single-word role names (the server
// cannot delimit multi-word ones), and everyone/here in server scopes. Lowercase.
const cache = new WeakMap();

export function mentionNamesFor({ detail, dmMembers } = {}) {
  if (dmMembers) return new Set(dmMembers.map((u) => String(u.username || '').toLowerCase()).filter(Boolean));
  if (!detail) return undefined;
  const members = detail.members || [];
  const roles = detail.roles || [];
  const hit = cache.get(detail);
  if (hit && hit.members === members && hit.roles === roles && hit.m === members.length && hit.r === roles.length) return hit.set;
  const set = new Set(['everyone', 'here']);
  for (const r of roles) if (r.name && !/\s/.test(r.name)) set.add(r.name.toLowerCase());
  for (const m of members) if (m.user?.username) set.add(m.user.username.toLowerCase());
  cache.set(detail, { members, roles, m: members.length, r: roles.length, set });
  return set;
}
