/* MedSumAI shared behaviour: light/dark theme. Load in <head> (no defer) so the saved theme is applied before first paint.
   Every page uses the same storage key ('theme'), so a choice made on one page carries to all of them. */
(function () {
  var KEY = 'theme';
  var root = document.documentElement;

  function read() {
    try {
      // 'msai_theme' was the key Methodology used on its own; honour it once so nobody loses their choice.
      return localStorage.getItem(KEY) || localStorage.getItem('msai_theme');
    } catch (e) { return null; }
  }
  function write(value) {
    try { localStorage.setItem(KEY, value); } catch (e) {}
  }
  function paint() {
    var dark = root.getAttribute('data-theme') === 'dark';
    var buttons = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].textContent = dark ? '☀️' : '🌙';
      buttons[i].setAttribute('aria-pressed', dark ? 'true' : 'false');
    }
  }
  function toggleTheme() {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    if (next === 'dark') root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    write(next);
    paint();
  }

  if (read() === 'dark') root.setAttribute('data-theme', 'dark');
  window.toggleTheme = toggleTheme; // kept for any inline onclick="toggleTheme()"

  document.addEventListener('DOMContentLoaded', function () {
    var buttons = document.querySelectorAll('.theme-toggle');
    for (var i = 0; i < buttons.length; i++) {
      if (!buttons[i].hasAttribute('onclick')) buttons[i].addEventListener('click', toggleTheme);
    }
    paint();
  });
})();
