/**
 * MuDi — server.js
 * The Digital Aux Cord — signalling server v3.0
 *
 * Handles: auth, rooms, WebRTC relay, NTP sync, file metadata, sync commands
 * Works on: Render, local dev, any Node 18+ environment
 */
'use strict';

require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const session  = require('express-session');
const db       = require('./db');

const PORT          = parseInt(process.env.PORT || '8080', 10);
const MAX_LISTENERS = 10;

// ── Wait for SQLite to initialise before accepting connections ───────────────
db.ready.then(startServer).catch(err => {
  console.error('[MuDi] Fatal: database failed to initialise:', err);
  process.exit(1);
});

function startServer() {
  const { router: authRouter, passport, requireAuth } = require('./auth');

  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, {
    cors: { origin: '*' },
    pingInterval: 20000,   // 20s — allows headroom during large file transfers
    pingTimeout:  60000,   // 60s — matches Render / proxy idle timeouts
    connectTimeout: 20000,
  });

  // ── Trust proxy headers (Render, ngrok, any reverse proxy) ──────────────
  app.set('trust proxy', 1);

  // ── Body parsers ─────────────────────────────────────────────────────────
  // Apply JSON/form parsers to everything EXCEPT /transfer/upload
  // (upload needs raw body — express.json() 100KB limit kills large files)
  app.use((req, res, next) => {
    if (req.path === '/transfer/upload') return next(); // skip body parsers
    express.json()(req, res, next);
  });
  app.use((req, res, next) => {
    if (req.path === '/transfer/upload') return next();
    express.urlencoded({ extended: true })(req, res, next);
  });

  // ── Session ───────────────────────────────────────────────────────────────
  const sessionMiddleware = session({
    secret:            process.env.SESSION_SECRET || 'dev-secret-change-me-in-production',
    resave:            false,
    saveUninitialized: false,
    cookie: {
      secure:   process.env.NODE_ENV === 'production',  // HTTPS only in prod
      httpOnly: true,
      maxAge:   7 * 24 * 60 * 60 * 1000,               // 7 days
      sameSite: 'lax',
    },
  });

  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());

  // ── Auth routes ──────────────────────────────────────────────────────────
  app.use('/auth', authRouter);

  // Which OAuth providers are configured — read by login page
  app.get('/auth/providers', (_req, res) => res.json({
    google:   !!process.env.GOOGLE_CLIENT_ID   && !!process.env.GOOGLE_CLIENT_SECRET,
    facebook: !!process.env.FACEBOOK_APP_ID    && !!process.env.FACEBOOK_APP_SECRET,
  }));


  // ICE server config — client fetches this so TURN creds stay in env vars
  app.get('/config', (_req, res) => {
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // Open Relay free TURN (metered.ca) — works globally, no auth needed
      { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject', transport: 'tcp' },
    ];

    // Override with env vars if provided (bring-your-own TURN)
    if (process.env.TURN_URL && process.env.TURN_USER && process.env.TURN_PASS) {
      iceServers.push(
        { urls: process.env.TURN_URL,                        username: process.env.TURN_USER, credential: process.env.TURN_PASS },
        { urls: process.env.TURN_URL.replace(':3478', ':443'), username: process.env.TURN_USER, credential: process.env.TURN_PASS },
      );
    }

    res.json({ iceServers });
  });

  // ── Legal pages (public — Facebook requires live /privacy URL) ───────────
  app.get('/privacy', (_req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'))
  );
  app.get('/terms', (_req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'terms.html'))
  );

  // ── HTTP file transfer ───────────────────────────────────────────────────
  // Host uploads file via HTTP POST (no socket overhead)
  // Listener downloads via HTTP GET using the transfer token
  const transferStore = new Map(); // token → { buf, meta, roomCode, expires }

  // Clean up stale transfers every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [token, t] of transferStore) {
      if (t.expires < now) { transferStore.delete(token); console.log('[transfer] expired', token); }
    }
  }, 5 * 60 * 1000);

  // Host uploads file — raw streaming, no body parser interference
  app.post('/transfer/upload', requireAuth, (req, res) => {
    const roomCode   = req.query.room;
    const fileName   = decodeURIComponent(req.query.name || 'audio');
    const fileHash   = req.query.hash || '';
    const fileSize   = parseInt(req.query.size || '0', 10);
    const compressed = req.query.compressed === '1';

    if (!roomCode) return res.status(400).json({ error: 'Missing room code' });

    const chunks = [];
    let received = 0;

    req.on('data', chunk => {
      chunks.push(chunk);
      received += chunk.length;
      // Log progress for large files
      if (fileSize > 0 && received % (1024 * 1024) < chunk.length) {
        console.log(`[upload] ${(received/1024/1024).toFixed(1)}MB / ${(fileSize/1024/1024).toFixed(1)}MB`);
      }
    });

    req.on('end', () => {
      const buf   = Buffer.concat(chunks);
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);

      transferStore.set(token, {
        buf,
        meta: { name: fileName, size: fileSize || buf.length, hash: fileHash, compressed },
        roomCode,
        expires: Date.now() + 60 * 60 * 1000, // 60 min
      });

      console.log('[upload] complete', (buf.length/1024/1024).toFixed(2), 'MB token:', token.slice(0,8));

      const room = rooms.get(roomCode.toUpperCase());
      if (room) {
        io.to(room.code).emit('file:http-ready', {
          token,
          name: fileName,
          size: fileSize || buf.length,
          hash: fileHash,
          compressed,
        });
      }

      res.json({ ok: true, token });
    });

    req.on('error', err => {
      console.error('[upload] error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  });

  // Listener downloads file by token
  app.get('/transfer/download/:token', requireAuth, (req, res) => {
    const entry = transferStore.get(req.params.token);
    if (!entry) return res.status(404).json({ error: 'Transfer not found or expired' });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', entry.buf.length);
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(entry.meta.name) + '"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(entry.buf);
  });

  // ── Login page (public) ───────────────────────────────────────────────────
  app.get('/login', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  // ── Static assets (CSS, JS, fonts — NOT index.html) ──────────────────────
  // index: false prevents express.static from serving index.html directly,
  // so every request to / must pass through requireAuth below.
  app.use(express.static(path.join(__dirname, 'public'), { index: false }));

  // ── Main app — requires authentication ───────────────────────────────────
  app.get('/', requireAuth, (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html'))
  );

  // ── Catch-all — unauthenticated requests go to login ─────────────────────
  app.use((req, res) => {
    if (req.accepts('html')) return res.redirect('/login');
    res.status(404).json({ error: 'Not found' });
  });

  // ── Share session with Socket.IO ──────────────────────────────────────────
  io.engine.use(sessionMiddleware);
  io.engine.use(passport.initialize());
  io.engine.use(passport.session());

  // ═══════════════════════════════════════════════════════════════════════════
  //  ROOM STATE
  // ═══════════════════════════════════════════════════════════════════════════

  /** @type {Map<string, RoomState>} */
  const rooms     = new Map();  // code → room
  const nameIndex = new Map();  // lowerName → code

  function genCode() {
    const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const D = '0123456789';
    const r = s => s[Math.random() * s.length | 0];
    return `${r(L)}${r(L)}${r(L)}-${r(D)}${r(D)}${r(D)}`;
  }

  function simpleHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  function snapshot(room) {
    return {
      code:          room.code,
      name:          room.name,
      listenerCount: room.followers.size,
      maxListeners:  MAX_LISTENERS,
      isFull:        room.followers.size >= MAX_LISTENERS,
      hasPassword:   room.hasPassword,
      fileHash:      room.fileHash,
      readyCount:    room.readySet.size,
      allReady:      room.readySet.size > 0 && room.readySet.size >= room.followers.size,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SOCKET.IO
  // ═══════════════════════════════════════════════════════════════════════════

  io.on('connection', socket => {
    const user     = socket.request?.user;
    const userName = user?.name || 'Guest';
    console.log(`[ws] + ${socket.id.slice(0, 8)} "${userName}"`);

    // ── NTP clock sync ──────────────────────────────────────────────────────
    socket.on('ntp:req', ({ t1 }) => {
      const t2 = Date.now();
      setImmediate(() => socket.emit('ntp:res', { t1, t2, t3: Date.now() }));
    });

    // ── Room: create ────────────────────────────────────────────────────────
    socket.on('room:create', ({ name, password } = {}) => {
      const roomName = (name || '').trim().slice(0, 32) || `Room ${Math.floor(Math.random() * 9000) + 1000}`;
      const lc       = roomName.toLowerCase();

      if (nameIndex.has(lc))
        return socket.emit('room:err', { msg: `"${roomName}" is already taken. Choose another name.` });

      let code;
      do { code = genCode(); } while (rooms.has(code));

      rooms.set(code, {
        code, name: roomName,
        masterSid:   socket.id,
        followers:   new Map(),
        readySet:    new Set(),
        passwordHash: password ? simpleHash(password.trim()) : null,
        hasPassword:  !!password,
        fileHash:     null,
      });
      nameIndex.set(lc, code);

      socket.join(code);
      socket.data.code = code;
      socket.data.role = 'master';

      socket.emit('room:created', { code, name: roomName, hasPassword: !!password, maxListeners: MAX_LISTENERS });
      console.log(`[room] created "${roomName}" (${code})`);
    });

    // ── Room: check name ────────────────────────────────────────────────────
    socket.on('room:check-name', ({ name }) =>
      socket.emit('room:name-available', {
        available: !nameIndex.has((name || '').trim().toLowerCase()),
      })
    );

    // ── Room: join ──────────────────────────────────────────────────────────
    socket.on('room:join', ({ code, name, password }) => {
      // Resolve by code first, then by room name
      let c = (code || '').toUpperCase().trim();
      if (!rooms.has(c) && name) {
        const byName = nameIndex.get(name.trim().toLowerCase());
        if (byName) c = byName;
      }

      const room = rooms.get(c);
      if (!room)
        return socket.emit('room:err', { msg: 'Room not found. Check the code or name and try again.' });
      if (room.followers.size >= MAX_LISTENERS)
        return socket.emit('room:err', { msg: `Room is full — ${MAX_LISTENERS} listeners max.` });
      if (room.passwordHash) {
        const attempt = password ? simpleHash(password.trim()) : '';
        if (attempt !== room.passwordHash)
          return socket.emit('room:err', { msg: 'Incorrect password.' });
      }

      room.followers.set(socket.id, { name: userName });
      socket.join(c);
      socket.data.code = c;
      socket.data.role = 'follower';

      socket.emit('room:joined', {
        code: c, name: room.name, masterSid: room.masterSid,
        listenerCount: room.followers.size, maxListeners: MAX_LISTENERS,
        yourName: userName,
      });

      if (room.masterSid) {
        // Master is connected — notify immediately
        io.to(room.masterSid).emit('peer:joined', { peerSid: socket.id, listenerCount: room.followers.size });
      }
      // Always broadcast room:state — master receives this and can navigate
      // even if peer:joined was missed (e.g. master was mid-reconnect)
      io.to(c).emit('room:state', snapshot(room));
    });

    // ── Room: info (password check, full check) ─────────────────────────────
    socket.on('room:info', ({ code, name }) => {
      let c = (code || '').toUpperCase().trim();
      if (!rooms.has(c) && name) {
        const byName = nameIndex.get(name.trim().toLowerCase());
        if (byName) c = byName;
      }
      const room = rooms.get(c);
      if (!room) return socket.emit('room:info-res', { found: false });
      socket.emit('room:info-res', { found: true, ...snapshot(room) });
    });

    // ── Room: intentional leave ─────────────────────────────────────────────
    socket.on('room:leave', () => {
      const { code, role } = socket.data;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;

      if (role === 'master') {
        clearTimeout(room._masterTimeout);
        nameIndex.delete(room.name.toLowerCase());
        rooms.delete(code);
        socket.to(code).emit('peer:left', { role: 'master', permanent: true });
        console.log(`[room] closed "${room.name}" by host`);
      } else {
        room.followers.delete(socket.id);
        room.readySet.delete(socket.id);
        if (room.masterSid)
          io.to(room.masterSid).emit('peer:left', {
            role: 'follower', peerSid: socket.id, permanent: true,
            listenerCount: room.followers.size,
          });
        io.to(code).emit('room:state', snapshot(room));
      }
      socket.data.code = null;
      socket.data.role = null;
      socket.leave(code);
    });

    // ── WebRTC signalling relay ──────────────────────────────────────────────
    ['rtc:offer', 'rtc:answer', 'rtc:ice'].forEach(ev =>
      socket.on(ev, d => io.to(d.to).emit(ev, { ...d, from: socket.id }))
    );

    // ── File metadata relay ──────────────────────────────────────────────────
    socket.on('file:meta', d => {
      const room = rooms.get(socket.data.code);
      if (!room || room.masterSid !== socket.id) return;
      room.fileHash  = d.hash;
      room.readySet  = new Set();
      room._relayBuf = null;   // clear any previous relay buffer
      socket.to(room.code).emit('file:meta', d);
    });

    // ── Socket.IO file relay (fallback when WebRTC P2P fails over internet) ─
    // Master sends chunks to server → server forwards to listeners
    // Each chunk: { seq, data (base64), total }
    socket.on('file:relay-chunk', ({ seq, data, total }) => {
      const room = rooms.get(socket.data.code);
      if (!room || room.masterSid !== socket.id) return;
      // Forward binary directly — Socket.IO preserves ArrayBuffer type
      socket.to(room.code).emit('file:relay-chunk', { seq, data, total });
    });

    socket.on('file:relay-start', ({ name, size, hash, total }) => {
      const room = rooms.get(socket.data.code);
      if (!room || room.masterSid !== socket.id) return;
      console.log(`[relay] "${name}" ${(size/1024/1024).toFixed(1)}MB, ${total} chunks`);
      socket.to(room.code).emit('file:relay-start', { name, size, hash, total });
    });

    socket.on('file:relay-done', () => {
      const room = rooms.get(socket.data.code);
      if (!room || room.masterSid !== socket.id) return;
      socket.to(room.code).emit('file:relay-done');
    });

    socket.on('file:ready', ({ hash }) => {
      const room = rooms.get(socket.data.code);
      if (!room || !room.masterSid || hash !== room.fileHash) return;
      room.readySet.add(socket.id);
      const snap = snapshot(room);
      io.to(room.masterSid).emit('file:ready', {
        peerSid: socket.id, readyCount: snap.readyCount,
        allReady: snap.allReady, listenerCount: snap.listenerCount,
      });
      io.to(room.code).emit('room:state', snap);
    });

    // ── Sync commands ────────────────────────────────────────────────────────
    socket.on('sync:play', ({ position = 0 }) => {
      const room = rooms.get(socket.data.code);
      if (!room || room.masterSid !== socket.id) return;
      io.to(room.code).emit('sync:play', { playAt: Date.now() + 400, position });
    });

    socket.on('sync:pause', () => {
      const c = socket.data.code;
      if (c) socket.to(c).emit('sync:pause');
    });

    socket.on('sync:stop', () => {
      const room = rooms.get(socket.data.code);
      if (!room || room.masterSid !== socket.id) return;
      room.fileHash = null;
      room.readySet = new Set();
      io.to(room.code).emit('sync:stop');
      io.to(room.code).emit('room:state', snapshot(room));
    });

    socket.on('sync:seek', ({ position }) => {
      const c = socket.data.code;
      if (c) io.to(c).emit('sync:seek', { position, seekAt: Date.now() });
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const { code, role } = socket.data;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;

      console.log(`[ws] - ${socket.id.slice(0, 8)} (${role}) from ${code}`);

      if (role === 'master') {
        room.masterSid = null;
        clearTimeout(room._masterTimeout);
        // Give master 30 s to reconnect before closing the room
        room._masterTimeout = setTimeout(() => {
          nameIndex.delete(room.name.toLowerCase());
          rooms.delete(code);
          io.to(code).emit('peer:left', { role: 'master', permanent: true });
          console.log(`[room] expired "${room.name}" (no host reconnect)`);
        }, 5 * 60 * 1000); // 5 minutes — gives mobile time to reconnect
        socket.to(code).emit('peer:left', { role: 'master', permanent: false });
      } else {
        room.followers.delete(socket.id);
        room.readySet.delete(socket.id);
        if (room.masterSid)
          io.to(room.masterSid).emit('peer:left', {
            role: 'follower', peerSid: socket.id, permanent: false,
            listenerCount: room.followers.size,
          });
        io.to(code).emit('room:state', snapshot(room));
      }
    });

    // ── Rejoin after reconnect ────────────────────────────────────────────────
    socket.on('room:rejoin', ({ code, role }) => {
      const c    = (code || '').toUpperCase().trim();
      const room = rooms.get(c);

      if (!room)
        return socket.emit('room:rejoin-err', { msg: 'Room has expired. Please create or join a new room.' });

      if (role === 'master') {
        if (room.masterSid && room.masterSid !== socket.id) {
          // Only reject if the old socket is STILL connected
          // (not just a stale masterSid from a previous connection)
          const oldSocket = io.sockets.sockets.get(room.masterSid);
          if (oldSocket && oldSocket.connected) {
            return socket.emit('room:rejoin-err', { msg: 'Host slot already taken.' });
          }
          // Old socket is gone — allow this new socket to take over
          console.log('[room] clearing stale masterSid, accepting rejoin');
          room.masterSid = null;
        }
        clearTimeout(room._masterTimeout);
        room.masterSid = socket.id;
        socket.join(c);
        socket.data.code = c;
        socket.data.role = 'master';
        socket.emit('room:rejoined', {
          code: c, name: room.name, role: 'master',
          listenerCount: room.followers.size,
          followerSids: [...room.followers.keys()],
          hasFollower:   room.followers.size > 0,
          fileHash:      room.fileHash || null,     // was a file being transferred?
          readyCount:    room.readySet.size,
        });
        for (const [sid] of room.followers)
          io.to(sid).emit('peer:rejoined', { role: 'master', peerSid: socket.id });
        console.log(`[room] host rejoined "${room.name}"`);

      } else {
        if (!room.followers.has(socket.id) && room.followers.size >= MAX_LISTENERS)
          return socket.emit('room:rejoin-err', { msg: 'Room is now full.' });
        room.followers.set(socket.id, { name: userName });
        socket.join(c);
        socket.data.code = c;
        socket.data.role = 'follower';
        socket.emit('room:rejoined', {
          code: c, name: room.name, role: 'follower', masterSid: room.masterSid,
        });
        if (room.masterSid)
          io.to(room.masterSid).emit('peer:rejoined', {
            role: 'follower', peerSid: socket.id, listenerCount: room.followers.size,
          });
      }
    });
  });

  // ── Start listening ──────────────────────────────────────────────────────
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  ╔══════════════════════════════════════╗`);
    console.log(`  ║   MuDi — The Digital Aux Cord        ║`);
    console.log(`  ║   http://localhost:${PORT}               ║`);
    console.log(`  ╚══════════════════════════════════════╝\n`);
  });
}
