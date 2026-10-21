/* api.js — notes / folders / images / shares.
 *
 * Authorization rule for the whole file: the caller's identity comes from their
 * session, never from the request body. Any owner_id in client JSON is ignored.
 *
 * Everything here is async (MariaDB via db.js). Two requests for the same note
 * can now interleave between awaits — something the synchronous SQLite version
 * made impossible — so every read-merge-write on a note re-reads the row with
 * `q.noteByIdForUpdate` inside its transaction and computes from that locked
 * copy. Side effects (hub broadcasts) are collected inside the transaction and
 * fired after it commits; see the rules at the top of db.js.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dbmod = require('./db');
const { q, tx } = dbmod;
const hub = require('./hub');
const sysmon = require('./sysmon');
const config = require('./config');
const { merge3 } = require('./merge');

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
}

// ---------------- areas ----------------
// A note's or folder's home: undefined/null = 一般 (the dashboard/tree exactly as
// before this feature), or one of these four, set at creation — updateNote's SQL
// has no area column, so a normal save can never change it; the one deliberate
// exception is moveNoteArea() below, a dedicated, narrowly-validated endpoint for
// reclassifying a note between the three non-gated areas. A folder's area must
// match every note and sub-folder placed inside it (checked in folderAreaOf
// below, not a DB constraint: MariaDB has no portable "check against a joined
// row").
const AREAS = ['course', 'knowledge', 'quick', 'novel', 'board', 'start', 'xmind', 'timetree', 'progress', 'foodmap'];   // board：看板（js/board.js）、start：起始頁（js/startpage.js）、xmind：心智圖（js/xmind.js）、timetree：行事曆（js/timetree.js）——都沒有資料夾、不能搬到別區
function normalizeArea(a) { return AREAS.indexOf(a) >= 0 ? a : null; }
// 所有筆記／課程筆記／知識區 之間可以互相搬——novel 有解鎖的安全考量、quick
// 沒有資料夾概念，兩個都刻意不讓這個功能碰，維持它們原本各自的規則。
const MOVABLE_AREAS = [null, 'course', 'knowledge'];

// 小說 (novel): the one area with a second gate. POST /api/novel/unlock (server/
// auth.js) sets sessions.novel_unlocked_at after the caller re-types their own
// password; this — not anything client-side — is what actually keeps a novel
// note unreadable, because it is checked inside permFor() below, the same choke
// point that already makes a trashed note invisible to every route. The unlock
// is timed from here, not from the session's own expiry, so a stale browser tab
// left open overnight re-locks on its own without needing to log out.
const NOVEL_UNLOCK_TTL_MS = 60 * 60 * 1000;   // 1 hour
function novelUnlocked(user) {
  return !!(user.novelUnlockedAt && (Date.now() - user.novelUnlockedAt) < NOVEL_UNLOCK_TTL_MS);
}

// ---------------- permissions ----------------
async function permFor(user, note) {
  // A trashed note does not exist as far as every normal route is concerned —
  // reading, saving, versions, shares, images all 404. Only the trash endpoints
  // (listTrash / restoreNote / purgeNote) look at those rows, owner-only.
  if (!note || note.deleted_at) return null;
  // A novel note is never shareable (setAccess refuses it) and is only ever the
  // owner's own — but the owner too gets nothing back until the session has
  // re-typed the password within the last hour. This one check is what keeps
  // GET/PUT on a note id, its versions, its images and its PDF export all 404
  // for a locked session, without each of those routes having to know.
  if (note.area === 'novel' && !(note.owner_id === user.id && novelUnlocked(user))) return null;
  if (note.owner_id === user.id) return 'owner';
  const s = await q.shareFor.get(note.id, user.id);
  if (s) return s.perm;              // 'read' | 'edit'
  // "General access": the owner opened the note to every signed-in user.
  if (note.access === 'site') return note.access_perm === 'edit' ? 'edit' : 'read';
  return null;
}
const canRead = p => p === 'owner' || p === 'read' || p === 'edit';
const canEdit = p => p === 'owner' || p === 'edit';

function shapeNote(row, perm, ownerName, viaSite) {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    content: row.content,
    meta: row.meta ? JSON.parse(row.meta) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    position: row.position == null ? null : Number(row.position),   // manual order in its folder
    rev: row.rev || 0,                // revision counter for live collaboration
    perm: perm,                       // so the UI can go read-only
    sharedBy: ownerName || undefined,
    access: row.access || 'restricted',          // owner's "general access" setting
    accessPerm: row.access_perm || 'read',
    viaSite: viaSite ? true : undefined,         // reached through site-wide access, not a share
    area: row.area || undefined,         // undefined = 一般, else 'course'|'knowledge'|'quick'|'novel'
    publicLink: row.public_link ? true : undefined   // 擁有者才有：這篇有還沒過期的公開連結
  };
}

// ---------------- notes ----------------
async function listNotes(user) {
  // 有公開連結的筆記要在清單上標出來：那是「沒有帳號的人也看得到」，關掉對話框之後
  // 沒有別的地方會提醒你哪幾篇是開著的
  const open = new Set((await q.notesWithLinks.all(user.id, Date.now())).map(r => r.note_id));
  const own = (await q.notesOwned.all(user.id)).map(r => {
    if (open.has(r.id)) r.public_link = 1;
    return shapeNote(r, 'owner');
  });
  const shared = (await q.notesSharedWith.all(user.id)).map(r => shapeNote(r, r.share_perm, r.owner_name));
  const site = (await q.notesSiteWide.all(user.id, user.id)).map(r => shapeNote(r, r.share_perm, r.owner_name, true));
  // 'novel' rides along in this same list once unlocked, so the client's normal
  // GET /api/notes — the one call it already knows how to make — is enough to
  // pick novel notes up right after POST /api/novel/unlock succeeds; no separate
  // endpoint needed. Locked, or never unlocked this session, it is simply absent.
  const novel = novelUnlocked(user) ? (await q.notesOwnedArea.all(user.id, 'novel')).map(r => shapeNote(r, 'owner')) : [];
  return own.concat(shared, site, novel);
}

async function getNote(user, id) {
  const row = await q.noteById.get(id);
  const perm = await permFor(user, row);
  if (!canRead(perm)) return null;
  const owner = perm === 'owner' ? null : await q.userById.get(row.owner_id);
  const viaSite = perm !== 'owner' && !(await q.shareFor.get(row.id, user.id));
  if (perm === 'owner' && (await q.noteHasLink.get(row.id, Date.now()))) row.public_link = 1;
  return shapeNote(row, perm, owner && owner.username, viaSite);
}

// Owner-only: who else may open this note without an explicit share.
async function setAccess(user, id, body) {
  const row = await q.noteById.get(id);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  // 小說沒有「一般存取」這回事：不管解鎖與否都不能開放給別人，這個區域本來就是
  // 為了不給別人看才做的。
  if (row.area === 'novel') return { status: 403, error: '小說筆記不能分享或開放給其他人' };
  const mode = body.mode === 'site' ? 'site' : 'restricted';
  const perm = body.perm === 'edit' ? 'edit' : 'read';
  await q.setAccess.run(mode, perm, id);
  return { ok: true, access: mode, accessPerm: perm };
}

// A note/folder placed inside folderId must belong to the SAME area as that
// folder (or, with no folderId, the area the caller asked for) — otherwise a
// course note could be filed into a general folder and disappear from both
// views, or worse, a novel note filed into a public folder would leak through
// a folder listing that has no reason to gate itself. Returns the resolved,
// validated area (a string or null), or throws a shaped error.
async function resolveArea(user, wantArea, folderId) {
  const area = normalizeArea(wantArea);
  if (!folderId) return area;
  const folder = await q.folderById.get(folderId);
  if (!folder || folder.owner_id !== user.id) throw { status: 404, error: '找不到這個資料夾' };
  if ((folder.area || null) !== area) throw { status: 400, error: '資料夾跟筆記不在同一個區域' };
  return area;
}

async function createNote(user, body) {
  let area;
  try { area = await resolveArea(user, body.area, body.folderId); }
  catch (e) { return e; }
  if (area === 'novel' && !novelUnlocked(user)) return { status: 403, error: 'novel_locked' };
  const now = Date.now();
  const id = uid('note');
  await q.insertNote.run(
    id, user.id, body.folderId || null,
    String(body.title || '未命名筆記'), String(body.content || ''),
    body.meta ? JSON.stringify(body.meta) : null, now, now, area);
  return shapeNote(await q.noteById.get(id), 'owner');
}

// 在 所有筆記／課程筆記／知識區 之間搬一篇筆記——這三個都是一般的資料夾式
// 區域，跟建立筆記一樣的規則：目標資料夾（如果有指定）必須屬於目標區域。只有
// 擁有者可以做，而且來源、目標都得是 MOVABLE_AREAS 之一（novel/quick 兩邊都不
// 給碰，見 MOVABLE_AREAS 的說明）。手動排序的 position 重置成 NULL——它在舊區域
// 那個層級才有意義，帶到新區域只會讓它莫名其妙排到最前面。
async function moveNoteArea(user, id, body) {
  const row = await q.noteById.get(id);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  if (MOVABLE_AREAS.indexOf(row.area || null) < 0) return { status: 400, error: '這篇筆記不能用這個方式換區域' };
  const raw = body.area || null;
  if (raw !== null && AREAS.indexOf(raw) < 0) return { status: 400, error: '區域名稱不正確' };
  if (MOVABLE_AREAS.indexOf(raw) < 0) return { status: 400, error: '不能換到這個區域' };
  let folderId = body.folderId || null;
  if (folderId) {
    const folder = await q.folderById.get(folderId);
    if (!folder || folder.owner_id !== user.id || (folder.area || null) !== raw) {
      return { status: 400, error: '資料夾不在目標區域裡' };
    }
  }
  await q.setNoteArea.run(raw, folderId, id, user.id);
  return { note: shapeNote(await q.noteById.get(id), 'owner') };
}

// ---------------- note version history ----------------

// One row per editing *session*, not per save. The editor autosaves 500ms after
// you stop typing, so a row per save would bury a real earlier draft under two
// hundred near-identical rows. Consecutive saves by the same author inside this
// window collapse into the row that is already open.
const VERSION_COALESCE_MS = 5 * 60 * 1000;
// Automatic versions kept per note. Labelled versions are never counted here and
// never pruned — that is the whole point of labelling one.
const VERSION_KEEP = 60;
const VERSION_LIST_MAX = 200;
// Labels the system applies itself. Both mark a row that must survive pruning.
const LABEL_PREHISTORY = '啟用版本歷史前';
const LABEL_BOOK = '電子書版本';

function shapeVersion(row) {
  return {
    id: row.id,
    rev: row.rev,
    title: row.title,
    author: row.author || '',
    label: row.label || null,
    createdAt: row.created_at,
    chars: row.chars != null ? row.chars : (row.content ? row.content.length : 0)
  };
}

// Called inside the same transaction as the note write, with the note row
// locked. `row` is the note as it was *before* this save.
async function recordVersion(row, user, title, content, metaStr, rev, now) {
  const latest = await q.versionLatest.get(row.id);

  // First ever version of this note: also keep what it looked like before this
  // edit, otherwise the text that existed before history was switched on is lost
  // at the very first save. Its author is genuinely unknown — nothing recorded
  // who last wrote it — so the field is left empty rather than guessed at.
  if (!latest) {
    await q.insertVersion.run(row.id, row.rev || 0, row.title, row.content, row.meta,
      '', LABEL_PREHISTORY, row.updated_at || now);
  }

  const open = latest && latest.label == null && latest.author === user.username &&
    (now - latest.created_at) < VERSION_COALESCE_MS;
  if (open) await q.updateVersion.run(rev, title, content, metaStr, now, latest.id);
  else await q.insertVersion.run(row.id, rev, title, content, metaStr, user.username, null, now);

  await q.pruneVersions.run(row.id, row.id, VERSION_KEEP);
}

async function listVersions(user, id) {
  const row = await q.noteById.get(id);
  const perm = await permFor(user, row);
  if (!canRead(perm)) return { status: 404 };
  return {
    versions: (await q.versionList.all(id, VERSION_LIST_MAX)).map(shapeVersion),
    perm: perm,
    current: { rev: row.rev || 0, title: row.title, updatedAt: row.updated_at, chars: row.content.length }
  };
}

async function getVersion(user, id, versionId) {
  const row = await q.noteById.get(id);
  const perm = await permFor(user, row);
  if (!canRead(perm)) return { status: 404 };
  const v = await q.versionById.get(Number(versionId), id);
  if (!v) return { status: 404, error: '找不到這個版本' };
  const out = shapeVersion(v);
  out.content = v.content;
  out.meta = v.meta ? JSON.parse(v.meta) : undefined;
  return { version: out, current: { content: row.content, rev: row.rev || 0, title: row.title } };
}

// A named snapshot of the note as it stands. Never coalesced, never pruned.
async function createVersion(user, id, body) {
  const pre = await q.noteById.get(id);
  const perm = await permFor(user, pre);
  if (!canRead(perm)) return { status: 404 };
  if (!canEdit(perm)) return { status: 403, error: '你對這篇筆記只有唯讀權限' };
  const label = String((body && body.label) || '').trim().slice(0, 80) || '標記版本';
  const now = Date.now();
  const inserted = await tx(async function () {
    // Snapshot the row as it is at this instant, not as it was when we checked
    // permissions a moment ago.
    const row = await q.noteByIdForUpdate.get(id);
    if (!row) return null;
    const r = await q.insertVersion.run(id, row.rev || 0, row.title, row.content, row.meta,
      user.username, label, now);
    return q.versionById.get(r.insertId, id);
  }, 'createVersion');
  if (!inserted) return { status: 404 };
  return { version: shapeVersion(inserted) };
}

async function renameVersion(user, id, versionId, body) {
  const row = await q.noteById.get(id);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  const v = await q.versionById.get(Number(versionId), id);
  if (!v) return { status: 404, error: '找不到這個版本' };
  const raw = String((body && body.label) || '').trim().slice(0, 80);
  await q.labelVersion.run(raw || null, Number(versionId), id);
  return { ok: true, label: raw || null };
}

async function deleteVersion(user, id, versionId) {
  const row = await q.noteById.get(id);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  const v = await q.versionById.get(Number(versionId), id);
  if (!v) return { status: 404, error: '找不到這個版本' };
  if (v.label === LABEL_BOOK) {
    return { status: 409, error: '這個版本被某個電子書版本引用，請先刪除該電子書版本' };
  }
  await q.deleteVersion.run(Number(versionId), id);
  return { ok: true };
}

// Inside a transaction, with `note` freshly read FOR UPDATE. Restoring first
// snapshots the text being replaced, so a restore is itself undoable —
// otherwise picking the wrong version would destroy the current work. Returns
// the broadcast payload; the caller fires it after commit.
async function restoreNoteToVersion(user, note, v, now) {
  const rev = (note.rev || 0) + 1;
  await q.insertVersion.run(note.id, note.rev || 0, note.title, note.content, note.meta,
    user.username, '還原前', now - 1);
  await q.updateNote.run(note.folder_id, v.title, v.content, v.meta, now, rev, note.id);
  await q.pruneVersions.run(note.id, note.id, VERSION_KEEP);
  return { rev: rev, content: v.content, title: v.title, by: user.username, updatedAt: now };
}

async function restoreVersion(user, id, versionId) {
  const pre = await q.noteById.get(id);
  const perm = await permFor(user, pre);
  if (!canRead(perm)) return { status: 404 };
  if (!canEdit(perm)) return { status: 403, error: '你對這篇筆記只有唯讀權限' };

  const out = await tx(async function () {
    const note = await q.noteByIdForUpdate.get(id);
    if (!note) return { status: 404 };
    const v = await q.versionById.get(Number(versionId), id);
    if (!v) return { status: 404, error: '找不到這個版本' };
    if (v.content === note.content && v.title === note.title) {
      return { note: shapeNote(note, perm), unchanged: true };
    }
    return { payload: await restoreNoteToVersion(user, note, v, Date.now()) };
  }, 'restoreVersion');

  if (!out.payload) return out;
  hub.broadcastUpdate(id, out.payload);
  return { note: shapeNote(await q.noteById.get(id), perm) };
}

// ---------------- e-book version history ----------------
//
// A book is a folder, so there is nothing about the book itself to version. What
// gets recorded is the cast list: which notes were chapters, in what order, and
// which note version each one was pinned to. The chapter order comes from the
// client because the ordering rule (natural sort of the titles) lives in
// js/book.js and must not be reimplemented differently here.

async function bookNotesFor(user, folderId, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const n = await q.noteById.get(String(ids[i]));
    // Only the owner's own notes in this exact folder can be chapters, which is
    // the same rule js/book.js applies when it builds the reader.
    if (!n || n.owner_id !== user.id || (n.folder_id || null) !== (folderId || null)) return null;
    out.push(n);
  }
  return out;
}

function parseManifest(row) {
  try { return JSON.parse(row.manifest) || []; } catch (e) { return []; }
}

async function listBookVersions(user, folderId) {
  const rows = await q.bookVersionList.all(folderId, user.id, VERSION_LIST_MAX);
  return {
    versions: rows.map(function (r) {
      const man = parseManifest(r);
      return {
        id: r.id, folderId: r.folder_id, title: r.title, label: r.label || null,
        createdAt: r.created_at, chapters: man.length
      };
    })
  };
}

async function createBookVersion(user, folderId, body) {
  const ids = Array.isArray(body && body.chapters) ? body.chapters : [];
  if (!ids.length) return { status: 400, error: '這本書還沒有任何章節' };
  const notes = await bookNotesFor(user, folderId, ids);
  if (!notes) return { status: 400, error: '章節清單與這個資料夾對不起來，請重新整理後再試' };

  const label = String((body && body.label) || '').trim().slice(0, 80) || null;
  const title = String((body && body.title) || '未命名電子書').slice(0, 200);
  const now = Date.now();

  const out = await tx(async function () {
    const manifest = [];
    for (const n of notes) {
      // Pin each chapter to a version row captured right now, labelled so the
      // automatic pruning can never delete the text this book version points at.
      const r = await q.insertVersion.run(n.id, n.rev || 0, n.title, n.content, n.meta,
        user.username, LABEL_BOOK, now);
      manifest.push({ noteId: n.id, title: n.title, versionId: r.insertId, rev: n.rev || 0 });
    }
    const b = await q.insertBookVersion.run(folderId, user.id, title, label, JSON.stringify(manifest), now);
    return { id: b.insertId, chapters: manifest.length };
  }, 'createBookVersion');

  return {
    version: {
      id: out.id, folderId: folderId, title: title, label: label,
      createdAt: now, chapters: out.chapters
    }
  };
}

async function getBookVersion(user, versionId) {
  const row = await q.bookVersionById.get(Number(versionId), user.id);
  if (!row) return { status: 404, error: '找不到這個電子書版本' };
  const man = parseManifest(row);
  const chapters = [];
  for (const c of man) {
    const v = await q.versionById.get(c.versionId, c.noteId);
    chapters.push({
      noteId: c.noteId,
      title: v ? v.title : c.title,
      versionId: c.versionId,
      rev: c.rev,
      chars: v ? v.content.length : 0,
      // A chapter note deleted since the snapshot still shows in the manifest,
      // flagged, rather than silently vanishing from the version.
      missing: v ? undefined : true
    });
  }
  return {
    version: {
      id: row.id, folderId: row.folder_id, title: row.title, label: row.label || null,
      createdAt: row.created_at, chapters: chapters
    }
  };
}

// The content of one chapter as it was in this book version.
async function getBookVersionChapter(user, versionId, noteId) {
  const row = await q.bookVersionById.get(Number(versionId), user.id);
  if (!row) return { status: 404, error: '找不到這個電子書版本' };
  const man = parseManifest(row);
  const entry = man.filter(function (c) { return c.noteId === String(noteId); })[0];
  if (!entry) return { status: 404, error: '這個版本裡沒有這一章' };
  const v = await q.versionById.get(entry.versionId, entry.noteId);
  if (!v) return { status: 404, error: '這一章的內容已經不在了' };
  return { chapter: { noteId: v.note_id, title: v.title, content: v.content, rev: v.rev } };
}

// One transaction for the whole book: either every chapter comes back to its
// pinned version or none does. The manifest order doubles as the lock order,
// so two restores of the same book queue up instead of deadlocking.
async function restoreBookVersion(user, versionId) {
  const row = await q.bookVersionById.get(Number(versionId), user.id);
  if (!row) return { status: 404, error: '找不到這個電子書版本' };
  const man = parseManifest(row);

  const out = await tx(async function () {
    const restored = [], skipped = [], pending = [];
    for (const c of man) {
      const note = await q.noteByIdForUpdate.get(c.noteId);
      const v = note ? await q.versionById.get(c.versionId, c.noteId) : null;
      if (!note || note.owner_id !== user.id || !v) { skipped.push(c.title); continue; }
      if (v.content === note.content && v.title === note.title) continue;
      pending.push({ id: note.id, payload: await restoreNoteToVersion(user, note, v, Date.now()) });
      restored.push(c.title);
    }
    return { restored: restored, skipped: skipped, pending: pending };
  }, 'restoreBookVersion');

  out.pending.forEach(function (p) { hub.broadcastUpdate(p.id, p.payload); });
  return { ok: true, restored: out.restored.length, skipped: out.skipped };
}

async function deleteBookVersion(user, versionId) {
  const row = await q.bookVersionById.get(Number(versionId), user.id);
  if (!row) return { status: 404, error: '找不到這個電子書版本' };
  const man = parseManifest(row);

  await tx(async function () {
    await q.deleteBookVersion.run(Number(versionId), user.id);
    // The note versions this book pinned were kept alive only for it. Release
    // any that no surviving book version still references, so deleting a book
    // version actually reclaims the space it was holding. (Two concurrent
    // deletes of different book versions can each see the other's manifest and
    // leave one labelled version un-released — a small leak, never a loss.)
    const others = await q.bookVersionList.all(row.folder_id, user.id, VERSION_LIST_MAX);
    const stillPinned = new Set();
    others.forEach(function (b) {
      parseManifest(b).forEach(function (c) { stillPinned.add(c.versionId); });
    });
    for (const c of man) {
      if (stillPinned.has(c.versionId)) continue;
      const v = await q.versionById.get(c.versionId, c.noteId);
      if (v && v.label === LABEL_BOOK) await q.deleteVersion.run(c.versionId, c.noteId);
    }
  }, 'deleteBookVersion');
  return { ok: true };
}

// ---------------- public e-book links ----------------
//
// The one door in this server that opens without a session, so it is built to be
// as small a door as possible:
//
//   * It serves a *snapshot*, not the live book. The client packs the whole book
//     into one self-contained HTML file (images already inlined as data URLs) and
//     that exact file is what gets stored and later handed out. Holding the link
//     therefore grants no API access, no other notes, and none of the owner's
//     later edits — those only appear if the owner deliberately refreshes it.
//   * The token is 32 random bytes. There is nothing to enumerate.
//   * Links can expire, and can be revoked at any time by deleting the row.
//   * Only the owner of the folder can create, refresh, list or revoke one.

const LINK_MAX_HTML = 40 * 1024 * 1024;   // a book with many photos is still one file
const LINK_MAX_DAYS = 3650;

function linkToken() { return crypto.randomBytes(32).toString('hex'); }

function shapeLink(row) {
  return {
    token: row.token,
    folderId: row.folder_id,
    title: row.title,
    chapters: row.chapters,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at || null,
    expired: !!(row.expires_at && row.expires_at < Date.now()),
    views: row.views || 0,
    chars: row.chars != null ? row.chars : (row.html ? row.html.length : 0)
  };
}

function expiryFrom(days) {
  const d = parseInt(days, 10);
  if (!d || d <= 0) return null;                       // 0 / missing = never expires
  return Date.now() + Math.min(d, LINK_MAX_DAYS) * 86400000;
}

// Only the folder's owner may share it, and only if it is actually theirs.
async function ownsFolder(user, folderId) {
  const f = await q.folderById.get(String(folderId));
  return !!(f && f.owner_id === user.id);
}

async function listBookLinks(user, folderId) {
  if (!(await ownsFolder(user, folderId))) return { status: 404 };
  return { links: (await q.linkList.all(String(folderId), user.id)).map(shapeLink) };
}

async function createBookLink(user, folderId, body) {
  if (!(await ownsFolder(user, folderId))) return { status: 404 };
  const html = String((body && body.html) || '');
  if (!html) return { status: 400, error: '沒有收到書的內容' };
  if (html.length > LINK_MAX_HTML) {
    return { status: 413, error: '這本書太大（超過 40 MB），無法建立分享連結' };
  }
  const now = Date.now();
  const token = linkToken();
  await q.insertLink.run(token, String(folderId), user.id,
    String((body && body.title) || '未命名電子書').slice(0, 200),
    html, parseInt(body && body.chapters, 10) || 0,
    now, now, expiryFrom(body && body.expiresDays));
  return { link: shapeLink(await q.linkByToken.get(token)) };
}

// Re-publish an existing link so the same URL starts serving the current book.
async function updateBookLink(user, token, body) {
  const row = await q.linkOwned.get(String(token), user.id);
  if (!row) return { status: 404, error: '找不到這個分享連結' };
  const html = String((body && body.html) || '');
  if (!html) return { status: 400, error: '沒有收到書的內容' };
  if (html.length > LINK_MAX_HTML) {
    return { status: 413, error: '這本書太大（超過 40 MB），無法更新分享連結' };
  }
  const expires = (body && body.expiresDays !== undefined)
    ? expiryFrom(body.expiresDays) : (row.expires_at || null);
  await q.updateLink.run(String((body && body.title) || row.title).slice(0, 200), html,
    parseInt(body && body.chapters, 10) || row.chapters, Date.now(), expires, row.token);
  return { link: shapeLink(await q.linkByToken.get(row.token)) };
}

async function deleteBookLink(user, token) {
  const row = await q.linkOwned.get(String(token), user.id);
  if (!row) return { status: 404, error: '找不到這個分享連結' };
  await q.deleteLink.run(row.token, user.id);
  return { ok: true };
}

// ---------------- 單篇筆記的公開連結 ----------------
// 「分享給沒有帳號的人」。規則跟上面電子書的連結完全一樣，理由也一樣：給出去的是
// 擁有者按下去那一刻的快照（一頁打包好的 HTML），不是筆記本身——token 換不到任何
// API、看不到之後的修改、也改不了任何東西。只有唯讀，沒有「匿名也能編輯」：那等於把
// 存檔的 API 開給任何拿到網址的人。
//   * 只有筆記的擁有者能建立、更新、列出、取消。被分享的人（就算有編輯權）不行。
//   * 小說區的筆記不能有公開連結（它連分享給站內的人都不行）。
//   * 筆記進了垃圾桶，連結立刻打不開；還原回來連結也回來。永久刪除就連同連結一起刪。
const NOTE_LINK_MAX = 10;       // 一篇筆記最多幾個連結（不同期限、給不同對象）

function shapeNoteLink(row, note) {
  return {
    token: row.token,
    noteId: row.note_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at || null,
    expired: !!(row.expires_at && row.expires_at < Date.now()),
    views: row.views || 0,
    chars: row.chars != null ? row.chars : (row.html ? row.html.length : 0),
    noteRev: row.note_rev || 0,
    // 要不要跟著筆記自動更新。關掉的連結就停在最後一次「更新內容」那一刻，要更新得自己按
    // （欄位是後來加的；讀不到就當作開著，跟加欄位之前的行為一樣）
    autoUpdate: row.auto_update == null ? true : !!row.auto_update,
    // 筆記在建立／更新連結之後又改過：連結上看到的已經不是最新的
    stale: !!(note && (note.rev || 0) > (row.note_rev || 0))
  };
}
// 這篇筆記能不能由這個人開公開連結：是他的、沒被刪、不是小說
async function linkableNote(user, noteId) {
  const row = await q.noteById.get(String(noteId));
  if (!row || row.owner_id !== user.id || row.deleted_at) return { status: 404 };
  if (row.area === 'novel') return { status: 400, error: '小說區的筆記不能建立公開連結' };
  return { note: row };
}
function linkHtml(body, what) {
  const html = String((body && body.html) || '');
  if (!html) return { status: 400, error: '沒有收到筆記的內容' };
  if (html.length > LINK_MAX_HTML) return { status: 413, error: '這篇筆記太大（超過 40 MB），無法' + what };
  return { html: html };
}
async function listNoteLinks(user, noteId) {
  const n = await linkableNote(user, noteId);
  if (!n.note) return n;
  return { links: (await q.noteLinkList.all(n.note.id, user.id)).map(r => shapeNoteLink(r, n.note)) };
}
async function createNoteLink(user, noteId, body) {
  const n = await linkableNote(user, noteId);
  if (!n.note) return n;
  const h = linkHtml(body, '建立公開連結');
  if (!h.html) return h;
  if ((await q.countNoteLinks.get(n.note.id)).n >= NOTE_LINK_MAX) {
    return { status: 400, error: '一篇筆記最多 ' + NOTE_LINK_MAX + ' 個公開連結，先取消用不到的' };
  }
  const now = Date.now();
  const token = linkToken();
  // rev 由前端帶上來（它打包的是第幾版），但不能比筆記現在的版本還新
  const rev = Math.min(parseInt(body && body.rev, 10) || 0, n.note.rev || 0);
  await q.insertNoteLink.run(token, n.note.id, user.id,
    String((body && body.title) || n.note.title || '未命名筆記').slice(0, 200),
    h.html, rev, now, now, expiryFrom(body && body.expiresDays));
  // 沒說就是自動更新；明確給 false 才關
  if (body && body.autoUpdate === false) await q.setNoteLinkAuto.run(0, token, user.id);
  return { link: shapeNoteLink(await q.noteLinkOwned.get(token, user.id), n.note) };
}
async function updateNoteLink(user, token, body) {
  const row = await q.noteLinkOwned.get(String(token), user.id);
  if (!row) return { status: 404, error: '找不到這個公開連結' };
  const n = await linkableNote(user, row.note_id);
  if (!n.note) return n;
  // 只改設定（自動更新的開關），不帶內容：連結上的頁面原封不動，更新時間也不動
  if (body && body.html === undefined && typeof body.autoUpdate === 'boolean') {
    await q.setNoteLinkAuto.run(body.autoUpdate ? 1 : 0, row.token, user.id);
    return { link: shapeNoteLink(await q.noteLinkOwned.get(row.token, user.id), n.note) };
  }
  const h = linkHtml(body, '更新公開連結');
  if (!h.html) return h;
  const expires = (body && body.expiresDays !== undefined)
    ? expiryFrom(body.expiresDays) : (row.expires_at || null);
  const rev = Math.min(parseInt(body && body.rev, 10) || 0, n.note.rev || 0);
  await q.updateNoteLink.run(String((body && body.title) || row.title).slice(0, 200), h.html,
    rev, Date.now(), expires, row.token);
  if (body && typeof body.autoUpdate === 'boolean') await q.setNoteLinkAuto.run(body.autoUpdate ? 1 : 0, row.token, user.id);
  return { link: shapeNoteLink(await q.noteLinkOwned.get(row.token, user.id), n.note) };
}
async function deleteNoteLink(user, token) {
  const row = await q.noteLinkOwned.get(String(token), user.id);
  if (!row) return { status: 404, error: '找不到這個公開連結' };
  await q.deleteNoteLink.run(row.token, user.id);
  return { ok: true };
}
// 公開頁（server.js 的 /s/<token>）。沒有 session，所以這裡只看 token 與筆記的狀態。
async function publicNote(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
  const row = await q.noteLinkPublic.get(String(token));
  if (!row || row.note_deleted || row.note_area === 'novel') return null;
  if (row.expires_at && row.expires_at < Date.now()) return { expired: true };
  try { await q.bumpNoteLinkViews.run(row.token); } catch (e) { /* ignore */ }
  return { html: row.html, title: row.title };
}

