/* Site behaviour: theme switch and the hero before/after comparison.
   The studio itself lives in app.js. */
(() => {
  'use strict';
  const root = document.documentElement;
  const themeBtn = document.getElementById('themeBtn');
  const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>';
  const effectiveTheme = () => root.getAttribute('data-theme') || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  function paintThemeButton() {
    if (!themeBtn) return;
    const dark = effectiveTheme() === 'dark';
    themeBtn.innerHTML = dark ? SUN : MOON;
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    themeBtn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  }
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('lws-theme', next); } catch (e) { /* storage unavailable */ }
      paintThemeButton();
    });
    paintThemeButton();
  }

  const loupe = document.getElementById('loupe');
  const range = document.getElementById('loupeRange');
  if (loupe && range) {
    const set = v => loupe.style.setProperty('--p', v + '%');
    range.addEventListener('input', () => set(range.value));
    set(range.value);
  }
})();
