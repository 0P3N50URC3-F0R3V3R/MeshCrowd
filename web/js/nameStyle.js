import { escapeHtml } from './utils.js';

// Text effects a person can give their own name. Only shown where no server role color applies
// (see permissions.js memberNameFx) and in DMs and on profile cards.
export const NAME_EFFECTS = ['rainbow', 'gradient', 'glow', 'neon', 'pulse', 'shimmer', 'fire', 'wave'];

// The class and style attributes for a name element: `base` is the element's own class.
export function nameAttrs({ color, effect } = {}, base = '') {
  const fx = NAME_EFFECTS.includes(effect) ? effect : '';
  const cls = `${base}${fx ? ` name-fx name-fx-${fx}` : ''}`.trim();
  const style = color ? ` style="color:${escapeHtml(color)};--nc:${escapeHtml(color)}"` : '';
  return `${cls ? ` class="${cls}"` : ''}${style}`;
}

// A person's own look, as shown on their profile card.
export const personalFx = (user) => ({ color: user?.nameColor || null, effect: user?.nameEffect || '' });
