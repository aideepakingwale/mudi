/**
 * routes/transfer.js — File transfer HTTP routes
 *
 * Mode A — Cloudflare R2 (fast, CDN-direct):
 *   POST /transfer/r2/presign   → presigned PUT URL for host
 *   POST /transfer/r2/confirm/:token → notify listeners, track deletion
 *
 * Mode B — Server streaming pipe (fallback, no R2 needed):
 *   POST /transfer/init         → create PassThrough stream, notify listeners
 *   POST /transfer/upload/:token → host streams bytes in
 *   GET  /transfer/stream/:token  → listener streams bytes out
 */
'use strict';

const { PassThrough } = require('stream');
const { r2Configured, r2PresignedUrl, deleteR2Object } = require('./r2');

// In-memory store for active pipe transfers (Mode B only)
// token → { mode, pass?, listeners, done, meta, roomCode, expires }
const transferStore = new Map();

// Purge expired Mode B entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, t] of transferStore) {
    if (t.expires < now) {
      try { if (t.pass) t.pass.destroy(); } catch(e) {}
      transferStore.delete(token);
    }
  }
}, 5 * 60 * 1000);

/**
 * Register all transfer HTTP routes.
 * @param {import('express').Application} app
 * @param {import('socket.io').Server} io
 * @param {Map} rooms   — live room state (from sockets/room.js)
 * @param {Function} requireAuth
 */
function registerTransferRoutes(app, io, rooms, requireAuth) {

  // ── MODE A: R2 ────────────────────────────────────────────────────────────
  app.post('/transfer/r2/presign', requireAuth, async (req, res) => {
    if (!r2Configured()) return res.status(503).json({ error: 'R2 not configured' });

    const roomCode = req.query.room;
    const fileName = decodeURIComponent(req.query.name || 'audio');
    const fileHash = req.query.hash || '';
    const fileSize = parseInt(req.query.size || '0', 10);
    const compressed = req.query.compressed === '1';

    if (!roomCode) return res.status(400).json({ error: 'Missing room' });

    const key   = `${roomCode}/${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);

    transferStore.set(token, {
      mode: 'r2', key,
      meta: { name: fileName, size: fileSize, hash: fileHash, compressed },
      roomCode,
      getUrl:  r2PresignedUrl('GET', key, 7200),
      expires: Date.now() + 2 * 60 * 60 * 1000,
    });

    console.log('[r2] presign token:', token.slice(0, 8), fileName, (fileSize / 1024 / 1024).toFixed(1) + 'MB');
    res.json({ ok: true, token, putUrl: r2PresignedUrl('PUT', key, 900) });
  });

  app.post('/transfer/r2/confirm/:token', requireAuth, (req, res) => {
    const entry = transferStore.get(req.params.token);
    if (!entry || entry.mode !== 'r2')
      return res.status(404).json({ error: 'Token not found' });

    const room = rooms.get(entry.roomCode.toUpperCase());
    if (room) {
      const { name, size, hash, compressed } = entry.meta;
      room._r2Key            = entry.key;
      room._r2ReadyCount     = 0;
      room._r2ExpectedCount  = room.followers.size;

      clearTimeout(room._r2DeleteTimer);
      room._r2DeleteTimer = setTimeout(() => {
        if (room._r2Key) {
          console.log('[r2] 30min safety delete:', room._r2Key);
          deleteR2Object(room._r2Key);
          room._r2Key = null;
        }
      }, 30 * 60 * 1000);

      io.to(room.code).emit('file:r2-ready', { url: entry.getUrl, name, size, hash, compressed });
      console.log('[r2] confirmed, notified', room.followers.size, 'listeners');
    }

    transferStore.delete(req.params.token);
    res.json({ ok: true });
  });

  // ── MODE B: Server streaming pipe ────────────────────────────────────────
  app.post('/transfer/init', requireAuth, (req, res) => {
    const roomCode   = req.query.room;
    const fileName   = decodeURIComponent(req.query.name || 'audio');
    const fileHash   = req.query.hash   || '';
    const fileSize   = parseInt(req.query.size || '0', 10);
    const compressed = req.query.compressed === '1';

    if (!roomCode) return res.status(400).json({ error: 'Missing room' });

    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const pass  = new PassThrough();

    transferStore.set(token, {
      mode: 'pipe', pass, listeners: 0, done: false,
      meta: { name: fileName, size: fileSize, hash: fileHash, compressed },
      roomCode,
      expires: Date.now() + 60 * 60 * 1000,
    });

    const room = rooms.get(roomCode.toUpperCase());
    if (room)
      io.to(room.code).emit('file:stream-ready', { token, name: fileName, size: fileSize, hash: fileHash, compressed });

    console.log('[pipe] init token:', token.slice(0, 8), fileName, (fileSize / 1024 / 1024).toFixed(1) + 'MB');
    res.json({ ok: true, token });
  });

  app.post('/transfer/upload/:token', requireAuth, (req, res) => {
    const entry = transferStore.get(req.params.token);
    if (!entry || entry.mode !== 'pipe')
      return res.status(404).json({ error: 'Token not found' });
    if (entry.done)
      return res.status(409).json({ error: 'Already uploaded' });

    let received = 0;
    req.on('data', chunk => { received += chunk.length; entry.pass.write(chunk); });
    req.on('end',  () => {
      entry.pass.end();
      entry.done = true;
      console.log('[pipe] done', (received / 1024 / 1024).toFixed(2) + 'MB');
      res.json({ ok: true, received });
    });
    req.on('error', err => {
      entry.pass.destroy(err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  });

  app.get('/transfer/stream/:token', requireAuth, (req, res) => {
    const entry = transferStore.get(req.params.token);
    if (!entry || entry.mode !== 'pipe')
      return res.status(404).json({ error: 'Not found' });

    entry.listeners++;
    res.setHeader('Content-Type', 'application/octet-stream');
    if (entry.meta.size) res.setHeader('Content-Length', entry.meta.size);
    res.setHeader('Cache-Control', 'no-store');
    entry.pass.pipe(res, { end: true });
    req.on('close', () => { entry.listeners = Math.max(0, entry.listeners - 1); });
  });
}

module.exports = { registerTransferRoutes, transferStore, deleteR2Object };
