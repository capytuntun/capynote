/* db.js — schema and queries on MariaDB via mysql2.
 *
 * Every statement here is prepared with bound parameters; user input is never
 * concatenated into SQL.
 *
 * Shape: `q.<name>.get(...) / .all(...) / .run(...)` are async and keep the
 * positional-parameter order the SQLite version had. `run()` resolves to
 * `{ insertId, affectedRows }`; `get()` resolves to `undefined` when nothing
 * matched.
 *
 * Transactions: `tx(async () => { ... })` checks a connection out of the pool,
 * BEGINs, and binds that connection through AsyncLocalStorage so every `q.*`
 * call inside the callback runs on it. Outside a `tx` callback `q.*` runs on
 * the pool with autocommit. A `tx()` started while another is active JOINS the
 * outer transaction (no new BEGIN), so helpers that need atomicity can be
 * composed. Two rules follow from this:
 *
 *   1. Do not schedule anything that escapes the callback (timers, un-awaited
 *      promises, hub broadcasts) from inside a `tx`: a deadlock retry re-runs
 *      the whole callback, and a rollback would leave phantom side effects.
 *      Collect results inside, act on them after `tx` resolves.
 *   2. A callback must be safe to run twice — build result arrays inside it.
 */
'use strict';

const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config');

const als = new AsyncLocalStorage();
let pool = null;
let datadir = '';

function conn() {
  const s = als.getStore();
  return (s && s.conn) || pool;
}
// mysql2 refuses `undefined` as a bound value; callers pass optional fields
// straight through, so treat undefined as SQL NULL.
const fix = p => p.map(v => (v === undefined ? null : v));

function stmt(sql) {
  return {
    sql: sql,
    async get() { const [rows] = await conn().execute(sql, fix(Array.from(arguments))); return rows[0]; },
    async all() { const [rows] = await conn().execute(sql, fix(Array.from(arguments))); return rows; },
    async run() {
      const [r] = await conn().execute(sql, fix(Array.from(arguments)));
      return { insertId: r.insertId, affectedRows: r.affectedRows };
    }
  };
}

// ---------------- concurrency helpers ----------------

// "Busy" = the request can simply be retried a moment later: a deadlock or a
// lock-wait timeout on the row it wanted, or a connection that vanished because
// MariaDB is restarting. The router turns these into 503 + Retry-After, and the
// client store retries on its own — same contract the SQLite version had.
function isBusy(e) {
  if (!e) return false;
  if (e.busy) return true;
  const c = e.code || e.errno;
  return c === 'ER_LOCK_DEADLOCK' || c === 1213 ||
         c === 'ER_LOCK_WAIT_TIMEOUT' || c === 1205 ||
         c === 'PROTOCOL_CONNECTION_LOST' || c === 'ECONNREFUSED' || c === 'ECONNRESET' ||
         c === 'ER_SERVER_SHUTDOWN' || c === 1053;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function retry(fn, label) {
  let wait = 20;
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!isBusy(e) || attempt >= 5) {
        if (isBusy(e)) {
          const err = new Error('資料庫忙碌中，請稍後再試');
          err.busy = true;
          err.cause = e;
          throw err;
        }
        throw e;
      }
      console.warn('[db] ' + (label || 'op') + ' 遇到鎖，第 ' + attempt + ' 次重試');
      await sleep(wait);
      wait *= 2;
    }
  }
}

async function tx(fn, label) {
  if (als.getStore()) return fn();            // nested: join the outer transaction
  return retry(async function () {
    const c = await pool.getConnection();
    try {
      await c.beginTransaction();
      const out = await als.run({ conn: c }, fn);
      await c.commit();
      return out;
    } catch (e) {
      try { await c.rollback(); } catch (e2) { /* connection is gone; release anyway */ }
      throw e;
    } finally {
      c.release();
    }
  }, label);
}

