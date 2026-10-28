// The viewport meta uses interactive-widget=resizes-content and the APK uses adjustResize, so the
// layout already shrinks when the keyboard opens. This adds (a) --kb / .kb-open for CSS that wants
// the keyboard height, and (b) scrolling a focused field into view after the keyboard animation.
export function installKeyboardSupport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const apply = () => {
    const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    root.style.setProperty('--kb', `${Math.round(kb)}px`);
    root.classList.toggle('kb-open', kb > 80);
  };
  vv?.addEventListener('resize', apply);
  vv?.addEventListener('scroll', apply);
  apply();
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.matches('input, textarea')) return;
    setTimeout(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
  });
}
