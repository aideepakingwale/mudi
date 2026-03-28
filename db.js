/**
 * MuDi — db.js  v2
 *
 * Storage: sql.js (SQLite in WebAssembly) + Cloudflare R2 for persistence.
 *
 * Why this approach is safe across Render redeploys:
 *   Render free tier resets the container filesystem on every deploy.
 *   The database is preserved by backing it up to R2 on every write and
 *   restoring it from R2 on every startup — before the server accepts requests.
 *
 * Startup (blocks until complete):
 *   1. Download db/mudi.db from R2  → write to local /app/data/mudi.db
 *   2. Initialise sql.js WASM       → runs in parallel with step 1
 *   3. Load local file into memory  → open the restored database
 *   4. Run CREATE TABLE IF NOT EXISTS → safe schema migrations, never drops data
 *   5. Server begins accepting requests
 *
 * Every write:
 *   1. sql.js executes SQL in memory (instant)
 *   2. Debounce 300ms → write to local disk  (fast, sync)
 *   3. Debounce 30s   → export memory → PUT to R2  (async, non-blocking)
 *      The R2 upload always exports fresh from memory, not from the disk file,
 *      so it is never stale even if persist() debounce hasn't fired.
 *
 * On SIGTERM (Render redeploy / restart):
 *   1. Cancel pending timers
 *   2. Export in-memory DB → write to local disk  (sync, immediate)
 *   3. Upload disk file to R2                     (async, wait for completion)
 *   4. process.exit(0)
 *   Render waits 30s before SIGKILL — this completes in < 2s.
 *
 * Fallback chain (R2 unavailable or not configured):
 *   - Startup: use existing local file, or start empty
 *   - Writes:  local file only — data lost on next redeploy
 *   - Log line clearly states which mode is active
 */

'use strict';

const path                    = require('path');
const fs                      = require('fs');
const { createHmac, createHash } = require('crypto');
const initSqlJs               = require('sql.js');

// ── Local storage ─────────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR ||
  (process.env.NODE_ENV === 'production' ? '/app/data' : path.join(__dirname, 'data'));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH   = path.join(DATA_DIR, 'mudi.db');
const R2_DB_KEY = 'db/mudi.db';   // single fixed key, overwrites on every backup

// ── R2 AWS Signature V4 (no external SDK — uses Node 18 built-in crypto) ─────
function r2Configured() {
  return !!(process.env.R2_ACCOUNT_ID &&
            process.env.R2_ACCESS_KEY_ID &&
            process.env.R2_SECRET_ACCESS_KEY);
}