// Called with no session at all. Returns the stored file, or null.
async function publicBook(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
  const row = await q.linkByToken.get(String(token));
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) return { expired: true };
  // An atomic `views = views + 1`; a view counter is not worth failing over.
  try { await q.bumpLinkViews.run(row.token); } catch (e) { /* ignore */ }
  return { html: row.html, title: row.title };
}

async function updateNote(user, id, body) {
  const pre = await q.noteById.get(id);
  const perm = await permFor(user, pre);
  if (!canRead(perm)) return { status: 404 };
  if (!canEdit(perm)) return { status: 403, error: '你對這篇筆記只有唯讀權限' };

  const incoming = String(body.content || '');
  const title = String(body.title || '未命名筆記');

  const out = await tx(async function () {
    // Everything below derives from the *locked* row, not from `pre`: between
    // the permission check and here another save may have landed, and merging
    // against a stale copy is exactly the lost update this lock exists for.
    const row = await q.noteByIdForUpdate.get(id);
    if (!row) return { status: 404 };
    // A recipient with edit rights may change content, but must not be able to
    // move someone else's note into their own folder tree.
    let folderId = perm === 'owner' ? (body.folderId || null) : row.folder_id;
    // A note's area is fixed at creation, so a move must stay inside that same
    // area — the target folder has to belong to it (and to this owner; folders
    // are never shared, so a stray id from elsewhere just falls back to the top
    // level here rather than erroring the whole save).
    if (folderId && perm === 'owner') {
      const target = await q.folderById.get(folderId);
      if (!target || target.owner_id !== user.id || (target.area || null) !== (row.area || null)) folderId = null;
    }
    // Collaborative merge: `baseContent` is the text this client last had in sync
    // with the server. If someone else saved in the meantime (row.content moved
    // on), reconcile the two edits; on a same-line clash this save wins.
    const base = (body.baseContent != null) ? String(body.baseContent) : row.content;
    const merged = merge3(base, incoming, row.content);
    const metaStr = body.meta ? JSON.stringify(body.meta) : row.meta;

    // Two kinds of change: the text itself (bumps the revision, wakes the other
    // editors, moves "last updated") and bookkeeping — folder, pin/meta — which
    // must still be written but should not look like an edit. A save that
    // changes neither is a no-op autosave and is dropped here.
    const textChanged = merged !== row.content || title !== row.title;
    const metaChanged = (folderId || null) !== (row.folder_id || null) || metaStr !== row.meta;
    if (!textChanged && !metaChanged) return { note: shapeNote(row, perm) };

    const now = textChanged ? Date.now() : row.updated_at;
    const rev = textChanged ? (row.rev || 0) + 1 : (row.rev || 0);
    // The note write and its history entry land in this one transaction. Apart,
    // a crash between them leaves either a version of text that was never
    // stored or a save with no way back to what it replaced.
    await q.updateNote.run(folderId, title, merged, metaStr, now, rev, id);
    if (textChanged) await recordVersion(row, user, title, merged, metaStr, rev, now);
    return {
      changed: true,
      payload: textChanged ? { rev: rev, content: merged, title: title, by: user.username, updatedAt: now } : null
    };
  }, 'updateNote');

  if (!out.changed) return out;
  // Let everyone watching the note pull in the authoritative merged text. `by`
  // carries the saver's name so their own client can ignore the echo.
  if (out.payload) hub.broadcastUpdate(id, out.payload);
  return { note: shapeNote(await q.noteById.get(id), perm) };
}

