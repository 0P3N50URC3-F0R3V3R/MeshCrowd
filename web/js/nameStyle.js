import { escapeHtml } from './utils.js';

// Text effects a person can give their own name. Only shown where no server role color applies
// (see permissions.js memberNameFx) and in DMs and on profile cards.
export const NAME_EFFECTS = ['rainbow', 'gradient', 'glow', 'neon', 'pulse', 'shimmer', 'fire', 'wave'];

// The class and style attributes for a name element: `base` is the element's own class. `colors` (own
// color stops) and `speed` (seconds per cycle) tune the effect through CSS variables.
export function nameAttrs({ color, effect, colors, speed } = {}, base = '') {
  const fx = NAME_EFFECTS.includes(effect) ? effect : '';
  const cls = `${base}${fx ? ` name-fx name-fx-${fx}` : ''}`.trim();
  const stops = fx ? (colors || []).filter((c) => /^#[0-9a-f]{6}$/i.test(c)) : [];
  const vars = [];
  const main = color || stops[0] || '';
  if (main) vars.push(`color:${main}`, `--nc:${main}`);
  if (stops.length) vars.push(`--nfx-g:linear-gradient(90deg, ${[...stops, stops[0]].join(', ')})`);
  if (fx && Number(speed) > 0) vars.push(`--nfx-t:${Math.min(12, Math.max(0.5, Number(speed)))}s`);
  const style = vars.length ? ` style="${escapeHtml(vars.join(';'))}"` : '';
  return `${cls ? ` class="${cls}"` : ''}${style}`;
}

// A person's own look, as shown on their profile card.
export const personalFx = (user) => ({ color: user?.nameColor || null, effect: user?.nameEffect || '', colors: user?.nameFx?.colors || [], speed: user?.nameFx?.speed });
