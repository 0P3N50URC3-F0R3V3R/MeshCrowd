(function () {
  var name = '';
  try { name = localStorage.getItem('mc_server_name') || ''; } catch (e) { /* storage blocked */ }
  name = name || location.host;
  var hu = (navigator.language || '').slice(0, 2).toLowerCase() === 'hu';
  document.getElementById('mc-boot-sub').textContent = hu ? name + ' betöltése…' : 'Loading ' + name + '…';
})();