// Relay a live caret position to the other people viewing this note. Nothing is
// stored — it is transient presence, gone the moment the editor moves or leaves.
async function broadcastCursor(user, id, body) {
  const row = await q.noteById.get(id);
  const perm = await permFor(user, row);
  if (!canRead(perm)) return { status: 404 };
  const pos = Math.max(0, parseInt(body && body.pos, 10) || 0);
  const end = Math.max(pos, parseInt(body && body.end, 10) || pos);
  hub.broadcastCursor(id, { by: user.username, pos: pos, end: end, ts: Date.now() });
  return { ok: true };
}

// "Delete" moves the note to the trash. The row stays in `notes` with deleted_at
// set, so shares, versions and images survive and a restore is a one-column
// update; it is deleted for good by purgeNote / emptyTrash / the retention sweep.
const linkpreview = require('./linkpreview');
// purge=true：直接硬刪、不進垃圾桶（影片庫用——使用者要「不留任何痕跡」）。版本／分享／公開連結
// 跟著 FK 一起掉，檔案筆記的檔案照 purgeNote 的規則處理，伺服器的連結預覽快取也一併忘掉。
async function deleteNote(user, id, purge) {
  const row = await q.noteById.get(id);
  const perm = await permFor(user, row);
  if (!canRead(perm)) return { status: 404 };
  if (perm !== 'owner') return { status: 403, error: '只有擁有者可以刪除筆記' };
  if (purge) {
    // 硬刪：筆記本身之外，它引用的上傳（影片庫存進系統的縮圖／大頭照也在內）沒有別篇在用就一起刪
    const f = fileOfNoteRow(row);
    const media = mediaOfNoteRow(row);
    await q.deleteNote.run(id);
    await dropFileIfUnused(f);
    for (const mf of media) await dropFileIfUnused(mf);
    forgetPreviewOf(row);
    return { ok: true, purged: true };
  }
  await q.trashNote.run(Date.now(), id);
  return { ok: true };
}
function forgetPreviewOf(row) {
  const m = /"url"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(String(row.content || ''));
  if (!m) return;
  try { linkpreview.forget(JSON.parse('"' + m[1] + '"')); } catch (e) { /* ignore */ }
}

