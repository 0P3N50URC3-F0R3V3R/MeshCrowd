const STRINGS = {
  en: { trying: 'Trying to reach server…', failed: 'Could not reach the server', retry: 'Retry', change: 'Change server' },
  hu: { trying: 'Kapcsolódás a szerverhez…', failed: 'A szerver nem érhető el', retry: 'Újrapróbálás', change: 'Szerver módosítása' },
};

const params = new URLSearchParams(location.search);
const lang = (navigator.language || 'en').slice(0, 2).toLowerCase();
const s = STRINGS[lang] || STRINGS.en;
const failed = params.get('failed') === '1';

document.body.classList.toggle('failed', failed);
document.getElementById('title').textContent = failed ? s.failed : s.trying;
document.getElementById('host').textContent = params.get('host') || '';
document.getElementById('retry').textContent = s.retry;
document.getElementById('change').textContent = s.change;

document.getElementById('retry').addEventListener('click', () => window.dismeshClient.retryConnect());
document.getElementById('change').addEventListener('click', () => window.dismeshClient.forgetServer());
