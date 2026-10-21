/* auth.js — login / register gate. Shows the app only once /api/me returns a user.
 *
 * This screen is convenience, not security: the server rejects every unauthenticated
 * API call regardless of what the browser chooses to display.
 */
(function (global) {
  'use strict';

  const $ = s => document.querySelector(s);
  let onReady = null;
  let currentUser = null;
  let registerMode = 'invite';

  function show(el, on) { el.hidden = !on; }

  function setError(msg) {
    const box = $('#auth-error');
    box.textContent = msg || '';
    box.hidden = !msg;
  }

  // 送出中：鈕上的字隱藏、中間轉圈（.auth-submit.is-busy），不改文字，圖示才不會被 textContent 洗掉
  function busy(on) {
    const b = $('#auth-submit');
    b.disabled = on;
    b.classList.toggle('is-busy', !!on);
  }

  let mode = 'login';
  function setMode(m) {
    mode = m;
    setError('');
    $('#auth-title').textContent = m === 'login' ? '登入' : '建立帳號';
    const st = $('.auth-submit-text');
    if (st) st.textContent = m === 'login' ? '登入' : '建立帳號'; else $('#auth-submit').textContent = m === 'login' ? '登入' : '建立帳號';
    $('#auth-toggle').innerHTML = m === 'login' ? '還沒有帳號？<b>建立一個</b>' : '已經有帳號？<b>前往登入</b>';
    // The invite field only matters when registering on an invite-only site.
    show($('#auth-invite-row'), m === 'register' && registerMode === 'invite');
    // A closed site has nothing to offer behind 「建立帳號」.
    show($('#auth-toggle'), registerMode !== 'closed' || m === 'register');
    show($('#auth-hint'), m === 'register');
  }

  function openGate() {
    show($('#auth-screen'), true);
    show($('#app'), false);
    setTimeout(function () { $('#auth-username').focus(); }, 30);
  }

  function enterApp(user) {
    currentUser = user;
    show($('#auth-screen'), false);
    show($('#app'), true);
    const who = $('#current-user');
    if (who) who.textContent = user.username;
    // Admin-only controls. The server checks the role on every admin call too —
    // hiding the button is only tidiness, not the boundary.
    const adminBtn = $('#admin-btn');
    if (adminBtn) adminBtn.hidden = user.role !== 'admin';
    const storageBtn = $('#storage-btn');
    if (storageBtn) storageBtn.hidden = user.role !== 'admin';
    // 管理員一登入就主動檢查磁碟空間，太低會在頂端跳出警告（之後每半小時再看一次）
    if (user.role === 'admin' && global.Admin && Admin.checkStorage) Admin.checkStorage();

    // A generated password has been printed to a terminal log; make it be replaced
    // before the app is usable.
    if (user.mustChangePassword && global.Admin) {
      Admin.showChangePassword({
        forced: true,
        onDone: function () {
          currentUser.mustChangePassword = false;
          if (onReady) { const f = onReady; onReady = null; f(currentUser); }
        }
      });
      return;
    }
    if (onReady) { const f = onReady; onReady = null; f(user); }
  }

  function submit() {
    const u = $('#auth-username').value.trim();
    const p = $('#auth-password').value;
    const inv = $('#auth-invite').value.trim();
    if (!u || !p) { setError('請輸入帳號與密碼'); return; }
    busy(true);
    const call = mode === 'login' ? Store.login(u, p) : Store.register(u, p, inv);
    call.then(function (r) {
      busy(false);
      $('#auth-password').value = '';
      enterApp(r.user);
    }).catch(function (e) {
      busy(false);
      setError(e.message || '登入失敗');
      $('#auth-password').select();
    });
  }

  function logout() {
    Store.logout().catch(function () {}).then(function () {
      // Full reload so no other user's notes can linger in memory.
      location.reload();
    });
  }

  // Called by store.js when any request comes back 401.
  function onSessionLost() {
    if (!currentUser) return;
    currentUser = null;
    alert('登入已過期，請重新登入。');
    location.reload();
  }

  // Local, so this error path cannot itself depend on another module having loaded.
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Replaces the login form when the page is not being served by our backend.
  //
  // On a developer machine (localhost) the likely cause is a static file server
  // or a backend that was never started, so say so and show the command. On any
  // other host the page came through a real deployment (proxy, tunnel) and a
  // failed /api/me is almost always the backend restarting or an upstream error
  // page — the only sane offer is "check again". Never navigate anywhere: an
  // earlier version bounced to http://<host>:8080/, which behind HTTPS is a
  // protocol downgrade to a port that is not even open.
  function showBackendProblem(e) {
    const box = document.querySelector('.auth-box');
    const here = location.origin + '/';
    const wrong = !!e.wrongServer;
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    let msg, fix = '';
    if (local && wrong) {
      msg = '你正連到 <code>' + esc(here) + '</code>，它送得出網頁，但 ' +
        '<code>/api/me</code> 回應 <b>' + esc(e.status) + '</b>。<br><br>' +
        '這通常表示它是一個<b>只會發送檔案的靜態伺服器</b>' +
        '（例如 <code>python -m http.server</code>、IDE 的預覽功能），' +
        '不是本系統的後端——所以登入、筆記全都不會動。';
      fix = '<div class="backend-fix"><div class="backend-step"><b>啟動後端，改用它印出的網址</b>' +
        '<pre>cd report_system\nnode server/server.js</pre></div></div>';
    } else if (local) {
      msg = '<code>' + esc(here) + '</code> 沒有回應。後端可能沒有啟動。';
      fix = '<div class="backend-fix"><div class="backend-step"><b>啟動後端</b>' +
        '<pre>cd report_system\nnode server/server.js</pre></div></div>';
    } else {
      msg = '無法連線到伺服器' + (wrong ? '（<code>/api/me</code> 回應 <b>' + esc(e.status) + '</b>）' : '') +
        '。伺服器可能正在重新啟動或維護中，請稍後按「重新檢查」。';
    }
    // 品牌區在 .auth-box 外面（index.html .auth-wrap），這裡只換卡片的內容
    box.innerHTML =
      '<div class="auth-form">' +
        '<div class="auth-title">' + (wrong ? '後端沒有正確回應' : '伺服器沒有回應') + '</div>' +
        '<div class="backend-msg">' + msg + '</div>' + fix +
        '<button type="button" class="btn btn-primary auth-submit backend-retry">重新檢查</button>' +
      '</div>';
    box.querySelector('.backend-retry').addEventListener('click', function () { location.reload(); });
    show(document.querySelector('#auth-screen'), true);
    show(document.querySelector('#app'), false);
  }

  function init(cb) {
    onReady = cb;
    $('#auth-form').addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    $('#auth-toggle').addEventListener('click', function () { setMode(mode === 'login' ? 'register' : 'login'); });
    // 密碼顯示／隱藏
    const eye = $('#auth-eye');
    if (eye) eye.addEventListener('click', function () {
      const pw = $('#auth-password');
      const on = pw.type === 'password';
      pw.type = on ? 'text' : 'password';
      eye.classList.toggle('is-on', on);
      eye.setAttribute('aria-pressed', on ? 'true' : 'false');
      eye.title = on ? '隱藏密碼' : '顯示密碼';
      eye.setAttribute('aria-label', on ? '隱藏密碼' : '顯示密碼');
      pw.focus();
    });
    // 主題切換：app.js 的 applyTheme 還沒跑（它在登入後才初始化），這裡做同一件事、寫同一個鍵
    const themeBtn = $('#auth-theme');
    if (themeBtn) themeBtn.addEventListener('click', function () {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      const next = dark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('theme', next); } catch (e) { /* */ }
      const link = $('#hljs-theme-light');
      if (link) link.href = next === 'dark' ? 'vendor/hljs-github-dark.min.css' : 'vendor/hljs-github.min.css';
    });
    // 帳號選單：點名稱開合，點選項或點外面則關閉
    const userBtn = $('#user-btn');
    const dropdown = $('#user-dropdown');
    function closeMenu() {
      if (dropdown) dropdown.hidden = true;
      if (userBtn) userBtn.setAttribute('aria-expanded', 'false');
    }
    function toggleMenu() {
      if (!dropdown) return;
      const open = dropdown.hidden;
      dropdown.hidden = !open;
      if (userBtn) userBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (userBtn) userBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });
    if (dropdown) dropdown.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });

    const out = $('#logout-btn');
    if (out) out.addEventListener('click', function () { closeMenu(); logout(); });
    const adminBtn = $('#admin-btn');
    if (adminBtn) adminBtn.addEventListener('click', function () { closeMenu(); Admin.showPanel(); });
    const pwBtn = $('#passwd-btn');
    if (pwBtn) pwBtn.addEventListener('click', function () { closeMenu(); Admin.showChangePassword({}); });
    const storageBtn = $('#storage-btn');
    if (storageBtn) storageBtn.addEventListener('click', function () { closeMenu(); Admin.showStorage(); });
    const backupBtn = $('#backup-btn');
    if (backupBtn) backupBtn.addEventListener('click', function () {
      closeMenu();
      if (global.Backup) Backup.open({ isAdmin: !!(currentUser && currentUser.role === 'admin') });
    });
    // Android APP（android/ 的 WebView 殼）：window.capynoteAndroid 是它注入的原生橋接，
    // 有的話多一個「APP 設定」進原生的設定頁（改伺服器網址、清登入）；瀏覽器裡永遠看不到。
    const androidBtn = $('#android-settings-btn');
    if (androidBtn && global.capynoteAndroid && typeof global.capynoteAndroid.openSettings === 'function') {
      androidBtn.hidden = false;
      androidBtn.addEventListener('click', function () { closeMenu(); global.capynoteAndroid.openSettings(); });
    }

    Store.ready().then(function (r) {
      registerMode = r.registerMode || 'invite';
      setMode('login');
      if (r.user) enterApp(r.user);
      else openGate();
    }).catch(function (e) {
      showBackendProblem(e);
    });
  }

  global.Auth = {
    init: init,
    logout: logout,
    onSessionLost: onSessionLost,
    user: function () { return currentUser; }
  };
})(window);