// ---------------- trash ----------------
const cfg = require('./config');
const trashKeepMs = () => cfg.trashKeepDays * 86400000;

// 垃圾桶的清單只說「這是哪一種筆記」，好讓每一列用對的圖示——meta 本身不送出去。
function kindOfMeta(raw) {
  let m = null;
  try { m = raw ? JSON.parse(raw) : null; } catch (e) { m = null; }
  if (!m) return '';
  return m.relMap ? 'relmap' : m.drawio ? 'drawio' : m.board ? 'board' : m.startpage ? 'start' : m.xmind ? 'xmind' : m.timetree ? 'timetree' : m.progress ? 'progress' : m.foodmap ? 'foodmap' : m.doc ? 'doc' : m.video ? 'video' : m.secReport ? 'sec' : m.perfReport ? 'perf' : m.file ? 'file' : m.sticky ? 'sticky' : '';
}
async function listTrash(user) {
  const rows = await q.trashOf.all(user.id);
  return {
    keepDays: cfg.trashKeepDays,
    notes: rows.map(r => ({
      id: r.id, title: r.title, folderId: r.folder_id, chars: r.chars, kind: kindOfMeta(r.meta),
      updatedAt: r.updated_at, deletedAt: r.deleted_at, expiresAt: r.deleted_at + trashKeepMs()
    }))
  };
}

