// The user's notification grid, as the server sent it on state.me.notifyGrid (status -> event ->
// surface -> boolean). Anything missing counts as allowed: a gap must never silence a user.
export function gridAllows(me, event, surface) {
  const cell = me && me.notifyGrid && me.notifyGrid[me.status || 'online'] && me.notifyGrid[me.status || 'online'][event];
  return !cell || cell[surface] !== false;
}