function _sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}
function _hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function r2PresignUrl(method, key, expiresIn = 300) {
  const bucket    = process.env.R2_BUCKET_NAME || 'mudi-transfers';
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const host      = `${bucket}.${accountId}.r2.cloudflarestorage.com`;

  const now       = new Date();
  const date      = now.toISOString().slice(0, 10).replace(/-/g, '');      // YYYYMMDD
  const datetime  = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');       // YYYYMMDDTHHmmssZ
  const scope     = `${date}/auto/s3/aws4_request`;
  const encodedKey = encodeURIComponent(key).replace(/%2F/g, '/');

  const qs = new URLSearchParams({
    'X-Amz-Algorithm':     'AWS4-HMAC-SHA256',
    'X-Amz-Credential':    `${accessKey}/${scope}`,
    'X-Amz-Date':          datetime,
    'X-Amz-Expires':       String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  });

  const canonical = [
    method,
    `/${encodedKey}`,
    qs.toString(),
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const signingKey = _hmac(
    _hmac(_hmac(_hmac('AWS4' + secretKey, date), 'auto'), 's3'),
    'aws4_request'
  );
  const signature = createHmac('sha256', signingKey)
    .update(`AWS4-HMAC-SHA256\n${datetime}\n${scope}\n${_sha256(canonical)}`)
    .digest('hex');

  qs.set('X-Amz-Signature', signature);
  return `https://${host}/${encodedKey}?${qs.toString()}`;
}

async function r2Get(key) {
  const res = await fetch(r2PresignUrl('GET', key));
  if (res.status === 404) return null;   // first boot — no backup yet
  if (!res.ok) throw new Error(`R2 GET ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function r2Put(key, buf) {
  const res = await fetch(r2PresignUrl('PUT', key, 600), {
    method:  'PUT',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
    body:    buf,
  });
  if (!res.ok) throw new Error(`R2 PUT ${res.status} ${await res.text()}`);
}

// ── Startup restore ───────────────────────────────────────────────────────────
// Returns true if the local file was written from R2 (i.e. restore happened).
// Errors are caught — startup never fails because of R2.
async function restoreFromR2() {
  if (!r2Configured()) return false;
  try {
    console.log('[db] R2: checking for backup...');
    const buf = await r2Get(R2_DB_KEY);
    if (!buf) {
      console.log('[db] R2: no backup found — starting with empty database');
      return false;
    }
    fs.writeFileSync(DB_PATH, buf);
    console.log(`[db] R2: restored ${(buf.length / 1024).toFixed(1)} KB`);
    return true;
  } catch (err) {
    console.warn('[db] R2: restore failed:', err.message, '— continuing with local file');
    return false;
  }
}

// ── Write-through upload ──────────────────────────────────────────────────────
// IMPORTANT: always exports from in-memory _db, not from disk.
// This avoids a stale-file bug where the 300ms disk-persist debounce
// hasn't fired yet but the R2 upload fires from the old disk content.

let _uploadTimer   = null;
let _uploadActive  = false;  // true while an HTTP PUT is in flight
let _uploadPending = false;  // true if writes arrived DURING an active upload
                             // — ensures those writes are not silently skipped

async function _doUpload(label) {
  if (!r2Configured() || !_db) return;

  // Concurrent-call guard — only one upload in flight at a time.
  // If a second caller arrives while we're uploading, set _uploadPending
  // so the first upload triggers another one when it finishes.
  if (_uploadActive) {
    _uploadPending = true;
    return;
  }

  _uploadActive  = true;
  _uploadPending = false;

  try {
    // Always export from in-memory _db — never reads stale disk file
    const buf = Buffer.from(_db.export());
    fs.writeFileSync(DB_PATH, buf);   // keep local file in sync
    await r2Put(R2_DB_KEY, buf);
    console.log(`[db] R2: backup OK (${label}, ${(buf.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.warn('[db] R2: backup failed:', err.message);
    _uploadPending = true;   // failed — retry on next schedule
  } finally {
    _uploadActive = false;
    // If writes arrived during this upload, or it failed, schedule another pass
    if (_uploadPending) {
      _uploadPending = false;
      scheduleUpload();
    }
  }
}

function scheduleUpload() {
  if (!r2Configured()) return;
  clearTimeout(_uploadTimer);
  _uploadTimer = setTimeout(() => _doUpload('30s debounce'), 30_000);
}

// ── SIGTERM handler — flush before Render kills the container ─────────────────
// Render waits 30s after SIGTERM before force-killing.
// This completes in < 2s for any realistic DB size.
async function _onShutdown(signal) {
  console.log(`[db] ${signal} — flushing to R2 before exit`);
  clearTimeout(_uploadTimer);          // cancel pending debounce

  // If an upload is already in flight, wait for it to finish (poll every 50ms)
  let waited = 0;
  while (_uploadActive && waited < 5000) {
    await new Promise(r => setTimeout(r, 50));
    waited += 50;
  }

  // Do a final upload with the very latest in-memory state
  await _doUpload('shutdown flush');
  console.log('[db] flush complete — exiting');
  process.exit(0);
}

process.once('SIGTERM', () => _onShutdown('SIGTERM'));
process.once('SIGINT',  () => _onShutdown('SIGINT'));

// ── sql.js init ───────────────────────────────────────────────────────────────
let _db         = null;
let _persistTmr = null;

const ready = (async () => {
  // Run R2 restore and WASM compilation in parallel — saves ~300ms
  const [restored, SQL] = await Promise.all([
    restoreFromR2(),
    initSqlJs({ locateFile: f => path.join(__dirname, 'node_modules/sql.js/dist', f) }),
  ]);

  // Load the file that restoreFromR2 wrote (or whatever was already on disk)
  _db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  // ── Schema — always uses IF NOT EXISTS, never drops tables ────────────────
  _db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT    UNIQUE,
      name          TEXT    NOT NULL,
      avatar        TEXT,
      provider      TEXT    NOT NULL DEFAULT 'local',
      provider_id   TEXT,
      password_hash TEXT,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_login    INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider
      ON users (provider, provider_id)
      WHERE provider_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS permanent_rooms (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT    UNIQUE NOT NULL,
      name          TEXT    NOT NULL,
      owner_id      INTEGER NOT NULL REFERENCES users(id),
      password_hash TEXT,
      has_password  INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      last_active   INTEGER
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id   INTEGER NOT NULL REFERENCES permanent_rooms(id),
      user_id   INTEGER NOT NULL REFERENCES users(id),
      joined_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS room_analytics (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code          TEXT    NOT NULL,
      room_name          TEXT,
      host_id            INTEGER REFERENCES users(id),
      listener_count     INTEGER DEFAULT 0,
      file_name          TEXT,
      file_size_bytes    INTEGER DEFAULT 0,
      transfer_mode      TEXT,
      sync_corrections   INTEGER DEFAULT 0,
      session_duration_s INTEGER DEFAULT 0,
      started_at         INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      ended_at           INTEGER
    );

    CREATE TABLE IF NOT EXISTS file_audit (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code       TEXT    NOT NULL,
      room_name       TEXT,
      host_id         INTEGER REFERENCES users(id),
      host_name       TEXT,
      file_name       TEXT    NOT NULL,
      file_hash       TEXT    NOT NULL,
      file_size_bytes INTEGER DEFAULT 0,
      audio_duration_s REAL   DEFAULT 0,
      transfer_mode   TEXT,
      listener_count  INTEGER DEFAULT 0,
      shared_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_file_audit_host ON file_audit(host_id, shared_at DESC);
    CREATE INDEX IF NOT EXISTS idx_file_audit_room ON file_audit(room_code, shared_at DESC);

    CREATE TABLE IF NOT EXISTS room_chat (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code   TEXT    NOT NULL,
      sid         TEXT,
      sender_name TEXT,
      role        TEXT,
      text        TEXT    NOT NULL,
      reply_to_id INTEGER,
      reply_text  TEXT,
      reply_sender TEXT,
      ts          INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_room ON room_chat(room_code, id);

    CREATE TABLE IF NOT EXISTS user_scores (
      user_id           INTEGER PRIMARY KEY REFERENCES users(id),
      word_points       INTEGER DEFAULT 0,
      reaction_points   INTEGER DEFAULT 0,
      reply_points      INTEGER DEFAULT 0,
      song_points       INTEGER DEFAULT 0,
      voice_points      INTEGER DEFAULT 0,
      total_points      INTEGER DEFAULT 0,
      sessions_hosted   INTEGER DEFAULT 0,
      sessions_joined   INTEGER DEFAULT 0,
      reactions_sent    INTEGER DEFAULT 0,
      messages_sent     INTEGER DEFAULT 0,
      songs_shared      INTEGER DEFAULT 0,
      updated_at        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS reaction_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code TEXT    NOT NULL,
      user_id   INTEGER REFERENCES users(id),
      user_name TEXT,
      emoji     TEXT    NOT NULL,
      ts        INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_rxn_room ON reaction_log(room_code, ts DESC);
  `);

  // ── Schema migrations — safe to re-run on every boot ─────────────────────
  // ALTER TABLE ADD COLUMN throws if column exists; we catch and ignore.
  // This handles databases restored from R2 that have the old schema.
  const migrations = [
    // user_scores: new columns added in v3.1
    "ALTER TABLE user_scores ADD COLUMN word_points     INTEGER DEFAULT 0",
    "ALTER TABLE user_scores ADD COLUMN reply_points    INTEGER DEFAULT 0",
    "ALTER TABLE user_scores ADD COLUMN song_points     INTEGER DEFAULT 0",
    "ALTER TABLE user_scores ADD COLUMN voice_points    INTEGER DEFAULT 0",
    "ALTER TABLE user_scores ADD COLUMN reactions_sent  INTEGER DEFAULT 0",
    "ALTER TABLE user_scores ADD COLUMN messages_sent   INTEGER DEFAULT 0",
    "ALTER TABLE user_scores ADD COLUMN songs_shared    INTEGER DEFAULT 0",
    // rename chat_points → word_points (copy data, old column stays but unused)
    "UPDATE user_scores SET word_points = chat_points WHERE word_points = 0 AND chat_points > 0",
    "UPDATE user_scores SET total_points = word_points + reaction_points + reply_points + song_points + voice_points WHERE total_points = 0",
  ];
  // file_audit table (added v3.2)
  try { _db.run(`CREATE TABLE IF NOT EXISTS file_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,room_code TEXT NOT NULL,room_name TEXT,
    host_id INTEGER,host_name TEXT,file_name TEXT NOT NULL,file_hash TEXT NOT NULL,
    file_size_bytes INTEGER DEFAULT 0,audio_duration_s REAL DEFAULT 0,
    transfer_mode TEXT,listener_count INTEGER DEFAULT 0,
    shared_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`); } catch(e) {}

  for (const sql of migrations) {
    try { _db.run(sql); } catch(e) { /* column already exists or old col absent — fine */ }
  }
  console.log('[db] migrations applied');

  // Initial persist to disk
  fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));

  const mode = r2Configured()
    ? (restored ? 'R2 restored' : 'R2 ready (first boot)')
    : 'WARNING: no R2 — data will be lost on redeploy';

  console.log(`[db] SQLite ready — ${DB_PATH} — ${mode}`);
  return _db;
})().catch(err => {
  console.error('[db] FATAL — database failed to initialise:', err);
  process.exit(1);
});

// ── Internal helpers ──────────────────────────────────────────────────────────
function _persist() {
  clearTimeout(_persistTmr);
  _persistTmr = setTimeout(() => {
    if (!_db) return;
    // Write in-memory DB to local file
    fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
    // Queue R2 backup (debounced — runs 30s after last write burst)
    scheduleUpload();
  }, 300);
}

async function _getDb() { return ready; }

function _row(d, sql, p = []) {
  const s = d.prepare(sql);
  s.bind(p);
  const r = s.step() ? s.getAsObject() : null;
  s.free();
  return r;
}

function _rows(d, sql, p = []) {
  const s = d.prepare(sql);
  s.bind(p);
  const out = [];
  while (s.step()) out.push(s.getAsObject());
  s.free();
  return out;
}

function _run(d, sql, p = []) {
  d.run(sql, p);
  _persist();
}

// ── Public API ────────────────────────────────────────────────────────────────
module.exports = {
  ready,

  // Users
  async findById(id) {
    return _row(await _getDb(), 'SELECT * FROM users WHERE id=?', [id]);
  },
  async findByEmail(email) {
    return _row(await _getDb(), 'SELECT * FROM users WHERE email=?',
      [(email || '').toLowerCase().trim()]);
  },
  async findByProvider(provider, providerId) {
    return _row(await _getDb(),
      'SELECT * FROM users WHERE provider=? AND provider_id=?', [provider, providerId]);
  },
  async touchLogin(id) {
    _run(await _getDb(), `UPDATE users SET last_login=strftime('%s','now') WHERE id=?`, [id]);
  },
  async create({ email, name, avatar, provider = 'local', providerId = null, passwordHash = null }) {
    const d = await _getDb();
    _run(d,
      `INSERT INTO users (email,name,avatar,provider,provider_id,password_hash) VALUES (?,?,?,?,?,?)`,
      [email ? email.toLowerCase().trim() : null,
       name || email || 'MuDi User',
       avatar || null, provider, providerId, passwordHash]
    );
    const id = d.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    return _row(d, 'SELECT * FROM users WHERE id=?', [id]);
  },
  async findOrCreate({ provider, providerId, email, name, avatar }) {
    let u = await this.findByProvider(provider, providerId);
    if (!u && email) u = await this.findByEmail(email);
    if (!u) u = await this.create({ email, name, avatar, provider, providerId });
    await this.touchLogin(u.id);
    return u;
  },

  // Permanent rooms
  // Upsert: creates if missing, updates last_active if exists
  // Used automatically when host creates/joins any room — no manual step needed
  async ensureRoom({ code, name, ownerId, passwordHash = null }) {
    const d = await _getDb();
    _run(d,
      `INSERT OR IGNORE INTO permanent_rooms (code,name,owner_id,password_hash,has_password)
       VALUES (?,?,?,?,?)`,
      [code, name, ownerId || null, passwordHash, passwordHash ? 1 : 0]
    );
    _run(d,
      `UPDATE permanent_rooms SET last_active=strftime('%s','now') WHERE code=?`,
      [code]
    );
    if (ownerId) {
      _run(d,
        `INSERT OR IGNORE INTO room_members (room_id,user_id)
         SELECT id,? FROM permanent_rooms WHERE code=?`,
        [ownerId, code]
      );
    }
    return _row(d, 'SELECT * FROM permanent_rooms WHERE code=?', [code]);
  },

  async createPermanentRoom({ code, name, ownerId, passwordHash = null }) {
    const d = await _getDb();
    _run(d,
      `INSERT OR IGNORE INTO permanent_rooms (code,name,owner_id,password_hash,has_password)
       VALUES (?,?,?,?,?)`,
      [code, name, ownerId, passwordHash, passwordHash ? 1 : 0]
    );
    _run(d,
      `INSERT OR IGNORE INTO room_members (room_id,user_id)
       SELECT id,? FROM permanent_rooms WHERE code=?`,
      [ownerId, code]
    );
    return _row(d, 'SELECT * FROM permanent_rooms WHERE code=?', [code]);
  },
  async getPermanentRoom(code) {
    return _row(await _getDb(), 'SELECT * FROM permanent_rooms WHERE code=?', [code]);
  },
  async getPermanentRoomsForUser(userId) {
    return _rows(await _getDb(),
      `SELECT pr.* FROM permanent_rooms pr
       JOIN room_members rm ON rm.room_id=pr.id
       WHERE rm.user_id=? ORDER BY pr.last_active DESC LIMIT 20`, [userId]);
  },
  async addRoomMember(code, userId) {
    if (!userId) return;
    const d = await _getDb();
    // Create room record if not already there (happens for rooms created before this feature)
    const room = _row(d, 'SELECT id FROM permanent_rooms WHERE code=?', [code]);
    if (!room) return; // room info not available here, caller should use ensureRoom
    _run(d, `INSERT OR IGNORE INTO room_members (room_id,user_id) VALUES (?,?)`,
      [room.id, userId]);
    _run(d, `UPDATE permanent_rooms SET last_active=strftime('%s','now') WHERE code=?`, [code]);
  },
  async getRoomMembers(code) {
    return _rows(await _getDb(),
      `SELECT u.id,u.name,u.avatar FROM users u
       JOIN room_members rm ON rm.user_id=u.id
       JOIN permanent_rooms pr ON pr.id=rm.room_id
       WHERE pr.code=? ORDER BY rm.joined_at`, [code]);
  },

  // Analytics
  // File audit log
  async logFileShared({ roomCode, roomName, hostId, hostName, fileName, fileHash,
                         fileSize, audioDuration, transferMode, listenerCount }) {
    _run(await _getDb(),
      `INSERT INTO file_audit
       (room_code,room_name,host_id,host_name,file_name,file_hash,
        file_size_bytes,audio_duration_s,transfer_mode,listener_count)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [roomCode, roomName||null, hostId||null, hostName||null, fileName,
       fileHash||'', fileSize||0, audioDuration||0, transferMode||'pipe', listenerCount||0]);
  },

  async getFileAudit(userId, limit=50) {
    const d = await _getDb();
    const hosted = _rows(d,
      `SELECT fa.*, u.name as host_name_db FROM file_audit fa
       LEFT JOIN users u ON u.id=fa.host_id
       WHERE fa.host_id=? ORDER BY fa.shared_at DESC LIMIT ?`,
      [userId, limit]);
    const summary = _row(d,
      `SELECT COUNT(*) as total_files,
        SUM(file_size_bytes) as total_bytes,
        SUM(audio_duration_s) as total_duration_s,
        COUNT(DISTINCT room_code) as rooms_used
       FROM file_audit WHERE host_id=?`,
      [userId]);
    return { hosted, summary };
  },

  async startSession({ roomCode, roomName, hostId, listenerCount, fileName, fileSize, transferMode }) {
    const d = await _getDb();
    _run(d,
      `INSERT INTO room_analytics
       (room_code,room_name,host_id,listener_count,file_name,file_size_bytes,transfer_mode)
       VALUES (?,?,?,?,?,?,?)`,
      [roomCode, roomName, hostId || null, listenerCount || 0,
       fileName || null, fileSize || 0, transferMode || 'pipe']
    );
    return d.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  },
  async endSession(sessionId, { syncCorrections, durationSecs }) {
    _run(await _getDb(),
      `UPDATE room_analytics
       SET ended_at=strftime('%s','now'), sync_corrections=?, session_duration_s=?
       WHERE id=?`,
      [syncCorrections || 0, durationSecs || 0, sessionId]
    );
  },
  async getAnalytics(userId) {
    const d = await _getDb();
    return {
      summary: _row(d,
        `SELECT COUNT(*) as total_sessions, SUM(listener_count) as total_listeners,
         SUM(file_size_bytes) as total_bytes, AVG(sync_corrections) as avg_corrections,
         MAX(listener_count) as peak_listeners
         FROM room_analytics WHERE host_id=?`, [userId]),
      recent: _rows(d,
        `SELECT * FROM room_analytics WHERE host_id=?
         ORDER BY started_at DESC LIMIT 10`, [userId]),
    };
  },

  // Scores
  async addPoints(userId, type, amount = 1) {
    const colMap = {
      word:'word_points', reaction:'reaction_points', reply:'reply_points',
      song:'song_points', voice:'voice_points', session:'word_points',
    };
    const col = colMap[type] || 'word_points';
    _run(await _getDb(),
      `INSERT INTO user_scores (user_id,${col},total_points,updated_at)
       VALUES (?,?,?,strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET
         ${col}=${col}+excluded.${col},
         total_points=total_points+excluded.total_points,
         updated_at=strftime('%s','now')`,
      [userId, amount, amount]);
  },

  async addReactionLog(roomCode, userId, userName, emoji) {
    _run(await _getDb(),
      `INSERT INTO reaction_log (room_code,user_id,user_name,emoji) VALUES (?,?,?,?)`,
      [roomCode, userId||null, userName||null, emoji]);
  },
  async getRoomReactions(roomCode, limit=50) {
    return _rows(await _getDb(),
      `SELECT id,user_name as userName,emoji,ts FROM reaction_log
       WHERE room_code=? ORDER BY ts DESC LIMIT ?`,
      [roomCode, limit]);
  },
  async incrementCounter(userId, col) {
    const safe = ['reactions_sent','messages_sent','songs_shared','sessions_hosted','sessions_joined'];
    if (!safe.includes(col)) return;
    _run(await _getDb(),
      `INSERT INTO user_scores (user_id,${col},updated_at) VALUES (?,1,strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET ${col}=${col}+1, updated_at=strftime('%s','now')`,
      [userId]);
  },
  async incrementSessions(userId, role) {
    const col = role === 'master' ? 'sessions_hosted' : 'sessions_joined';
    _run(await _getDb(),
      `INSERT INTO user_scores (user_id,${col},updated_at)
       VALUES (?,1,strftime('%s','now'))
       ON CONFLICT(user_id) DO UPDATE SET ${col}=${col}+1,
         updated_at=strftime('%s','now')`,
      [userId]
    );
  },
  // Called when live user IDs are available (from socket room state)
  // Ensures all current room participants appear even with 0 points
  async getLeaderboardLive(roomCode, liveUserIds = [], limit = 20) {
    const d = await _getDb();
    // Upsert 0-point rows for any live user not yet in user_scores
    for (const uid of liveUserIds) {
      if (!uid) continue;
      _run(d,
        `INSERT OR IGNORE INTO user_scores (user_id, updated_at)
         VALUES (?, strftime('%s','now'))`,
        [uid]
      );
    }
    return this.getLeaderboard(roomCode, limit);
  },

  async getLeaderboard(roomCode, limit = 20) {
    return _rows(await _getDb(),
      `SELECT DISTINCT u.id, u.name, u.avatar,
         COALESCE(s.word_points,0)     as word_points,
         COALESCE(s.reaction_points,0) as reaction_points,
         COALESCE(s.reply_points,0)    as reply_points,
         COALESCE(s.song_points,0)     as song_points,
         COALESCE(s.voice_points,0)    as voice_points,
         COALESCE(s.total_points,0)    as total_points,
         COALESCE(s.messages_sent,0)   as messages_sent,
         COALESCE(s.reactions_sent,0)  as reactions_sent,
         COALESCE(s.songs_shared,0)    as songs_shared
       FROM users u
       INNER JOIN user_scores s ON s.user_id=u.id
       WHERE s.user_id IS NOT NULL
       ORDER BY s.total_points DESC LIMIT ?`,
      [limit]
    );
  },
  // Chat persistence
  async saveChat(roomCode, { sid, senderName, role, text, replyToId, replyText, replySender, ts }) {
    const d = await _getDb();
    const tsMs = ts || Date.now();
    _run(d,
      `INSERT INTO room_chat (room_code,sid,sender_name,role,text,reply_to_id,reply_text,reply_sender,ts)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [roomCode, sid||null, senderName||null, role||null, text,
       replyToId||null, replyText||null, replySender||null, tsMs]);
    return d.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  },
  async getChatHistory(roomCode, limit=100) {
    return _rows(await _getDb(),
      `SELECT id,sid,sender_name as senderName,role,text,reply_to_id as replyToId,
              reply_text as replyText,reply_sender as replySender,ts
       FROM room_chat WHERE room_code=? ORDER BY id DESC LIMIT ?`,
      [roomCode, limit]).reverse();
  },

  async getUserScore(userId) {
    return _row(await _getDb(),
      'SELECT * FROM user_scores WHERE user_id=?', [userId])
      || { chat_points: 0, reaction_points: 0, session_points: 0, total_points: 0 };
  },
};