// Owner-only, and only for rows that are actually in the trash: a live note (or
// someone else's) is 404 here exactly as a trashed one is 404 everywhere else.
async function trashedRowOf(user, id) {
  const row = await q.noteById.get(id);
  return row && row.owner_id === user.id && row.deleted_at ? row : null;
}
async function restoreNote(user, id) {
  if (!(await trashedRowOf(user, id))) return { status: 404 };
  const r = await q.restoreNote.run(id);
  if (!r.affectedRows) return { status: 404 };
  return { note: shapeNote(await q.noteById.get(id), 'owner') };
}
// A "file note" (meta.file, made by uploading into an area folder — js/app.js) is only
// the folder entry for an upload. When the note is deleted for good its file goes with it,
// unless some other note still references it — otherwise a purged 500 MB lecture video
// would sit in the file library forever as "unused". Two steps, in this order: read the
// file id off the row (fileOfNoteRow) BEFORE the note is deleted, drop the file
// (dropFileIfUnused) AFTER — checked against the notes that are left, trashed ones
// included, so two trashed notes naming one file cannot keep each other's file alive when
// the trash is emptied. If the second step fails the file merely shows as unused in the
// library. An id that is a prefix of another id reads as "still used": the safe direction.
function fileOfNoteRow(row) {
  let meta = null;
  try { meta = row && row.meta ? JSON.parse(row.meta) : null; } catch (e) { meta = null; }
  const fid = meta && meta.file && meta.file.id;
  return fid && /^[\w.-]+$/.test(fid) ? { id: fid, ownerId: row.owner_id } : null;
}
// 內文裡每一個 img:/pdf:/file: 引用（硬刪一篇時連它存的圖一起清）
function mediaOfNoteRow(row) {
  const out = [], seen = {};
  for (const m of String(row && row.content || '').matchAll(/\b(?:img|pdf|file):([\w-]+(?:\.[\w-]+)*)/g)) {
    const id = m[1].replace(/[.-]+$/, '');
    if (id && !seen[id]) { seen[id] = true; out.push({ id: id, ownerId: row.owner_id }); }
  }
  return out;
}
async function dropFileIfUnused(f) {
  if (!f) return;
  if (await q.mediaUsedElsewhere.get('', 'img:' + f.id, 'pdf:' + f.id, 'file:' + f.id)) return;
  await q.deleteImage.run(f.id, f.ownerId);   // owner-scoped: never someone else's upload
}
async function purgeNote(user, id) {
  const row = await trashedRowOf(user, id);
  if (!row) return { status: 404 };
  const f = fileOfNoteRow(row);
  await q.deleteNote.run(id);
  await dropFileIfUnused(f);
  return { ok: true };
}
async function emptyTrash(user) {
  const files = (await q.trashedFileNotesOf.all(user.id)).map(fileOfNoteRow);
  const r = await q.purgeTrashOf.run(user.id);
  for (const f of files) await dropFileIfUnused(f);
  return { ok: true, purged: r.affectedRows };
}
// Retention sweep (server.js runs it at start and hourly). One hard delete per
// row so the FK cascades do the same work they do for a manual purge.
async function purgeExpiredTrash() {
  const rows = await q.trashExpired.all(Date.now() - trashKeepMs());
  for (const r of rows) {
    const f = fileOfNoteRow(await q.noteById.get(r.id));
    await q.deleteNote.run(r.id);
    await dropFileIfUnused(f);
  }
  return rows.length;
}

// ---------------- folders ----------------
// Folders are private structure; they are never shared.
function shapeFolder(r) {
  return {
    id: r.id, name: r.name, parentId: r.parent_id, createdAt: r.created_at, isBook: !!r.is_book,
    position: r.position == null ? null : Number(r.position),
    area: r.area || undefined
  };
}
async function listFolders(user) {
  const own = (await q.foldersOf.all(user.id)).map(shapeFolder);
  // Same idea as listNotes: novel folders ride along in this same response once
  // this session has re-typed the password, and are simply absent otherwise.
  const novel = novelUnlocked(user) ? (await q.foldersOfArea.all(user.id, 'novel')).map(shapeFolder) : [];
  return own.concat(novel);
}
async function createFolder(user, body) {
  let area;
  try { area = await resolveArea(user, body.area, body.parentId); }
  catch (e) { return e; }
  if (area === 'novel' && !novelUnlocked(user)) return { status: 403, error: 'novel_locked' };
  const id = uid('fld');
  await q.insertFolder.run(id, user.id, String(body.name || '新資料夾'), body.parentId || null, Date.now(), area);
  return shapeFolder(await q.folderById.get(id));
}
async function updateFolder(user, id, body) {
  const r = await q.folderById.get(id);
  if (!r || r.owner_id !== user.id) return { status: 404 };
  // A folder's own area never changes (same rule as a note's), so a move must
  // land it under a parent of that SAME area — resolveArea, pinned to the area
  // this folder already has instead of one the caller gets to pick.
  const parentId = body.parentId !== undefined ? body.parentId : r.parent_id;
  if (parentId) {
    try { await resolveArea(user, r.area, parentId); }
    catch (e) { return e; }
  }
  await tx(async function () {
    await q.updateFolder.run(String(body.name || r.name), parentId || null, id, user.id);
    // isBook is optional so that a rename or a move leaves the bookshelf alone.
    if (body.isBook !== undefined) await q.setFolderBook.run(body.isBook ? 1 : 0, id, user.id);
  }, 'updateFolder');
  return { folder: shapeFolder(await q.folderById.get(id)) };
}
async function deleteFolder(user, id) {
  const r = await q.folderById.get(id);
  if (!r || r.owner_id !== user.id) return { status: 404 };
  await q.deleteFolder.run(id, user.id);
  return { ok: true };
}

