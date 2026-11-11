// Settings panel: opens from the footer button, closes on the X, on a tap
// outside it, or on Escape. The settings inside are wired up in app.js.
(() => {
  const panel = document.getElementById('settings-panel');
  const openBtn = document.getElementById('settings-btn');
  const closeBtn = document.getElementById('settings-close');
  if (!panel || !openBtn || !closeBtn) return;

  function setOpen(open) {
    panel.classList.toggle('hidden', !open);
    openBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) closeBtn.focus();
    else if (panel.contains(document.activeElement)) openBtn.focus();
  }

  openBtn.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
  closeBtn.addEventListener('click', () => setOpen(false));
  document.addEventListener('pointerdown', (e) => {
    if (!panel.classList.contains('hidden') && !panel.contains(e.target) && !openBtn.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) setOpen(false);
  });
})();
