/* backup.js — one-click backup to a zip, and restore from one.
 *
 * The zip is readable without the app: every note is a .md file placed by its
 * folder path (notes/<資料夾>/<標題>.md), uploads sit in files/ under their own
 * extension, and JSON indexes (folders.json, notes.json, files.json, books.json)
 * carry everything the .md cannot — ids, timestamps, meta, access, shares,
 * version history, positions. Restore reads only the indexes and the paths they
 * name, so anything else in the archive (a __MACOSX folder, a re-zipped parent
 * directory) is ignored.
 *
 * Two scopes. `mine` is what the caller owns: folders, notes (trashed ones too),
 * uploads, versions, shares given, book versions and share links. `site` (admins)
 * is every account's data plus users.json (with the scrypt hashes, so passwords
 * survive a move to a new machine) and settings.json. Notes shared *to* the caller
 * are the other owner's and are not in a `mine` backup.
 *
 * Restore keeps ids, so it is idempotent and safe by default: what is missing is
 * recreated, what already exists is left alone. With `overwrite`, a note that
 * exists and is the caller's is replaced by the backup copy — after snapshotting
 * the current text as a version (label 還原備份前), the same way restoring a
 * version does. A row whose id exists under another owner is a conflict and is
 * skipped, never taken over. A `mine` backup restores into the caller's account
 * whatever usernames it was made under; a `site` backup maps owners by username,
 * creates the accounts that are missing (with their old password hashes) and
 * keeps the ones that exist — including the admin doing the restore, whose
 * current password therefore stays valid.
 *
 * Uploads arrive in chunks (js/backup.js slices the file) into a temp file, then
 * the restore runs as a background job the client polls: behind a tunnel a
 * single request may neither exceed ~100 MB nor stay open for minutes. One
 * restore runs at a time.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { once } = require('node:events');
const dbmod = require('./db');
const { q, tx } = dbmod;
const config = require('./config');
const hub = require('./hub');
const settings = require('./settings');
const { normalizeArea } = require('./api');
const { ZipWriter, ZipReader } = require('./zip');

const FORMAT = 'capynote-backup';
const LEGACY_FORMATS = ['strikenote-backup']; // 改名前做的備份還是要能還原
const FORMAT_VERSION = 1;
// One entry at most: a note, a packed book or an upload — all bounded by
// MariaDB's max_allowed_packet in practice.
const ENTRY_MAX = 64 * 1024 * 1024;
// Chunk size for a big file going back into image_chunks (same as api.js UPLOAD_CHUNK).
const RESTORE_CHUNK = 8 * 1024 * 1024;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const JOB_TTL_MS = 60 * 60 * 1000;
const LABEL_RESTORE = '還原備份前';
const VALID_ROLES = { admin: 1, user: 1 };

// ---------------- helpers ----------------
function safeName(s, fallback) {
  const t = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
    .slice(0, 100);
  return t || fallback;
}

function extFor(mime, name) {
  const m = String(mime || '').toLowerCase();
  const byMime = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp', 'application/pdf': 'pdf'
  };
  if (byMime[m]) return byMime[m];
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  return fromName ? fromName[1].toLowerCase() : 'bin';
}

function stamp(ms) {
  const d = new Date(ms);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

function parseJson(s, dflt) {
  if (s == null || s === '') return dflt;
  try { return JSON.parse(s); } catch (e) { return dflt; }
}

// ---------------- export ----------------
async function exportZip(user, scope, req, res) {
  const site = scope === 'site';
  const now = Date.now();
  const filename = 'capynote-backup-' + (site ? 'site' : 'mine') + '-' + stamp(now) + '.zip';

  const users = site ? await q.usersAll.all() : [{ id: user.id, username: user.username }];
  const nameOf = new Map(users.map(u => [u.id, u.username]));
  const folders = site ? await q.foldersAll.all() : await q.foldersOf.all(user.id);
  const noteIds = (site ? await q.noteIdsAll.all() : await q.noteIdsOf.all(user.id)).map(r => r.id);
  const imageIds = (site ? await q.imageIdsAll.all() : await q.imageIdsOf.all(user.id)).map(r => r.id);
  const bookVersions = site ? await q.bookVersionsAll.all() : await q.bookVersionsOf.all(user.id);
  const links = site ? await q.linksAll.all() : await q.linksOf.all(user.id);
  const noteLinks = site ? await q.noteLinksAll.all() : await q.noteLinksOf.all(user.id);

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  const closed = new Promise(function (resolve) { res.on('close', resolve); });
  const zip = new ZipWriter(async function (buf) {
    if (res.destroyed) throw new Error('client gone');
    if (!res.write(buf)) await Promise.race([once(res, 'drain'), closed]);
  });
  const addText = (name, text) => zip.add(name, Buffer.from(String(text), 'utf8'), { mtime: now });
  const addJson = (name, obj) => addText(name, JSON.stringify(obj, null, 2));

  await addJson('manifest.json', {
    format: FORMAT, version: FORMAT_VERSION, scope: scope,
    exportedAt: now, exportedBy: user.username,
    counts: { users: site ? users.length : 1, folders: folders.length, notes: noteIds.length, files: imageIds.length,
      bookVersions: bookVersions.length, bookLinks: links.length, noteLinks: noteLinks.length }
  });
  await addText('README.txt',
    'capynote 備份（' + (site ? '整個站台' : user.username + ' 的資料') + '，' + new Date(now).toLocaleString('zh-TW') + '）\n\n' +
    'notes/     每篇筆記一個 .md，照資料夾放；垃圾桶裡的在 _垃圾桶/ 底下' + (site ? '，最外層是使用者名稱' : '') + '\n' +
    'files/     上傳過的圖片、PDF 與其他檔案（檔名是它在筆記裡的 id）\n' +
    'versions/  每篇筆記的版本歷史，一個版本一個 .md\n' +
    'books/     電子書公開分享連結的打包 HTML\n' +
    '*.json     還原時用的索引：id、時間、資料夾、分享、位置等 .md 裡沒有的東西\n\n' +
    '還原：登入 capynote → 右上角帳號選單 → 備份與還原 → 上傳這個 zip。\n' +
    '缺的會補回來、已經有的預設不動；勾「覆蓋」才會用備份裡的內容取代現有筆記（覆蓋前會先留一份版本）。\n');

  // Folder paths per id, for the readable layout.
  const folderById = new Map(folders.map(f => [f.id, f]));
  const pathCache = new Map();
  function folderPath(id) {
    if (!id) return [];
    if (pathCache.has(id)) return pathCache.get(id);
    const parts = [];
    const seen = new Set();
    for (let cur = id; cur && !seen.has(cur); ) {
      seen.add(cur);
      const f = folderById.get(cur);
      if (!f) break;
      parts.unshift(safeName(f.name, '未命名資料夾'));
      cur = f.parent_id;
    }
    pathCache.set(id, parts);
    return parts;
  }
  const used = new Set();
  function uniquePath(dir, base, ext) {
    let p = dir + base + ext;
    for (let i = 2; used.has(p); i++) p = dir + base + ' (' + i + ')' + ext;
    used.add(p);
    return p;
  }

  await addJson('folders.json', folders.map(f => ({
    id: f.id, owner: nameOf.get(f.owner_id) || null, name: f.name, parentId: f.parent_id || null,
    createdAt: Number(f.created_at), isBook: !!f.is_book, position: f.position == null ? null : Number(f.position),
    area: f.area || null
  })));

  const notesIndex = [];
  for (const id of noteIds) {
    if (res.destroyed) return;
    const n = await q.noteById.get(id);
    if (!n) continue;
    const owner = nameOf.get(n.owner_id) || null;
    const dir = 'notes/' + (site ? safeName(owner, 'user_' + n.owner_id) + '/' : '') +
      (n.deleted_at ? '_垃圾桶/' : '') + folderPath(n.folder_id).map(s => s + '/').join('');
    const file = uniquePath(dir, safeName(n.title, '未命名筆記'), '.md');
    await addText(file, n.content || '');
    const versions = [];
    for (const v of await q.versionsOfNote.all(id)) {
      const vfile = 'versions/' + id + '/' + v.id + '.md';
      await addText(vfile, v.content || '');
      versions.push({
        id: v.id, rev: Number(v.rev), title: v.title, author: v.author || '', label: v.label || null,
        createdAt: Number(v.created_at), meta: parseJson(v.meta, null), file: vfile
      });
    }
    const shares = (await q.sharesOfNote.all(id)).map(s => ({ username: s.username, perm: s.perm, createdAt: Number(s.created_at) }));
    notesIndex.push({
      id: id, owner: owner, folderId: n.folder_id || null, title: n.title, file: file,
      meta: parseJson(n.meta, null), createdAt: Number(n.created_at), updatedAt: Number(n.updated_at),
      rev: Number(n.rev || 0), access: n.access || 'restricted', accessPerm: n.access_perm || 'read',
      position: n.position == null ? null : Number(n.position), deletedAt: n.deleted_at ? Number(n.deleted_at) : null,
      area: n.area || null, shares: shares, versions: versions
    });
  }
  await addJson('notes.json', notesIndex);

  const filesIndex = [];
  for (const id of imageIds) {
    if (res.destroyed) return;
    const img = await q.imageById.get(id);
    if (!img) continue;
    const ext = extFor(img.mime, img.name);
    const file = 'files/' + id + '.' + ext;
    if (img.size != null) {
      // A chunked upload (image_chunks): images.data is empty, the bytes are in the
      // chunk rows. Streamed one 8 MB row at a time — a lecture video never sits in memory.
      const total = Number(img.size), rows = Math.ceil(total / Number(img.chunk_size));
      await zip.addStream(file, total, { mtime: Number(img.created_at) || now }, async function* () {
        for (let seq = 0; seq < rows; seq++) {
          const c = await q.chunkData.get(id, seq);
          if (!c) throw new Error('檔案 ' + id + ' 缺了第 ' + seq + ' 塊');
          yield c.data;
        }
      });
      filesIndex.push({
        id: id, owner: nameOf.get(img.owner_id) || null, mime: img.mime, name: img.name || null,
        createdAt: Number(img.created_at), shapes: null, file: file, original: null, chunked: true, size: total
      });
      continue;
    }
    const compressible = !/^(image\/|application\/pdf)/.test(String(img.mime || ''));
    await zip.add(file, img.data, { deflate: compressible, mtime: Number(img.created_at) || now });
    let original = null;
    if (img.original) {
      original = 'files/' + id + '.original.' + ext;
      await zip.add(original, img.original, { deflate: false, mtime: Number(img.created_at) || now });
    }
    filesIndex.push({
      id: id, owner: nameOf.get(img.owner_id) || null, mime: img.mime, name: img.name || null,
      createdAt: Number(img.created_at), shapes: parseJson(img.shapes, null), file: file, original: original
    });
    // drawio 的圖示庫：有標記才寫，沒有的就跟以前的備份長得一樣
    if (img.icon) filesIndex[filesIndex.length - 1].icon = true;
    // 影片庫存進系統的圖：還原後一樣不能跑到檔案管理裡
    if (img.hidden) filesIndex[filesIndex.length - 1].hidden = true;
  }
  await addJson('files.json', filesIndex);

  const bookIndex = { versions: [], links: [] };
  for (const bv of bookVersions) {
    bookIndex.versions.push({
      id: bv.id, folderId: bv.folder_id, owner: nameOf.get(bv.owner_id) || null, title: bv.title,
      label: bv.label || null, manifest: parseJson(bv.manifest, []), createdAt: Number(bv.created_at)
    });
  }
  for (const l of links) {
    if (res.destroyed) return;
    const file = 'books/' + l.token + '.html';
    await zip.add(file, Buffer.from(l.html || '', 'utf8'), { level: 1, mtime: Number(l.updated_at) || now });
    bookIndex.links.push({
      token: l.token, folderId: l.folder_id, owner: nameOf.get(l.owner_id) || null, title: l.title,
      chapters: Number(l.chapters || 0), createdAt: Number(l.created_at), updatedAt: Number(l.updated_at),
      expiresAt: l.expires_at ? Number(l.expires_at) : null, views: Number(l.views || 0), file: file
    });
  }
  await addJson('books.json', bookIndex);

  // 單篇筆記的公開連結：一樣是一整頁打包好的 HTML，一個 token 一個檔
  const linkIndex = [];
  for (const l of noteLinks) {
    if (res.destroyed) return;
    const file = 'links/' + l.token + '.html';
    await zip.add(file, Buffer.from(l.html || '', 'utf8'), { level: 1, mtime: Number(l.updated_at) || now });
    linkIndex.push({
      token: l.token, noteId: l.note_id, owner: nameOf.get(l.owner_id) || null, title: l.title,
      noteRev: Number(l.note_rev || 0), autoUpdate: l.auto_update == null ? true : !!l.auto_update,
      createdAt: Number(l.created_at), updatedAt: Number(l.updated_at),
      expiresAt: l.expires_at ? Number(l.expires_at) : null, views: Number(l.views || 0), file: file
    });
  }
  await addJson('links.json', linkIndex);

  if (site) {
    await addJson('users.json', users.map(u => ({
      id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, mustChangePw: !!u.must_change_pw,
      createdAt: Number(u.created_at), lastLogin: u.last_login ? Number(u.last_login) : null,
      pwHash: Buffer.from(u.pw_hash).toString('base64'), pwSalt: Buffer.from(u.pw_salt).toString('base64')
    })));
    const s = {};
    for (const r of await q.settingsAll.all()) s[r.k] = r.v;
    await addJson('settings.json', s);
  }

  await zip.finish();
  res.end();
}

// ---------------- uploads ----------------
const uploads = new Map();   // id -> { id, userId, file, size, touched, job }
const jobs = new Map();      // id -> job
let running = null;          // the job currently restoring, if any

function newId() { return crypto.randomBytes(12).toString('hex'); }

function uploadOf(user, id) {
  const up = uploads.get(id);
  return up && up.userId === user.id ? up : null;
}

function removeFile(file) {
  fs.promises.unlink(file).catch(function () { /* already gone */ });
}