// ---------------- manual order ----------------
// One whole level — the children of `parentId` — in its new order:
// { parentId, notes: [ids] } or { parentId, folders: [ids] }. Every listed row
// gets its position and is moved into that level, so a drag from one folder into
// another is a single request. Like a folder move in updateNote this is
// bookkeeping: no rev, no broadcast, no updated_at. Rows that are not the
// caller's, or are in the trash, are skipped by the statements themselves.
// Deliberately not cross-checked against `area` here the way updateNote's folder
// move is: q.orderNote/orderFolder only ever touch folder_id/parent_id, never
// `area`, so even a forged cross-area call cannot smuggle a note out of the
// novel gate (permFor() and the general listing key off `area`, not folder_id).
// The worst it can do is leave a note's folder_id pointing at a folder from a
// different area, which just makes it fall out of that area's own folder tree —
// a display-only rough edge each area's own (area-scoped) drag-and-drop never
// produces on its own, so it is left as a known gap rather than adding an
// id -> area lookup to every drag here.
const ORDER_MAX = 5000;
async function saveOrder(user, body) {
  const b = body || {};
  const parentId = b.parentId ? String(b.parentId) : null;
  const notes = Array.isArray(b.notes) ? b.notes.map(String) : [];
  const folders = Array.isArray(b.folders) ? b.folders.map(String) : [];
  if (notes.length + folders.length > ORDER_MAX) return { status: 400, error: '一次排序的項目太多' };
  // One level belongs to one area. A note or folder filed into another area's folder is shown
  // by neither area's tree (each filters by area), i.e. it silently disappears — so the rows
  // must match the parent folder's area, or, at the top level, each other's. Changing area is
  // moveNoteArea's job, never a drag's.
  let levelArea;   // undefined until the first owned row (or the parent) says which area this is
  if (parentId) {
    const parent = await q.folderById.get(parentId);
    if (!parent || parent.owner_id !== user.id) return { status: 404 };
    levelArea = parent.area || null;
  }
  for (const kind of [[notes, q.noteAreaById], [folders, q.folderById]]) {
    for (const id of kind[0]) {
      const r = await kind[1].get(id);
      if (!r || r.owner_id !== user.id) continue;   // not mine: the UPDATE skips it as well
      const a = r.area || null;
      if (levelArea === undefined) levelArea = a;
      else if (a !== levelArea) return { status: 400, error: '不能把筆記或資料夾排進別的區域' };
    }
  }
  if (levelArea === undefined) levelArea = null;
  if (folders.length && parentId) {
    // Neither the notes nor the folders table has a foreign key on its parent,
    // so nothing else stops a folder being filed inside its own subtree, where it
    // and everything in it would vanish from every view.
    const all = new Map((await q.foldersOf.all(user.id)).map(f => [f.id, f]));
    const moving = new Set(folders);
    for (let cur = parentId, hops = 0; cur && hops < 10000; hops++) {
      if (moving.has(cur)) return { status: 400, error: '資料夾不能移到自己的子資料夾裡' };
      const f = all.get(cur);
      cur = f ? f.parent_id : null;
    }
  }
  await tx(async function () {
    for (let i = 0; i < notes.length; i++) await q.orderNote.run(parentId, i + 1, notes[i], user.id, levelArea);
    for (let i = 0; i < folders.length; i++) await q.orderFolder.run(parentId, i + 1, folders[i], user.id, levelArea);
  }, 'saveOrder');
  return { ok: true };
}

// ---------------- images ----------------
// Chunked uploads: a file too big for one request (MAX_BODY_BYTES) or one packet
// (max_allowed_packet) arrives as fixed-size chunks, each stored as its own row. The image
// row is `pending` until finishUpload has counted every byte, so a half-uploaded file is
// never listed, served or backed up; abandoned ones are swept hourly. A retried chunk is
// recognised by its sequence number and not appended twice. 8 MiB fits the default
// MAX_BODY_BYTES (25 MB), MariaDB's stock max_allowed_packet (16 MB) and any tunnel; an
// operator who lowered MAX_BODY_BYTES below that gets chunks that still fit one request.
const UPLOAD_CHUNK = Math.max(64 * 1024, Math.min(8 * 1024 * 1024, config.maxBodyBytes || Infinity));
async function startUpload(user, body) {
  const size = Number(body && body.size);
  if (!config.uploadMaxBytes) return { status: 400, error: '這台伺服器沒有開放大檔案上傳' };
  if (!Number.isSafeInteger(size) || size <= 0) return { status: 400, error: '檔案大小不正確' };
  if (size > config.uploadMaxBytes) {
    return { status: 413, error: '檔案太大（上限 ' + Math.floor(config.uploadMaxBytes / 1048576) + ' MB）' };
  }
  const id = uid('img');
  const mime = String((body && body.mime) || 'application/octet-stream').slice(0, 255);
  const name = body && body.name ? String(body.name).slice(0, 255) : null;
  const folderId = await resolveFileFolder(user, body && body.folderId);
  await q.insertImagePending.run(id, user.id, mime, name, Date.now(), size, UPLOAD_CHUNK, folderId);
  return { id: id, chunkSize: UPLOAD_CHUNK, chunks: Math.ceil(size / UPLOAD_CHUNK) };
}
async function pendingUploadOf(user, id) {
  const row = await q.imageById.get(id);
  return row && row.owner_id === user.id && row.pending ? row : null;
}
async function putChunk(user, id, seq, buf) {
  const row = await pendingUploadOf(user, id);
  if (!row) return { status: 404 };
  const total = Number(row.size), cs = Number(row.chunk_size);
  const last = Math.ceil(total / cs) - 1;
  if (!Number.isInteger(seq) || seq < 0 || seq > last) return { status: 400, error: '區塊序號不正確' };
  const want = seq === last ? total - cs * last : cs;
  if (buf.length !== want) return { status: 400, error: '區塊大小不正確' };
  const have = Number((await q.chunkStats.get(id)).n);
  if (seq < have) return { ok: true, next: have };            // a retry of a chunk we already hold
  if (seq > have) return { status: 409, error: '區塊順序不對', next: have };
  await q.insertChunk.run(id, seq, buf);
  return { ok: true, next: have + 1 };
}
async function finishUpload(user, id) {
  const row = await pendingUploadOf(user, id);
  if (!row) return { status: 404 };
  const st = await q.chunkStats.get(id);
  if (Number(st.bytes) !== Number(row.size)) return { status: 409, error: '檔案還沒傳完', next: Number(st.n) };
  await q.finishImage.run(id, user.id);
  return { id: id, size: Number(row.size) };
}
async function sweepPendingUploads() {
  const r = await q.deleteStalePending.run(Date.now() - 3600000);
  return r.affectedRows;
}
// ---------------- file folders (檔案管理／雲端硬碟) ----------------
// 跟筆記的 folders 完全分開的一棵樹，純粹整理上傳的檔案；見 db.js file_folders 表的註解。
// 沒有 area、沒有 permFor() 那套可見性——檔案資料夾本來就是私有的，跟筆記的分享/site-wide
// 完全無關（分享的是筆記，不是檔案管理本身）。
async function resolveFileFolder(user, folderId) {
  if (!folderId) return null;
  const f = await q.fileFolderById.get(folderId);
  if (!f || f.owner_id !== user.id) return null;   // 資料夾不存在或不是自己的：當作根目錄，不擋上傳
  return folderId;
}
async function listFileFolders(user) {
  return (await q.fileFoldersOf.all(user.id)).map(f => ({ id: f.id, name: f.name, parentId: f.parent_id, createdAt: Number(f.created_at) }));
}
async function createFileFolder(user, body) {
  const parentId = await resolveFileFolder(user, body && body.parentId);
  const id = uid('ffld');
  await q.insertFileFolder.run(id, user.id, String((body && body.name) || '新資料夾'), parentId, Date.now());
  const f = await q.fileFolderById.get(id);
  return { id: f.id, name: f.name, parentId: f.parent_id, createdAt: Number(f.created_at) };
}
async function updateFileFolder(user, id, body) {
  const r = await q.fileFolderById.get(id);
  if (!r || r.owner_id !== user.id) return { status: 404 };
  const wantParent = body && body.parentId !== undefined ? body.parentId : r.parent_id;
  // 不能把資料夾搬進自己的子孫底下——會斷成一個孤島，樹狀結構跟著壞掉。
  if (wantParent) {
    let cur = wantParent, hops = 0;
    while (cur && hops++ < 100) {
      if (cur === id) return { status: 400, error: '不能搬到自己的子資料夾底下' };
      const p = await q.fileFolderById.get(cur);
      cur = p ? p.parent_id : null;
    }
  }
  const parentId = await resolveFileFolder(user, wantParent);
  await q.updateFileFolder.run(String((body && body.name) || r.name), parentId, id, user.id);
  const f = await q.fileFolderById.get(id);
  return { folder: { id: f.id, name: f.name, parentId: f.parent_id, createdAt: Number(f.created_at) } };
}
// 檔案沒有垃圾桶，所以刪資料夾絕對不能連坐刪掉裡面的東西：子資料夾與檔案都先搬去上一層
// （NULL 就是雲端硬碟最上層），再刪這個空掉的資料夾——使用者永遠不會因為刪錯一個資料夾
// 就弄丟檔案，最多只是東西跑到上一層，還找得到。
async function deleteFileFolder(user, id) {
  const r = await q.fileFolderById.get(id);
  if (!r || r.owner_id !== user.id) return { status: 404 };
  await tx(async function () {
    await q.moveChildFileFoldersUp.run(r.parent_id, id, user.id);
    await q.moveChildImagesUp.run(r.parent_id, id, user.id);
    await q.deleteFileFolder.run(id, user.id);
  }, 'deleteFileFolder');
  return { ok: true };
}

