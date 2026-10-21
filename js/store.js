/* store.js — persistence via the server API.
 *
 * This module used to talk to IndexedDB. It now talks to /api, but deliberately
 * keeps the same promise-based shape (getNotes / createNote / putImage / …) so
 * the rest of the front-end did not have to change.
 *
 * Nothing here decides who may see what — the server does, on every request.
 */
(function (global) {
  'use strict';

  function uid(prefix) {
    uid._c = (uid._c || 0) + 1;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + uid._c.toString(36);
  }

  // The custom header is what makes a cross-site form post fail our CSRF check.
  function headers(extra) {
    return Object.assign({ 'X-Requested-With': 'report-notes' }, extra || {});
  }

  // Image bytes fetched this session, keyed by id (see getImageBlob).
  const imgBlobCache = {};
  // Link preview answers, keyed by URL (see getLinkPreview).
  const linkPreviewCache = {};

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function req(method, path, body, opts, attempt) {
    const o = opts || {};
    const init = { method: method, headers: headers(o.headers), credentials: 'same-origin' };
    if (body !== undefined) {
      if (o.raw) init.body = body;
      else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    }
    return fetch(path, init).then(function (r) {
      // 503 means the database was momentarily locked. It is transient by
      // definition, so retry rather than making the user notice it — otherwise an
      // autosave could sit unsaved until the next keystroke.
      if (r.status === 503 && (attempt || 0) < 2) {
        return delay(600 * ((attempt || 0) + 1))
          .then(function () { return req(method, path, body, opts, (attempt || 0) + 1); });
      }
      if (r.status === 401) {
        // 登入／註冊本身的 401 是「帳號或密碼錯誤」，要照伺服器的話顯示，不是 session 過期
        if (path === '/api/login' || path === '/api/register') {
          return r.json().catch(function () { return {}; }).then(function (data) {
            const err = new Error(data.error || '帳號或密碼錯誤'); err.status = 401; err.data = data; throw err;
          });
        }
        // Session gone (expired, or logged out in another tab) — bounce to login
        // rather than let the UI silently fail on every keystroke.
        if (global.Auth && global.Auth.onSessionLost) global.Auth.onSessionLost();
        throw new Error('請重新登入');
      }
      if (o.blob) {
        if (!r.ok) throw new Error('讀取失敗 (' + r.status + ')');
        return r.blob();
      }
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          // status／data 給需要分辨錯誤種類的呼叫端用（uploadFile 靠 409 的 next 重新對齊）
          const err = new Error(data.error || ('請求失敗 (' + r.status + ')'));
          err.status = r.status; err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  // Notes arrive with a `perm` of owner | edit | read; the UI uses it to decide
  // whether to allow editing. The server enforces it regardless.
  const Store = {
    uid: uid,

    // Probe the backend before the app trusts it.
    //
    // A plain file server (python -m http.server, an IDE live-preview, nginx
    // serving the folder) will happily hand out index.html and then 404/501 every
    // /api call. That produced baffling "請求失敗 (501)" errors, so tell the
    // difference here and report which of the two is actually wrong.
    ready: function () {
      return fetch('/api/me', { headers: headers(), credentials: 'same-origin' })
        .then(function (r) {
          const ct = r.headers.get('content-type') || '';
          if (!r.ok || ct.indexOf('json') < 0) {
            const e = new Error('wrong-server');
            e.wrongServer = true;
            e.status = r.status;
            throw e;
          }
          return r.json().then(function (data) {
            if (!data || typeof data.registerMode !== 'string') {
              const e = new Error('wrong-server');
              e.wrongServer = true;
              e.status = r.status;
              throw e;
            }
            return data;
          });
        }, function () {
          const e = new Error('no-server');
          e.noServer = true;
          throw e;
        });
    },

    // Folders (private — never shared)
    getFolders: function () { return req('GET', '/api/folders').then(r => r.folders); },
    // area: undefined = 一般 (unchanged default), or 'course'/'knowledge'/'quick'/'novel'
    // (js/areas.js AREAS) — must match parentId's own area, checked server-side.
    createFolder: function (name, parentId, area) {
      const body = { name: name || '新資料夾', parentId: parentId || null };
      if (area) body.area = area;
      return req('POST', '/api/folders', body).then(r => r.folder);
    },
    updateFolder: function (folder) {
      const body = { name: folder.name, parentId: folder.parentId || null };
      if (folder.isBook !== undefined) body.isBook = !!folder.isBook;
      return req('PUT', '/api/folders/' + folder.id, body).then(r => r.folder);
    },
    deleteFolder: function (id) { return req('DELETE', '/api/folders/' + id); },

    // 檔案管理／雲端硬碟的資料夾（js/imagelib.js）：跟上面的筆記 folders 完全分開的一棵樹。
    getFileFolders: function () { return req('GET', '/api/file-folders').then(r => r.folders); },
    createFileFolder: function (name, parentId) {
      return req('POST', '/api/file-folders', { name: name || '新資料夾', parentId: parentId || null }).then(r => r.folder);
    },
    updateFileFolder: function (id, body) { return req('PUT', '/api/file-folders/' + id, body).then(r => r.folder); },
    deleteFileFolder: function (id) { return req('DELETE', '/api/file-folders/' + id); },
    // Manual order (js/sorting.js). `ids` is one whole level — the children of
    // `parentId` — in its new order; a listed row from elsewhere moves in.
    saveOrder: function (kind, parentId, ids) {
      const body = { parentId: parentId || null };
      body[kind === 'folder' ? 'folders' : 'notes'] = ids;
      return req('PUT', '/api/order', body);
    },

    // Notes
    getNotes: function () { return req('GET', '/api/notes').then(r => r.notes); },
    getNote: function (id) { return req('GET', '/api/notes/' + id).then(r => r.note); },
    // opts: { area, meta, content } — area must match folderId's own area (or be
    // top-level within that area with no folderId), checked server-side.
    createNote: function (title, folderId, opts) {
      const o = opts || {};
      const body = { title: title || '未命名筆記', folderId: folderId || null, content: o.content || '' };
      if (o.area) body.area = o.area;
      if (o.meta) body.meta = o.meta;
      return req('POST', '/api/notes', body).then(r => r.note);
    },
    updateNote: function (note) {
      return req('PUT', '/api/notes/' + note.id, {
        title: note.title, content: note.content, folderId: note.folderId || null, meta: note.meta,
        // For collaborative merge: the revision/content this client was last in
        // sync with. The server reconciles against these if someone else saved.
        baseRev: note.baseRev, baseContent: note.baseContent
      }).then(function (r) {
        note.updatedAt = r.note.updatedAt;
        note.rev = r.note.rev;
        return r.note;   // authoritative note (may hold merged content)
      });
    },
    // purge=true 直接硬刪、不進垃圾桶（影片庫）；平常是移到垃圾桶
    deleteNote: function (id, purge) { return req('DELETE', '/api/notes/' + id + (purge ? '?purge=1' : '')); },
    // 所有筆記／課程筆記／知識區 之間搬一篇筆記（js/app.js moveNoteToArea）；
    // area 是 null 或 'course'/'knowledge' ——novel／quick 不走這條，伺服器會拒絕。
    moveNoteArea: function (id, area, folderId) {
      return req('PUT', '/api/notes/' + id + '/area', { area: area || null, folderId: folderId || null })
        .then(function (r) { return r.note; });
    },

    // Trash. deleteNote above only moves a note into it; these are the way back
    // out (restore) or all the way out (purge). getTrash resolves to
    // { keepDays, notes: [{ id, title, folderId, chars, deletedAt, expiresAt }] }.
    getTrash: function () { return req('GET', '/api/trash'); },
    restoreNote: function (id) { return req('POST', '/api/notes/' + id + '/restore').then(r => r.note); },
    purgeNote: function (id) { return req('DELETE', '/api/trash/' + id); },
    emptyTrash: function () { return req('DELETE', '/api/trash'); },

    // 小說區（js/novel.js）：重新輸入目前帳號的密碼，通過後這個 session 一小時內
    // 都算已解鎖（server/api.js NOVEL_UNLOCK_TTL_MS）——之後 getNotes/getFolders
    // 才會把 area:'novel' 的項目也一起帶回來。密碼錯誤時 reject，訊息可直接顯示。
    unlockNovel: function (password) { return req('POST', '/api/novel/unlock', { password: password }); },

    // Version history. The list never carries note bodies — only sizes — so
    // opening the panel on a long note stays cheap.
    getVersions: function (noteId) { return req('GET', '/api/notes/' + noteId + '/versions'); },
    getVersion: function (noteId, versionId) {
      return req('GET', '/api/notes/' + noteId + '/versions/' + versionId);
    },
    createVersion: function (noteId, label) {
      return req('POST', '/api/notes/' + noteId + '/versions', { label: label || '' }).then(r => r.version);
    },
    renameVersion: function (noteId, versionId, label) {
      return req('PUT', '/api/notes/' + noteId + '/versions/' + versionId, { label: label || '' });
    },
    deleteVersion: function (noteId, versionId) {
      return req('DELETE', '/api/notes/' + noteId + '/versions/' + versionId);
    },
    restoreVersion: function (noteId, versionId) {
      return req('POST', '/api/notes/' + noteId + '/versions/' + versionId + '/restore', {})
        .then(r => r.note);
    },

    // E-book versions. `chapters` is the ordered list of note ids as js/book.js
    // computed it — the server pins each one but does not re-derive the order.
    getBookVersions: function (folderId) {
      return req('GET', '/api/books/' + folderId + '/versions').then(r => r.versions);
    },
    createBookVersion: function (folderId, title, label, chapterIds) {
      return req('POST', '/api/books/' + folderId + '/versions',
        { title: title, label: label || '', chapters: chapterIds }).then(r => r.version);
    },
    getBookVersion: function (versionId) {
      return req('GET', '/api/book-versions/' + versionId).then(r => r.version);
    },
    getBookVersionChapter: function (versionId, noteId) {
      return req('GET', '/api/book-versions/' + versionId + '/chapters/' + noteId).then(r => r.chapter);
    },
    restoreBookVersion: function (versionId) {
      return req('POST', '/api/book-versions/' + versionId + '/restore', {});
    },
    deleteBookVersion: function (versionId) {
      return req('DELETE', '/api/book-versions/' + versionId);
    },

    // Public e-book links. `html` is the packed, self-contained book; the server
    // stores it verbatim and serves that exact file at /s/<token>, so a link
    // never exposes an API or anything outside the book it was made from.
    getBookLinks: function (folderId) {
      return req('GET', '/api/books/' + folderId + '/links').then(r => r.links);
    },
    createBookLink: function (folderId, payload) {
      return req('POST', '/api/books/' + folderId + '/links', payload).then(r => r.link);
    },
    updateBookLink: function (token, payload) {
      return req('PUT', '/api/book-links/' + token, payload).then(r => r.link);
    },
    deleteBookLink: function (token) { return req('DELETE', '/api/book-links/' + token); },
    // 單篇筆記的公開連結（沒有帳號也能看）：同一套規則，見 server/api.js 的 listNoteLinks
    getNoteLinks: function (noteId) { return req('GET', '/api/notes/' + noteId + '/links').then(r => r.links || []); },
    createNoteLink: function (noteId, payload) { return req('POST', '/api/notes/' + noteId + '/links', payload).then(r => r.link); },
    updateNoteLink: function (token, payload) { return req('PUT', '/api/note-links/' + token, payload).then(r => r.link); },
    deleteNoteLink: function (token) { return req('DELETE', '/api/note-links/' + token); },

    // Sharing
    getShares: function (noteId) { return req('GET', '/api/notes/' + noteId + '/shares').then(r => r.shares); },
    addShare: function (noteId, username, perm) {
      return req('POST', '/api/notes/' + noteId + '/shares', { username: username, perm: perm });
    },
    removeShare: function (noteId, username) {
      return req('DELETE', '/api/notes/' + noteId + '/shares/' + encodeURIComponent(username));
    },
    // General access (owner only): 'restricted' | 'site', with 'read' | 'edit' for site
    setAccess: function (noteId, mode, perm) {
      return req('PUT', '/api/notes/' + noteId + '/access', { mode: mode, perm: perm });
    },

    // Live collaboration: subscribe to a note's Server-Sent-Events stream.
    // handlers = { onUpdate(payload), onPresence(users), onCursor(payload) }.
    openNoteStream: function (noteId, handlers) {
      if (typeof EventSource === 'undefined') return function () {};
      const es = new EventSource('/api/notes/' + noteId + '/events');
      es.addEventListener('update', function (e) {
        try { handlers.onUpdate && handlers.onUpdate(JSON.parse(e.data)); } catch (x) {}
      });
      es.addEventListener('presence', function (e) {
        try { handlers.onPresence && handlers.onPresence(JSON.parse(e.data).users || []); } catch (x) {}
      });
      es.addEventListener('cursor', function (e) {
        try { handlers.onCursor && handlers.onCursor(JSON.parse(e.data)); } catch (x) {}
      });
      return function close() { try { es.close(); } catch (x) {} };
    },
    // Report my caret position to the note's other editors (fire-and-forget).
    sendCursor: function (noteId, pos, end) {
      return req('POST', '/api/notes/' + noteId + '/cursor', { pos: pos, end: end });
    },

    // Uploads — images, PDFs and any other file. `name` travels percent-encoded
    // in X-File-Name (a header cannot hold CJK); `type` overrides a missing or
    // wrong blob.type (a .pdf the OS did not label). `folderId` (optional) is a
    // 檔案管理 folder id — ASCII, so unlike the name it goes straight in a header
    // (X-Folder-Id) with no encoding. Every existing caller (paste/drop/toolbar/
    // course-file upload) omits it and lands at 雲端硬碟's root, unchanged.
    putImage: function (blob, name, type, folderId) {
      const h = { 'Content-Type': type || blob.type || 'application/octet-stream' };
      const n = name != null ? name : blob.name;
      if (n) h['X-File-Name'] = encodeURIComponent(String(n));
      if (folderId) h['X-Folder-Id'] = folderId;
      return req('POST', '/api/images', blob, { raw: true, headers: h }).then(r => r.id);
    },
    // Any file, any size (up to the server's UPLOAD_MAX_BYTES). A file that fits one
    // request goes through putImage unchanged; anything bigger — a course video, a heavy
    // deck — is cut into the chunk size the server names and PUT in order. A chunk that
    // fails is retried a few times (the server recognises a repeat by its sequence number,
    // so a retry can never append twice). onProgress(sentBytes, totalBytes). Resolves to
    // the file id, the same id putImage would give.
    uploadFile: function (file, onProgress, type, folderId) {
      const mime = type || file.type || 'application/octet-stream';
      const progress = function (n) { if (onProgress) onProgress(n, file.size); };
      if (file.size <= 20 * 1024 * 1024) {
        progress(0);
        // 這台伺服器的 MAX_BODY_BYTES 可能調得比 20 MB 小：改走分塊，區塊大小由伺服器決定。
        // 不能只認 413——伺服器一拒收就關連線，瀏覽器還在送 body，看到的是沒有 status 的
        // 「Failed to fetch」。真的斷網的話，分塊的第一個請求一樣會失敗，錯誤照常浮上來。
        return this.putImage(file, file.name, mime, folderId).then(function (id) { progress(file.size); return id; },
          function (e) { if (e && (e.status === 413 || !e.status)) return chunked(); throw e; });
      }
      return chunked();
      function chunked() { return req('POST', '/api/uploads', { name: file.name, mime: mime, size: file.size, folderId: folderId || null }).then(function (up) {
        let seq = 0;
        function putChunk(tries) {
          const start = seq * up.chunkSize;
          const piece = file.slice(start, Math.min(file.size, start + up.chunkSize));
          return req('PUT', '/api/uploads/' + up.id + '/' + seq, piece, { raw: true, headers: { 'Content-Type': 'application/octet-stream' } })
            .catch(function (e) {
              // 409：伺服器手上的進度跟我們以為的不一樣（上一塊其實有收到），照它說的接下去
              if (e && e.status === 409 && e.data && typeof e.data.next === 'number') return { next: e.data.next };
              // 其他 4xx 是真的錯（太大、格式不對）；沒有 status 的是網路斷掉，重試幾次
              if (tries >= 3 || (e && e.status && e.status < 500)) throw e;
              return new Promise(function (r) { setTimeout(r, 1200 * (tries + 1)); }).then(function () { return putChunk(tries + 1); });
            });
        }
        function next() {
          if (seq >= up.chunks) return req('POST', '/api/uploads/' + up.id + '/finish', {}).then(function () { return up.id; });
          return putChunk(0).then(function (r) {
            // the server says which chunk it wants next — after a 409 that is how we resync
            seq = (r && typeof r.next === 'number') ? r.next : seq + 1;
            progress(Math.min(file.size, seq * up.chunkSize));
            return next();
          });
        }
        progress(0);
        return next();
      }); }
    },
    // Title / description / image for a {%preview url %} card, fetched once per
    // URL for the session. Never rejects: a site that cannot be read resolves to
    // { error }, and the card just keeps showing the address.
    // 硬刪一部影片後把它的預覽答案從這一頁的快取拿掉（伺服器那邊 api.deleteNote 也會忘掉）
    forgetLinkPreview: function (url) { delete linkPreviewCache[url]; },
    // 用名字找人（影片庫）：{ name, image, aliases } 或 { error }；伺服器與這裡都不留快取
    // 美食地圖（js/foodmap.js）：地址 → 座標（伺服器固定問 OSM 的 Nominatim）；{ results: [...], approx } 或 { error }，不丟例外
    geocode: function (q) { return req('GET', '/api/geocode?q=' + encodeURIComponent(q)).catch(function (e) { return { error: e && e.message || 'error' }; }); },
    // 座標 → 地址：{ address, displayName, name, lat, lng } 或 { error }
    reverseGeocode: function (lat, lng) { return req('GET', '/api/geocode?lat=' + encodeURIComponent(lat) + '&lng=' + encodeURIComponent(lng)).catch(function (e) { return { error: e && e.message || 'error' }; }); },
    lookupPerson: function (name) { return req('GET', '/api/link-preview/person?name=' + encodeURIComponent(name)); },
    // 影片庫：把外部圖片存進系統（hidden 的上傳，檔案管理不列），回 { id }
    storeLinkImage: function (url) { return req('POST', '/api/link-preview/store', { url: url }); },
    // 同上，但把瀏覽器縮小過的圖片位元組直接送上去
    storeLinkImageBytes: function (blob) { return req('POST', '/api/link-preview/store-image', blob, { raw: true, headers: { 'Content-Type': blob.type || 'image/webp' } }); },
    // noCache=true（影片庫）：不碰這一頁的快取，伺服器那邊也不讀不寫（?nocache=1，回 no-store）
    getLinkPreview: function (url, noCache) {
      if (noCache) return req('GET', '/api/link-preview?url=' + encodeURIComponent(url) + '&nocache=1');
      if (!linkPreviewCache[url]) {
        linkPreviewCache[url] = req('GET', '/api/link-preview?url=' + encodeURIComponent(url))
          .then(function (info) {
            // 失敗的答案不留在這一頁的快取裡：使用者按「抓預覽」重試才會真的再問一次伺服器
            // （伺服器那邊自己有 10 分鐘的失敗快取）
            if (info && info.error) delete linkPreviewCache[url];
            return info;
          }, function (e) { delete linkPreviewCache[url]; return { error: e && e.message || 'error' }; });
      }
      return linkPreviewCache[url];
    },
    // Image bytes, cached by id for this session. The on-screen preview
    // (MD.resolveImages) and the PDF export (MD.inlineImagesAsDataURL) both go
    // through here, so a note's screenshots are fetched from the server once and
    // then reused — the PDF no longer re-downloads every image the preview
    // already has, which is what made exporting an image-heavy report crawl.
    //
    // The cache holds the in-flight PROMISE, not just the settled blob, so a
    // burst of calls for the SAME id — a report reusing one small icon several
    // times, `resolveImages` walks every `<img>` synchronously before any of
    // them can resolve — share the one request instead of each firing its own.
    // A rejected request is not left cached (the next call gets a fresh try);
    // deleting only when the promise that's failing is still the current entry
    // avoids a slow-to-fail request clobbering a newer one already in flight.
    // Cleared by invalidateImage after an annotation rewrites an image.
    getImageBlob: function (id) {
      if (imgBlobCache[id]) return imgBlobCache[id];
      const p = req('GET', '/api/images/' + id, undefined, { blob: true })
        .catch(function () {
          if (imgBlobCache[id] === p) delete imgBlobCache[id];
          return null;
        });
      imgBlobCache[id] = p;
      return p;
    },
    invalidateImage: function (id) { delete imgBlobCache[id]; },
    // Blob + annotation metadata (shapes / canAnnotate / mime). Only the
    // annotation editor needs the metadata; rendering and PDF want the bytes
    // only and call getImageBlob, so the /meta request is not on the hot path.
    getImage: function (id) {
      return Promise.all([
        Store.getImageBlob(id),
        req('GET', '/api/images/' + id + '/meta').catch(function () { return {}; })
      ]).then(function (res) {
        if (!res[0]) return null;
        return { id: id, blob: res[0], type: res[1].mime, shapes: res[1].shapes, canAnnotate: res[1].canAnnotate };
      }).catch(function () { return null; });
    },
    // Kept separate so rendering a note does not drag the pre-annotation copy
    // of every screenshot over the wire.
    getImageOriginal: function (id) {
      return req('GET', '/api/images/' + id + '/original', undefined, { blob: true });
    },
    saveImage: function (rec) {
      return blobToBase64(rec.blob).then(function (data) {
        const payload = { data: data, mime: rec.type || 'image/png', shapes: rec.shapes || [] };
        if (rec.original) {
          return blobToBase64(rec.original).then(function (orig) {
            payload.original = orig;
            return req('PUT', '/api/images/' + rec.id, payload);
          });
        }
        return req('PUT', '/api/images/' + rec.id, payload);
      });
    },
    deleteImage: function (id) { return req('DELETE', '/api/images/' + id); },
    // 檔案管理：重新命名／搬移到資料夾，只動中繼資料（不像 saveImage 要整包位元組）。
    // body 可以只給 { name } 或只給 { folderId }，或兩個一起。
    updateFile: function (id, body) { return req('PUT', '/api/images/' + id + '/file', body); },
    // Image library: every upload of mine (no bytes) with the notes that embed it.
    listImages: function () { return req('GET', '/api/images'); },
    // drawio 的圖示庫（js/drawio.js 左邊的「我的圖示」）：只有自己的。
    // removeIcon 回 { kept }：那個圖示還有圖在用的話檔案會留著，只是從庫裡拿掉。
    listIcons: function () { return req('GET', '/api/icons').then(function (r) { return r.icons || []; }); },
    putIcon: function (file) {
      const h = { 'Content-Type': file.type || 'application/octet-stream' };
      if (file.name) h['X-File-Name'] = encodeURIComponent(String(file.name));
      return req('POST', '/api/icons', file, { raw: true, headers: h }).then(function (r) { return r.icon; });
    },
    removeIcon: function (id) { return req('DELETE', '/api/icons/' + id); },

    // Auth
    login: function (username, password) {
      return req('POST', '/api/login', { username: username, password: password });
    },
    changePassword: function (current, next) {
      return req('POST', '/api/change-password', { current: current, next: next });
    },

    // Admin (the server rejects these for non-admins regardless of the UI)
    adminListUsers: function () { return req('GET', '/api/admin/users').then(r => r.users); },
    adminSetDisabled: function (id, disabled) {
      return req('POST', '/api/admin/users/' + id + '/disabled', { disabled: !!disabled });
    },
    adminSetRole: function (id, role) {
      return req('POST', '/api/admin/users/' + id + '/role', { role: role });
    },
    adminDeleteUser: function (id) { return req('DELETE', '/api/admin/users/' + id); },
    adminStorage: function () { return req('GET', '/api/admin/storage'); },
    adminSystem: function () { return req('GET', '/api/admin/system'); },
    // Backup and restore (js/backup.js). The zip is downloaded by navigating a
    // hidden frame to backupUrl; a restore is uploaded in chunks, inspected, then
    // run as a server-side job that is polled.
    backupUrl: function (scope) { return '/api/backup?scope=' + (scope === 'site' ? 'site' : 'mine'); },
    backupCreateUpload: function () { return req('POST', '/api/backup/upload', {}); },
    backupAppend: function (id, offset, blob) {
      return req('PUT', '/api/backup/upload/' + id + '?offset=' + offset, blob,
        { raw: true, headers: { 'Content-Type': 'application/octet-stream' } });
    },
    backupUploadStatus: function (id) { return req('GET', '/api/backup/upload/' + id); },
    backupDrop: function (id) { return req('DELETE', '/api/backup/upload/' + id); },
    backupInspect: function (id) { return req('POST', '/api/backup/upload/' + id + '/inspect', {}); },
    backupRestore: function (id, opts) { return req('POST', '/api/backup/upload/' + id + '/restore', opts || {}); },
    backupJob: function (jobId) { return req('GET', '/api/backup/jobs/' + jobId); },
    // Registration mode ('open' | 'invite' | 'closed') and the invite code.
    // patch: { registerMode?, inviteCode?, regenerateInvite? }
    adminGetSettings: function () { return req('GET', '/api/admin/settings'); },
    adminSaveSettings: function (patch) { return req('PUT', '/api/admin/settings', patch); },
    register: function (username, password, invite) {
      return req('POST', '/api/register', { username: username, password: password, invite: invite });
    },
    logout: function () { return req('POST', '/api/logout', {}); }
  };

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1]); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  global.Store = Store;
})(window);
