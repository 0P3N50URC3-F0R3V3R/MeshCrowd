document.getElementById('connect-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('error');
  errorEl.textContent = '';
  const url = document.getElementById('url').value.trim();
  const result = await window.dismeshClient.setServer(url);
  if (!result.ok) {
    errorEl.textContent = result.error;
  }
});