async function createImage(user, mime, buf, name, folderId) {
  const id = uid('img');
  await q.insertImage.run(id, user.id, String(mime || 'application/octet-stream'), name || null,
    buf, null, null, Date.now(), await resolveFileFolder(user, folderId));
  return { id: id };
}
// 影片庫：把一張外部圖片（縮圖、大頭照）抓回來存進系統，之後就不用每次再去抓。走 linkpreview.image
// 的同一套防護（只准 http(s)、不碰內網、5 MB、只收圖片類型）；存成一般上傳但標 hidden，檔案管理
// 不列、也不會被當成「未使用」掃掉。回 { id }，呼叫端寫成 img:<id>，所以可見性跟任何上傳一樣。
async function storeLinkImage(user, url) {
  const img = await linkpreview.image(url);
  if (img.error) return { status: 400, error: img.error };
  let name = 'image';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'image').slice(0, 120); } catch (e) { /* keep */ }
  const r = await createImage(user, img.type, img.body, name, null);
  await q.setImageHidden.run(1, r.id, user.id);
  return { id: r.id };
}
// 同上，但位元組由瀏覽器給（它已經透過代理抓到、縮小過了）；一樣標 hidden
async function storeImageBytes(user, mime, buf) {
  const r = await createImage(user, mime, buf, 'image', null);
  await q.setImageHidden.run(1, r.id, user.id);
  return { id: r.id };
}
// 檔案管理的重新命名／搬移到資料夾：只動中繼資料，不像 saveImage 那樣要求整包位元組
// （標註）——連分塊上傳的大檔案也能改名字、搬資料夾，只是不能標註（saveImage 自己擋）。
// name／folderId 都是選填，各自要動哪個由呼叫端決定（跟 updateFolder 同一個做法）。
async function updateFile(user, id, body) {
  const row = await q.imageById.get(id);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  if (body && body.name !== undefined) await q.renameImage.run(String(body.name || '').slice(0, 255) || row.name, id, user.id);
  if (body && body.folderId !== undefined) await q.moveImage.run(await resolveFileFolder(user, body.folderId), id, user.id);
  return { ok: true };
}

async function getImage(user, id) {
  const row = await q.imageById.get(id);
  if (!row || row.pending) return null;   // pending = a chunked upload still in progress
  if (row.owner_id === user.id) return row;
  // Not the owner: only serve it if some note the caller can read references it,
  // as an image (img:), a PDF (pdf:) or any other attachment (file:).
  for (const scheme of ['img:', 'pdf:', 'file:']) {
    if (await q.imageVisibleTo.get(scheme + id, user.id, user.id)) return row;
  }
  return null;
}

async function saveImage(user, id, body) {
  const row = await q.imageById.get(id);
  if (!row) return { status: 404 };
  // Annotations rewrite pixels — only the owner may do that, even if a recipient
  // has edit rights on a note that happens to embed the image.
  if (row.owner_id !== user.id) return { status: 403, error: '只有圖片擁有者可以標註' };
  // A chunked upload is served from image_chunks; rewriting `data` would be ignored.
  if (row.size != null) return { status: 400, error: '分塊上傳的大檔案不能標註' };
  const data = Buffer.from(body.data, 'base64');
  const original = body.original ? Buffer.from(body.original, 'base64') : row.original;
  await q.updateImage.run(String(body.mime || row.mime), data, original,
    body.shapes ? JSON.stringify(body.shapes) : null, id);
  return { ok: true };
}

async function deleteImage(user, id) {
  await q.deleteImage.run(id, user.id);
  return { ok: true };
}

// ---------------- drawio 的圖示庫（js/drawio.js 左邊的「我的圖示」）----------------
// 一個圖示就是一個普通的上傳（images 的一列）加上 icon = 1。清單只有本人拿得到：
// listIcons 只查 owner_id = 自己的，沒有任何「別人的圖示庫」可以問。
// 圖示用在圖裡是寫成 src=img:<id>，所以「誰看得到這張圖片」照舊由 getImage 決定——讀得到
// 那張圖表的人看得到上面的圖示（不然分享出去的圖會缺一塊），但他拿不到圖示庫，也不能
// 把它加進自己的庫。
// 只收瀏覽器能當圖片畫的幾種，大小有上限：圖示庫每次開編輯器都要整排載入縮圖。
const ICON_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
const ICON_MAX_BYTES = 2 * 1024 * 1024;
const ICON_MAX_COUNT = 300;
function shapeIcon(r) {
  return { id: r.id, name: r.name || '', mime: r.mime, bytes: Number(r.bytes), createdAt: Number(r.created_at) };
}
async function listIcons(user) {
  return { icons: (await q.iconsOf.all(user.id)).map(shapeIcon) };
}
async function createIcon(user, mime, buf, name) {
  if (ICON_MIMES.indexOf(String(mime)) < 0) return { status: 400, error: '圖示只能是 PNG、JPG、GIF、WebP 或 SVG' };
  if (!buf || !buf.length) return { status: 400, error: '檔案是空的' };
  if (buf.length > ICON_MAX_BYTES) return { status: 413, error: '圖示不能超過 2 MB' };
  if ((await q.countIconsOf.get(user.id)).n >= ICON_MAX_COUNT) {
    return { status: 400, error: '圖示庫最多 ' + ICON_MAX_COUNT + ' 個，先移除一些用不到的' };
  }
  const id = uid('img');
  await tx(async function () {
    await q.insertImage.run(id, user.id, String(mime), name || null, buf, null, null, Date.now(), null);
    await q.setImageIcon.run(1, id, user.id);
  }, 'createIcon');
  return { icon: { id: id, name: name || '', mime: String(mime), bytes: buf.length, createdAt: Date.now() } };
}
// 從圖示庫移除。已經畫在某張圖裡的圖示，檔案要留著（不然那張圖就缺一塊），只是不再出現
// 在庫裡；沒有任何筆記用到的才連檔案一起刪。kept 告訴前端是哪一種。
async function removeIcon(user, id) {
  const row = await q.imageById.get(id);
  if (!row || row.owner_id !== user.id || !row.icon) return { status: 404 };
  await q.setImageIcon.run(0, id, user.id);
  await dropFileIfUnused({ id: id, ownerId: user.id });
  return { ok: true, kept: !!(await q.imageOwner.get(id)) };
}

// ---------------- image library ----------------
// Everything the caller uploaded, each with the notes that embed it, for the
// image manager (js/imagelib.js). "Embeds" is read from note text exactly the
// way image visibility is decided above (img:<id> or pdf:<id> anywhere in the
// content), and across every note, not only the caller's: an upload pasted into
// someone else's note is still in use, and calling it unused would invite a
// delete that breaks their note. A note the caller cannot open is counted in
// hiddenNotes but never named, and its alt text is never used as the name.
// The caller's own trashed notes are listed (flagged) since the owner can
// restore them; anyone else's trash is invisible, so it counts as hidden.
// `!?` because a PDF shown as a file link and every other attachment are written
// without the image bang: [名稱](pdf:…) / [名稱](file:…).
const MEDIA_REF = /(?:!?\[([^\]\n]*)\]\()?(?:img|pdf|file):([\w.-]+)/g;

async function listImages(user) {
  const images = (await q.imagesOf.all(user.id)).map(r => ({
    id: r.id, mime: r.mime, createdAt: Number(r.created_at), folderId: r.folder_id, icon: !!r.icon,
    bytes: Number(r.bytes) + Number(r.original_bytes), annotated: !!r.annotated,
    name: '', fileName: r.name || '', notes: [], hiddenNotes: 0
  }));
  if (!images.length) return { images: images };
  const byId = new Map(images.map(i => [i.id, i]));

  for (const n of await q.notesEmbeddingMedia.all()) {
    const hits = new Map();                 // image id -> { count, alt }
    for (const m of String(n.content).matchAll(MEDIA_REF)) {
      // [\w.-]+ also swallows a full stop that ends a sentence ("see img:img_x.").
      let id = m[2];
      if (!byId.has(id)) id = id.replace(/[.-]+$/, '');
      if (!byId.has(id)) continue;
      const h = hits.get(id) || { count: 0, alt: '' };
      h.count++;
      if (!h.alt && m[1] && m[1] !== '__cover_logo__') h.alt = m[1].trim();
      hits.set(id, h);
    }
    if (!hits.size) continue;

    const mine = n.owner_id === user.id;
    const visible = mine || !!(await permFor(user, n));
    for (const [id, h] of hits) {
      const img = byId.get(id);
      if (!visible) { img.hiddenNotes++; continue; }
      if (!img.name && h.alt) img.name = h.alt;
      img.notes.push({
        id: n.id, title: n.title, folderId: mine ? n.folder_id : null, count: h.count,
        trashed: !!n.deleted_at, sharedBy: mine ? undefined : n.owner_name, updatedAt: Number(n.updated_at)
      });
    }
  }
  for (const img of images) {
    // Live notes first, then the most recently edited.
    img.notes.sort((a, b) => (a.trashed - b.trashed) || (b.updatedAt - a.updatedAt));
    // An image keeps the alt text someone gave it in a note ("螢幕截圖" says more
    // than "image.png"); any other file is known by the name it was uploaded with.
    const media = /^image\//.test(img.mime) || img.mime === 'application/pdf';
    if (img.fileName && (!img.name || !media)) img.name = img.fileName;
  }
  return { images: images };
}