function createUpload(user) {
  const id = newId();
  const file = path.join(os.tmpdir(), 'capynote-restore-' + id + '.zip');
  fs.writeFileSync(file, '');
  uploads.set(id, { id: id, userId: user.id, file: file, size: 0, touched: Date.now(), job: null });
  return { id: id, chunkMax: config.maxBodyBytes, totalMax: config.backupMaxBytes };
}

async function appendUpload(user, id, offset, buf) {
  const up = uploadOf(user, id);
  if (!up) return { status: 404, error: '找不到這次上傳，請重新選擇檔案' };
  if (up.job) return { status: 409, error: '這個檔案已經在還原中' };
  if (offset !== up.size) return { status: 409, error: '上傳順序錯亂（伺服器已收到 ' + up.size + ' bytes）' };
  if (up.size + buf.length > config.backupMaxBytes) {
    return { status: 413, error: '備份檔超過上限 ' + Math.round(config.backupMaxBytes / 1048576) + ' MB' };
  }
  await fs.promises.appendFile(up.file, buf);
  up.size += buf.length;
  up.touched = Date.now();
  return { size: up.size };
}

function uploadStatus(user, id) {
  const up = uploadOf(user, id);
  if (!up) return { status: 404, error: '找不到這次上傳' };
  return { size: up.size };
}

