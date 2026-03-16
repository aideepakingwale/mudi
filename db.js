/**
 * MuDi — db.js  (sql.js pure-WASM, works on Windows + Linux without build tools)
 */
const path = require('path');
const fs   = require('fs');

const DATA_DIR = process.env.DATA_DIR ||
  (process.env.NODE_ENV === 'production'
    ? '/app/data'
    : path.join(__dirname, 'data'));
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'mudi.db');

const initSqlJs = require('sql.js');

let _db = null;
let _saveTimer = null;

// EXPORT ready so server.js can await db.ready
const ready = initSqlJs({
  // Tell sql.js where its WASM file lives — needed in Docker/Alpine
  locateFile: file => path.join(__dirname, 'node_modules/sql.js/dist', file),
}).then(SQL => {
  _db = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

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
  `);
  persist();
  console.log('[db] SQLite ready —', DB_PATH);
  return _db;
}).catch(err => {
  console.error('[db] FATAL: sql.js failed to initialise', err);
  process.exit(1);
});

function persist() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    if (!_db) return;
    fs.writeFileSync(DB_PATH, Buffer.from(_db.export()));
  }, 300);
}

async function getDb() { return ready; }

function row(d, sql, params = []) {
  const s = d.prepare(sql);
  s.bind(params);
  const r = s.step() ? s.getAsObject() : null;
  s.free();
  return r;
}
function run(d, sql, params = []) { d.run(sql, params); persist(); }

module.exports = {
  ready,   // ← exported so server.js can await db.ready

  async findById(id) {
    const d = await getDb();
    return row(d, 'SELECT * FROM users WHERE id = ?', [id]);
  },
  async findByEmail(email) {
    const d = await getDb();
    return row(d, 'SELECT * FROM users WHERE email = ?', [(email||'').toLowerCase().trim()]);
  },
  async findByProvider(provider, providerId) {
    const d = await getDb();
    return row(d, 'SELECT * FROM users WHERE provider = ? AND provider_id = ?', [provider, providerId]);
  },
  async create({ email, name, avatar, provider = 'local', providerId = null, passwordHash = null }) {
    const d = await getDb();
    run(d,
      `INSERT INTO users (email, name, avatar, provider, provider_id, password_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [email ? email.toLowerCase().trim() : null,
       name || email || 'MuDi User',
       avatar || null, provider, providerId, passwordHash]
    );
    const id = d.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    return row(d, 'SELECT * FROM users WHERE id = ?', [id]);
  },
  async touchLogin(id) {
    const d = await getDb();
    run(d, `UPDATE users SET last_login = strftime('%s','now') WHERE id = ?`, [id]);
  },
  async findOrCreate({ provider, providerId, email, name, avatar }) {
    let user = await this.findByProvider(provider, providerId);
    if (!user && email) user = await this.findByEmail(email);
    if (!user) user = await this.create({ email, name, avatar, provider, providerId });
    await this.touchLogin(user.id);
    return user;
  },
};
