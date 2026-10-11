#!/usr/bin/env node
/* smoke.js — end-to-end exercise of the HTTP API against a *scratch* server.
 *
 * Two jobs:
 *   1. Build a synthetic fixture on the old SQLite server (`--old` skips the
 *      endpoints/behaviours that only the MariaDB build has), so the migration
 *      tool has something realistic — CJK/emoji text, images, a 20 MB PDF,
 *      versions, shares, book versions, share links — to move.
 *   2. Verify the MariaDB build end to end.
 *
 * Never point this at a real instance: it registers users and writes data.
 *
 *   BASE_URL=http://127.0.0.1:8090 ADMIN_PASSWORD=... node server/tools/smoke.js [--old]
 */
'use strict';

const crypto = require('node:crypto');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8090';
const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'scratchpass123';
const BOB = 'bob';
const BOB_PW = 'bob-password-123';
const OLD = process.argv.includes('--old');
const BODY_LIMIT = parseInt(process.env.MAX_BODY_BYTES || '', 10) || 25 * 1024 * 1024;
const CSRF = { 'X-Requested-With': 'report-notes' };

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else {
    fail++;
    console.log('  FAIL  ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : ''));
  }
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

function jar() {
  let cookie = '';
  return {
    absorb(res) {
      const sc = res.headers.get('set-cookie');
      if (!sc) return;
      const m = sc.match(/rn_session=([^;]*)/);
      if (m) cookie = m[1] ? 'rn_session=' + m[1] : '';
    },
    header() { return cookie; }
  };
}

async function call(session, method, path, body, opts) {
  opts = opts || {};
  const headers = Object.assign({}, CSRF, opts.headers || {});
  if (session && session.header()) headers.Cookie = session.header();
  let payload;
  if (opts.raw) { payload = body; headers['Content-Type'] = opts.contentType || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(BASE + path, { method: method, headers: headers, body: payload, redirect: 'manual' });
  if (session) session.absorb(res);
  let data = null;
  if (opts.buffer) data = Buffer.from(await res.arrayBuffer());
  else if ((res.headers.get('content-type') || '').includes('json')) data = await res.json().catch(() => null);
  else data = await res.text();
  return { status: res.status, data: data, headers: res.headers };
}

// A valid 1×1 PNG (red pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

async function login(session, username, password) {
  return call(session, 'POST', '/api/login', { username: username, password: password });
}

async function main() {
  console.log('smoke → ' + BASE + (OLD ? '  (old server: new-only checks skipped)' : ''));
  const admin = jar(), bob = jar(), anon = jar();

  if (!OLD) {
    section('health');
    const h = await call(null, 'GET', '/api/health');
    ok(h.status === 200 && h.data && h.data.ok === true, '/api/health is 200 {ok:true}', h.data);
  }

  section('accounts');
  let r = await login(admin, ADMIN, ADMIN_PW);
  ok(r.status === 200 && r.data.user && r.data.user.username === ADMIN, 'admin login', r.data);
  r = await call(bob, 'POST', '/api/register', { username: BOB, password: BOB_PW, invite: '' });
  if (r.status !== 200) r = await login(bob, BOB, BOB_PW);
  ok(r.status === 200 && r.data.user && r.data.user.username === BOB, 'bob registered/logged in', r.data);
  const bobId = r.data.user.id;
  r = await call(bob, 'GET', '/api/me');
  ok(r.status === 200 && r.data.user && r.data.user.id === bobId, '/api/me reflects bob', r.data);
  r = await call(anon, 'GET', '/api/notes');
  ok(r.status === 401, 'anonymous /api/notes is 401', r.status);
  r = await call(admin, 'POST', '/api/notes', {}, { headers: { 'X-Requested-With': 'nope' } });
  ok(r.status === 403, 'wrong CSRF header is 403', r.status);

  section('folders');
  r = await call(admin, 'POST', '/api/folders', { name: '專案 A' });
  ok(r.status === 200 && r.data.folder && r.data.folder.id, 'create folder', r.data);
  const fid = r.data.folder.id;
  r = await call(admin, 'POST', '/api/folders', { name: '子資料夾', parentId: fid });
  const subId = r.data.folder.id;
  r = await call(admin, 'PUT', '/api/folders/' + fid, { name: '專案 A（改名）', parentId: null, isBook: true });
  ok(r.status === 200 && r.data.folder.isBook === true && r.data.folder.name === '專案 A（改名）', 'rename + isBook', r.data);
  r = await call(admin, 'PUT', '/api/folders/' + fid, { name: '專案 A（改名）', parentId: null });
  ok(r.status === 200 && r.data.folder.isBook === true, 'rename without isBook leaves the flag alone', r.data);
  r = await call(bob, 'PUT', '/api/folders/' + fid, { name: 'hijack' });
  ok(r.status === 404, "bob cannot touch admin's folder", r.status);

  section('notes');
  const texts = [
    '# 01 前言\n\n這是滲透測試報告的前言，含 emoji 🚀 與 `<script>alert(1)</script>`。\n\n#lab #oscp',
    "# 02 主機\n\n```bash\nsqlmap -u 'http://t/?id=1' --dbs\n```\n\n' OR 1=1 -- \n\n[[03 附錄]]",
    '# 03 附錄\n\n| a | b |\n|---|---|\n| 中文 | 表格 |\n\n> [!NOTE]\n> callout'
  ];
  const noteIds = [];
  for (let i = 0; i < texts.length; i++) {
    r = await call(admin, 'POST', '/api/notes', { title: '0' + (i + 1) + ' 章', content: texts[i], folderId: fid });
    ok(r.status === 200 && r.data.note && r.data.note.folderId === fid, 'create chapter ' + (i + 1), r.data);
    noteIds.push(r.data.note.id);
  }
  r = await call(admin, 'POST', '/api/notes', { title: '散裝筆記', content: 'loose #lab' });
  const looseId = r.data.note.id;
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0]);
  ok(r.status === 200 && r.data.note.content === texts[0], 'round-trips CJK/emoji/markdown exactly');
  const n0 = r.data.note;
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[0], {
    title: n0.title, content: texts[0] + '\n\n第二段。', baseContent: n0.content, baseRev: n0.rev, folderId: fid,
    meta: { pinned: true }
  });
  ok(r.status === 200 && r.data.note.rev === n0.rev + 1 && r.data.note.meta && r.data.note.meta.pinned === true,
    'save bumps rev and stores meta', r.data);
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[0], {
    title: n0.title, content: r.data.note.content, baseContent: r.data.note.content, folderId: fid, meta: { pinned: true }
  });
  ok(r.status === 200 && r.data.note.rev === n0.rev + 1, 'no-op save does not bump rev', r.data.note.rev);
  // Three-way merge: two clients edit different lines from the same base.
  const base = (await call(admin, 'GET', '/api/notes/' + noteIds[1])).data.note;
  const lines = base.content.split('\n');
  const a = lines.slice(); a[0] = '# 02 主機（A 改標題行）';
  const b = lines.slice(); b.push('B 加了一行');
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: base.title, content: a.join('\n'), baseContent: base.content, folderId: fid });
  ok(r.status === 200, 'merge: first save');
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: base.title, content: b.join('\n'), baseContent: base.content, folderId: fid });
  ok(r.status === 200 && r.data.note.content.includes('A 改標題行') && r.data.note.content.includes('B 加了一行'),
    'merge: second save keeps both edits', r.data.note && r.data.note.content);
  // Same line, different places: merged word by word, not "last save takes the line".
  let mcur = (await call(admin, 'GET', '/api/notes/' + noteIds[1])).data.note;
  const line = '共同的一行：今天討論報告內容';
  const cbase = mcur.content + '\n' + line;
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: mcur.title, content: cbase, baseContent: mcur.content, folderId: fid });
  mcur = r.data.note;
  await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: mcur.title, content: cbase.replace('今天', '今天下午'), baseContent: cbase, folderId: fid });
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: mcur.title, content: cbase.replace('報告', '期末報告'), baseContent: cbase, folderId: fid });
  ok(r.status === 200 && r.data.note.content.endsWith('共同的一行：今天下午討論期末報告內容'), 'merge: same line, different places → both kept', r.data.note && r.data.note.content.slice(-40));
  // Same spot: both typed right there → both kept.
  const sbase = r.data.note.content;
  await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: mcur.title, content: sbase + '【甲】', baseContent: sbase, folderId: fid });
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: mcur.title, content: sbase + '【乙】', baseContent: sbase, folderId: fid });
  ok(r.status === 200 && r.data.note.content.includes('【甲】') && r.data.note.content.includes('【乙】'), 'merge: same spot → both kept', r.data.note && r.data.note.content.slice(-20));
  // A save measured against a stale base re-sends text the server already has: not added twice.
  const now = r.data.note.content;
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: mcur.title, content: now + '\n再加一行', baseContent: '', folderId: fid });
  ok(r.status === 200 && r.data.note.content.split('共同的一行').length === 2 && r.data.note.content.endsWith('再加一行'),
    'merge: a stale-base save does not duplicate the note', r.data.note && r.data.note.content.length);

  section('shares + site-wide access');
  r = await call(bob, 'GET', '/api/notes/' + noteIds[0]);
  ok(r.status === 404, 'bob cannot see an unshared note', r.status);
  r = await call(admin, 'POST', '/api/notes/' + noteIds[0] + '/shares', { username: BOB, perm: 'read' });
  ok(r.status === 200 && r.data.perm === 'read', 'share read', r.data);
  r = await call(admin, 'POST', '/api/notes/' + noteIds[0] + '/shares', { username: BOB, perm: 'edit' });
  ok(r.status === 200 && r.data.perm === 'edit', 'share upsert → edit', r.data);
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0] + '/shares');
  ok(r.status === 200 && r.data.shares.length === 1 && r.data.shares[0].perm === 'edit', 'one share row after upsert', r.data);
  r = await call(bob, 'GET', '/api/notes/' + noteIds[0]);
  ok(r.status === 200 && r.data.note.perm === 'edit' && r.data.note.sharedBy === ADMIN, 'bob sees it with edit', r.data);
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[2] + '/access', { mode: 'site', perm: 'read' });
  ok(r.status === 200 && r.data.access === 'site', 'site-wide read', r.data);
  r = await call(bob, 'GET', '/api/notes');
  ok(r.status === 200 && r.data.notes.some(n => n.id === noteIds[2] && n.viaSite === true), 'bob lists the site-wide note', r.data && r.data.notes.length);
  r = await call(bob, 'PUT', '/api/notes/' + noteIds[2], { title: 'x', content: 'x' });
  ok(r.status === 403, 'site-wide read is not edit', r.status);
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[2] + '/access', { mode: 'restricted', perm: 'read' });
  ok(r.status === 200, 'back to restricted');

  section('versions (coalesce, label, restore, prune)');
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0] + '/versions');
  ok(r.status === 200 && r.data.versions.some(v => v.label === '啟用版本歷史前') && r.data.versions.length === 2,
    'first save left prehistory + one open row', r.data && r.data.versions.map(v => v.label));
  r = await call(admin, 'POST', '/api/notes/' + noteIds[0] + '/versions', { label: '里程碑' });
  ok(r.status === 200 && r.data.version && r.data.version.label === '里程碑', 'labelled version', r.data);
  const milestoneId = r.data.version.id;
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[0] + '/versions/' + milestoneId, { label: '里程碑 v2' });
  ok(r.status === 200 && r.data.label === '里程碑 v2', 'rename label', r.data);
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0] + '/versions/' + milestoneId);
  ok(r.status === 200 && typeof r.data.version.content === 'string' && r.data.version.chars === r.data.version.content.length,
    'get version has content and matching chars', r.data);
  // Alternate authors so coalescing cannot merge the rows: 70 saves → 70
  // unlabelled versions → prune keeps 60.
  let cur = (await call(admin, 'GET', '/api/notes/' + noteIds[0])).data.note;
  for (let i = 0; i < 70; i++) {
    const who = i % 2 ? bob : admin;
    const next = cur.content + '\n行 ' + i;
    r = await call(who, 'PUT', '/api/notes/' + noteIds[0], { title: cur.title, content: next, baseContent: cur.content, folderId: fid });
    if (r.status !== 200) { ok(false, 'save #' + i, r); break; }
    cur = r.data.note;
  }
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0] + '/versions');
  const unl = r.data.versions.filter(v => !v.label).length;
  const lab = r.data.versions.filter(v => v.label).length;
  ok(unl === 60 && lab >= 2, 'prune keeps 60 unlabelled, labelled untouched', { unlabelled: unl, labelled: lab });
  r = await call(admin, 'POST', '/api/notes/' + noteIds[0] + '/versions/' + milestoneId + '/restore');
  ok(r.status === 200 && r.data.note && !r.data.note.content.includes('行 69'), 'restore rewinds the text', r.data);
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0] + '/versions');
  ok(r.data.versions.some(v => v.label === '還原前'), 'restore left a 還原前 snapshot');
  r = await call(admin, 'DELETE', '/api/notes/' + noteIds[0] + '/versions/' + milestoneId);
  ok(r.status === 200, 'delete labelled version');

  section('images + PDF');
  r = await call(admin, 'POST', '/api/images', PNG, { raw: true, contentType: 'image/png' });
  ok(r.status === 200 && r.data.id, 'upload png', r.data);
  const imgId = r.data.id;
  r = await call(admin, 'GET', '/api/images/' + imgId, undefined, { buffer: true });
  ok(r.status === 200 && r.data.equals(PNG) && r.headers.get('content-type') === 'image/png', 'png round-trips byte for byte');
  // Bob has no note embedding it yet → 404; embed it in the shared note → 200.
  r = await call(bob, 'GET', '/api/images/' + imgId, undefined, { buffer: true });
  ok(r.status === 404, 'image hidden from a user with no note referencing it', r.status);
  cur = (await call(admin, 'GET', '/api/notes/' + noteIds[0])).data.note;
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[0], { title: cur.title, content: cur.content + '\n\n![img](img:' + imgId + ')', baseContent: cur.content, folderId: fid });
  r = await call(bob, 'GET', '/api/images/' + imgId, undefined, { buffer: true });
  ok(r.status === 200, 'image visible once a shared note embeds it', r.status);
  // 圖片黑框把引用寫成 ![x](img:<id>#frame)。id 只吃 [\w.-]，所以 MEDIA_REF 切出來的 id
  // 不會含「#frame」，可見性的 `img:<id>` 子字串比對也還在——這條規則一旦破掉，分享出去
  // 的筆記裡所有加了框的圖都會變成 404，而且只有收件人才看得出來。
  r = await call(admin, 'POST', '/api/images', PNG, { raw: true, contentType: 'image/png' });
  const framedId = r.data.id;
  cur = (await call(admin, 'GET', '/api/notes/' + noteIds[0])).data.note;
  await call(admin, 'PUT', '/api/notes/' + noteIds[0], { title: cur.title, content: cur.content + '\n\n![框](img:' + framedId + '#frame)', baseContent: cur.content, folderId: fid });
  r = await call(bob, 'GET', '/api/images/' + framedId, undefined, { buffer: true });
  ok(r.status === 200, 'a framed reference (img:<id>#frame) is still visible to a share recipient', r.status);
  r = await call(admin, 'GET', '/api/images');
  const framedRow = (r.data.images || []).find(x => x.id === framedId);
  ok(!!framedRow && framedRow.notes && framedRow.notes.length > 0, 'a framed reference still counts as used in 檔案管理', framedRow);
  r = await call(admin, 'PUT', '/api/images/' + imgId, {
    mime: 'image/png', data: PNG.toString('base64'), original: PNG.toString('base64'),
    shapes: [{ type: 'rect', x: 1, y: 1, w: 2, h: 2, color: '#f00' }]
  });
  ok(r.status === 200, 'annotate (data + original + shapes)', r.data);
  r = await call(admin, 'GET', '/api/images/' + imgId + '/meta');
  ok(r.status === 200 && r.data.hasOriginal === true && r.data.shapes.length === 1 && r.data.canAnnotate === true, 'meta after annotate', r.data);
  r = await call(bob, 'PUT', '/api/images/' + imgId, { mime: 'image/png', data: PNG.toString('base64') });
  ok(r.status === 403, 'only the owner may annotate', r.status);
  r = await call(admin, 'GET', '/api/images/' + imgId + '/original', undefined, { buffer: true });
  ok(r.status === 200 && r.data.equals(PNG), '/original serves the original');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n%synthetic\n'), crypto.randomBytes(20 * 1024 * 1024)]);
  r = await call(admin, 'POST', '/api/images', pdf, { raw: true, contentType: 'application/pdf' });
  ok(r.status === 200 && r.data.id, 'upload 20 MB pdf', r.status);
  const pdfId = r.data.id;
  r = await call(admin, 'GET', '/api/images/' + pdfId, undefined, { buffer: true });
  ok(r.status === 200 && sha(r.data) === sha(pdf) && r.headers.get('content-type') === 'application/pdf', '20 MB pdf round-trips');
  cur = (await call(admin, 'GET', '/api/notes/' + noteIds[2])).data.note;
  await call(admin, 'PUT', '/api/notes/' + noteIds[2], { title: cur.title, content: cur.content + '\n\n![report](pdf:' + pdfId + ')', baseContent: cur.content, folderId: fid });
  // Any file type is accepted, but only inert types are served back as themselves:
  // an uploaded page or script must never run as HTML or JavaScript on this origin.
  r = await call(admin, 'POST', '/api/images', Buffer.from('<script>alert(1)</script>'),
    { raw: true, contentType: 'text/html', headers: { 'X-File-Name': encodeURIComponent('報告 附件.html') } });
  ok(r.status === 200 && r.data.id, 'any file type uploads (text/html)', r.data);
  const fileId = r.data.id;
  r = await call(admin, 'GET', '/api/images/' + fileId, undefined, { buffer: true });
  const disp = r.headers.get('content-disposition') || '';
  ok(r.status === 200 && r.headers.get('content-type') === 'application/octet-stream' && /^attachment;/.test(disp) &&
     disp.includes(encodeURIComponent('報告 附件.html')) && (r.headers.get('content-security-policy') || '').includes('sandbox'),
    'a non-media upload comes back as a sandboxed attachment under its own name', { type: r.headers.get('content-type'), disp });
  r = await call(admin, 'GET', '/api/images/' + fileId + '/original', undefined, { buffer: true });
  ok(r.status === 200 && r.headers.get('content-type') === 'application/octet-stream', '/original is an attachment too', r.headers.get('content-type'));
  r = await call(bob, 'GET', '/api/images/' + fileId, undefined, { buffer: true });
  ok(r.status === 404, 'attachment hidden until a readable note links it', r.status);
  cur = (await call(admin, 'GET', '/api/notes/' + noteIds[0])).data.note;
  await call(admin, 'PUT', '/api/notes/' + noteIds[0], { title: cur.title, content: cur.content + '\n\n[報告 附件.html](file:' + fileId + ')', baseContent: cur.content, folderId: fid });
  r = await call(bob, 'GET', '/api/images/' + fileId, undefined, { buffer: true });
  ok(r.status === 200, 'attachment visible once a shared note links it with file:', r.status);

  // drawio 的圖示庫（js/drawio.js 左邊的「我的圖示」）。圖示庫是私人的：清單只有本人拿得到。
  // 圖示畫進圖裡是 src=img:<id>，所以讀得到那張圖的人看得到圖片本身（不然分享出去的圖
  // 會缺一塊），但他的圖示庫裡不會多出別人的東西，也動不了別人的圖示。
  section('drawio icon library');
  {
    const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c00"/></svg>');
    const before = (await call(admin, 'GET', '/api/images')).data.images.length;
    r = await call(admin, 'GET', '/api/icons');
    ok(r.status === 200 && Array.isArray(r.data.icons) && r.data.icons.length === 0, 'the icon library starts empty', r.data);
    r = await call(admin, 'POST', '/api/icons', PNG, { raw: true, contentType: 'image/png', headers: { 'X-File-Name': encodeURIComponent('防火牆.png') } });
    ok(r.status === 200 && r.data.icon && r.data.icon.id && r.data.icon.name === '防火牆.png' && r.data.icon.bytes === PNG.length, 'upload an icon', r.data);
    const icon1 = r.data.icon.id;
    r = await call(admin, 'POST', '/api/icons', SVG, { raw: true, contentType: 'image/svg+xml', headers: { 'X-File-Name': 'server.svg' } });
    ok(r.status === 200 && r.data.icon.mime === 'image/svg+xml', 'an SVG icon is accepted', r.data);
    const icon2 = r.data.icon.id;
    r = await call(admin, 'GET', '/api/icons');
    ok(r.data.icons.length === 2 && r.data.icons[0].id === icon1 && r.data.icons[1].id === icon2, 'the owner lists their icons, oldest first', r.data.icons.map(i => i.id));
    r = await call(admin, 'GET', '/api/images/' + icon2, undefined, { buffer: true });
    ok(r.status === 200 && r.data.equals(SVG) && /sandbox/.test(r.headers.get('content-security-policy') || ''),
      'an SVG icon is served like any uploaded SVG: as itself, under a sandbox policy', r.headers.get('content-security-policy'));

    r = await call(bob, 'GET', '/api/icons');
    ok(r.status === 200 && r.data.icons.length === 0, "another user's library does not show my icons", r.data);
    r = await call(bob, 'GET', '/api/images/' + icon1, undefined, { buffer: true });
    ok(r.status === 404, 'nor can they fetch the icon itself', r.status);
    r = await call(bob, 'DELETE', '/api/icons/' + icon1);
    ok(r.status === 404, 'nor remove it', r.status);
    r = await call(null, 'GET', '/api/icons');
    ok(r.status === 401, 'the icon library needs a session', r.status);

    r = await call(admin, 'POST', '/api/icons', Buffer.from('<script>alert(1)</script>'), { raw: true, contentType: 'text/html' });
    ok(r.status === 400, 'only images can be icons (text/html refused)', r.status);
    r = await call(admin, 'POST', '/api/icons', Buffer.from('%PDF-1.4'), { raw: true, contentType: 'application/pdf' });
    ok(r.status === 400, 'a PDF is not an icon', r.status);
    r = await call(admin, 'POST', '/api/icons', Buffer.alloc(0), { raw: true, contentType: 'image/png' });
    ok(r.status === 400, 'an empty file is refused', r.status);
    let bigStatus = 0;
    try { bigStatus = (await call(admin, 'POST', '/api/icons', Buffer.alloc(2 * 1024 * 1024 + 1024, 1), { raw: true, contentType: 'image/png' })).status; }
    catch (e) { bigStatus = 413; }   // the server may hang up before the body is through
    ok(bigStatus === 413, 'an icon over 2 MB is refused', bigStatus);
    r = await call(admin, 'GET', '/api/icons');
    ok(r.data.icons.length === 2, 'none of the refused uploads got in', r.data.icons.length);

    // A diagram using the icon, shared with bob.
    const dsl = 'shape s1 image x=0 y=0 w=60 h=60 "FW" src=img:' + icon1 + ' fill=none stroke=none';
    r = await call(admin, 'POST', '/api/notes', { title: '圖示測試圖', content: '```drawio\n' + dsl + '\n```\n', meta: { drawio: true } });
    const dNote = r.data.note.id;
    await call(admin, 'POST', '/api/notes/' + dNote + '/shares', { username: BOB, perm: 'read' });
    r = await call(bob, 'GET', '/api/images/' + icon1, undefined, { buffer: true });
    ok(r.status === 200 && r.data.equals(PNG), 'someone who can read the diagram can see the icon drawn on it', r.status);
    r = await call(bob, 'GET', '/api/images/' + icon2, undefined, { buffer: true });
    ok(r.status === 404, 'but not the icons the diagram does not use', r.status);
    r = await call(bob, 'GET', '/api/icons');
    ok(r.data.icons.length === 0, "and their own library still has nothing of mine", r.data);
    r = await call(admin, 'GET', '/api/images');
    const row1 = r.data.images.find(x => x.id === icon1), row2 = r.data.images.find(x => x.id === icon2);
    ok(row1 && row1.icon === true && row1.notes.some(n => n.id === dNote), '檔案管理 shows the icon as used by the diagram, flagged as an icon', row1);
    ok(row2 && row2.icon === true && row2.notes.length === 0, 'an icon not drawn anywhere is flagged too (so it is not mistaken for junk)', row2);

    // Removing: a used icon leaves the library but keeps its file; an unused one goes entirely.
    r = await call(admin, 'DELETE', '/api/icons/' + icon1);
    ok(r.status === 200 && r.data.kept === true, 'removing an icon that a diagram uses keeps the file', r.data);
    r = await call(bob, 'GET', '/api/images/' + icon1, undefined, { buffer: true });
    ok(r.status === 200 && r.data.equals(PNG), 'the diagram still shows it', r.status);
    r = await call(admin, 'DELETE', '/api/icons/' + icon2);
    ok(r.status === 200 && r.data.kept === false, 'removing an unused icon deletes the file', r.data);
    ok((await call(admin, 'GET', '/api/images/' + icon2)).status === 404, 'it is gone');
    r = await call(admin, 'GET', '/api/icons');
    ok(r.data.icons.length === 0, 'both are out of the library', r.data);
    r = await call(admin, 'DELETE', '/api/icons/' + icon1);
    ok(r.status === 404, 'a file that is no longer an icon cannot be removed as one', r.status);

    // Leave the fixture as it was: later sections count notes and files.
    await call(admin, 'DELETE', '/api/notes/' + dNote);
    await call(admin, 'DELETE', '/api/trash/' + dNote);
    await call(admin, 'DELETE', '/api/images/' + icon1);
    r = await call(admin, 'GET', '/api/images');
    ok(r.data.images.length === before, 'cleaned up', { before: before, after: r.data.images.length });
  }

  section('book versions');
  r = await call(admin, 'POST', '/api/books/' + fid + '/versions', { title: '專案 A', label: '初版', chapters: noteIds });
  ok(r.status === 200 && r.data.version && r.data.version.chapters === 3, 'create book version', r.data);
  const bvId = r.data.version.id;
  r = await call(admin, 'GET', '/api/books/' + fid + '/versions');
  ok(r.status === 200 && r.data.versions.length === 1 && r.data.versions[0].id === bvId, 'list book versions', r.data);
  r = await call(admin, 'GET', '/api/book-versions/' + bvId);
  ok(r.status === 200 && r.data.version.chapters.length === 3 && r.data.version.chapters.every(c => !c.missing), 'get book version', r.data);
  r = await call(admin, 'GET', '/api/book-versions/' + bvId + '/chapters/' + noteIds[1]);
  ok(r.status === 200 && r.data.chapter.content.includes('A 改標題行'), 'chapter content pinned', r.data);
  cur = (await call(admin, 'GET', '/api/notes/' + noteIds[1])).data.note;
  await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: cur.title, content: 'overwritten', baseContent: cur.content, folderId: fid });
  r = await call(admin, 'POST', '/api/book-versions/' + bvId + '/restore');
  ok(r.status === 200 && r.data.restored === 1, 'restore book restores the changed chapter only', r.data);
  r = await call(admin, 'GET', '/api/notes/' + noteIds[1]);
  ok(r.data.note.content.includes('A 改標題行'), 'chapter text is back');
  r = await call(admin, 'POST', '/api/books/' + fid + '/versions', { title: '專案 A', chapters: [noteIds[0], noteIds[1]] });
  const bv2 = r.data.version.id;
  r = await call(bob, 'GET', '/api/book-versions/' + bvId);
  ok(r.status === 404, "bob cannot read admin's book version", r.status);
  r = await call(admin, 'DELETE', '/api/book-versions/' + bv2);
  ok(r.status === 200, 'delete second book version');
  r = await call(admin, 'GET', '/api/notes/' + noteIds[2] + '/versions');
  ok(r.data.versions.filter(v => v.label === '電子書版本').length === 1, 'pinned versions of the deleted book released, the other kept',
    r.data.versions.filter(v => v.label === '電子書版本').length);

  section('public share links');
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>專案 A</title></head><body>' +
    '<h1>專案 A</h1><p>' + 'x'.repeat(2 * 1024 * 1024) + '</p><script>console.log("inline")</script></body></html>';
  r = await call(admin, 'POST', '/api/books/' + fid + '/links', { title: '專案 A', html: html, chapters: 3, expiresDays: 0 });
  ok(r.status === 200 && /^[0-9a-f]{64}$/.test(r.data.link.token) && r.data.link.expiresAt === null, 'create share link', r.data);
  const tok = r.data.link.token;
  r = await call(anon, 'GET', '/s/' + tok);
  ok(r.status === 200 && r.data === html, 'anonymous GET serves the exact snapshot');
  ok((r.headers.get('content-security-policy') || '').includes("default-src 'none'") && !r.headers.get('set-cookie'),
    'snapshot has its own CSP and sets no cookie');
  r = await call(admin, 'PUT', '/api/book-links/' + tok, { html: html.replace('inline', 'updated'), chapters: 3, expiresDays: 30 });
  ok(r.status === 200 && r.data.link.expiresAt > Date.now(), 'refresh link + expiry', r.data);
  r = await call(anon, 'GET', '/s/' + tok);
  ok(r.status === 200 && r.data.includes('updated'), 'same URL serves the new snapshot');
  r = await call(admin, 'GET', '/api/books/' + fid + '/links');
  ok(r.status === 200 && r.data.links.length === 1 && r.data.links[0].views >= 2 && r.data.links[0].html === undefined, 'list: views counted, html not shipped', r.data);
  r = await call(admin, 'POST', '/api/books/' + fid + '/links', { title: '第二條', html: html, chapters: 3, expiresDays: 7 });
  const tok2 = r.data.link.token;
  r = await call(admin, 'DELETE', '/api/book-links/' + tok2);
  ok(r.status === 200, 'revoke second link');
  r = await call(anon, 'GET', '/s/' + tok2);
  ok(r.status === 404, 'revoked link is 404', r.status);
  r = await call(anon, 'GET', '/s/' + 'f'.repeat(64));
  ok(r.status === 404, 'unknown token is 404', r.status);
  r = await call(bob, 'POST', '/api/books/' + fid + '/links', { html: html });
  ok(r.status === 404, "bob cannot share admin's folder", r.status);

  // 單篇筆記的公開連結（分享給沒有帳號的人）。跟電子書的連結同一套：快照、唯讀、只有
  // 擁有者能管、token 猜不到。多了「筆記進垃圾桶連結就打不開」跟「小說不能開」。
  section('public note links');
  {
    const csp = r => r.headers.get('content-security-policy') || '';
    r = await call(admin, 'POST', '/api/notes', { title: '公開的報告', content: '# 公開\n\n給外面的人看' });
    const pub = r.data.note.id;
    const page = '<!doctype html><html><head><meta charset="utf-8"><title>公開的報告</title></head><body><h1>公開的報告</h1><p>v1</p></body></html>';
    r = await call(admin, 'GET', '/api/notes/' + pub + '/links');
    ok(r.status === 200 && r.data.links.length === 0, 'a note starts with no public link', r.data);
    r = await call(admin, 'GET', '/api/notes/' + pub);
    ok(r.data.note.publicLink === undefined, 'and is not flagged as public', r.data.note.publicLink);
    r = await call(admin, 'POST', '/api/notes/' + pub + '/links', { title: '公開的報告', html: page, rev: 0, expiresDays: 0 });
    ok(r.status === 200 && /^[0-9a-f]{64}$/.test(r.data.link.token) && r.data.link.noteId === pub && r.data.link.stale === false && r.data.link.expiresAt === null,
      'the owner creates a public link', r.data);
    const ntok = r.data.link.token;
    r = await call(anon, 'GET', '/s/' + ntok);
    ok(r.status === 200 && r.data === page, 'anonymous GET serves the snapshot, exactly as stored');
    ok(/sandbox allow-scripts/.test(csp(r)) && !/allow-same-origin/.test(csp(r)) && csp(r).includes("default-src 'none'") && !r.headers.get('set-cookie'),
      'the page is sandboxed (its own origin, no cookie, no network)', csp(r));
    r = await call(anon, 'GET', '/s/' + tok);
    ok(/sandbox allow-scripts/.test(csp(r)) && !/allow-same-origin/.test(csp(r)), 'the e-book page is sandboxed the same way', csp(r));
    r = await call(admin, 'GET', '/api/notes/' + pub);
    ok(r.data.note.publicLink === true, 'the note is now flagged as having a public link', r.data.note.publicLink);
    r = await call(admin, 'GET', '/api/notes');
    ok(r.data.notes.find(n => n.id === pub).publicLink === true && !r.data.notes.some(n => n.id !== pub && n.publicLink), 'the listing flags it, and only it');

    // 筆記改了：連結上還是舊的，stale
    cur = (await call(admin, 'GET', '/api/notes/' + pub)).data.note;
    r = await call(admin, 'PUT', '/api/notes/' + pub, { title: cur.title, content: cur.content + '\n\n第二版', baseContent: cur.content, folderId: null });
    const rev2 = r.data.note.rev;
    r = await call(admin, 'GET', '/api/notes/' + pub + '/links');
    ok(r.data.links.length === 1 && r.data.links[0].stale === true && r.data.links[0].html === undefined, 'after an edit the link is reported stale (and never ships its html)', r.data.links[0]);
    r = await call(anon, 'GET', '/s/' + ntok);
    ok(r.data === page, 'the anonymous page still shows the snapshot, not the edit');
    r = await call(admin, 'PUT', '/api/note-links/' + ntok, { html: page.replace('v1', 'v2'), rev: rev2, expiresDays: 30 });
    ok(r.status === 200 && r.data.link.stale === false && r.data.link.expiresAt > Date.now(), 'refreshing the link clears stale and can set an expiry', r.data);
    r = await call(anon, 'GET', '/s/' + ntok);
    ok(r.data.includes('v2'), 'the same URL now serves the new snapshot');
    r = await call(admin, 'PUT', '/api/note-links/' + ntok, { html: page, rev: 999 });
    ok(r.status === 200 && r.data.link.noteRev === rev2, 'a rev from the client is capped at the note\'s real rev', r.data.link);

    // 自動更新的開關：每個連結各自的設定，預設開
    r = await call(admin, 'GET', '/api/notes/' + pub + '/links');
    const before = r.data.links[0];
    ok(before.autoUpdate === true, 'a link auto-updates unless told otherwise', before.autoUpdate);
    r = await call(admin, 'PUT', '/api/note-links/' + ntok, { autoUpdate: false });
    ok(r.status === 200 && r.data.link.autoUpdate === false && r.data.link.updatedAt === before.updatedAt && r.data.link.noteRev === before.noteRev,
      'switching auto-update off is a setting only: the snapshot and its timestamp are untouched', r.data.link);
    r = await call(anon, 'GET', '/s/' + ntok);
    ok(r.status === 200 && r.data === page, 'and the page itself is exactly what it was');
    r = await call(admin, 'PUT', '/api/note-links/' + ntok, {});
    ok(r.status === 400, 'a PUT with neither a page nor a setting is refused', r.status);
    r = await call(bob, 'PUT', '/api/note-links/' + ntok, { autoUpdate: true });
    ok(r.status === 404, "bob cannot flip admin's setting", r.status);
    r = await call(admin, 'PUT', '/api/note-links/' + ntok, { html: page, rev: rev2, autoUpdate: true });
    ok(r.status === 200 && r.data.link.autoUpdate === true, 'a refresh can carry the setting too', r.data.link.autoUpdate);
    r = await call(admin, 'POST', '/api/notes/' + pub + '/links', { html: page, autoUpdate: false });
    ok(r.status === 200 && r.data.link.autoUpdate === false, 'a link can be created with auto-update off', r.data.link.autoUpdate);
    await call(admin, 'DELETE', '/api/note-links/' + r.data.link.token);

    // 別人
    r = await call(bob, 'GET', '/api/notes/' + pub + '/links');
    ok(r.status === 404, "bob cannot list admin's links", r.status);
    r = await call(bob, 'POST', '/api/notes/' + pub + '/links', { html: page });
    ok(r.status === 404, 'nor create one', r.status);
    r = await call(bob, 'PUT', '/api/note-links/' + ntok, { html: '<p>hijacked</p>' });
    ok(r.status === 404, 'nor overwrite it', r.status);
    r = await call(bob, 'DELETE', '/api/note-links/' + ntok);
    ok(r.status === 404, 'nor revoke it', r.status);
    await call(admin, 'POST', '/api/notes/' + pub + '/shares', { username: BOB, perm: 'edit' });
    r = await call(bob, 'POST', '/api/notes/' + pub + '/links', { html: page });
    ok(r.status === 404, 'an editor the owner shared with still cannot publish it', r.status);
    r = await call(bob, 'GET', '/api/notes/' + pub);
    ok(r.status === 200 && r.data.note.publicLink === undefined, 'the public flag is the owner\'s business only', r.data.note.publicLink);
    r = await call(anon, 'POST', '/api/notes/' + pub + '/links', { html: page });
    ok(r.status === 401, 'managing links needs a session', r.status);
    ok((await call(anon, 'GET', '/api/notes/' + pub)).status === 401, 'the token grants nothing on the API');

    // 限制與拒絕
    r = await call(admin, 'POST', '/api/notes/' + pub + '/links', { html: '' });
    ok(r.status === 400, 'an empty page is refused', r.status);
    r = await call(admin, 'POST', '/api/notes', { title: '小說', content: 'x', area: 'novel' });
    const novelNote = r.data.note && r.data.note.id;
    if (novelNote) {
      await call(admin, 'POST', '/api/novel/unlock', { password: ADMIN_PASSWORD });
      r = await call(admin, 'POST', '/api/notes/' + novelNote + '/links', { html: page });
      ok(r.status === 400 || r.status === 404, 'a novel note can never have a public link', r.status);
    }
    // 看板（js/board.js）是 area 'board' 的筆記：建得起來、列表帶著 area、垃圾桶認得它的 kind
    r = await call(admin, 'POST', '/api/notes', { title: '看板一', content: '```board\n{"bg":"blue","labels":[],"lists":[]}\n```\n', area: 'board', meta: { board: true } });
    ok(r.status === 200 && r.data.note && r.data.note.area === 'board', 'a board note is created in area board', r.status);
    const boardNote = r.data.note && r.data.note.id;
    if (boardNote) {
      r = await call(admin, 'GET', '/api/notes');
      ok(r.data.notes.some(n => n.id === boardNote && n.area === 'board'), 'the listing carries area board');
      r = await call(admin, 'PUT', '/api/notes/' + boardNote + '/area', { area: null });
      ok(r.status === 400, 'a board cannot be moved out of its area', r.status);
      await call(admin, 'DELETE', '/api/notes/' + boardNote);
      r = await call(admin, 'GET', '/api/trash');
      ok(r.data.notes.some(n => n.id === boardNote && n.kind === 'board'), 'the trash lists it as kind board');
      await call(admin, 'POST', '/api/notes/' + boardNote + '/restore');
    }
    // 起始頁（js/startpage.js）：area 'start'，同一套
    r = await call(admin, 'POST', '/api/notes', { title: '起始頁一', content: '```startpage\n{"bg":"grey","columns":4,"search":"google","widgets":[]}\n```\n', area: 'start', meta: { startpage: true } });
    ok(r.status === 200 && r.data.note && r.data.note.area === 'start', 'a start page note is created in area start', r.status);
    if (r.data.note) {
      const sp = r.data.note.id;
      await call(admin, 'DELETE', '/api/notes/' + sp);
      r = await call(admin, 'GET', '/api/trash');
      ok(r.data.notes.some(n => n.id === sp && n.kind === 'start'), 'the trash lists it as kind start');
      await call(admin, 'POST', '/api/notes/' + sp + '/restore');
    }

    // 心智圖（js/xmind.js）：area 'xmind'，同一套；內文是 ```xmind 圍欄的 JSON
    r = await call(admin, 'POST', '/api/notes', { title: '心智圖一', content: '```xmind\n{"sheets":[{"id":"s1","name":"工作表 1","theme":"classic","structure":"map","root":{"id":"r","title":"中心","children":[]}}]}\n```\n', area: 'xmind', meta: { xmind: true } });
    ok(r.status === 200 && r.data.note && r.data.note.area === 'xmind', 'an xmind note is created in area xmind', r.status);
    if (r.data.note) {
      const xm = r.data.note.id;
      r = await call(admin, 'PUT', '/api/notes/' + xm + '/area', { area: null });
      ok(r.status === 400, 'a mind map cannot be moved out of its area', r.status);
      await call(admin, 'DELETE', '/api/notes/' + xm);
      r = await call(admin, 'GET', '/api/trash');
      ok(r.data.notes.some(n => n.id === xm && n.kind === 'xmind'), 'the trash lists it as kind xmind');
      await call(admin, 'POST', '/api/notes/' + xm + '/restore');
    }

    // 行事曆（js/timetree.js）：area 'timetree'，同一套；內文是 ```timetree 圍欄的 JSON
    r = await call(admin, 'POST', '/api/notes', { title: '行事曆一', content: '```timetree\n{"color":"#2ec4a6","labels":[],"events":[{"id":"e1","title":"考試","allDay":true,"start":"2026-10-20","end":"2026-10-20"}]}\n```\n', area: 'timetree', meta: { timetree: true } });
    ok(r.status === 200 && r.data.note && r.data.note.area === 'timetree', 'a timetree note is created in area timetree', r.status);
    if (r.data.note) {
      const tt = r.data.note.id;
      r = await call(admin, 'PUT', '/api/notes/' + tt + '/area', { area: null });
      ok(r.status === 400, 'a calendar cannot be moved out of its area', r.status);
      await call(admin, 'DELETE', '/api/notes/' + tt);
      r = await call(admin, 'GET', '/api/trash');
      ok(r.data.notes.some(n => n.id === tt && n.kind === 'timetree'), 'the trash lists it as kind timetree');
      await call(admin, 'POST', '/api/notes/' + tt + '/restore');
    }

    // 課程進度（js/progress.js）：area 'progress'，同一套；內文是 ```progress 圍欄的 JSON
    r = await call(admin, 'POST', '/api/notes', { title: '課程一', content: '```progress\n{"color":"#d9962a","chapters":[{"id":"c1","title":"第一章","done":true},{"id":"c2","title":"第二章","due":"2026-10-20"}]}\n```\n', area: 'progress', meta: { progress: true } });
    ok(r.status === 200 && r.data.note && r.data.note.area === 'progress', 'a course-progress note is created in area progress', r.status);
    if (r.data.note) {
      const pg = r.data.note.id;
      r = await call(admin, 'PUT', '/api/notes/' + pg + '/area', { area: 'course' });
      ok(r.status === 400, 'a course cannot be moved out of its area', r.status);
      await call(admin, 'DELETE', '/api/notes/' + pg);
      r = await call(admin, 'GET', '/api/trash');
      ok(r.data.notes.some(n => n.id === pg && n.kind === 'progress'), 'the trash lists it as kind progress');
      await call(admin, 'POST', '/api/notes/' + pg + '/restore');
    }

    // 垃圾桶：連結跟著筆記的狀態
    r = await call(admin, 'DELETE', '/api/notes/' + pub);
    r = await call(anon, 'GET', '/s/' + ntok);
    ok(r.status === 404, 'a trashed note\'s link is 404', r.status);
    r = await call(admin, 'GET', '/api/notes/' + pub + '/links');
    ok(r.status === 404, 'and cannot be managed while trashed', r.status);
    await call(admin, 'POST', '/api/notes/' + pub + '/restore', {});
    r = await call(anon, 'GET', '/s/' + ntok);
    ok(r.status === 200, 'restoring the note brings the link back', r.status);

    // 第二條、取消、上限
    r = await call(admin, 'POST', '/api/notes/' + pub + '/links', { html: page, expiresDays: 7 });
    const ntok2 = r.data.link.token;
    r = await call(admin, 'GET', '/api/notes/' + pub + '/links');
    ok(r.data.links.length === 2 && r.data.links[0].views !== undefined, 'a note can carry several links (different expiry, different people)', r.data.links.length);
    r = await call(admin, 'DELETE', '/api/note-links/' + ntok2);
    ok(r.status === 200 && (await call(anon, 'GET', '/s/' + ntok2)).status === 404, 'a revoked link dies at once');
    ok((await call(anon, 'GET', '/s/' + 'e'.repeat(64))).status === 404, 'an unknown token is 404');

    // 永久刪除：連結連著消失
    await call(admin, 'DELETE', '/api/notes/' + pub);
    await call(admin, 'DELETE', '/api/trash/' + pub);
    r = await call(anon, 'GET', '/s/' + ntok);
    ok(r.status === 404, 'purging the note deletes its links with it', r.status);
    r = await call(admin, 'GET', '/api/notes');
    ok(!r.data.notes.some(n => n.publicLink), 'no note is flagged public any more');
  }

  if (!OLD) {
    section('trash (soft delete, restore, purge)');
    r = await call(admin, 'POST', '/api/notes', { title: '垃圾桶測試', content: 'bin me' });
    const binId = r.data.note.id;
    r = await call(bob, 'DELETE', '/api/notes/' + binId);
    ok(r.status === 404, 'stranger cannot trash a note', r.status);
    r = await call(admin, 'DELETE', '/api/notes/' + binId);
    ok(r.status === 200, 'owner moves a note to the trash');
    r = await call(admin, 'GET', '/api/notes/' + binId);
    ok(r.status === 404, 'trashed note is 404 on GET', r.status);
    r = await call(admin, 'GET', '/api/notes');
    ok(!r.data.notes.some(n => n.id === binId), 'trashed note is gone from the list');
    r = await call(admin, 'PUT', '/api/notes/' + binId, { title: 'x', content: 'y' });
    ok(r.status === 404, 'trashed note cannot be saved to', r.status);
    r = await call(admin, 'GET', '/api/trash');
    ok(r.status === 200 && typeof r.data.keepDays === 'number' &&
       r.data.notes.some(n => n.id === binId && n.deletedAt && n.expiresAt > n.deletedAt && n.title === '垃圾桶測試'),
      'trash lists it with an expiry', r.data);
    r = await call(bob, 'GET', '/api/trash');
    ok(r.status === 200 && !r.data.notes.some(n => n.id === binId), 'trash is per owner');
    r = await call(bob, 'POST', '/api/notes/' + binId + '/restore');
    ok(r.status === 404, 'stranger cannot restore', r.status);
    r = await call(admin, 'POST', '/api/notes/' + binId + '/restore');
    ok(r.status === 200 && r.data.note && r.data.note.id === binId, 'owner restores', r.data);
    r = await call(admin, 'GET', '/api/notes/' + binId);
    ok(r.status === 200 && r.data.note.content === 'bin me', 'restored note reads back intact');
    r = await call(admin, 'POST', '/api/notes/' + binId + '/restore');
    ok(r.status === 404, 'restoring a live note is 404', r.status);
    await call(admin, 'DELETE', '/api/notes/' + binId);
    r = await call(bob, 'DELETE', '/api/trash/' + binId);
    ok(r.status === 404, 'stranger cannot purge', r.status);
    r = await call(admin, 'DELETE', '/api/trash/' + binId);
    ok(r.status === 200, 'owner purges for good');
    r = await call(admin, 'GET', '/api/trash');
    ok(!r.data.notes.some(n => n.id === binId), 'purged note left the trash');
    r = await call(admin, 'POST', '/api/notes/' + binId + '/restore');
    ok(r.status === 404, 'purged note cannot be restored', r.status);
    // Restoring after the folder it lived in was deleted lands at the top level.
    r = await call(admin, 'POST', '/api/folders', { name: '暫存夾' });
    const tmpFolder = r.data.folder.id;
    r = await call(admin, 'POST', '/api/notes', { title: '夾內', content: 'in folder', folderId: tmpFolder });
    const bin3 = r.data.note.id;
    await call(admin, 'DELETE', '/api/notes/' + bin3);
    await call(admin, 'DELETE', '/api/folders/' + tmpFolder);
    r = await call(admin, 'POST', '/api/notes/' + bin3 + '/restore');
    ok(r.status === 200 && r.data.note.folderId === null, 'restore after its folder was deleted → top level', r.data);
    r = await call(admin, 'POST', '/api/notes', { title: '清空測試', content: 'z' });
    await call(admin, 'DELETE', '/api/notes/' + r.data.note.id);
    await call(admin, 'DELETE', '/api/notes/' + bin3);
    r = await call(admin, 'DELETE', '/api/trash');
    ok(r.status === 200 && r.data.purged === 2, 'empty trash reports what it removed', r.data);
    r = await call(admin, 'GET', '/api/trash');
    ok(r.status === 200 && r.data.notes.length === 0, 'trash is empty afterwards');
  }

  if (!OLD) {
    section('image library');
    const upload = async function () {
      const res = await call(admin, 'POST', '/api/images', PNG, { raw: true, contentType: 'image/png' });
      return res.data.id;
    };
    const usedId = await upload(), binOnlyId = await upload(), unusedId = await upload(), foreignRefId = await upload();
    r = await call(admin, 'POST', '/api/notes', {
      title: '圖庫：使用中',
      content: '![螢幕截圖](img:' + usedId + ')\n\n又一次 ![](img:' + usedId + ')，句尾引用 img:' + foreignRefId + '.'
    });
    const libLive = r.data.note.id;
    r = await call(admin, 'POST', '/api/notes', { title: '圖庫：垃圾桶', content: '![bin](img:' + binOnlyId + ')' });
    await call(admin, 'DELETE', '/api/notes/' + r.data.note.id);
    // Bob pastes one of admin's image ids into a private note of his own.
    await call(bob, 'POST', '/api/notes', { title: 'bob 的私人筆記', content: '![不該外洩的替代文字](img:' + foreignRefId + ')' });
    r = await call(admin, 'GET', '/api/images');
    const lib = r.status === 200 && Array.isArray(r.data.images) ? r.data.images : [];
    const entry = id => lib.find(i => i.id === id) || { notes: [] };
    ok(lib.length >= 4 && lib.every(i => typeof i.bytes === 'number' && i.data === undefined && Array.isArray(i.notes)),
      'lists own uploads, metadata only', r.status);
    const used = entry(usedId);
    ok(used.notes.length === 1 && used.notes[0].id === libLive && used.notes[0].count === 2 && used.name === '螢幕截圖',
      'used image: which note, how often, alt text as name', used);
    const binOnly = entry(binOnlyId);
    ok(binOnly.notes.length === 1 && binOnly.notes[0].trashed === true, 'image used only by a trashed note says so', binOnly);
    const unused = entry(unusedId);
    ok(unused.notes.length === 0 && unused.hiddenNotes === 0, 'unused image has no notes', unused);
    const foreign = entry(foreignRefId);
    ok(foreign.notes.length === 1 && foreign.hiddenNotes === 1 && foreign.name === '',
      'a note the owner cannot read is counted, not named, and its alt text is not used', foreign);
    ok(entry(imgId).notes.some(n => n.id === noteIds[0]) && entry(pdfId).name === 'report' && entry(pdfId).mime === 'application/pdf',
      'earlier image and PDF resolve to their notes', { img: entry(imgId), pdf: entry(pdfId) });
    ok(entry(fileId).name === '報告 附件.html' && entry(fileId).notes.some(n => n.id === noteIds[0]),
      'an attachment is listed under its uploaded name, used by the note that links it', entry(fileId));
    r = await call(bob, 'GET', '/api/images');
    ok(r.status === 200 && !r.data.images.some(i => i.id === usedId || i.id === foreignRefId), "bob's library does not list admin's uploads", r.data);
    await call(bob, 'DELETE', '/api/images/' + unusedId);
    r = await call(admin, 'GET', '/api/images');
    ok(r.data.images.some(i => i.id === unusedId), "a stranger's delete leaves the image alone");
    r = await call(admin, 'DELETE', '/api/images/' + unusedId);
    ok(r.status === 200, 'owner deletes an unused image');
    r = await call(admin, 'GET', '/api/images');
    ok(!r.data.images.some(i => i.id === unusedId), 'deleted image left the library');
  }

  if (!OLD) {
    section('manual order');
    r = await call(admin, 'POST', '/api/folders', { name: '排序測試' });
    const ordFolder = r.data.folder.id;
    const ord = [];
    for (const t of ['甲', '乙', '丙']) {
      r = await call(admin, 'POST', '/api/notes', { title: t, content: t, folderId: ordFolder });
      ord.push(r.data.note);
    }
    r = await call(admin, 'POST', '/api/notes', { title: '頂層', content: 'top' });
    const topNote = r.data.note;
    ok(topNote.position === null, 'a new note has no manual position', topNote.position);
    r = await call(admin, 'PUT', '/api/order', { parentId: ordFolder, notes: [ord[2].id, ord[0].id, topNote.id, ord[1].id] });
    ok(r.status === 200, "save one level's order", r.data);
    r = await call(admin, 'GET', '/api/notes');
    const noteRow = id => r.data.notes.find(n => n.id === id) || {};
    ok(noteRow(ord[2].id).position === 1 && noteRow(ord[0].id).position === 2 && noteRow(ord[1].id).position === 4,
      'positions follow the saved order', [ord[2], ord[0], ord[1]].map(n => noteRow(n.id).position));
    ok(noteRow(topNote.id).folderId === ordFolder && noteRow(topNote.id).position === 3,
      'a row listed from another level moves in', noteRow(topNote.id));
    ok(noteRow(ord[0].id).rev === ord[0].rev && noteRow(ord[0].id).updatedAt === ord[0].updatedAt,
      'ordering is bookkeeping: no rev bump, no updatedAt change', noteRow(ord[0].id));
    r = await call(bob, 'PUT', '/api/order', { parentId: null, notes: [ord[0].id] });
    const strangerStatus = r.status;
    r = await call(admin, 'GET', '/api/notes');
    ok(strangerStatus === 200 && noteRow(ord[0].id).folderId === ordFolder && noteRow(ord[0].id).position === 2,
      "a stranger's order request leaves someone else's notes alone", noteRow(ord[0].id));
    r = await call(bob, 'PUT', '/api/order', { parentId: ordFolder, notes: [] });
    ok(r.status === 404, "cannot order into someone else's folder", r.status);
    r = await call(admin, 'POST', '/api/folders', { name: '子', parentId: ordFolder });
    const ordKid = r.data.folder.id;
    r = await call(admin, 'PUT', '/api/order', { parentId: ordKid, folders: [ordFolder] });
    ok(r.status === 400, 'a folder cannot be moved into its own subfolder', r.status);
    r = await call(admin, 'PUT', '/api/order', { parentId: null, folders: [ordFolder, fid] });
    ok(r.status === 200, 'folder order at the top level', r.data);
    r = await call(admin, 'GET', '/api/folders');
    const folderPos = id => (r.data.folders.find(f => f.id === id) || {}).position;
    ok(folderPos(ordFolder) === 1 && folderPos(fid) === 2 && folderPos(ordKid) === null, 'folder positions stored',
      [folderPos(ordFolder), folderPos(fid), folderPos(ordKid)]);

    // One level is one area: a drag must never file a row into another area's folder,
    // where neither area's tree would show it.
    r = await call(admin, 'POST', '/api/folders', { name: '課程資料夾', area: 'course' });
    const crsFolder = r.data.folder.id;
    r = await call(admin, 'POST', '/api/notes', { title: '課程筆記一', area: 'course', folderId: crsFolder });
    const crsNote = r.data.note.id;
    r = await call(admin, 'POST', '/api/notes', { title: '課程筆記二', area: 'course' });
    const crsTop = r.data.note.id;
    r = await call(admin, 'PUT', '/api/order', { parentId: crsFolder, notes: [ord[0].id] });
    ok(r.status === 400, "a general note cannot be ordered into a course folder", r.status);
    r = await call(admin, 'PUT', '/api/order', { parentId: ordFolder, notes: [crsNote] });
    ok(r.status === 400, "a course note cannot be ordered into a general folder", r.status);
    r = await call(admin, 'PUT', '/api/order', { parentId: null, notes: [crsTop, ord[0].id] });
    ok(r.status === 400, 'a top level cannot mix areas', r.status);
    r = await call(admin, 'PUT', '/api/order', { parentId: ordFolder, folders: [crsFolder] });
    ok(r.status === 400, "a course folder cannot be moved into a general folder", r.status);
    r = await call(admin, 'GET', '/api/notes/' + crsNote);
    ok(r.data.note.folderId === crsFolder && (await call(admin, 'GET', '/api/notes/' + ord[0].id)).data.note.folderId === ordFolder,
      'nothing moved on a refused order', r.data.note.folderId);
    r = await call(admin, 'PUT', '/api/order', { parentId: crsFolder, notes: [crsTop, crsNote] });
    ok(r.status === 200, 'ordering inside one area works', r.data);
    r = await call(admin, 'GET', '/api/notes/' + crsTop);
    ok(r.data.note.folderId === crsFolder && r.data.note.position === 1 && r.data.note.area === 'course', 'the course note moved into the course folder', r.data.note);

    section('link preview guard');
    const refused = ['http://127.0.0.1:8090/', 'http://localhost/', 'http://localhost./', 'http://[::1]/',
      'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/', 'http://192.168.1.1/', 'http://0x7f000001/', 'http://2130706433/',
      'http://example.com:8080/', 'https://user:pw@example.com/', 'file:///etc/passwd', 'javascript:alert(1)'];
    for (const u of refused) {
      r = await call(admin, 'GET', '/api/link-preview?url=' + encodeURIComponent(u));
      ok(r.status === 200 && r.data && r.data.error && !r.data.title, 'link preview refuses ' + u, r.data);
    }
    r = await call(admin, 'GET', '/api/link-preview/image?url=' + encodeURIComponent('http://127.0.0.1:8090/logo.png'), undefined, { buffer: true });
    ok(r.status === 404, 'preview image proxy refuses loopback', r.status);
    r = await call(anon, 'GET', '/api/link-preview?url=' + encodeURIComponent('https://example.com/'));
    ok(r.status === 401, 'link preview needs a session', r.status);
  }

  section('SSE');
  {
    const ac = new AbortController();
    const res = await fetch(BASE + '/api/notes/' + noteIds[0] + '/events', { headers: { Cookie: admin.header() }, signal: ac.signal });
    ok(res.status === 200 && (res.headers.get('content-type') || '').includes('text/event-stream'), 'stream opens');
    const reader = res.body.getReader();
    let got = '';
    const waiter = (async function () {
      const dec = new TextDecoder();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ done: false, value: null }), 500))]);
        if (chunk.done) break;
        if (chunk.value) got += dec.decode(chunk.value);
        if (/event: update/.test(got)) break;
      }
    })();
    await new Promise(r => setTimeout(r, 300));
    cur = (await call(bob, 'GET', '/api/notes/' + noteIds[0])).data.note;
    await call(bob, 'PUT', '/api/notes/' + noteIds[0], { title: cur.title, content: cur.content + '\nfrom bob', baseContent: cur.content });
    await waiter;
    ok(/event: update/.test(got) && /"by":"bob"/.test(got), "bob's save arrives on admin's stream", got.slice(0, 200));
    ac.abort();
  }

  section('admin');
  // 系統監控（/api/admin/system）：只有數字，沒有筆記內容；非管理員 403
  r = await call(admin, 'GET', '/api/admin/system');
  ok(r.status === 200 && r.data.host && typeof r.data.host.cores === 'number' && r.data.mem && r.data.mem.total > 0 &&
     r.data.proc && r.data.proc.pid > 0 && r.data.hub && r.data.sessions && r.data.storage && r.data.storage.notes,
    'system monitor returns host / mem / proc / hub / sessions / storage', r.data && Object.keys(r.data));
  ok(!/"content"|"title"/.test(JSON.stringify(r.data)), 'and carries no note text');
  r = await call(bob, 'GET', '/api/admin/system');
  ok(r.status === 403, 'system monitor is admin only', r.status);
  r = await call(bob, 'GET', '/api/admin/users');
  ok(r.status === 403, 'non-admin is 403', r.status);
  r = await call(admin, 'GET', '/api/admin/users');
  ok(r.status === 200 && r.data.users.length === 2 && r.data.users.every(u => typeof u.notes === 'number'), 'list users with numeric counts', r.data);
  r = await call(admin, 'POST', '/api/admin/users/' + bobId + '/disabled', { disabled: true });
  ok(r.status === 200 && r.data.disabled === true, 'disable bob', r.data);
  r = await call(bob, 'GET', '/api/notes');
  ok(r.status === 401, "bob's session died with the disable", r.status);
  r = await login(bob, BOB, BOB_PW);
  ok(r.status === 403, 'disabled bob cannot log in', r.status);
  r = await call(admin, 'POST', '/api/admin/users/' + bobId + '/disabled', { disabled: false });
  ok(r.status === 200, 're-enable bob');
  r = await login(bob, BOB, BOB_PW);
  ok(r.status === 200, 'bob logs in again');
  r = await call(admin, 'POST', '/api/admin/users/' + bobId + '/role', { role: 'admin' });
  ok(r.status === 200 && r.data.role === 'admin', 'promote bob');
  r = await call(admin, 'POST', '/api/admin/users/' + bobId + '/role', { role: 'user' });
  ok(r.status === 200 && r.data.role === 'user', 'demote bob');
  const me = (await call(admin, 'GET', '/api/me')).data.user;
  r = await call(admin, 'POST', '/api/admin/users/' + me.id + '/role', { role: 'user' });
  ok(r.status === 400, 'cannot demote self', r.status);
  r = await call(admin, 'GET', '/api/admin/storage');
  ok(r.status === 200 && r.data.images.count >= 2 && r.data.images.bytes > 20 * 1024 * 1024 && r.data.notes.count >= 4 &&
     r.data.versions.count > 0 && r.data.links.count === 1 && Array.isArray(r.data.perUser) && typeof r.data.dbBytes === 'number',
    'storage panel numbers', r.data && { images: r.data.images, notes: r.data.notes, links: r.data.links, dbBytes: r.data.dbBytes, dataDir: r.data.dataDir });

  if (!OLD) {
    section('registration settings');
    r = await call(bob, 'GET', '/api/admin/settings');
    ok(r.status === 403, 'a non-admin cannot read registration settings', r.status);
    r = await call(admin, 'GET', '/api/admin/settings');
    ok(r.status === 200 && r.data.registerMode === 'open', 'settings start from REGISTER_MODE', r.data);
    r = await call(admin, 'PUT', '/api/admin/settings', { registerMode: 'invite', inviteCode: 'smoke-invite-1' });
    ok(r.status === 200 && r.data.registerMode === 'invite' && r.data.inviteCode === 'smoke-invite-1',
      'switch to invite with a chosen code', r.data);
    r = await call(anon, 'GET', '/api/me');
    ok(r.data && r.data.registerMode === 'invite', '/api/me reports the new mode at once', r.data);
    const carol = jar();
    r = await call(carol, 'POST', '/api/register', { username: 'carol', password: 'carol-password-123', invite: '' });
    ok(r.status === 400, 'invite mode refuses a missing code', r.data);
    r = await call(carol, 'POST', '/api/register', { username: 'carol', password: 'carol-password-123', invite: '邀請碼邀請碼' });
    ok(r.status === 400, 'a wrong multi-byte code is a plain refusal, not a crash', r.status);
    r = await call(carol, 'POST', '/api/register', { username: 'carol', password: 'carol-password-123', invite: 'smoke-invite-1' });
    ok(r.status === 200 && r.data.user, 'the right code registers', r.data);
    if (r.data && r.data.user) await call(admin, 'DELETE', '/api/admin/users/' + r.data.user.id);
    r = await call(admin, 'PUT', '/api/admin/settings', { regenerateInvite: true });
    ok(r.status === 200 && r.data.inviteCode && r.data.inviteCode !== 'smoke-invite-1', 'regenerate replaces the code', r.data);
    r = await call(admin, 'PUT', '/api/admin/settings', { inviteCode: 'has space' });
    ok(r.status === 400, 'an invite code with a space is refused', r.status);
    r = await call(admin, 'PUT', '/api/admin/settings', { registerMode: 'everyone' });
    ok(r.status === 400, 'an unknown mode is refused', r.status);
    await call(admin, 'PUT', '/api/admin/settings', { registerMode: 'closed' });
    r = await call(jar(), 'POST', '/api/register', { username: 'dave', password: 'dave-password-123', invite: '' });
    ok(r.status === 400, 'closed mode refuses registration', r.data);
    r = await call(admin, 'PUT', '/api/admin/settings', { registerMode: 'open' });
    ok(r.status === 200 && r.data.registerMode === 'open', 'back to open', r.data);
  }

  if (!OLD) {
    section('backup and restore');
    const { ZipReader } = require('../zip');
    const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
    const openZip = function (buf) {
      const f = path.join(os.tmpdir(), 'smoke-' + crypto.randomBytes(4).toString('hex') + '.zip');
      fs.writeFileSync(f, buf);
      return { zr: ZipReader.open(f), f: f };
    };
    const readJson = (zr, name) => JSON.parse(zr.read(name, 1 << 26).toString('utf8'));
    const RAW = { raw: true, contentType: 'application/octet-stream' };
    async function uploadZip(session, buf) {
      const c = await call(session, 'POST', '/api/backup/upload', {});
      const id = c.data.id;
      const half = Math.ceil(buf.length / 2);
      let res = await call(session, 'PUT', '/api/backup/upload/' + id + '?offset=0', buf.subarray(0, half), RAW);
      if (res.status !== 200) throw new Error('chunk 1: ' + res.status + ' ' + JSON.stringify(res.data));
      res = await call(session, 'PUT', '/api/backup/upload/' + id + '?offset=' + half, buf.subarray(half), RAW);
      if (res.status !== 200) throw new Error('chunk 2: ' + res.status + ' ' + JSON.stringify(res.data));
      return id;
    }
    async function waitJob(session, jobId) {
      for (let i = 0; i < 300; i++) {
        const s = await call(session, 'GET', '/api/backup/jobs/' + jobId);
        if (s.data && s.data.finished) return s.data;
        await new Promise(r => setTimeout(r, 200));
      }
      throw new Error('restore job did not finish');
    }

    // carol: a folder, a note with an image, an edit, a labelled version, a share, a trashed note.
    const carol = jar();
    r = await call(carol, 'POST', '/api/register', { username: 'carol', password: 'carol-password-123', invite: '' });
    ok(r.status === 200, 'carol registered', r.data);
    r = await call(carol, 'POST', '/api/folders', { name: '備份資料夾' });
    const cFolder = r.data.folder.id;
    // 從圖示庫上傳（drawio 的「我的圖示」）：檔案本身跟一般上傳一樣，多一個要跟著備份走的標記
    r = await call(carol, 'POST', '/api/icons', PNG, { raw: true, contentType: 'image/png', headers: { 'X-File-Name': encodeURIComponent('截圖.png') } });
    const cImg = r.data.icon.id;
    r = await call(carol, 'POST', '/api/notes', { title: '第一章', content: '# 第一章\n\n![截圖](img:' + cImg + ')\n\n內文 🚀', folderId: cFolder });
    const cNote = r.data.note;
    r = await call(carol, 'PUT', '/api/notes/' + cNote.id, { title: cNote.title, content: cNote.content + '\n\n第二段', baseContent: cNote.content, folderId: cFolder });
    const cNoteV2 = r.data.note;
    await call(carol, 'POST', '/api/notes/' + cNote.id + '/versions', { label: '備份前標記' });
    await call(carol, 'POST', '/api/notes/' + cNote.id + '/shares', { username: BOB, perm: 'read' });
    // 一個公開連結（分享給沒有帳號的人）：備份要帶著走，還原回來同一個網址要能開
    r = await call(carol, 'POST', '/api/notes/' + cNote.id + '/links', { html: '<p>public snapshot</p>', rev: cNoteV2.rev, autoUpdate: false });
    const cLink = r.data.link.token;
    r = await call(carol, 'POST', '/api/notes', { title: '要丟掉的', content: 'bin' });
    const cBin = r.data.note.id;
    await call(carol, 'DELETE', '/api/notes/' + cBin);

    r = await call(carol, 'GET', '/api/backup?scope=mine', undefined, { buffer: true });
    ok(r.status === 200 && (r.headers.get('content-type') || '').includes('zip') &&
       /^attachment; filename="capynote-backup-mine-/.test(r.headers.get('content-disposition') || ''), 'download a mine backup', r.status);
    const mineZip = r.data;
    let z = openZip(mineZip);
    const man = readJson(z.zr, 'manifest.json');
    const notesIdx = readJson(z.zr, 'notes.json');
    const filesIdx = readJson(z.zr, 'files.json');
    ok(man.format === 'capynote-backup' && man.scope === 'mine' && man.counts.notes === 2 && man.counts.files === 1 && man.counts.folders === 1,
      'manifest describes the backup', man);
    const n1 = notesIdx.find(n => n.id === cNote.id);
    ok(n1 && n1.file === 'notes/備份資料夾/第一章.md' && z.zr.read(n1.file).toString('utf8') === cNoteV2.content,
      'a note is a .md under its folder path', n1 && n1.file);
    ok(n1 && n1.versions.length >= 2 && n1.versions.some(v => v.label === '備份前標記') && n1.shares.some(s => s.username === BOB),
      'versions and shares are indexed', n1 && { versions: n1.versions.length, shares: n1.shares });
    const nBin = notesIdx.find(n => n.id === cBin);
    ok(nBin && nBin.deletedAt && /^notes\/_垃圾桶\//.test(nBin.file), 'a trashed note sits under _垃圾桶', nBin && nBin.file);
    ok(filesIdx.length === 1 && filesIdx[0].file === 'files/' + cImg + '.png' && z.zr.read(filesIdx[0].file).equals(PNG) && filesIdx[0].name === '截圖.png',
      'an upload is stored byte for byte with its name', filesIdx[0]);
    ok(filesIdx[0].icon === true, 'an icon is marked as one in files.json', filesIdx[0]);
    ok(!z.zr.has('users.json'), 'a mine backup carries no accounts');
    const linksIdx = readJson(z.zr, 'links.json');
    ok(man.counts.noteLinks === 1 && linksIdx.length === 1 && linksIdx[0].token === cLink && linksIdx[0].noteId === cNote.id &&
       z.zr.read(linksIdx[0].file).toString('utf8') === '<p>public snapshot</p>' && linksIdx[0].autoUpdate === false,
      'a public note link is in the backup with its page and its auto-update setting', linksIdx[0]);
    z.zr.close(); fs.unlinkSync(z.f);

    r = await call(carol, 'GET', '/api/backup?scope=site');
    ok(r.status === 403, 'a site backup needs an admin', r.status);
    r = await call(admin, 'GET', '/api/backup?scope=site', undefined, { buffer: true });
    ok(r.status === 200, 'the admin downloads a site backup', r.status);
    const siteZip = r.data;
    z = openZip(siteZip);
    const users = readJson(z.zr, 'users.json');
    const bobRow = users.find(u => u.username === BOB);
    ok(bobRow && bobRow.pwHash && bobRow.pwSalt && readJson(z.zr, 'manifest.json').scope === 'site',
      'a site backup carries accounts with their password hashes', bobRow && Object.keys(bobRow));
    ok(readJson(z.zr, 'notes.json').some(n => n.owner === 'carol' && /^notes\/carol\//.test(n.file)), 'a site backup nests notes under their owner');
    ok(z.zr.has('settings.json'), 'a site backup carries the registration settings');
    z.zr.close(); fs.unlinkSync(z.f);

    // Wipe carol (cascade) and bring her back empty: the disaster this is for.
    const carolId = (await call(carol, 'GET', '/api/me')).data.user.id;
    r = await call(admin, 'DELETE', '/api/admin/users/' + carolId);
    ok(r.status === 200, 'carol is deleted with everything she had');
    const carol2 = jar();
    r = await call(carol2, 'POST', '/api/register', { username: 'carol', password: 'carol-password-123', invite: '' });
    ok(r.status === 200 && (await call(carol2, 'GET', '/api/notes')).data.notes.length === 0, 'carol is back with nothing');

    let upId = await uploadZip(carol2, mineZip);
    r = await call(carol2, 'PUT', '/api/backup/upload/' + upId + '?offset=0', Buffer.from('x'), RAW);
    ok(r.status === 409, 'a chunk at the wrong offset is refused', r.status);
    r = await call(bob, 'POST', '/api/backup/upload/' + upId + '/inspect', {});
    ok(r.status === 404, "another user cannot see carol's upload", r.status);
    r = await call(carol2, 'POST', '/api/backup/upload/' + upId + '/inspect', {});
    ok(r.status === 200 && r.data.scope === 'mine' && r.data.counts.notes === 2 && r.data.canRestore === true, 'inspect reads the manifest', r.data);
    r = await call(carol2, 'POST', '/api/backup/upload/' + upId + '/restore', {});
    ok(r.status === 200 && r.data.job, 'restore starts a job', r.data);
    let job = await waitJob(carol2, r.data.job);
    ok(!job.error && job.report.notes.created === 2 && job.report.notes.trashed === 1 && job.report.files.created === 1 &&
       job.report.folders.created === 1 && job.report.versions.created >= 2 && job.report.shares.created === 1,
      'restore recreates folder, notes, versions, file and share', job.error || job.report);
    r = await call(carol2, 'GET', '/api/notes/' + cNote.id);
    ok(r.status === 200 && r.data.note.content === cNoteV2.content && r.data.note.folderId === cFolder && r.data.note.rev === cNoteV2.rev,
      'the note is back with its content, folder and rev', r.data && r.data.note && { rev: r.data.note.rev, folder: r.data.note.folderId });
    r = await call(carol2, 'GET', '/api/images/' + cImg, undefined, { buffer: true });
    ok(r.status === 200 && r.data.equals(PNG), 'the image is back byte for byte', r.status);
    r = await call(carol2, 'GET', '/api/icons');
    ok(r.status === 200 && r.data.icons.length === 1 && r.data.icons[0].id === cImg && r.data.icons[0].name === '截圖.png',
      'and it is back in the icon library', r.data);
    r = await call(carol2, 'GET', '/api/notes/' + cNote.id + '/versions');
    ok(r.status === 200 && r.data.versions.some(v => v.label === '備份前標記'), 'the labelled version is back', r.data && r.data.versions.map(v => v.label));
    r = await call(bob, 'GET', '/api/notes/' + cNote.id);
    ok(r.status === 200 && r.data.note.perm === 'read', 'the share to bob is back', r.status);
    r = await call(anon, 'GET', '/s/' + cLink);
    ok(r.status === 200 && r.data === '<p>public snapshot</p>' && job.report.links && job.report.links.created === 1,
      'the public note link is back at the same URL', { status: r.status, report: job.report.links });
    r = await call(carol2, 'GET', '/api/notes/' + cNote.id + '/links');
    ok(r.status === 200 && r.data.links.length === 1 && r.data.links[0].autoUpdate === false, 'with auto-update still off', r.data.links);
    r = await call(carol2, 'GET', '/api/trash');
    ok(r.data.notes.some(n => n.id === cBin), 'the trashed note is back in the trash');

    upId = await uploadZip(carol2, mineZip);
    r = await call(carol2, 'POST', '/api/backup/upload/' + upId + '/restore', {});
    job = await waitJob(carol2, r.data.job);
    ok(!job.error && job.report.notes.created === 0 && job.report.notes.skipped === 2 && job.report.files.skipped === 1 && job.report.folders.skipped === 1,
      'restoring the same backup again changes nothing', job.error || job.report);

    const curNote = (await call(carol2, 'GET', '/api/notes/' + cNote.id)).data.note;
    await call(carol2, 'PUT', '/api/notes/' + cNote.id, { title: curNote.title, content: '改壞了', baseContent: curNote.content, folderId: cFolder });
    upId = await uploadZip(carol2, mineZip);
    r = await call(carol2, 'POST', '/api/backup/upload/' + upId + '/restore', { overwrite: true });
    job = await waitJob(carol2, r.data.job);
    r = await call(carol2, 'GET', '/api/notes/' + cNote.id);
    ok(!job.error && job.report.notes.overwritten === 2 && r.data.note.content === cNoteV2.content,
      'overwrite puts the backup text back', job.error || job.report);
    r = await call(carol2, 'GET', '/api/notes/' + cNote.id + '/versions');
    ok(r.data.versions.some(v => v.label === '還原備份前'), 'overwrite first snapshots the text it replaces', r.data && r.data.versions.map(v => v.label));

    upId = await uploadZip(bob, siteZip);
    r = await call(bob, 'POST', '/api/backup/upload/' + upId + '/inspect', {});
    ok(r.status === 200 && r.data.canRestore === false, 'bob may look at a site backup but not restore it', r.data);
    r = await call(bob, 'POST', '/api/backup/upload/' + upId + '/restore', {});
    ok(r.status === 403, 'a site restore by a non-admin is 403', r.status);
    await call(bob, 'DELETE', '/api/backup/upload/' + upId);
    upId = await uploadZip(admin, siteZip);
    r = await call(admin, 'POST', '/api/backup/upload/' + upId + '/restore', {});
    job = await waitJob(admin, r.data.job);
    ok(!job.error && job.report.users.created === 0 && job.report.users.kept >= 3 && job.report.notes.created === 0 && job.report.notes.conflicts === 0,
      'a site restore onto the same site keeps every account and note', job.error || job.report);
    r = await call(carol2, 'POST', '/api/login', { username: 'carol', password: 'carol-password-123' });
    ok(r.status === 200, "an existing account's password survives a site restore", r.status);
  }

  if (!OLD) {
    section('chunked uploads, Range and file notes (課程筆記)');
    const { ZipReader } = require('../zip');
    const os = require('node:os'), fs = require('node:fs'), path = require('node:path');
    const RAW = { raw: true, contentType: 'application/octet-stream' };
    const dave = jar();
    r = await call(dave, 'POST', '/api/register', { username: 'dave', password: 'dave-password-123', invite: '' });
    ok(r.status === 200, 'dave registered', r.data);

    // Two full chunks and a short tail, so every boundary case exists.
    r = await call(dave, 'POST', '/api/uploads', { size: 1, mime: 'video/mp4', name: 'probe.mp4' });
    const CS = r.data.chunkSize, probe = r.data.id;   // never finished: stays pending
    ok(r.status === 200 && CS > 0 && CS < BODY_LIMIT && r.data.chunks === 1, 'a chunk fits inside one request body', r.data);
    const VID = crypto.randomBytes(CS * 2 + 12345);
    r = await call(dave, 'POST', '/api/uploads', { size: VID.length, mime: 'video/mp4', name: '第一堂 錄影.mp4' });
    ok(r.status === 200 && r.data.id && r.data.chunks === 3, 'start a chunked upload', r.data);
    const vid = r.data.id;
    const put = (s, id, seq, buf) => call(s, 'PUT', '/api/uploads/' + id + '/' + seq, buf, RAW);
    r = await put(dave, vid, 1, VID.subarray(CS, CS * 2));
    ok(r.status === 409 && r.data.next === 0, 'a chunk ahead of its turn is refused and says what is next', r.data);
    r = await put(dave, vid, 0, VID.subarray(0, CS - 1));
    ok(r.status === 400, 'a chunk of the wrong size is refused', r.status);
    r = await put(bob, vid, 0, VID.subarray(0, CS));
    ok(r.status === 404, "another user cannot write into dave's upload", r.status);
    r = await put(dave, vid, 0, VID.subarray(0, CS));
    ok(r.status === 200 && r.data.next === 1, 'chunk 0', r.data);
    r = await put(dave, vid, 0, VID.subarray(0, CS));
    ok(r.status === 200 && r.data.next === 1, 'a retried chunk is acknowledged, not appended twice', r.data);
    r = await call(dave, 'POST', '/api/uploads/' + vid + '/finish', {});
    ok(r.status === 409 && r.data.next === 1, 'finish before the last chunk is refused', r.data);
    r = await call(dave, 'GET', '/api/images/' + vid);
    ok(r.status === 404, 'an unfinished upload cannot be fetched', r.status);
    r = await put(dave, vid, 1, VID.subarray(CS, CS * 2));
    ok(r.status === 200 && r.data.next === 2, 'chunk 1', r.data);
    r = await put(dave, vid, 2, VID.subarray(CS * 2));
    ok(r.status === 200 && r.data.next === 3, 'the short last chunk', r.data);
    r = await call(dave, 'POST', '/api/uploads/' + vid + '/finish', {});
    ok(r.status === 200 && r.data.size === VID.length, 'finish', r.data);
    r = await put(dave, vid, 2, VID.subarray(CS * 2));
    ok(r.status === 404, 'a finished upload takes no more chunks', r.status);

    r = await call(dave, 'GET', '/api/images/' + vid, undefined, { buffer: true });
    ok(r.status === 200 && r.data.length === VID.length && sha(r.data) === sha(VID) &&
       r.headers.get('content-type') === 'video/mp4' && r.headers.get('accept-ranges') === 'bytes',
      'the whole file streams back byte for byte, as video', { status: r.status, len: r.data.length, type: r.headers.get('content-type') });
    const range = (s, id, v) => call(s, 'GET', '/api/images/' + id, undefined, { buffer: true, headers: { Range: v } });
    r = await range(dave, vid, 'bytes=' + (CS - 50) + '-' + (CS + 49));
    ok(r.status === 206 && r.data.equals(VID.subarray(CS - 50, CS + 50)) &&
       r.headers.get('content-range') === 'bytes ' + (CS - 50) + '-' + (CS + 49) + '/' + VID.length,
      'a Range across a chunk boundary', { status: r.status, cr: r.headers.get('content-range') });
    r = await range(dave, vid, 'bytes=' + (CS * 2 + 1000) + '-');
    ok(r.status === 206 && r.data.equals(VID.subarray(CS * 2 + 1000)), 'an open-ended Range runs to the end', r.status);
    r = await range(dave, vid, 'bytes=-777');
    ok(r.status === 206 && r.data.equals(VID.subarray(VID.length - 777)), 'a suffix Range', r.status);
    r = await range(dave, vid, 'bytes=' + VID.length + '-');
    ok(r.status === 416 && r.headers.get('content-range') === 'bytes */' + VID.length, 'a Range past the end is 416', r.status);

    // A type the browser must never run is still an attachment when chunked.
    const HTML = Buffer.concat([Buffer.from('<script>alert(1)</script>'), crypto.randomBytes(2000)]);
    r = await call(dave, 'POST', '/api/uploads', { size: HTML.length, mime: 'text/html', name: 'evil.html' });
    const evil = r.data.id;
    await put(dave, evil, 0, HTML);
    await call(dave, 'POST', '/api/uploads/' + evil + '/finish', {});
    r = await call(dave, 'GET', '/api/images/' + evil, undefined, { buffer: true });
    ok(r.status === 200 && r.headers.get('content-type') === 'application/octet-stream' &&
       /^attachment/.test(r.headers.get('content-disposition') || '') && /sandbox/.test(r.headers.get('content-security-policy') || ''),
      'a chunked .html is served as an inert attachment', r.headers.get('content-type'));

    // The file lives in a 課程筆記 folder as a "file note".
    r = await call(dave, 'POST', '/api/folders', { name: '第一週', area: 'course' });
    const dFolder = r.data.folder.id;
    const fileNote = (s, id, name, size, mime) => call(s, 'POST', '/api/notes', {
      title: name, folderId: dFolder, area: 'course', content: '[' + name + '](file:' + id + ')\n',
      meta: { file: { id: id, name: name, mime: mime, size: size } } });
    r = await fileNote(dave, vid, '第一堂 錄影.mp4', VID.length, 'video/mp4');
    ok(r.status === 200 && r.data.note.area === 'course' && r.data.note.meta.file.id === vid, 'a file note in a course folder', r.data);
    const vNote = r.data.note.id;
    r = await call(dave, 'GET', '/api/images');
    const listed = r.data.images.find(i => i.id === vid);
    ok(listed && listed.bytes === VID.length && listed.notes.some(n => n.id === vNote), 'the library lists it with its real size, as used', listed);
    ok(!r.data.images.some(i => i.id === probe), 'an upload that never finished is not in the library');
    r = await call(bob, 'GET', '/api/images/' + vid);
    ok(r.status === 404, 'nobody else can fetch it', r.status);
    await call(dave, 'POST', '/api/notes/' + vNote + '/shares', { username: BOB, perm: 'read' });
    r = await range(bob, vid, 'bytes=0-9');
    ok(r.status === 206 && r.data.equals(VID.subarray(0, 10)), 'a share recipient can stream it', r.status);

    // Backup: a chunked file is streamed into the zip and re-chunked on restore.
    r = await call(dave, 'GET', '/api/backup?scope=mine', undefined, { buffer: true });
    ok(r.status === 200, 'dave downloads a backup', r.status);
    const daveZip = r.data;
    const zf = path.join(os.tmpdir(), 'smoke-' + crypto.randomBytes(4).toString('hex') + '.zip');
    fs.writeFileSync(zf, daveZip);
    const zr = ZipReader.open(zf);
    const fIdx = JSON.parse(zr.read('files.json', 1 << 26).toString('utf8'));
    const fRow = fIdx.find(f => f.id === vid);
    let zsum = crypto.createHash('sha256'), zlen = 0;
    if (fRow) for await (const piece of zr.stream(fRow.file)) { zsum.update(piece); zlen += piece.length; }
    ok(fRow && fRow.chunked === true && fRow.size === VID.length && zlen === VID.length && zsum.digest('hex') === sha(VID),
      'the backup holds the chunked file byte for byte', fRow);
    zr.close(); fs.unlinkSync(zf);

    const daveId = (await call(dave, 'GET', '/api/me')).data.user.id;
    await call(admin, 'DELETE', '/api/admin/users/' + daveId);
    const dave2 = jar();
    r = await call(dave2, 'POST', '/api/register', { username: 'dave', password: 'dave-password-123', invite: '' });
    ok(r.status === 200 && (await call(dave2, 'GET', '/api/images/' + vid)).status === 404, 'dave is wiped, the file with him');
    r = await call(dave2, 'POST', '/api/backup/upload', {});
    const bId = r.data.id;
    const STEP = Math.min(BODY_LIMIT, 16 * 1024 * 1024) - 1024;
    for (let off = 0; off < daveZip.length; off += STEP) {
      r = await call(dave2, 'PUT', '/api/backup/upload/' + bId + '?offset=' + off, daveZip.subarray(off, Math.min(daveZip.length, off + STEP)), RAW);
      if (r.status !== 200) break;
    }
    ok(r.status === 200, 'the backup zip goes back up in pieces', r.status);
    r = await call(dave2, 'POST', '/api/backup/upload/' + bId + '/restore', {});
    let dJob = null;
    for (let i = 0; i < 600 && r.data && r.data.job; i++) {
      const s = await call(dave2, 'GET', '/api/backup/jobs/' + r.data.job);
      if (s.data && s.data.finished) { dJob = s.data; break; }
      await new Promise(res => setTimeout(res, 200));
    }
    ok(dJob && !dJob.error && dJob.report.files.created === 2 && dJob.report.notes.created === 1, 'restore recreates the files and the file note', dJob && (dJob.error || dJob.report));
    r = await call(dave2, 'GET', '/api/images/' + vid, undefined, { buffer: true });
    ok(r.status === 200 && sha(r.data) === sha(VID), 'the restored file is byte for byte', r.status);
    r = await range(dave2, vid, 'bytes=' + (CS * 2 - 5) + '-' + (CS * 2 + 4));
    ok(r.status === 206 && r.data.equals(VID.subarray(CS * 2 - 5, CS * 2 + 5)), 'and still seekable', r.status);

    // Purging a file note takes its file along — unless another note still uses it.
    r = await call(dave2, 'POST', '/api/notes', { title: '講義', area: 'course', folderId: dFolder, content: '影片在這：[錄影](file:' + vid + ')' });
    const otherNote = r.data.note.id;
    await call(dave2, 'DELETE', '/api/notes/' + vNote);
    r = await call(dave2, 'DELETE', '/api/trash/' + vNote);
    ok(r.status === 200 && (await call(dave2, 'GET', '/api/images/' + vid)).status === 200, 'purging the file note keeps a file another note still links', r.status);
    await call(dave2, 'DELETE', '/api/notes/' + otherNote);
    await call(dave2, 'DELETE', '/api/trash/' + otherNote);
    ok((await call(dave2, 'GET', '/api/images/' + vid)).status === 200, 'purging an ordinary note never deletes uploads');
    r = await fileNote(dave2, vid, 'x.mp4', VID.length, 'video/mp4');
    await call(dave2, 'DELETE', '/api/notes/' + r.data.note.id);
    ok((await call(dave2, 'GET', '/api/images/' + vid)).status === 200, 'a file note in the trash still has its file');
    await call(dave2, 'DELETE', '/api/trash');
    ok((await call(dave2, 'GET', '/api/images/' + vid)).status === 404, 'emptying the trash deletes the file with its note');
  }

  if (!OLD) {
    section('request limits and static allow-list (MariaDB build only)');
    const big = JSON.stringify({ title: 'x', content: 'y'.repeat(BODY_LIMIT + 1024) });
    r = await call(admin, 'POST', '/api/notes', big, { raw: true, contentType: 'application/json' });
    ok(r.status === 413, 'oversize body is 413', r.status);
    r = await call(admin, 'POST', '/api/notes', '{bad json', { raw: true, contentType: 'application/json' });
    ok(r.status === 400, 'bad JSON is 400', r.status);
    const expect = [
      ['/', 200], ['/index.html', 200], ['/app.css', 200], ['/js/store.js', 200], ['/logo.png', 200],
      ['/vendor/fonts/fonts.css', 200], ['/vendor/marked.min.js', 200],
      ['/README.md', 404], ['/CLAUDE.md', 404], ['/docs/interface.png', 404], ['/app.css.orig', 404],
      ['/.git/HEAD', 404], ['/server/db.js', 404], ['/vendor/../server/db.js', 404], ['/package.json', 404],
      ['/%', 400]
    ];
    for (const [p, want] of expect) {
      const s = await fetch(BASE + p, { redirect: 'manual' });
      await s.arrayBuffer();
      ok(s.status === want, 'static ' + p + ' → ' + want, s.status);
    }
  }

  // 匯入外面的 Markdown：掃引用、改寫成站上的寫法。瀏覽器的「匯入 .md」跟命令列的
  // server/tools/import-md.js 用的是同一份 js/mdimport.js，所以這裡驗一次兩邊都算驗到。
  section('markdown import (js/mdimport.js)');
  {
    const MdImport = require('../../js/mdimport.js');
    const src = [
      '---', 'title: 匯入測試', '---', '',
      '![封面](images/cover.png)',
      '<img src="images/cover.png" alt="同一張">',
      '[規格](files/spec.pdf) ｜ [官網](https://example.com/docs)',
      '![內嵌](data:image/png;base64,iVBORw0KGgo=)',
      '![有空白的路徑](img/step 1.png)',
      '```', '![不可以動](images/cover.png)', '```',
      '[s1]: guide/img/step 1.png'
    ].join('\n');
    const fm = MdImport.frontMatter(src);
    ok(fm.title === '匯入測試' && fm.body.indexOf('---') !== 0, 'front matter gives the title and is stripped', fm.title);
    const refs = MdImport.scan(fm.body);
    const targets = refs.map(function (r) { return r.target; });
    ok(targets.indexOf('images/cover.png') >= 0 && refs.filter(function (r) { return r.syntax === 'html'; }).length === 1,
      'scan finds markdown images and <img src>', targets);
    ok(targets.indexOf('img/step 1.png') >= 0 && targets.indexOf('guide/img/step 1.png') >= 0,
      'scan handles raw spaces in a path and in a reference definition', targets);
    ok(refs.filter(function (r) { return r.kind === 'data'; }).length === 1, 'scan finds the inline data: image');
    ok(targets.filter(function (t) { return t === 'images/cover.png'; }).length === 2, 'the fenced copy is not scanned', targets);
    const seen = {};
    const outText = MdImport.rewrite(fm.body, function (ref) {
      if (ref.kind === 'data') return { id: 'img_d', scheme: 'img', name: 'inline.png' };
      if (ref.target === 'https://example.com/docs') return null;     // 外部連結不動
      if (ref.target === 'files/spec.pdf') return { id: 'img_p', scheme: 'pdf', name: 'spec.pdf' };
      const p = MdImport.resolvePath([], ref.target);
      seen[p] = true;
      return { id: 'img_1', scheme: 'img', name: 'cover.png' };
    });
    ok(outText.indexOf('![封面](img:img_1)') >= 0 && outText.indexOf('![同一張](img:img_1)') >= 0,
      'rewrite turns both image forms into img:', outText.split('\n')[0]);
    ok(outText.indexOf('[規格](pdf:img_p)') >= 0 && outText.indexOf('[官網](https://example.com/docs)') >= 0,
      'a pdf link becomes pdf:, an external link is left alone');
    ok(outText.indexOf('![內嵌](img:img_d)') >= 0 && outText.indexOf('data:image') < 0, 'the data: image is replaced');
    ok(/\[s1\]: img:img_1/.test(outText), 'reference definition rewritten', outText.split('\n').pop());
    ok(outText.indexOf('![不可以動](images/cover.png)') >= 0, 'the fenced copy is untouched');
    ok(seen['img/step 1.png'] === true, 'a percent-free path with a space resolves', Object.keys(seen));
    ok(MdImport.rewrite(fm.body, function () { return null; }) === fm.body, 'resolving nothing changes nothing');
  }

  // 檔案管理／雲端硬碟：跟筆記完全分開的一棵資料夾樹（server/db.js file_folders），只整理
  // 上傳的檔案本身。這裡順便驗一次 backup.js 的還原路徑——images.folder_id 那個欄位加進去
  // 的時候，insertImagePending／insertImage 的參數數目沒有跟著改，backup.js 的呼叫端沒補上
  // 新的那個參數，還原就整個炸掉（mysql2 回「Malformed communication packet」）；這幾項
  // 顧著別再回去。
  if (!OLD) {
    section('file folders / 雲端硬碟 (server/db.js file_folders, server/api.js)');
    r = await call(admin, 'GET', '/api/file-folders');
    ok(r.status === 200 && Array.isArray(r.data.folders), 'list starts empty (or at least an array)', r.data);
    r = await call(admin, 'POST', '/api/file-folders', { name: '煙霧測試' });
    ok(r.status === 200 && r.data.folder && r.data.folder.name === '煙霧測試', 'create a top-level file folder', r.data);
    const ffId = r.data.folder.id;
    r = await call(admin, 'POST', '/api/file-folders', { name: '子資料夾', parentId: ffId });
    const ffSubId = r.data.folder.id;
    ok(r.status === 200 && r.data.folder.parentId === ffId, 'create a nested file folder', r.data);

    // 直接上傳到子資料夾（X-Folder-Id），跟一般上傳（沒有這個 header）不衝突
    r = await call(admin, 'POST', '/api/images', 'smoke-drive-file',
      { raw: true, contentType: 'text/plain', headers: { 'X-File-Name': encodeURIComponent('smoke.txt'), 'X-Folder-Id': ffSubId } });
    const ffFileId = r.data.id;
    ok(r.status === 200 && !!ffFileId, 'upload directly into a subfolder', r.data);
    r = await call(admin, 'POST', '/api/images', 'smoke-root-file',
      { raw: true, contentType: 'text/plain', headers: { 'X-File-Name': encodeURIComponent('root.txt') } });
    const rootFileId = r.data.id;
    r = await call(admin, 'GET', '/api/images');
    let img = r.data.images.find(x => x.id === ffFileId);
    ok(img && img.folderId === ffSubId, 'listImages reports the folderId for the scoped upload', img);
    img = r.data.images.find(x => x.id === rootFileId);
    ok(img && img.folderId == null, 'an upload with no X-Folder-Id still lands at the drive root (existing paste/drop callers unaffected)', img);

    // 重新命名／搬移：只動中繼資料的那條路，不像標註要整包位元組
    r = await call(admin, 'PUT', '/api/images/' + ffFileId + '/file', { name: '改名了.txt' });
    ok(r.status === 200, 'rename via /file');
    r = await call(admin, 'PUT', '/api/images/' + ffFileId + '/file', { folderId: ffId });
    ok(r.status === 200, 'move via /file');
    r = await call(admin, 'GET', '/api/images');
    ok(r.data.images.find(x => x.id === ffFileId).folderId === ffId, 'file now reports the new folder');

    // 刪掉有內容的資料夾：檔案沒有垃圾桶，裡面的東西要搬到上一層，不能被連坐刪掉
    r = await call(admin, 'DELETE', '/api/file-folders/' + ffSubId);
    ok(r.status === 200, 'delete a non-empty folder succeeds');
    r = await call(admin, 'GET', '/api/images');
    ok(r.data.images.find(x => x.id === ffFileId).folderId === ffId, 'file that was untouched by the delete keeps its folder');
    r = await call(admin, 'DELETE', '/api/file-folders/' + ffId);
    ok(r.status === 200, 'delete the (now non-empty again) top folder too');
    r = await call(admin, 'GET', '/api/images');
    img = r.data.images.find(x => x.id === ffFileId);
    ok(img && img.folderId == null, 'the file that was inside the deleted top folder landed at drive root, not lost', img);

    // 收尾：把煙霧測試留下的檔案清掉，不要弄髒 scratch 資料庫
    await call(admin, 'DELETE', '/api/images/' + ffFileId);
    await call(admin, 'DELETE', '/api/images/' + rootFileId);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