function dropUpload(user, id) {
  const up = uploadOf(user, id);
  if (!up) return { ok: true };
  if (up.job && !up.job.finished) return { status: 409, error: '還原進行中，不能取消' };
  uploads.delete(id);
  removeFile(up.file);
  return { ok: true };
}

// manifest.json may sit under a directory when someone re-zipped an extracted
// backup; every other path is then relative to that directory.
function findManifest(zr) {
  let best = null;
  for (const name of zr.names()) {
    if (name !== 'manifest.json' && !name.endsWith('/manifest.json')) continue;
    if (name.indexOf('__MACOSX/') === 0) continue;
    if (!best || name.length < best.length) best = name;
  }
  if (!best) throw new Error('這個 zip 裡沒有 manifest.json，不是 capynote 的備份');
  const prefix = best.slice(0, best.length - 'manifest.json'.length);
  const manifest = parseJson(zr.read(best, ENTRY_MAX).toString('utf8'), null);
  if (!manifest || (manifest.format !== FORMAT && !LEGACY_FORMATS.includes(manifest.format))) throw new Error('這不是 capynote 的備份檔');
  if (Number(manifest.version) > FORMAT_VERSION) throw new Error('這個備份是較新版本的 capynote 做的，請先更新伺服器');
  return { prefix: prefix, manifest: manifest };
}

