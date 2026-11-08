/*
 * Theme boot — classic script, loaded before the stylesheet.
 *
 * It runs before first paint so the window never shows one theme and then
 * flips to another, and so a light theme never flashes the dark canvas. It
 * reads localStorage directly (synchronous, available pre-paint) and sets
 * `data-theme` plus `color-scheme` on <html>. The preference file in userData
 * is only a launch cache for the native window colour, not the source of truth.
 *
 * No fetch, no XHR, no URLs: the whole file must stay usable offline.
 */
(function () {
  var STORAGE_KEY = 'ncs.theme';
  var THEMES = ['current', 'graphite', 'paper'];
  var DARK = { current: true, graphite: true, paper: false };
  var stored = 'current';
  try {
    var raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && THEMES.indexOf(raw) !== -1) stored = raw;
    else if (raw === 'system') stored = 'system';
  } catch (error) {
    stored = 'current';
  }
  var prefersLight = false;
  try {
    prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch (error) {
    prefersLight = false;
  }
  var resolved = stored === 'system' ? (prefersLight ? 'paper' : 'graphite') : stored;
  if (THEMES.indexOf(resolved) === -1) resolved = 'current';
  var root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  root.setAttribute('data-theme-mode', stored);
  root.style.colorScheme = DARK[resolved] ? 'dark' : 'light';
})();
