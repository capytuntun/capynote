// capynote Android：注入每個頁面的膠水（MainActivity 以 addDocumentStartJavaScript 注入，
// 不支援的 WebView 則在 onPageFinished 補注入；有 __capyAndroid 守門所以跑兩次也沒事）。
// 網站本身不需要知道這段的存在；它只需要 window.capynoteAndroid（Bridge.kt）。
//
// 1. 主題：盯著 <html data-theme> 的變化，通知原生端換狀態列顏色。
// 2. 下載：網站的匯出都是 <a download> + blob:/data: 網址（CSV、PNG、SVG、docx、電子書 HTML…），
//    WebView 的 DownloadListener 拿不到 blob: 的內容，所以在這裡把內容轉成 base64 交給原生端存檔。
//    不能 fetch(blob:)——網站的 CSP 是 connect-src 'self'，blob: 會被擋（模擬器上就是這樣失敗的）——
//    所以改攔 URL.createObjectURL，把 Blob 物件本身記住，點下載時直接用 FileReader 讀。
//    http(s) 的 <a download>（檔案管理的「下載」）交給 DownloadListener 串流，只先把檔名記起來。
// 3. 匯入整個資料夾：<input webkitdirectory> 在 Android 沒有選取器，攔下它的點擊改叫原生的
//    「選擇資料夾」（Bridge.pickFolder）；原生端走完整棵樹後呼叫 __capyFolderPicked，這裡把每個
//    檔案從同源假網址 /__capynote/pick/<token>/<序號> fetch 回來做成 File（補上 webkitRelativePath），
//    塞進那個 input 再發 change——網站的 importMarkdownFiles 完全不用知道這些。
(function () {
  if (window.__capyAndroid) return;
  window.__capyAndroid = 1;
  // 橋接物件在 document-start 時可能還沒掛上（第一版就是這樣提早 return，從此沒有任何監聽），
  // 所以每次用到才查，而不是一開始抓一次
  function B() { return window.capynoteAndroid || null; }

  // ---- 主題 ----
  function pushTheme() {
    try {
      var h = document.documentElement;
      var b = B(); if (h && b) b.setTheme(h.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    } catch (e) { /* bridge gone */ }
  }
  function arm() {
    var h = document.documentElement;
    if (!h) return;
    try {
      new MutationObserver(pushTheme).observe(h, { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) { /* */ }
    pushTheme();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arm);
  else arm();

  // ---- blob: 網址 → Blob 物件 ----
  var blobs = new Map();
  try {
    var origCreate = URL.createObjectURL, origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = function (o) {
      var u = origCreate.apply(URL, arguments);
      if (o instanceof Blob) {
        blobs.set(u, o);
        if (blobs.size > 40) blobs.delete(blobs.keys().next().value);   // 沒 revoke 的也不要無限留著
      }
      return u;
    };
    URL.revokeObjectURL = function (u) { blobs.delete(u); return origRevoke.apply(URL, arguments); };
  } catch (e) { /* */ }

  function dataUrlToBlob(href) {
    var m = /^data:([^;,]*)((?:;[^,]*)*),([\s\S]*)$/.exec(href);
    if (!m) return null;
    var type = m[1] || 'application/octet-stream';
    var payload = m[3];
    if (/;base64/i.test(m[2])) {
      var bin = atob(payload.replace(/\s/g, ''));
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: type });
    }
    var txt; try { txt = decodeURIComponent(payload); } catch (e) { txt = payload; }
    return new Blob([txt], { type: type });
  }

  function save(b, blob, name) {
    var fr = new FileReader();
    fr.onload = function () {
      var s = String(fr.result || '');
      b.saveBlob(name || 'download', blob.type || 'application/octet-stream', s.slice(s.indexOf(',') + 1));
    };
    fr.onerror = function () { b.toast('下載失敗'); };
    fr.readAsDataURL(blob);
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[download]');
    if (!a) return;
    var href = a.href || '';
    var name = a.getAttribute('download') || '';
    var b = B();
    if (!b) return;
    if (/^https?:/i.test(href)) {
      // DownloadListener 會接手；它只拿得到網址，所以先把檔名記起來
      try { b.expectDownload(href, name); } catch (e) { /* */ }
      return;
    }
    var blob = null;
    if (/^blob:/i.test(href)) blob = blobs.get(href) || null;
    else if (/^data:/i.test(href)) { try { blob = dataUrlToBlob(href); } catch (e) { blob = null; } }
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (blob) { save(b, blob, name); return; }
    // 不是這個頁面 createObjectURL 出來的（理論上不會）：最後才試 fetch，CSP 擋就只能說失敗
    fetch(href).then(function (r) { return r.blob(); }).then(function (bl) { save(b, bl, name); })
      .catch(function () { b.toast('下載失敗'); });
  }, true);

  // ---- 匯入整個資料夾 ----
  var dirInput = null;
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'INPUT' || t.type !== 'file' || !t.hasAttribute('webkitdirectory')) return;
    var b = B();
    if (!b || typeof b.pickFolder !== 'function') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    dirInput = t;
    try { b.pickFolder(); } catch (err) { dirInput = null; }
  }, true);

  window.__capyFolderPicked = function (info) {
    var input = dirInput; dirInput = null;
    var b = B();
    if (!info || !input || !b) return;
    var files = info.files || [];
    if (!files.length) { b.toast('這個資料夾裡沒有檔案'); return; }
    if (files.length > 20) b.toast('讀取 ' + files.length + ' 個檔案中…');
    var base = location.origin + '/__capynote/pick/' + info.token + '/';
    var out = new Array(files.length), failed = 0, next = 0;
    function one() {
      if (next >= files.length) return Promise.resolve();
      var f = files[next++];
      return fetch(base + f.i, { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(function (blob) {
          var file = new File([blob], f.name, { type: f.type || blob.type || '' });
          try { Object.defineProperty(file, 'webkitRelativePath', { value: f.path }); } catch (e) { /* */ }
          out[f.i] = file;
        })
        .catch(function () { failed++; })
        .then(one);
    }
    // 四條一起抓；順序由 out[f.i] 保證
    Promise.all([one(), one(), one(), one()]).then(function () {
      try { b.pickDone(info.token); } catch (e) { /* */ }
      var dt = new DataTransfer();
      out.forEach(function (f) { if (f) dt.items.add(f); });
      if (!dt.files.length) { b.toast('讀不到資料夾裡的檔案'); return; }
      var extra = (failed ? '，' + failed + ' 個讀取失敗' : '') + (info.skipped ? '，' + info.skipped + ' 個超過 200 MB 略過' : '');
      if (extra) b.toast('已讀取 ' + dt.files.length + ' 個檔案' + extra);
      try { input.files = dt.files; } catch (e) { b.toast('匯入失敗：' + e.message); return; }
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
})();