function inspectUpload(user, id) {
  const up = uploadOf(user, id);
  if (!up) return { status: 404, error: '找不到這次上傳，請重新選擇檔案' };
  let zr;
  try { zr = ZipReader.open(up.file); }
  catch (e) { return { status: 400, error: e.message }; }
  try {
    const found = findManifest(zr);
    const m = found.manifest;
    const site = m.scope === 'site';
    const out = {
      scope: site ? 'site' : 'mine', exportedAt: Number(m.exportedAt) || null, exportedBy: m.exportedBy || null,
      counts: m.counts || {}, entries: zr.names().length, bytes: up.size, canRestore: true, reason: null
    };
    if (site && user.role !== 'admin') { out.canRestore = false; out.reason = '整個站台的備份只有管理員能還原'; }
    return out;
  } catch (e) {
    return { status: 400, error: e.message };
  } finally {
    zr.close();
  }
}

// ---------------- restore ----------------
function startRestore(user, id, body) {
  const up = uploadOf(user, id);
  if (!up) return { status: 404, error: '找不到這次上傳，請重新選擇檔案' };
  if (up.job) return { status: 409, error: '這個檔案已經在還原中' };
  if (running && !running.finished) return { status: 409, error: '有另一個還原正在進行，請等它完成' };
  // The scope check inspect already made, repeated here so the answer is a
  // plain 403 rather than a job that fails.
  const look = inspectUpload(user, id);
  if (look.status) return look;
  if (!look.canRestore) return { status: 403, error: look.reason };
  const job = {
    id: newId(), userId: user.id, uploadId: id, startedAt: Date.now(), finished: false, finishedAt: null,
    phase: '準備中', done: 0, total: 0, error: null, report: null
  };
  jobs.set(job.id, job);
  up.job = job;
  running = job;
  const opts = { overwrite: !!(body && body.overwrite) };
  runRestore(job, user, up, opts).catch(function (e) {
    job.error = e && e.message || String(e);
    console.error('[backup] restore failed:', e && e.stack || e);
  }).then(function () {
    job.finished = true;
    job.finishedAt = Date.now();
    if (running === job) running = null;
    uploads.delete(id);
    removeFile(up.file);
  });
  return { job: job.id };
}

function jobStatus(user, id) {
  const job = jobs.get(id);
  if (!job || job.userId !== user.id) return { status: 404, error: '找不到這個還原工作' };
  return {
    id: job.id, phase: job.phase, done: job.done, total: job.total, finished: job.finished,
    error: job.error, report: job.report, startedAt: job.startedAt, finishedAt: job.finishedAt
  };
}

