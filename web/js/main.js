import { api } from './api.js';
import { setMe } from './state.js';
import { renderAuth } from './views/auth.js';
import { mountShell } from './views/shell.js';
import { initI18n, applyStaticI18n } from './i18n.js';
import './animatedImages.js';

const root = document.getElementById('app');

async function boot() {
  try {
    const { user } = await api.me();
    await initI18n(user);
    applyStaticI18n();
    setMe(user);
    await mountShell(root);
  } catch {
    await initI18n(null);
    applyStaticI18n();
    const user = await renderAuth(root);
    setMe(user);
    await mountShell(root);
  }
}

boot();