// ---------------- shares ----------------
async function listShares(user, noteId) {
  const row = await q.noteById.get(noteId);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  return {
    shares: (await q.sharesOfNote.all(noteId)).map(s => ({ username: s.username, perm: s.perm }))
  };
}

async function addShare(user, noteId, body) {
  const row = await q.noteById.get(noteId);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  const perm = body.perm === 'edit' ? 'edit' : 'read';
  const target = await q.userByName.get(String(body.username || ''));
  if (!target) return { status: 404, error: '找不到這個帳號' };
  if (target.id === user.id) return { status: 400, error: '不能分享給自己' };
  await q.insertShare.run(noteId, target.id, perm, Date.now());
  return { ok: true, username: target.username, perm: perm };
}

async function removeShare(user, noteId, username) {
  const row = await q.noteById.get(noteId);
  if (!row) return { status: 404 };
  const target = await q.userByName.get(String(username || ''));
  if (!target) return { status: 404, error: '找不到這個帳號' };
  // The owner may revoke anyone; a recipient may drop their own share (leave),
  // but may not meddle with anyone else's access.
  const isOwner = row.owner_id === user.id;
  const isSelf = target.id === user.id && !!(await q.shareFor.get(noteId, user.id));
  if (!isOwner && !isSelf) return { status: 404 };
  await q.deleteShare.run(noteId, target.id);
  return { ok: true };
}

// ---------------- admin ----------------
//
// Scope note: an admin manages *accounts*, not content. There is deliberately no
// endpoint here that returns anyone's note text — only counts. Reading a
// colleague's report still requires them to share it.
async function adminListUsers(user) {
  return {
    users: (await q.listUsers.all()).map(function (u) {
      return {
        id: u.id, username: u.username, role: u.role,
        disabled: !!u.disabled, createdAt: u.created_at, lastLogin: u.last_login,
        notes: u.notes, folders: u.folders, images: u.images,
        sharedOut: u.shared_out, sharedIn: u.shared_in,
        self: u.id === user.id
      };
    })
  };
}

// The "last admin" guard rails below read the admin count with the rows locked
// inside the same transaction as the change, so two admins demoting or deleting
// each other at the same moment cannot both pass the check.
async function adminSetDisabled(user, id, disabled) {
  const target = await q.userById.get(Number(id));
  if (!target) return { status: 404, error: '找不到這個帳號' };
  if (target.id === user.id) return { status: 400, error: '不能停用自己的帳號' };
  return tx(async function () {
    if (disabled && target.role === 'admin' && (await q.countAdminsLocked.get()).n <= 1) {
      return { status: 400, error: '這是最後一個啟用中的管理員，不能停用' };
    }
    await q.setDisabled.run(disabled ? 1 : 0, target.id);
    // Kill their sessions so a disable takes effect now, not when the cookie expires.
    if (disabled) await q.deleteSessionsOf.run(target.id);
    return { ok: true, disabled: !!disabled };
  }, 'setDisabled');
}

async function adminSetRole(user, id, role) {
  const target = await q.userById.get(Number(id));
  if (!target) return { status: 404, error: '找不到這個帳號' };
  if (role !== 'admin' && role !== 'user') return { status: 400, error: '權限值不正確' };
  if (target.id === user.id) return { status: 400, error: '不能更改自己的權限' };
  return tx(async function () {
    if (role === 'user' && target.role === 'admin' && (await q.countAdminsLocked.get()).n <= 1) {
      return { status: 400, error: '這是最後一個管理員，不能取消其權限' };
    }
    await q.setRole.run(role, target.id);
    return { ok: true, role: role };
  }, 'setRole');
}

async function adminDeleteUser(user, id) {
  const target = await q.userById.get(Number(id));
  if (!target) return { status: 404, error: '找不到這個帳號' };
  if (target.id === user.id) return { status: 400, error: '不能刪除自己的帳號' };
  return tx(async function () {
    if (target.role === 'admin' && (await q.countAdminsLocked.get()).n <= 1) {
      return { status: 400, error: '這是最後一個管理員，不能刪除' };
    }
    // Their notes, folders, images and shares go with them (ON DELETE CASCADE).
    await q.deleteSessionsOf.run(target.id);
    await q.deleteUser.run(target.id);
    return { ok: true };
  }, 'deleteUser');
}

// ---------------- storage ----------------
//
// Disk headroom where MariaDB keeps its files, plus what the database is made
// of. Sizes and counts only — consistent with the admin scope note above, this
// never touches note text. The data directory comes from `SELECT @@datadir` at
// startup; statfs on it needs no permission on the directory itself, only on
// the path leading to it, and falls back up the tree when even that is denied.
function diskFor(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch (e) { return null; }
}
function storageSummary() {
  const dir = dbmod.datadir;
  let disk = null;
  const candidates = dir ? [dir, path.dirname(dir), '/'] : [];
  for (const c of candidates) { disk = diskFor(c); if (disk) break; }
  const warnBytes = config.storageWarnMb * 1024 * 1024;
  const low = !!disk && (disk.free < warnBytes || (disk.total > 0 && disk.free / disk.total * 100 < config.storageWarnPct));
  return { disk: disk, low: low, thresholds: { bytes: warnBytes, pct: config.storageWarnPct } };
}
async function adminStorage() {
  const dbBytes = (await q.dbBytes.get()).bytes;
  const img = await q.imageBytes.get();
  const notes = await q.noteBytes.get();
  // Version history keeps a full copy of the text per version, so on a note that
  // is edited daily it can outweigh the note itself. Reporting it separately is
  // the only way the number in the panel matches what is actually on disk.
  const versions = await q.versionBytes.get();
  // Each share link stores a whole packed book, images and all, so these are the
  // single largest rows in the database and have to be visible in the panel.
  const bookLinks = await q.linkBytes.get();
  const noteLinks = await q.noteLinkBytes.get();   // 單篇筆記的公開連結也是一整頁打包好的 HTML
  const links = { n: Number(bookLinks.n) + Number(noteLinks.n), bytes: Number(bookLinks.bytes) + Number(noteLinks.bytes) };
  const s = storageSummary();
  return {
    dataDir: dbmod.datadir || '',
    dbBytes: dbBytes,
    images: { count: img.n, bytes: img.bytes },
    notes: { count: notes.n, bytes: notes.bytes },
    versions: { count: versions.n, bytes: versions.bytes },
    links: { count: links.n, bytes: links.bytes },
    disk: s.disk, low: s.low, thresholds: s.thresholds,
    perUser: (await q.storagePerUser.all()).map(function (u) {
      return {
        id: u.id, username: u.username,
        notes: u.notes, noteBytes: u.note_bytes,
        versions: u.versions, versionBytes: u.version_bytes,
        images: u.images, imageBytes: u.image_bytes
      };
    })
  };
}

// 系統監控（帳號選單 → 系統監控）：機器本身（server/sysmon.js）＋ 這個站台現在的狀態。
// 跟 adminStorage 一樣只有數字，沒有任何筆記內容。
async function adminSystem() {
  const sess = await q.sessionStats.get(Date.now());
  return sysmon.snapshot({
    hub: hub.stats(),
    sessions: { n: Number(sess.n), users: Number(sess.users) },
    users: Number((await q.countUsers.get()).n),
    storage: await adminStorage()
  });
}

module.exports = {
  adminListUsers, adminSetDisabled, adminSetRole, adminDeleteUser, adminStorage, adminSystem, storageSummary,
  listNotes, getNote, createNote, updateNote, deleteNote, broadcastCursor, setAccess, moveNoteArea,
  listTrash, restoreNote, purgeNote, emptyTrash, purgeExpiredTrash,
  listVersions, getVersion, createVersion, renameVersion, deleteVersion, restoreVersion,
  listBookVersions, createBookVersion, getBookVersion, getBookVersionChapter,
  restoreBookVersion, deleteBookVersion,
  listBookLinks, createBookLink, updateBookLink, deleteBookLink, publicBook,
  listNoteLinks, createNoteLink, updateNoteLink, deleteNoteLink, publicNote,
  listFolders, createFolder, updateFolder, deleteFolder,
  listFileFolders, createFileFolder, updateFileFolder, deleteFileFolder,
  createImage, storeLinkImage, storeImageBytes, getImage, saveImage, updateFile, deleteImage, listImages, saveOrder,
  listIcons, createIcon, removeIcon, ICON_MAX_BYTES,
  startUpload, putChunk, finishUpload, sweepPendingUploads,
  listShares, addShare, removeShare,
  normalizeArea   // server/backup.js reuses this so a restored area is validated the same way a live create is
};
