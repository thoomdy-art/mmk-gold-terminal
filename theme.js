/* Light / dark theme switch for MMK Gold Terminal.
   - Loaded in <head> (before paint) so the saved choice is applied with no flash.
   - Default = follow the visitor's system setting until they press the toggle.
   - The choice is saved in localStorage and shared by every page. */
(function () {
 try {
  var root = document.documentElement;
  var KEY = 'theme';

  function systemDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function saved() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch (e) { return null; }
  }
  function current() { return saved() || (systemDark() ? 'dark' : 'light'); }

  function paintMeta(mode) {
    var color = mode === 'dark' ? '#111110' : '#E5E1D8';
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      metas[i].setAttribute('content', color);
      metas[i].removeAttribute('media'); // an explicit choice overrides the system-based pair
    }
  }
  function apply(mode, persist) {
    root.setAttribute('data-theme', mode);
    root.classList.toggle('dark', mode === 'dark');
    if (persist) { try { localStorage.setItem(KEY, mode); } catch (e) {} }
    if (document.body) paintMeta(mode);
    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.setAttribute('aria-pressed', mode === 'dark' ? 'true' : 'false');
      btn.setAttribute('aria-label', mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.title = mode === 'dark' ? 'Light mode' : 'Dark mode';
    }
  }

  // Apply immediately (we are in <head>).
  apply(current(), false);

  window.toggleTheme = function () {
    apply(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', true);
  };

  // If the visitor never chose, keep following the system setting live.
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onSys = function () { if (!saved()) apply(systemDark() ? 'dark' : 'light', false); };
    if (mq.addEventListener) mq.addEventListener('change', onSys); else if (mq.addListener) mq.addListener(onSys);
  }


  // Toggle button styles live here too, so the button looks right even if premium.css is cached/old.
  function injectCss() {
    if (document.getElementById('theme-toggle-css')) return;
    var st = document.createElement('style');
    st.id = 'theme-toggle-css';
    st.textContent =
      'html body>header button.theme-toggle[class]{display:inline-grid;place-items:center;flex:0 0 auto;width:2.4rem;height:2.4rem;padding:0 !important;cursor:pointer;' +
      'background:var(--sf-elevated,#292925) !important;border:1px solid var(--bd-strong,#45433D) !important;border-radius:9999px !important;color:var(--gold-text,#F5C451) !important;box-shadow:none !important;transform:none !important}' +
      'html body>header button.theme-toggle[class] *{color:var(--gold-text,#F5C451) !important}' +
      'html body>header button.theme-toggle[class]:hover{background:rgba(245,196,81,.2) !important}' +
      '.theme-toggle svg{display:block}' +
      ':root[data-theme="dark"] .theme-toggle .ico-moon{display:none}' +
      ':root:not([data-theme="dark"]) .theme-toggle .ico-sun{display:none}';
    document.head.appendChild(st);
  }

  function inject() {
    try { injectCss(); } catch (e) {}
    paintMeta(root.getAttribute('data-theme'));
    if (document.getElementById('themeToggle')) return;
    var header = document.querySelector('body > header');
    if (!header) return;
    var btn = document.createElement('button');
    btn.id = 'themeToggle';
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.innerHTML =
      '<svg class="ico-sun" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
      '<svg class="ico-moon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    btn.addEventListener('click', window.toggleTheme);
    // Place it right before the language button (or at the end of the header's right-hand group).
    var lang = header.querySelector('button');
    if (lang && lang.parentNode) lang.parentNode.insertBefore(btn, lang);
    else {
      var group = header.querySelector('nav') ? header.querySelector('nav').parentNode : header;
      group.appendChild(btn);
    }
    apply(root.getAttribute('data-theme'), false); // sync aria/title
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', inject); else inject();
 } catch (e) { /* theme switch is optional; never break the page */ }
})();