function b64(s, max) {
  if (typeof s !== 'string' || !s) return null;
  const b = Buffer.from(s, 'base64');
  return b.length > 0 && b.length <= max ? b : null;
}

async function runRestore(job, user, up, opts) {
  const zr = ZipReader.open(up.file);
  try {
    const found = findManifest(zr);
    const manifest = found.manifest;
    const site = manifest.scope === 'site';
    if (site && user.role !== 'admin') throw new Error('整個站台的備份只有管理員能還原');
    const readEntry = (name) => zr.read(found.prefix + name, ENTRY_MAX);
    const readText = (name) => { const b = readEntry(name); return b == null ? null : b.toString('utf8'); };
    const readJson = (name, dflt) => { const t = readText(name); return t == null ? dflt : parseJson(t, dflt); };
    const list = (v) => Array.isArray(v) ? v : [];

    const folders = list(readJson('folders.json', []));
    const notes = list(readJson('notes.json', []));
    const files = list(readJson('files.json', []));
    const books = readJson('books.json', {}) || {};
    const bookVersions = list(books.versions), bookLinks = list(books.links);
    const noteLinks = list(readJson('links.json', []));
    const users = site ? list(readJson('users.json', [])) : [];
    const savedSettings = site ? (readJson('settings.json', null) || null) : null;

    const report = {
      scope: site ? 'site' : 'mine',
      users: { created: 0, kept: 0, skipped: 0 },
      settings: false,
      folders: { created: 0, updated: 0, skipped: 0, conflicts: 0 },
      files: { created: 0, updated: 0, skipped: 0, conflicts: 0 },
      notes: { created: 0, overwritten: 0, skipped: 0, conflicts: 0, trashed: 0 },
      versions: { created: 0 },
      shares: { created: 0, missingUsers: [] },
      books: { versions: 0, links: 0, skipped: 0 },
      links: { created: 0, skipped: 0 },     // 單篇筆記的公開連結
      warnings: []
    };
    const warn = (msg) => { if (report.warnings.length < 200) report.warnings.push(msg); };
    job.total = users.length + folders.length + files.length + notes.length + bookVersions.length + bookLinks.length;
    job.report = report;
    const tick = () => { job.done++; };

    // ---- users (site scope) ----
    // Backup usernames -> ids on this site. Existing accounts keep everything
    // they have (password included); missing ones come back with their old hash.
    const ownerId = new Map();
    if (site) {
      job.phase = '使用者';
      for (const u of users) {
        tick();
        const name = String(u.username || '');
        if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(name)) { report.users.skipped++; warn('使用者名稱不合法，略過：' + name.slice(0, 40)); continue; }
        const existing = await q.userByName.get(name);
        if (existing) { ownerId.set(name, existing.id); report.users.kept++; continue; }
        const hash = b64(u.pwHash, 128), salt = b64(u.pwSalt, 64);
        if (!hash || !salt) { report.users.skipped++; warn('使用者 ' + name + ' 的密碼雜湊損毀，略過'); continue; }
        const r = await q.insertUserFull.run(name, hash, salt, Number(u.createdAt) || Date.now(),
          VALID_ROLES[u.role] ? u.role : 'user', u.disabled ? 1 : 0, u.mustChangePw ? 1 : 0,
          u.lastLogin ? Number(u.lastLogin) : null);
        ownerId.set(name, r.insertId);
        report.users.created++;
      }
      if (savedSettings && typeof savedSettings === 'object') {
        const now = Date.now();
        let any = false;
        if (settings.MODES.indexOf(savedSettings.register_mode) >= 0) { await q.setSetting.run('register_mode', savedSettings.register_mode, now); any = true; }
        if (typeof savedSettings.invite_code === 'string' && /^[\x21-\x7e]{6,64}$/.test(savedSettings.invite_code)) {
          await q.setSetting.run('invite_code', savedSettings.invite_code, now); any = true;
        }
        if (any) { await settings.load(); report.settings = true; }
      }
    }
    const resolveOwner = (username) => site ? (ownerId.get(String(username || '')) || null) : user.id;
    const idOk = (s) => typeof s === 'string' && /^[\w.-]{1,64}$/.test(s);

    // ---- folders (parents first; no FK guards a dangling parent) ----
    job.phase = '資料夾';
    const mine = new Set();   // folder ids owned by the target owner after this phase
    const pending = folders.filter(f => idOk(f.id));
    const knownIds = new Set(pending.map(f => f.id));
    const doneIds = new Set();
    while (pending.length) {
      // Parents first. A parent that is not in the backup is checked against the
      // database below; a cycle (nothing ready) is broken by sending the rest up.
      let batch = pending.filter(f => !f.parentId || !knownIds.has(f.parentId) || doneIds.has(f.parentId));
      if (!batch.length) { batch = pending.slice(); batch.forEach(f => { f.parentId = null; }); }
      for (const f of batch) {
        pending.splice(pending.indexOf(f), 1);
        doneIds.add(f.id);
        tick();
        const owner = resolveOwner(f.owner);
        if (!owner) { report.folders.skipped++; warn('資料夾「' + f.name + '」的擁有者不在這個站台，略過'); continue; }
        let parentId = f.parentId || null;
        if (parentId && !mine.has(parentId)) {
          const p = await q.folderById.get(parentId);
          if (!p || p.owner_id !== owner) { warn('資料夾「' + f.name + '」的上層不存在，改放到最上層'); parentId = null; }
        }
        const existing = await q.folderById.get(f.id);
        const pos = f.position == null ? null : Number(f.position);
        if (!existing) {
          await q.insertFolderFull.run(f.id, owner, String(f.name || '新資料夾'), parentId, Number(f.createdAt) || Date.now(), f.isBook ? 1 : 0, pos, normalizeArea(f.area));
          mine.add(f.id);
          report.folders.created++;
        } else if (existing.owner_id === owner) {
          mine.add(f.id);
          if (opts.overwrite) { await q.updateFolderFull.run(String(f.name || existing.name), parentId, f.isBook ? 1 : 0, pos, f.id); report.folders.updated++; }
          else report.folders.skipped++;
        } else {
          report.folders.conflicts++;
          warn('資料夾「' + f.name + '」的 id 已被別的帳號使用，略過');
        }
      }
    }

    // ---- files ----
    job.phase = '檔案';
    for (const f of files) {
      tick();
      if (!idOk(f.id)) { report.files.skipped++; continue; }
      const owner = resolveOwner(f.owner);
      if (!owner) { report.files.skipped++; continue; }
      const existing = await q.imageOwner.get(f.id);
      if (existing && existing.owner_id !== owner) { report.files.conflicts++; warn('檔案 ' + f.id + ' 已被別的帳號使用，略過'); continue; }
      if (existing && !opts.overwrite) { report.files.skipped++; continue; }
      // A chunked file (or any entry too big for one packet) goes back in the way it
      // was uploaded: a pending row, then 8 MB chunk rows cut from the zip stream, and
      // only marked complete once the zip's own size and CRC check has passed.
      const entry = f.file ? found.prefix + f.file : null;
      if (entry && zr.has(entry) && (f.chunked || zr.sizeOf(entry) > ENTRY_MAX)) {
        const total = zr.sizeOf(entry);
        const mimeC = String(f.mime || 'application/octet-stream').slice(0, 255);
        const nameC = f.name ? String(f.name).slice(0, 255) : null;
        try {
          if (existing) await q.deleteImage.run(f.id, owner);
          // 已知的缺口：備份／還原目前不記檔案管理的雲端硬碟資料夾位置（folder_id），還原回來
          // 一律落在最上層——檔案本身不會不見，只是要自己再搬一次資料夾。
          await q.insertImagePending.run(f.id, owner, mimeC, nameC, Number(f.createdAt) || Date.now(), total, RESTORE_CHUNK, null);
          let held = [], heldLen = 0, seq = 0;
          const flush = async function (final) {
            while (heldLen >= RESTORE_CHUNK || (final && heldLen > 0)) {
              const all = held.length === 1 ? held[0] : Buffer.concat(held);
              const piece = all.subarray(0, Math.min(RESTORE_CHUNK, all.length));
              await q.insertChunk.run(f.id, seq++, piece);
              const rest = all.subarray(piece.length);
              held = rest.length ? [rest] : []; heldLen = rest.length;
              tick();
            }
          };
          for await (const b of zr.stream(entry)) { held.push(b); heldLen += b.length; await flush(false); }
          await flush(true);
          await q.finishImage.run(f.id, owner);
          if (existing) report.files.updated++; else report.files.created++;
        } catch (e) {
          await q.deleteImage.run(f.id, owner).catch(function () {});
          report.files.skipped++;
          warn('大檔案 ' + (f.name || f.id) + ' 還原失敗：' + (e && e.message || e));
        }
        continue;
      }
      const data = f.file ? readEntry(f.file) : null;
      if (!data) { report.files.skipped++; warn('備份裡缺少檔案內容：' + (f.file || f.id)); continue; }
      const original = f.original ? readEntry(f.original) : null;
      const shapes = f.shapes ? JSON.stringify(f.shapes) : null;
      const mime = String(f.mime || 'application/octet-stream').slice(0, 255);
      const name = f.name ? String(f.name).slice(0, 255) : null;
      if (!existing) {
        // 同上：還原的檔案一律落在雲端硬碟最上層，不記得備份當時在哪個檔案管理資料夾裡。
        await q.insertImage.run(f.id, owner, mime, name, data, original, shapes, Number(f.createdAt) || Date.now(), null);
        report.files.created++;
      } else {
        await q.updateImageFull.run(mime, name, data, original, shapes, f.id);
        report.files.updated++;
      }
      // 圖示庫的標記跟著回來（只會加，不會因為還原一份舊備份就把現在的圖示拿掉）
      if (f.icon === true) await q.setImageIcon.run(1, f.id, owner);
      if (f.hidden === true) await q.setImageHidden.run(1, f.id, owner);
    }

    // ---- notes, their versions and shares ----
    job.phase = '筆記';
    const versionMap = new Map();   // backup version id -> id on this site
    const broadcasts = [];
    for (const n of notes) {
      tick();
      if (!idOk(n.id)) { report.notes.skipped++; continue; }
      const owner = resolveOwner(n.owner);
      if (!owner) { report.notes.skipped++; warn('筆記「' + n.title + '」的擁有者不在這個站台，略過'); continue; }
      const content = n.file ? readText(n.file) : null;
      if (content == null) { report.notes.skipped++; warn('備份裡缺少筆記內容：' + (n.file || n.id)); continue; }
      let folderId = n.folderId || null;
      if (folderId && !mine.has(folderId)) {
        const f = await q.folderById.get(folderId);
        if (!f || f.owner_id !== owner) { warn('筆記「' + n.title + '」的資料夾不存在，改放到最上層'); folderId = null; }
      }
      const title = String(n.title || '未命名筆記');
      const metaStr = n.meta ? JSON.stringify(n.meta) : null;
      const area = normalizeArea(n.area);
      // 小說永遠不能對外開放，就算備份裡帶著一個 access:'site' 的小說筆記也一樣——
      // 跟 api.js 的 setAccess 是同一條規則。
      const access = n.access === 'site' && area !== 'novel' ? 'site' : 'restricted';
      const accessPerm = n.accessPerm === 'edit' ? 'edit' : 'read';
      const deletedAt = n.deletedAt ? Number(n.deletedAt) : null;
      const position = n.position == null ? null : Number(n.position);
      const existing = await q.noteById.get(n.id);

      if (!existing) {
        const created = await tx(async function () {
          await q.insertNoteFull.run(n.id, owner, folderId, title, content, metaStr,
            Number(n.createdAt) || Date.now(), Number(n.updatedAt) || Date.now(), Number(n.rev) || 0,
            access, accessPerm, deletedAt, position, area);
          let made = 0;
          for (const v of list(n.versions)) {
            const vtext = v.file ? readText(v.file) : null;
            if (vtext == null) continue;
            const r = await q.insertVersion.run(n.id, Number(v.rev) || 0, String(v.title || title), vtext,
              v.meta ? JSON.stringify(v.meta) : null, String(v.author || ''), v.label ? String(v.label).slice(0, 255) : null,
              Number(v.createdAt) || Date.now());
            if (v.id != null) versionMap.set(Number(v.id), r.insertId);
            made++;
          }
          return made;
        }, 'restoreNote');
        report.versions.created += created;
        report.notes.created++;
        if (deletedAt) report.notes.trashed++;
        for (const s of list(n.shares)) {
          const who = await q.userByName.get(String(s.username || ''));
          if (!who || who.id === owner) { if (!who && report.shares.missingUsers.indexOf(s.username) < 0) report.shares.missingUsers.push(String(s.username)); continue; }
          await q.insertShare.run(n.id, who.id, s.perm === 'edit' ? 'edit' : 'read', Number(s.createdAt) || Date.now());
          report.shares.created++;
        }
      } else if (existing.owner_id !== owner) {
        report.notes.conflicts++;
        warn('筆記「' + title + '」的 id 已被別的帳號使用，略過');
      } else if (!opts.overwrite) {
        report.notes.skipped++;
      } else {
        const payload = await tx(async function () {
          const row = await q.noteByIdForUpdate.get(n.id);
          if (!row) return null;
          const now = Date.now();
          const rev = (row.rev || 0) + 1;
          if (row.content !== content || row.title !== title) {
            await q.insertVersion.run(n.id, row.rev || 0, row.title, row.content, row.meta, user.username, LABEL_RESTORE, now - 1);
          }
          await q.restoreNoteFull.run(folderId, title, content, metaStr, now, rev, access, accessPerm, deletedAt, position, n.id);
          return { rev: rev, content: content, title: title, by: user.username, updatedAt: now };
        }, 'restoreNoteOverwrite');
        if (payload) { broadcasts.push([n.id, payload]); report.notes.overwritten++; }
      }
    }
    broadcasts.forEach(function (b) { hub.broadcastUpdate(b[0], b[1]); });

    // ---- books ----
    job.phase = '電子書';
    for (const bv of bookVersions) {
      tick();
      const owner = resolveOwner(bv.owner);
      if (!owner || !idOk(bv.folderId)) { report.books.skipped++; continue; }
      const folder = mine.has(bv.folderId) ? { owner_id: owner } : await q.folderById.get(bv.folderId);
      if (!folder || folder.owner_id !== owner) { report.books.skipped++; warn('電子書版本「' + bv.title + '」的資料夾不在這個帳號，略過'); continue; }
      const createdAt = Number(bv.createdAt) || Date.now();
      if (await q.bookVersionExists.get(bv.folderId, owner, createdAt)) { report.books.skipped++; continue; }
      const chapters = [];
      let complete = true;
      for (const ch of list(bv.manifest)) {
        if (!ch || !idOk(ch.noteId)) { complete = false; break; }
        let vid = versionMap.get(Number(ch.versionId));
        if (vid == null) {
          const v = await q.versionById.get(Number(ch.versionId), ch.noteId);
          if (!v) { complete = false; break; }
          vid = v.id;
        }
        chapters.push({ noteId: ch.noteId, title: ch.title, versionId: vid, rev: ch.rev });
      }
      if (!complete) { report.books.skipped++; warn('電子書版本「' + bv.title + '」缺少章節版本，略過'); continue; }
      await q.insertBookVersion.run(bv.folderId, owner, String(bv.title || ''), bv.label ? String(bv.label).slice(0, 255) : null,
        JSON.stringify(chapters), createdAt);
      report.books.versions++;
    }
    for (const l of bookLinks) {
      tick();
      const owner = resolveOwner(l.owner);
      if (!owner || !idOk(l.folderId) || !/^[0-9a-f]{64}$/.test(String(l.token || ''))) { report.books.skipped++; continue; }
      const folder = mine.has(l.folderId) ? { owner_id: owner } : await q.folderById.get(l.folderId);
      if (!folder || folder.owner_id !== owner) { report.books.skipped++; continue; }
      const existing = await q.linkByToken.get(l.token);
      if (existing) { report.books.skipped++; continue; }
      const html = l.file ? readText(l.file) : null;
      if (html == null) { report.books.skipped++; warn('備份裡缺少分享連結的內容：' + l.token.slice(0, 8) + '…'); continue; }
      await q.insertLink.run(l.token, l.folderId, owner, String(l.title || ''), html, Number(l.chapters) || 0,
        Number(l.createdAt) || Date.now(), Number(l.updatedAt) || Date.now(), l.expiresAt ? Number(l.expiresAt) : null);
      report.books.links++;
    }
    // 單篇筆記的公開連結：筆記要在（剛還原的或本來就有的，而且是這個人的），token 沒被用過
    for (const l of noteLinks) {
      tick();
      const owner = resolveOwner(l.owner);
      if (!owner || !idOk(l.noteId) || !/^[0-9a-f]{64}$/.test(String(l.token || ''))) { report.links.skipped++; continue; }
      const note = await q.noteById.get(l.noteId);
      if (!note || note.owner_id !== owner) { report.links.skipped++; continue; }
      if (await q.noteLinkPublic.get(l.token)) { report.links.skipped++; continue; }
      const html = l.file ? readText(l.file) : null;
      if (html == null) { report.links.skipped++; warn('備份裡缺少公開連結的內容：' + l.token.slice(0, 8) + '…'); continue; }
      await q.insertNoteLink.run(l.token, l.noteId, owner, String(l.title || ''), html, Number(l.noteRev) || 0,
        Number(l.createdAt) || Date.now(), Number(l.updatedAt) || Date.now(), l.expiresAt ? Number(l.expiresAt) : null);
      // 舊的備份沒有這個欄位：照預設（自動更新）
      if (l.autoUpdate === false) await q.setNoteLinkAuto.run(0, l.token, owner);
      report.links.created++;
    }

    job.phase = '完成';
    job.done = job.total;
    console.log('[backup] ' + user.username + ' 還原了一份' + (site ? '站台' : '個人') + '備份：' +
      report.notes.created + ' 篇新筆記、' + report.notes.overwritten + ' 篇覆蓋、' + report.files.created + ' 個檔案');
  } finally {
    zr.close();
  }
}

// ---------------- housekeeping ----------------
function sweep() {
  const now = Date.now();
  uploads.forEach(function (up, id) {
    if (up.job || now - up.touched < UPLOAD_TTL_MS) return;
    uploads.delete(id);
    removeFile(up.file);
  });
  jobs.forEach(function (job, id) {
    if (job.finished && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  });
}

// Temp files left by a previous process (a crash mid-upload) are nobody's now.
function startHousekeeping() {
  fs.promises.readdir(os.tmpdir()).then(function (names) {
    names.filter(n => /^(capynote|strikenote)-restore-[0-9a-f]{24}\.zip$/.test(n))
      .forEach(n => removeFile(path.join(os.tmpdir(), n)));
  }).catch(function () { /* unreadable tmp: nothing to clean */ });
  setInterval(sweep, 5 * 60 * 1000).unref();
}

module.exports = {
  exportZip, createUpload, appendUpload, uploadStatus, dropUpload, inspectUpload, startRestore, jobStatus,
  startHousekeeping, FORMAT, FORMAT_VERSION
};