// ---------------- schema ----------------
//
// One statement per array element (multipleStatements stays off). Text ids and
// tokens are utf8mb4_bin so comparisons are exact and PK lookups are cheap; a
// foreign-key column must carry the collation of the column it references, so
// every note_id / folder_id / parent_id does too. `username` deliberately keeps
// the case-insensitive default collation: "admin" and "Admin" are the same
// account, which is what a login form should mean anyway.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id             INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username       VARCHAR(64) NOT NULL,
    pw_hash        VARBINARY(128) NOT NULL,
    pw_salt        VARBINARY(64) NOT NULL,
    created_at     BIGINT NOT NULL,
    role           VARCHAR(16) NOT NULL DEFAULT 'user',
    disabled       TINYINT(1) NOT NULL DEFAULT 0,
    must_change_pw TINYINT(1) NOT NULL DEFAULT 0,
    last_login     BIGINT NULL,
    UNIQUE KEY uq_users_username (username)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    user_id    INT NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    KEY idx_sessions_user (user_id),
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS folders (
    id         VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    owner_id   INT NOT NULL,
    name       TEXT NOT NULL,
    parent_id  VARCHAR(64) COLLATE utf8mb4_bin NULL,
    created_at BIGINT NOT NULL,
    is_book    TINYINT(1) NOT NULL DEFAULT 0,
    area       VARCHAR(16) NULL,
    KEY idx_folders_owner (owner_id),
    CONSTRAINT fk_folders_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS notes (
    id          VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    owner_id    INT NOT NULL,
    folder_id   VARCHAR(64) COLLATE utf8mb4_bin NULL,
    title       TEXT NOT NULL,
    content     LONGTEXT NOT NULL,
    meta        LONGTEXT NULL,
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL,
    rev         INT NOT NULL DEFAULT 0,
    access      VARCHAR(16) NOT NULL DEFAULT 'restricted',
    access_perm VARCHAR(8) NOT NULL DEFAULT 'read',
    area        VARCHAR(16) NULL,
    KEY idx_notes_owner (owner_id),
    CONSTRAINT fk_notes_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS images (
    id         VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    owner_id   INT NOT NULL,
    mime       VARCHAR(255) NOT NULL,
    data       LONGBLOB NOT NULL,
    original   LONGBLOB NULL,
    shapes     LONGTEXT NULL,
    created_at BIGINT NOT NULL,
    KEY idx_images_owner (owner_id),
    CONSTRAINT fk_images_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // Big uploads (course videos, decks): one request can carry at most MAX_BODY_BYTES
  // and one packet at most max_allowed_packet, so a large file is stored as a run of
  // fixed-size chunks instead of one LONGBLOB. images.size / images.chunk_size say so;
  // images.data is then an empty blob. Every chunk but the last is exactly chunk_size
  // bytes, which is what makes HTTP Range a matter of arithmetic (server.js sendChunked).
  `CREATE TABLE IF NOT EXISTS image_chunks (
    image_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    seq      INT NOT NULL,
    data     LONGBLOB NOT NULL,
    PRIMARY KEY (image_id, seq),
    CONSTRAINT fk_chunks_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 檔案管理／雲端硬碟（js/imagelib.js, server/api.js 的 "file folders"）：一套跟筆記的
  // folders 完全分開的資料夾樹，只用來整理上傳的檔案本身，不牽涉任何一篇筆記——沒有 area、
  // 沒有 is_book，就是最陽春的「id / 名字 / 上層」。images.folder_id（下面 MIGRATIONS）指到
  // 這裡；NULL 是雲端硬碟的最上層。刻意不重用 folders 表：folders 的 area 系統（course/
  // knowledge/quick/novel）跟 permFor()／novelUnlocked() 這些筆記可見性規則綁得很緊，檔案
  // 資料夾不該被拖進那套邏輯，也不該讓「刪除資料夾」意外牽動任何一篇筆記。
  `CREATE TABLE IF NOT EXISTS file_folders (
    id         VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    owner_id   INT NOT NULL,
    name       TEXT NOT NULL,
    parent_id  VARCHAR(64) COLLATE utf8mb4_bin NULL,
    created_at BIGINT NOT NULL,
    KEY idx_file_folders_owner (owner_id),
    CONSTRAINT fk_file_folders_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS shares (
    note_id    VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    user_id    INT NOT NULL,
    perm       VARCHAR(8) NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (note_id, user_id),
    KEY idx_shares_user (user_id),
    CONSTRAINT chk_shares_perm CHECK (perm IN ('read','edit')),
    CONSTRAINT fk_shares_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
    CONSTRAINT fk_shares_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 筆記版本歷史。一次儲存 = 一列會讓 500ms 自動存檔在一小時內產生幾百列，所以
  // api.js 會「合併」同一個人短時間內的連續存檔（見 VERSION_COALESCE_MS），一次
  // 編輯時段只留一列。label 不是 NULL 的是使用者手動建立的標記版本，永遠不會被
  // 自動修剪掉。content 存整份內文而不是差異——筆記本來就只有幾十 KB，存整份換來
  // 的是「還原」不可能因為中間某個差異壞掉而失敗。
  `CREATE TABLE IF NOT EXISTS note_versions (
    id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    note_id    VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    rev        INT NOT NULL,
    title      TEXT NOT NULL,
    content    LONGTEXT NOT NULL,
    meta       LONGTEXT NULL,
    author     VARCHAR(64) NOT NULL,
    label      VARCHAR(255) NULL,
    created_at BIGINT NOT NULL,
    KEY idx_note_versions (note_id, id),
    CONSTRAINT fk_note_versions_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 電子書版本。一本書就是一個資料夾，資料夾本身沒有任何可以版本化的東西，所以
  // 一個書版本記的是「當下這本書由哪些筆記、各自的哪一個版本組成」——manifest 是
  // 一個 JSON 陣列 [{noteId, title, versionId, rev}]，順序就是章節順序。還原一本書
  // 就是把每一章各自還原到它被釘住的那個筆記版本。
  `CREATE TABLE IF NOT EXISTS book_versions (
    id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    folder_id  VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    owner_id   INT NOT NULL,
    title      TEXT NOT NULL,
    label      VARCHAR(255) NULL,
    manifest   LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL,
    KEY idx_book_versions (folder_id, id),
    CONSTRAINT fk_book_versions_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 公開分享連結。這是這個系統裡唯一不需要登入就能讀到的東西，所以刻意做成
  // 「快照」而不是「開一個口子讓外面的人讀資料庫」：擁有者按下分享時，前端把整本書
  // 打包成一個自給自足的 HTML（圖片已是 data URL），伺服器只是把那份 HTML 原封不動
  // 存起來、之後原封不動吐出去。持有連結的人拿不到任何 API、任何其他筆記、任何
  // 之後的修改——除非擁有者再按一次「更新內容」。
  // token 是 32 bytes 的亂數（64 個十六進位字元），無法猜測；expires_at 可為 NULL
  // 表示不過期。
  `CREATE TABLE IF NOT EXISTS book_links (
    token      VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    folder_id  VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    owner_id   INT NOT NULL,
    title      TEXT NOT NULL,
    html       LONGTEXT NOT NULL,
    chapters   INT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    expires_at BIGINT NULL,
    views      INT NOT NULL DEFAULT 0,
    KEY idx_book_links_owner (owner_id, folder_id),
    CONSTRAINT fk_book_links_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 單篇筆記的公開連結（/s/<token>，沒有帳號也能看）。跟上面電子書的連結同一套規則：
  // 存的是擁有者按下「建立／更新內容」那一刻打包好的整頁 HTML，不是即時的筆記——拿到
  // token 的人只拿得到那一頁，碰不到 API，也看不到之後的修改。note_rev 記下快照是筆記的
  // 第幾版，介面上才說得出「筆記在那之後改過」。筆記被永久刪除，連結跟著消失（FK）。
  `CREATE TABLE IF NOT EXISTS note_links (
    token      VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    note_id    VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    owner_id   INT NOT NULL,
    title      TEXT NOT NULL,
    html       LONGTEXT NOT NULL,
    note_rev   INT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    expires_at BIGINT NULL,
    views      INT NOT NULL DEFAULT 0,
    KEY idx_note_links_note (note_id),
    KEY idx_note_links_owner (owner_id),
    CONSTRAINT fk_note_links_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_note_links_note FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  // 管理員在介面上改的站台設定（server/settings.js）：註冊方式、邀請碼。一列一個鍵。
  `CREATE TABLE IF NOT EXISTS settings (
    k          VARCHAR(64) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
    v          TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
];

// Columns added after a table's first release. Each is [table, column, DDL];
// `addColumnIfMissing` consults information_schema instead of catching an
// ALTER error, so a real failure (permissions, disk) is not swallowed. The list
// mirrors the SQLite history so the helper is exercised on every fresh boot.
const MIGRATIONS = [
  ['users', 'role', "VARCHAR(16) NOT NULL DEFAULT 'user'"],
  ['users', 'disabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['users', 'must_change_pw', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['users', 'last_login', 'BIGINT NULL'],
  ['notes', 'rev', 'INT NOT NULL DEFAULT 0'],
  ['notes', 'access', "VARCHAR(16) NOT NULL DEFAULT 'restricted'"],
  ['notes', 'access_perm', "VARCHAR(8) NOT NULL DEFAULT 'read'"],
  ['folders', 'is_book', 'TINYINT(1) NOT NULL DEFAULT 0'],
  // Soft delete: ms epoch when the note went into the trash, NULL = live. Shares,
  // versions and images stay attached so a restore brings everything back.
  ['notes', 'deleted_at', 'BIGINT NULL'],
  // Manual order within a folder (api.js saveOrder). NULL = never dragged; the
  // client sorts those ahead of positioned ones by last update.
  ['notes', 'position', 'INT NULL'],
  ['folders', 'position', 'INT NULL'],
  // The uploaded file's own name, for downloads and the file library.
  ['images', 'name', 'VARCHAR(255) NULL'],
  // Chunked uploads (image_chunks): total bytes and the chunk size they were cut at;
  // both NULL for an ordinary single-blob upload. pending = still being uploaded:
  // invisible to every listing and read until finishUpload clears it, swept after an hour.
  ['images', 'size', 'BIGINT NULL'],
  ['images', 'chunk_size', 'INT NULL'],
  ['images', 'pending', 'TINYINT NOT NULL DEFAULT 0'],
  // Areas (server/api.js "areas"): a note/folder's home is NULL (一般, unchanged
  // default) or 'course' | 'knowledge' | 'quick' | 'novel', set once at creation
  // and never changed afterwards. A folder's own area must match every note and
  // sub-folder placed inside it (enforced in api.js, not by a DB constraint,
  // since MariaDB has no portable "check against a joined row" constraint).
  ['notes', 'area', 'VARCHAR(16) NULL'],
  ['folders', 'area', 'VARCHAR(16) NULL'],
  // Set by POST /api/novel/unlock after the caller re-types their own password;
  // permFor() only grants access to an area:'novel' note while this is set and
  // fresh (NOVEL_UNLOCK_TTL_MS in api.js) — see the 小說 bullet in CLAUDE.md.
  ['sessions', 'novel_unlocked_at', 'BIGINT NULL'],
  // 檔案管理／雲端硬碟：哪個 file_folders 資料夾裝著這個檔案，NULL = 最上層。跟 notes.area
  // 那套完全無關——見上面 file_folders 表的註解。
  ['images', 'folder_id', 'VARCHAR(64) COLLATE utf8mb4_bin NULL'],
  // drawio 的「我的圖示」：這個上傳是不是擁有者的圖示庫裡的一個。只是一個標記——檔案
  // 本身、誰看得到它（筆記內容裡有 img:<id>）都跟其他上傳一樣，見 api.js 的 listIcons。
  ['images', 'icon', 'TINYINT NOT NULL DEFAULT 0'],
  // 影片庫存進系統的縮圖／大頭照（api.js storeLinkImage）：是上傳沒錯，但不出現在檔案管理
  ['images', 'hidden', 'TINYINT NOT NULL DEFAULT 0'],
  // 公開連結要不要跟著筆記自動更新（見 api.js 的 note_links 那一段）。預設 1：加這個欄位
  // 之前建立的連結本來就是自動更新的，升級之後行為不能變。
  ['note_links', 'auto_update', 'TINYINT NOT NULL DEFAULT 1']
];

async function addColumnIfMissing(table, col, ddl) {
  const [rows] = await pool.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, col]);
  if (!rows.length) {
    console.log('[db] ALTER TABLE ' + table + ' ADD COLUMN ' + col);
    await pool.query('ALTER TABLE `' + table + '` ADD COLUMN `' + col + '` ' + ddl);
  }
}

// Called once from server.js before anything else touches `q`.
async function init() {
  pool = mysql.createPool({
    host: config.db.socket ? undefined : config.db.host,
    port: config.db.socket ? undefined : config.db.port,
    socketPath: config.db.socket || undefined,
    user: config.db.user,
    password: config.db.password,
    database: config.db.name,
    charset: 'utf8mb4_unicode_ci',
    waitForConnections: true,
    connectionLimit: 5,
    maxIdle: 5,
    idleTimeout: 60000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 10000,
    // Integers and SUM()/COUNT() come back as JS numbers, not strings: api.js
    // compares owner_id === user.id all over the place.
    supportBigNumbers: true,
    bigNumberStrings: false,
    decimalNumbers: true,
    namedPlaceholders: false,
    multipleStatements: false
  });
  await pool.query('SELECT 1');
  for (const ddl of SCHEMA) await pool.query(ddl);
  for (const m of MIGRATIONS) await addColumnIfMissing(m[0], m[1], m[2]);
  const [rows] = await pool.query('SELECT @@datadir AS dir');
  datadir = String((rows[0] && rows[0].dir) || '');
}

async function close() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

const q = {
  ping: stmt('SELECT 1 AS ok'),

  // users
  userByName: stmt('SELECT * FROM users WHERE username = ?'),
  userById: stmt(
    'SELECT id, username, created_at, role, disabled, must_change_pw FROM users WHERE id = ?'),
  insertUser: stmt(
    'INSERT INTO users (username, pw_hash, pw_salt, created_at, role) VALUES (?, ?, ?, ?, ?)'),
  countUsers: stmt('SELECT COUNT(*) AS n FROM users'),
  countAdmins: stmt("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0"),
  // Same count, but holding the rows until the transaction ends, so two admins
  // demoting each other at the same moment cannot both see "2 admins left".
  countAdminsLocked: stmt(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 FOR UPDATE"),
  setPassword: stmt('UPDATE users SET pw_hash = ?, pw_salt = ?, must_change_pw = 0 WHERE id = ?'),
  setMustChange: stmt('UPDATE users SET must_change_pw = ? WHERE id = ?'),
  touchLogin: stmt('UPDATE users SET last_login = ? WHERE id = ?'),

  // admin — metadata only; note contents are deliberately not exposed here
  listUsers: stmt(`
    SELECT u.id, u.username, u.role, u.disabled, u.created_at, u.last_login,
           (SELECT COUNT(*) FROM notes n WHERE n.owner_id = u.id)              AS notes,
           (SELECT COUNT(*) FROM folders f WHERE f.owner_id = u.id)            AS folders,
           (SELECT COUNT(*) FROM images i WHERE i.owner_id = u.id)             AS images,
           (SELECT COUNT(*) FROM shares s JOIN notes n2 ON n2.id = s.note_id
              WHERE n2.owner_id = u.id)                                        AS shared_out,
           (SELECT COUNT(*) FROM shares s2 WHERE s2.user_id = u.id)            AS shared_in
    FROM users u ORDER BY u.id`),
  setDisabled: stmt('UPDATE users SET disabled = ? WHERE id = ?'),
  setRole: stmt('UPDATE users SET role = ? WHERE id = ?'),
  deleteUser: stmt('DELETE FROM users WHERE id = ?'),
  deleteSessionsOf: stmt('DELETE FROM sessions WHERE user_id = ?'),

  // sessions
  insertSession: stmt(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  sessionByHash: stmt('SELECT * FROM sessions WHERE token_hash = ?'),
  deleteSession: stmt('DELETE FROM sessions WHERE token_hash = ?'),
  deleteExpiredSessions: stmt('DELETE FROM sessions WHERE expires_at < ?'),
  // 系統監控：還沒過期的登入有幾個、是幾個不同的帳號
  sessionStats: stmt('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM sessions WHERE expires_at > ?'),
  // 小說區解鎖（server/auth.js unlockNovel）：這個 session 最後一次成功重新輸入密碼的時間。
  setNovelUnlock: stmt('UPDATE sessions SET novel_unlocked_at = ? WHERE token_hash = ?'),

  // folders
  // "Areas" (server/api.js): course/knowledge/quick folders ride along in the
  // normal listing — the client filters by .area client-side, same idea as
  // filtering by .folderId — because they cost nothing to expose. 'novel' is
  // the one area excluded here even from its owner: api.js only folds it back
  // in via foldersOfArea once the caller's session has re-typed the password
  // (see novelUnlocked() / permFor()).
  foldersOf: stmt("SELECT * FROM folders WHERE owner_id = ? AND (area IS NULL OR area <> 'novel')"),
  foldersOfArea: stmt('SELECT * FROM folders WHERE owner_id = ? AND area = ?'),
  folderById: stmt('SELECT * FROM folders WHERE id = ?'),
  insertFolder: stmt(
    'INSERT INTO folders (id, owner_id, name, parent_id, created_at, area) VALUES (?, ?, ?, ?, ?, ?)'),
  updateFolder: stmt('UPDATE folders SET name = ?, parent_id = ? WHERE id = ? AND owner_id = ?'),
  setFolderBook: stmt('UPDATE folders SET is_book = ? WHERE id = ? AND owner_id = ?'),
  deleteFolder: stmt('DELETE FROM folders WHERE id = ? AND owner_id = ?'),

  // notes
  // Every listing excludes trashed notes; only the trash statements below see them.
  // Same area split as folders above: everything except 'novel' rides along.
  notesOwned: stmt("SELECT * FROM notes WHERE owner_id = ? AND deleted_at IS NULL AND (area IS NULL OR area <> 'novel')"),
  notesOwnedArea: stmt('SELECT * FROM notes WHERE owner_id = ? AND deleted_at IS NULL AND area = ?'),
  notesSharedWith: stmt(`
    SELECT n.*, s.perm AS share_perm, u.username AS owner_name
    FROM notes n
    JOIN shares s ON s.note_id = n.id
    JOIN users u ON u.id = n.owner_id
    WHERE s.user_id = ? AND n.deleted_at IS NULL`),
  // Notes opened up to the whole site by their owner. An explicit share for the
  // same person takes precedence (it may grant more), so those rows are skipped.
  // area <> 'novel': a novel note is never shareable in the first place
  // (setAccess refuses it in api.js), but this is the same belt-and-braces
  // exclusion notesSharedWith relies on by construction.
  notesSiteWide: stmt(`
    SELECT n.*, n.access_perm AS share_perm, u.username AS owner_name
    FROM notes n
    JOIN users u ON u.id = n.owner_id
    WHERE n.access = 'site' AND n.owner_id != ? AND n.deleted_at IS NULL
      AND (n.area IS NULL OR n.area <> 'novel')
      AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.note_id = n.id AND s.user_id = ?)`),
  setAccess: stmt('UPDATE notes SET access = ?, access_perm = ? WHERE id = ?'),
  noteById: stmt('SELECT * FROM notes WHERE id = ?'),
  // The row plus a lock on it until the transaction ends. Every read-merge-write
  // on a note (save, restore) goes through this, otherwise two saves that both
  // read rev 5 would both write rev 6 and one edit would silently vanish.
  noteByIdForUpdate: stmt('SELECT * FROM notes WHERE id = ? FOR UPDATE'),
  insertNote: stmt(`
    INSERT INTO notes (id, owner_id, folder_id, title, content, meta, created_at, updated_at, area)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateNote: stmt(
    'UPDATE notes SET folder_id = ?, title = ?, content = ?, meta = ?, updated_at = ?, rev = ? WHERE id = ?'),
  // Hard delete — only the trash sweep / purge call this; "delete" in the UI is trashNote.
  deleteNote: stmt('DELETE FROM notes WHERE id = ?'),

  // trash
  trashNote: stmt('UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
  // The folder may have been deleted while the note sat in the trash; a dangling
  // folder_id would make the restored note invisible on the dashboard, so it
  // lands at the top level instead.
  restoreNote: stmt(`
    UPDATE notes n
    LEFT JOIN folders f ON f.id = n.folder_id
    SET n.deleted_at = NULL, n.folder_id = IF(f.id IS NULL, NULL, n.folder_id)
    WHERE n.id = ? AND n.deleted_at IS NOT NULL`),
  // The list never carries note bodies, only sizes (CHAR_LENGTH: the UI shows characters).
  trashOf: stmt(`
    SELECT id, folder_id, title, meta, deleted_at, updated_at, CHAR_LENGTH(content) AS chars
    FROM notes WHERE owner_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC`),
  trashExpired: stmt('SELECT id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?'),
  purgeTrashOf: stmt('DELETE FROM notes WHERE owner_id = ? AND deleted_at IS NOT NULL'),
  // File notes in the trash (api.js dropFileOfNote): the LIKE only trims the scan, the JSON is parsed there.
  trashedFileNotesOf: stmt('SELECT id, owner_id, meta FROM notes WHERE owner_id = ? AND deleted_at IS NOT NULL AND meta LIKE ' + "'%\"file\"%'"),

  // note versions — the list view never selects `content`, only its length, so
  // opening the history of a long note costs one small row per version.
  // (CHAR_LENGTH: the UI shows characters; LENGTH would be UTF-8 bytes.)
  versionList: stmt(`
    SELECT id, rev, title, author, label, created_at, CHAR_LENGTH(content) AS chars
    FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT ?`),
  versionById: stmt('SELECT * FROM note_versions WHERE id = ? AND note_id = ?'),
  versionLatest: stmt(
    'SELECT * FROM note_versions WHERE note_id = ? ORDER BY id DESC LIMIT 1'),
  insertVersion: stmt(`
    INSERT INTO note_versions (note_id, rev, title, content, meta, author, label, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  // Coalescing an autosave into the version row that is already open for this
  // author and editing session.
  updateVersion: stmt(
    'UPDATE note_versions SET rev = ?, title = ?, content = ?, meta = ?, created_at = ? WHERE id = ?'),
  labelVersion: stmt('UPDATE note_versions SET label = ? WHERE id = ? AND note_id = ?'),
  deleteVersion: stmt('DELETE FROM note_versions WHERE id = ? AND note_id = ?'),
  // Keep the newest N automatic versions; labelled ones are never pruned and do
  // not count against the budget. The extra derived table is MariaDB's rule:
  // neither LIMIT inside an IN-subquery nor selecting from the table being
  // deleted from is allowed, but a materialised derived table sidesteps both.
  pruneVersions: stmt(`
    DELETE FROM note_versions
    WHERE note_id = ? AND label IS NULL AND id NOT IN (
      SELECT id FROM (
        SELECT id FROM note_versions WHERE note_id = ? AND label IS NULL ORDER BY id DESC LIMIT ?
      ) AS keep)`),

  // book versions
  bookVersionList: stmt(`
    SELECT id, folder_id, title, label, created_at, manifest
    FROM book_versions WHERE folder_id = ? AND owner_id = ? ORDER BY id DESC LIMIT ?`),
  bookVersionById: stmt(
    'SELECT * FROM book_versions WHERE id = ? AND owner_id = ?'),
  insertBookVersion: stmt(`
    INSERT INTO book_versions (folder_id, owner_id, title, label, manifest, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`),
  deleteBookVersion: stmt('DELETE FROM book_versions WHERE id = ? AND owner_id = ?'),

  // public share links — the list never selects `html`, only its length, so the
  // owner's management dialog does not drag megabytes of snapshot around.
  linkList: stmt(`
    SELECT token, folder_id, title, chapters, created_at, updated_at, expires_at, views,
           CHAR_LENGTH(html) AS chars
    FROM book_links WHERE folder_id = ? AND owner_id = ? ORDER BY created_at DESC`),
  linkByToken: stmt('SELECT * FROM book_links WHERE token = ?'),
  linkOwned: stmt('SELECT * FROM book_links WHERE token = ? AND owner_id = ?'),
  insertLink: stmt(`
    INSERT INTO book_links (token, folder_id, owner_id, title, html, chapters,
                            created_at, updated_at, expires_at, views)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
  updateLink: stmt(
    'UPDATE book_links SET title = ?, html = ?, chapters = ?, updated_at = ?, expires_at = ? WHERE token = ?'),
  deleteLink: stmt('DELETE FROM book_links WHERE token = ? AND owner_id = ?'),
  bumpLinkViews: stmt('UPDATE book_links SET views = views + 1 WHERE token = ?'),
  linkBytes: stmt(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(html)), 0) AS bytes FROM book_links'),

  // 單篇筆記的公開連結（api.js 的 listNoteLinks 那一組）
  noteLinkList: stmt(`
    SELECT token, note_id, title, note_rev, auto_update, created_at, updated_at, expires_at, views,
           CHAR_LENGTH(html) AS chars
    FROM note_links WHERE note_id = ? AND owner_id = ? ORDER BY created_at DESC`),
  noteLinkOwned: stmt('SELECT * FROM note_links WHERE token = ? AND owner_id = ?'),
  // 公開頁：連同筆記現在的狀態一起拿——進了垃圾桶或是小說區的筆記，連結就當作不存在
  noteLinkPublic: stmt(`
    SELECT l.token, l.title, l.html, l.expires_at, n.deleted_at AS note_deleted, n.area AS note_area
    FROM note_links l JOIN notes n ON n.id = l.note_id WHERE l.token = ?`),
  insertNoteLink: stmt(`
    INSERT INTO note_links (token, note_id, owner_id, title, html, note_rev,
                            created_at, updated_at, expires_at, views)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`),
  updateNoteLink: stmt(
    'UPDATE note_links SET title = ?, html = ?, note_rev = ?, updated_at = ?, expires_at = ? WHERE token = ?'),
  deleteNoteLink: stmt('DELETE FROM note_links WHERE token = ? AND owner_id = ?'),
  // 自動更新的開關另外一句 UPDATE 設：insertNoteLink 還有 backup.js 在用，不去動它的參數個數
  setNoteLinkAuto: stmt('UPDATE note_links SET auto_update = ? WHERE token = ? AND owner_id = ?'),
  bumpNoteLinkViews: stmt('UPDATE note_links SET views = views + 1 WHERE token = ?'),
  countNoteLinks: stmt('SELECT COUNT(*) AS n FROM note_links WHERE note_id = ?'),
  // 哪些筆記現在有還沒過期的公開連結（清單上要標出來）
  notesWithLinks: stmt(
    'SELECT DISTINCT note_id FROM note_links WHERE owner_id = ? AND (expires_at IS NULL OR expires_at > ?)'),
  noteHasLink: stmt(
    'SELECT 1 AS ok FROM note_links WHERE note_id = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1'),
  noteLinkBytes: stmt(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(html)), 0) AS bytes FROM note_links'),
  noteLinksOf: stmt('SELECT * FROM note_links WHERE owner_id = ? ORDER BY created_at'),
  noteLinksAll: stmt('SELECT * FROM note_links ORDER BY created_at'),

  // images
  imageById: stmt('SELECT * FROM images WHERE id = ?'),
  insertImage: stmt(`
    INSERT INTO images (id, owner_id, mime, name, data, original, shapes, created_at, folder_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateImage: stmt('UPDATE images SET mime = ?, data = ?, original = ?, shapes = ? WHERE id = ?'),
  // 檔案管理的重新命名／搬移資料夾：不動位元組，跟標註（updateImage）分開一條路。
  // 兩個欄位都給、都不給皆可（分開呼叫各自的呼叫端負責帶齊）。
  renameImage: stmt('UPDATE images SET name = ? WHERE id = ? AND owner_id = ?'),
  moveImage: stmt('UPDATE images SET folder_id = ? WHERE id = ? AND owner_id = ?'),
  deleteImage: stmt('DELETE FROM images WHERE id = ? AND owner_id = ?'),
  // drawio 的圖示庫（api.js listIcons / createIcon / removeIcon）。標記另外用一句 UPDATE
  // 設，不加進 insertImage 的參數：那一句還有 backup.js 在用，參數多一個少一個就是
  // 「Malformed communication packet」，整個還原失敗（folder_id 那次就發生過）。
  setImageIcon: stmt('UPDATE images SET icon = ? WHERE id = ? AND owner_id = ?'),
  setImageHidden: stmt('UPDATE images SET hidden = ? WHERE id = ? AND owner_id = ?'),
  iconsOf: stmt(
    'SELECT id, mime, name, created_at, LENGTH(data) AS bytes FROM images ' +
    'WHERE owner_id = ? AND icon = 1 AND pending = 0 ORDER BY created_at, id'),
  countIconsOf: stmt('SELECT COUNT(*) AS n FROM images WHERE owner_id = ? AND icon = 1'),
  // chunked uploads (api.js startUpload / putChunk / finishUpload)
  insertImagePending: stmt(`
    INSERT INTO images (id, owner_id, mime, name, data, original, shapes, created_at, size, chunk_size, pending, folder_id)
    VALUES (?, ?, ?, ?, '', NULL, NULL, ?, ?, ?, 1, ?)`),
  insertChunk: stmt('INSERT INTO image_chunks (image_id, seq, data) VALUES (?, ?, ?)'),
  chunkStats: stmt('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM image_chunks WHERE image_id = ?'),
  chunkData: stmt('SELECT data FROM image_chunks WHERE image_id = ? AND seq = ?'),
  deleteChunks: stmt('DELETE FROM image_chunks WHERE image_id = ?'),
  finishImage: stmt('UPDATE images SET pending = 0 WHERE id = ? AND owner_id = ?'),
  deleteStalePending: stmt('DELETE FROM images WHERE pending = 1 AND created_at < ?'),
  // A file note being purged takes its file with it, unless some other note still uses it.
  mediaUsedElsewhere: stmt(`
    SELECT 1 AS ok FROM notes WHERE id <> ?
      AND (INSTR(content, ?) > 0 OR INSTR(content, ?) > 0 OR INSTR(content, ?) > 0) LIMIT 1`),
  // File library (api.js listImages): the owner's uploads without their bytes,
  // and every note, any owner, trashed or not, whose text could embed an upload.
  // The INSTR filter only trims the scan; listImages does the exact matching.
  imagesOf: stmt(
    'SELECT id, mime, name, folder_id, icon, created_at, COALESCE(size, LENGTH(data)) AS bytes, COALESCE(LENGTH(original), 0) AS original_bytes, ' +
    '(original IS NOT NULL) AS annotated FROM images WHERE owner_id = ? AND pending = 0 AND hidden = 0 ORDER BY created_at DESC'),

  // 檔案管理／雲端硬碟資料夾（file_folders）：跟 notes 的 folders 完全獨立的一棵樹，
  // 純粹整理上傳的檔案，見上面 file_folders 表的註解。
  fileFoldersOf: stmt('SELECT * FROM file_folders WHERE owner_id = ?'),
  fileFolderById: stmt('SELECT * FROM file_folders WHERE id = ?'),
  insertFileFolder: stmt(
    'INSERT INTO file_folders (id, owner_id, name, parent_id, created_at) VALUES (?, ?, ?, ?, ?)'),
  updateFileFolder: stmt('UPDATE file_folders SET name = ?, parent_id = ? WHERE id = ? AND owner_id = ?'),
  deleteFileFolder: stmt('DELETE FROM file_folders WHERE id = ? AND owner_id = ?'),
  // 刪掉一個資料夾之前，把它裡面的東西（子資料夾與檔案）都先搬到它的上層——檔案沒有
  // 垃圾桶，刪資料夾絕對不能連著把裡面的檔案一起刪掉。
  moveChildFileFoldersUp: stmt('UPDATE file_folders SET parent_id = ? WHERE parent_id = ? AND owner_id = ?'),
  moveChildImagesUp: stmt('UPDATE images SET folder_id = ? WHERE folder_id = ? AND owner_id = ?'),
  notesEmbeddingMedia: stmt(
    'SELECT n.id, n.owner_id, u.username AS owner_name, n.title, n.folder_id, n.access, n.access_perm, ' +
    'n.deleted_at, n.updated_at, n.content FROM notes n JOIN users u ON u.id = n.owner_id ' +
    "WHERE INSTR(n.content, 'img:') > 0 OR INSTR(n.content, 'pdf:') > 0 OR INSTR(n.content, 'file:') > 0"),

  // Manual order (api.js saveOrder): a drag rewrites one folder level's whole
  // order, and moves the dragged rows into that level in the same statement.
  // `area <=> ?` (NULL-safe equals): a row is only ever filed into a level of its own area.
  // saveOrder checks that up front and answers 400; the condition here is what makes it hold
  // even if the row's area changed (moveNoteArea) between that check and this statement.
  orderNote: stmt(
    'UPDATE notes SET folder_id = ?, position = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND area <=> ?'),
  orderFolder: stmt('UPDATE folders SET parent_id = ?, position = ? WHERE id = ? AND owner_id = ? AND area <=> ?'),
  noteAreaById: stmt('SELECT owner_id, area FROM notes WHERE id = ?'),
  // The one deliberate exception to "a note's area never changes" (api.js
  // moveNoteArea): reclassifying a note between 所有筆記／課程筆記／知識區.
  // Resets position to NULL — a manual order position made sense in the old
  // area's level, not this one, and NULL sorts predictably (see sorting.js).
  setNoteArea: stmt(
    'UPDATE notes SET area = ?, folder_id = ?, position = NULL WHERE id = ? AND owner_id = ? AND deleted_at IS NULL'),

  // backup / restore (server/backup.js). Export walks ids and fetches rows one at
  // a time so a big site never has every note body in memory at once; the full
  // INSERTs restore rows exactly as they were, ids and timestamps included.
  usersAll: stmt('SELECT * FROM users ORDER BY id'),
  insertUserFull: stmt(`
    INSERT INTO users (username, pw_hash, pw_salt, created_at, role, disabled, must_change_pw, last_login)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  foldersAll: stmt('SELECT * FROM folders ORDER BY created_at'),
  insertFolderFull: stmt(
    'INSERT INTO folders (id, owner_id, name, parent_id, created_at, is_book, position, area) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  updateFolderFull: stmt('UPDATE folders SET name = ?, parent_id = ?, is_book = ?, position = ? WHERE id = ?'),
  noteIdsOf: stmt('SELECT id FROM notes WHERE owner_id = ? ORDER BY created_at'),
  noteIdsAll: stmt('SELECT id FROM notes ORDER BY created_at'),
  // area is restored on insert only (a missing row is recreated exactly as it
  // was); an existing row's area never changes on restore, same as a live edit
  // can never change it — restoreNoteFull deliberately has no area column.
  insertNoteFull: stmt(`
    INSERT INTO notes (id, owner_id, folder_id, title, content, meta, created_at, updated_at, rev, access, access_perm, deleted_at, position, area)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  restoreNoteFull: stmt(`
    UPDATE notes SET folder_id = ?, title = ?, content = ?, meta = ?, updated_at = ?, rev = ?,
      access = ?, access_perm = ?, deleted_at = ?, position = ? WHERE id = ?`),
  versionsOfNote: stmt('SELECT * FROM note_versions WHERE note_id = ? ORDER BY id'),
  imageIdsOf: stmt('SELECT id FROM images WHERE owner_id = ? AND pending = 0 ORDER BY created_at'),
  imageIdsAll: stmt('SELECT id FROM images WHERE pending = 0 ORDER BY created_at'),
  imageOwner: stmt('SELECT id, owner_id FROM images WHERE id = ?'),
  updateImageFull: stmt('UPDATE images SET mime = ?, name = ?, data = ?, original = ?, shapes = ? WHERE id = ?'),
  bookVersionsOf: stmt('SELECT * FROM book_versions WHERE owner_id = ? ORDER BY id'),
  bookVersionsAll: stmt('SELECT * FROM book_versions ORDER BY id'),
  bookVersionExists: stmt('SELECT id FROM book_versions WHERE folder_id = ? AND owner_id = ? AND created_at = ? LIMIT 1'),
  linksOf: stmt('SELECT * FROM book_links WHERE owner_id = ? ORDER BY created_at'),
  linksAll: stmt('SELECT * FROM book_links ORDER BY created_at'),

  // site settings (server/settings.js)
  settingsAll: stmt('SELECT k, v FROM settings'),
  setSetting: stmt(
    'INSERT INTO settings (k, v, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)'),

  // shares
  shareFor: stmt('SELECT * FROM shares WHERE note_id = ? AND user_id = ?'),
  sharesOfNote: stmt(`
    SELECT s.*, u.username FROM shares s JOIN users u ON u.id = s.user_id WHERE s.note_id = ?`),
  insertShare: stmt(`
    INSERT INTO shares (note_id, user_id, perm, created_at) VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE perm = VALUES(perm)`),
  deleteShare: stmt('DELETE FROM shares WHERE note_id = ? AND user_id = ?'),

  // An image is readable by whoever can read a note that references it. Checking
  // ownership alone would break shared notes; skipping the check entirely would
  // let anyone enumerate ids and pull other people's screenshots.
  // Params: (needle, userId, userId)
  imageVisibleTo: stmt(`
    SELECT 1 AS ok FROM notes n
    WHERE INSTR(n.content, ?) > 0 AND n.deleted_at IS NULL
      AND (n.owner_id = ? OR n.access = 'site'
           OR EXISTS (SELECT 1 FROM shares s WHERE s.note_id = n.id AND s.user_id = ?))
    LIMIT 1`),

  // storage — sizes and counts only (admin sees how much, never what).
  // LENGTH here is bytes (UTF-8), which is what "bytes" in the panel means.
  dbBytes: stmt(
    'SELECT COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.TABLES WHERE table_schema = DATABASE()'),
  imageBytes: stmt(
    'SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(size, LENGTH(data))), 0) + COALESCE(SUM(LENGTH(original)), 0) AS bytes FROM images'),
  noteBytes: stmt('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM notes'),
  // Version history keeps a full copy of the text per version, so it is a real
  // consumer of disk and has to be reported separately — otherwise the storage
  // panel would understate usage on exactly the notes that are edited most.
  versionBytes: stmt(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM note_versions'),
  storagePerUser: stmt(`
    SELECT * FROM (
      SELECT u.id, u.username,
        (SELECT COUNT(*) FROM notes n WHERE n.owner_id = u.id)                                   AS notes,
        (SELECT COALESCE(SUM(LENGTH(n.content)), 0) FROM notes n WHERE n.owner_id = u.id)        AS note_bytes,
        (SELECT COUNT(*) FROM note_versions v JOIN notes n2 ON n2.id = v.note_id
           WHERE n2.owner_id = u.id)                                                             AS versions,
        (SELECT COALESCE(SUM(LENGTH(v.content)), 0) FROM note_versions v
           JOIN notes n3 ON n3.id = v.note_id WHERE n3.owner_id = u.id)                          AS version_bytes,
        (SELECT COUNT(*) FROM images i WHERE i.owner_id = u.id)                                  AS images,
        (SELECT COALESCE(SUM(COALESCE(i.size, LENGTH(i.data))), 0) + COALESCE(SUM(LENGTH(i.original)), 0)
           FROM images i WHERE i.owner_id = u.id)                                                AS image_bytes
      FROM users u
    ) t
    ORDER BY t.image_bytes + t.note_bytes + t.version_bytes DESC`)
};

// Raw statements for tools only (the migration script builds multi-row INSERTs
// and TRUNCATEs). Application code goes through `q`.
async function exec(sql, params) { const [r] = await conn().execute(sql, fix(params || [])); return r; }
async function query(sql, params) { const [r] = await conn().query(sql, params || []); return r; }

module.exports = {
  q, tx, retry, close, isBusy, init, exec, query,
  get datadir() { return datadir; }
};
