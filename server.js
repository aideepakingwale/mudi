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
  // Skip body parsers for raw upload routes — express.json() 100KB limit kills large files
  app.use((req, res, next) => {
    if (req.path.startsWith('/transfer/upload')) return next();
    express.json()(req, res, next);
  });
  app.use((req, res, next) => {
    if (req.path.startsWith('/transfer/upload')) return next();
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

  // ── File Transfer ────────────────────────────────────────────────────────
  //
  // Mode A — Cloudflare R2 (when R2_* env vars are set):
  //   Host  → PUT presigned URL → R2 bucket (bypasses this server entirely)
  //   Server → emits presigned GET URL to listeners via socket
  //   Listeners → GET presigned URL → R2 (Cloudflare CDN, full speed)
  //
  // Mode B — Server streaming pipe (fallback, no R2 config needed):
  //   Host → POST /transfer/upload/:token → PassThrough → GET /transfer/stream/:token → Listeners
  //   Listener starts receiving bytes the moment host starts uploading.
  //
  const { PassThrough } = require('stream');
  const transferStore   = new Map(); // token → entry (Mode B)

  // R2 presigned URL generation — no AWS SDK needed
  // Uses Node 18 built-in crypto for AWS Signature V4
  const { createHmac, createHash } = require('crypto');

  function r2Configured() {
    return !!(process.env.R2_ACCOUNT_ID &&
              process.env.R2_ACCESS_KEY_ID &&
              process.env.R2_SECRET_ACCESS_KEY);
  }

  function sha256hex(data) {
    return createHash('sha256').update(data).digest('hex');
  }

  function hmacSha256(key, data) {
    return createHmac('sha256', key).update(data).digest();
  }

  function awsSigningKey(secretKey, date, region, service) {
    const kDate    = hmacSha256('AWS4' + secretKey, date);
    const kRegion  = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, service);
    return hmacSha256(kService, 'aws4_request');
  }

  // Generate a presigned URL for PUT or GET
  function r2PresignedUrl(method, key, expiresIn = 900) {
    const bucket    = process.env.R2_BUCKET_NAME || 'mudi-transfers';
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secretKey = process.env.R2_SECRET_ACCESS_KEY;
    const region    = 'auto';
    const service   = 's3';
    const host      = `${bucket}.${accountId}.r2.cloudflarestorage.com`;

    const now       = new Date();
    const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');  // YYYYMMDD
    const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '');  // YYYYMMDDTHHmmssZ

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const credential      = `${accessKey}/${credentialScope}`;

    const queryParams = new URLSearchParams({
      'X-Amz-Algorithm':     'AWS4-HMAC-SHA256',
      'X-Amz-Credential':    credential,
      'X-Amz-Date':          amzDate,
      'X-Amz-Expires':       String(expiresIn),
      'X-Amz-SignedHeaders': 'host',
    });

    const canonicalQueryString = queryParams.toString();
    const canonicalHeaders     = `host:${host}\n`;
    const signedHeaders        = 'host';
    const payloadHash          = 'UNSIGNED-PAYLOAD';

    const canonicalRequest = [
      method,
      `/${encodeURIComponent(key).replace(/%2F/g, '/')}`,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256hex(canonicalRequest),
    ].join('\n');

    const signingKey = awsSigningKey(secretKey, dateStamp, region, service);
    const signature  = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    queryParams.set('X-Amz-Signature', signature);

    return `https://${host}/${encodeURIComponent(key).replace(/%2F/g, '/')}?${queryParams.toString()}`;
  }

  // Delete an object from R2
  async function deleteR2Object(key) {
    if (!r2Configured()) return;
    const bucket = process.env.R2_BUCKET_NAME || 'mudi-transfers';
    try {
      // R2 DELETE uses the same AWS4 signing as GET/PUT
      const deleteUrl = r2PresignedUrl('DELETE', key, 300);
      const res = await fetch(deleteUrl, { method: 'DELETE' });
      if (res.ok || res.status === 204 || res.status === 404) {
        console.log('[r2] deleted:', key);
      } else {
        console.warn('[r2] delete returned', res.status, 'for', key);
      }
    } catch(e) {
      console.error('[r2] delete error:', e.message);
    }
  }

  // Clean up Mode B transfers
  setInterval(() => {
    const now = Date.now();
    for (const [token, t] of transferStore) {
      if (t.expires < now) {
        try { if (t.pass) t.pass.destroy(); } catch(e) {}
        transferStore.delete(token);
      }
    }
  }, 5 * 60 * 1000);

  // ── MODE A: R2 presigned upload URL ──────────────────────────────────────
  app.post('/transfer/r2/presign', requireAuth, async (req, res) => {
    if (!r2Configured()) return res.status(503).json({ error: 'R2 not configured' });

    const roomCode   = req.query.room;
    const fileName   = decodeURIComponent(req.query.name || 'audio');
    const fileHash   = req.query.hash   || '';
    const fileSize   = parseInt(req.query.size || '0', 10);
    const compressed = req.query.compressed === '1';

    if (!roomCode) return res.status(400).json({ error: 'Missing room' });

    // Object key: roomCode/timestamp-filename (scoped, easy cleanup)
    const key   = `${roomCode.toUpperCase()}/${Date.now()}-${encodeURIComponent(fileName)}`;
    const bucket = process.env.R2_BUCKET_NAME || 'mudi-transfers';

    try {
      // Presigned PUT — host uploads directly to R2 (15 min window)
      const putUrl = r2PresignedUrl('PUT', key, 900);

      // Presigned GET — listeners download directly from R2 (2 hr window)
      const getUrl = r2PresignedUrl('GET', key, 7200);

      // Store metadata so we can notify listeners once host confirms upload done
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      transferStore.set(token, {
        mode: 'r2', key, bucket, getUrl,
        meta: { name: fileName, size: fileSize, hash: fileHash, compressed },
        roomCode,
        expires: Date.now() + 2 * 60 * 60 * 1000,
      });

      console.log('[r2] presigned token:', token.slice(0,8), fileName);
      res.json({ ok: true, token, putUrl });
    } catch(e) {
      console.error('[r2] presign error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // Host calls this after R2 PUT completes — server notifies listeners
  app.post('/transfer/r2/confirm/:token', requireAuth, (req, res) => {
    const entry = transferStore.get(req.params.token);
    if (!entry || entry.mode !== 'r2')
      return res.status(404).json({ error: 'Token not found' });

    const room = rooms.get(entry.roomCode.toUpperCase());
    if (room) {
      const { name, size, hash, compressed } = entry.meta;

      // Store R2 key on the room so file:ready handler can delete it
      room._r2Key            = entry.key;
      room._r2ReadyCount     = 0;
      room._r2ExpectedCount  = room.followers.size;

      // Safety net: delete from R2 after 30 min regardless
      // (covers case where listeners disconnect without sending file:ready)
      clearTimeout(room._r2DeleteTimer);
      room._r2DeleteTimer = setTimeout(() => {
        if (room._r2Key) {
          console.log('[r2] 30min safety delete:', room._r2Key);
          deleteR2Object(room._r2Key);
          room._r2Key = null;
        }
      }, 30 * 60 * 1000);

      io.to(room.code).emit('file:r2-ready', {
        url: entry.getUrl,
        name, size, hash, compressed,
      });
      console.log('[r2] confirmed, notified', room.followers.size,
        'listeners — will delete after all download');
    }

    transferStore.delete(req.params.token); // free memory
    res.json({ ok: true });
  });

  // ── MODE B: Server streaming pipe (fallback) ─────────────────────────────
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
    if (room) {
      io.to(room.code).emit('file:stream-ready', {
        token, name: fileName, size: fileSize, hash: fileHash, compressed,
      });
    }

    console.log('[pipe] init token:', token.slice(0,8), fileName, (fileSize/1024/1024).toFixed(1)+'MB');
    res.json({ ok: true, token });
  });

  app.post('/transfer/upload/:token', requireAuth, (req, res) => {
    const entry = transferStore.get(req.params.token);
    if (!entry || entry.mode !== 'pipe') return res.status(404).json({ error: 'Token not found' });
    if (entry.done) return res.status(409).json({ error: 'Already uploaded' });

    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      entry.pass.write(chunk);
    });
    req.on('end', () => {
      entry.pass.end();
      entry.done = true;
      console.log('[pipe] done', (received/1024/1024).toFixed(2)+'MB');
      res.json({ ok: true, received });
    });
    req.on('error', err => {
      entry.pass.destroy(err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  });

  app.get('/transfer/stream/:token', requireAuth, (req, res) => {
    const entry = transferStore.get(req.params.token);
    if (!entry || entry.mode !== 'pipe') return res.status(404).json({ error: 'Not found' });

    entry.listeners++;
    res.setHeader('Content-Type', 'application/octet-stream');
    if (entry.meta.size) res.setHeader('Content-Length', entry.meta.size);
    res.setHeader('Cache-Control', 'no-store');
    entry.pass.pipe(res, { end: true });
    req.on('close', () => { entry.listeners = Math.max(0, entry.listeners - 1); });
  });

  // ── Share link redirect ────────────────────────────────────────────────────
  app.get('/join/:code', (req, res) => {
    const code = (req.params.code || '').toUpperCase().trim();
    res.redirect(`/?join=${code}`);
  });

  // ── Permanent rooms API ───────────────────────────────────────────────────
  app.get('/api/my-rooms', requireAuth, async (req, res) => {
    try {
      const rooms_ = await db.getPermanentRoomsForUser(req.user.id);
      // Annotate with live status
      const result = rooms_.map(r => ({
        ...r,
        live: rooms.has(r.code),
        hostOnline: !!(rooms.get(r.code)?.masterSid),
        listenerCount: rooms.get(r.code)?.followers.size || 0,
      }));
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/permanent-room', requireAuth, async (req, res) => {
    try {
      const { name, password } = req.body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
      let code; do { code = genCode(); } while (rooms.has(code));
      const pwHash = password ? simpleHash(password.trim()) : null;
      const room = await db.createPermanentRoom({ code, name: name.trim().slice(0,32), ownerId: req.user.id, passwordHash: pwHash });
      res.json(room);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/room-members/:code', requireAuth, async (req, res) => {
    try {
      const members = await db.getRoomMembers(req.params.code.toUpperCase());
      res.json(members);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Analytics API ─────────────────────────────────────────────────────────
  app.get('/api/analytics', requireAuth, async (req, res) => {
    try {
      const data = await db.getAnalytics(req.user.id);
      res.json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── PWA manifest ──────────────────────────────────────────────────────────
  app.get('/manifest.json', (_req, res) => {
    res.json({
      name: 'MuDi',
      short_name: 'MuDi',
      description: 'The Digital Aux Cord — sync music with friends',
      start_url: '/',
      display: 'standalone',
      background_color: '#09091A',
      theme_color: '#00ADB5',
      orientation: 'portrait-primary',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
      categories: ['music', 'entertainment'],
      shortcuts: [
        { name: 'Host a Room', url: '/?action=host', description: 'Create a new listening room' },
        { name: 'Join a Room', url: '/?action=join', description: 'Join an existing room' },
      ],
    });
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

      room.followers.set(socket.id, { name: userName, displayName: userName });
      // Add to permanent room member list if it exists
      db.addRoomMember(c, socket.request?.user?.id).catch(()=>{});
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
        // Delete R2 file if host leaves before all listeners downloaded
        if (room._r2Key) {
          clearTimeout(room._r2DeleteTimer);
          deleteR2Object(room._r2Key);
          room._r2Key = null;
        }
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

      // R2 deletion: track how many listeners confirmed download
      if (room._r2Key) {
        room._r2ReadyCount = (room._r2ReadyCount || 0) + 1;
        const expected = room._r2ExpectedCount || room.followers.size;
        console.log(`[r2] ${room._r2ReadyCount}/${expected} listeners verified download`);
        if (room._r2ReadyCount >= expected) {
          // All listeners have downloaded and verified — delete from R2 now
          clearTimeout(room._r2DeleteTimer);
          const key = room._r2Key;
          room._r2Key = null;
          deleteR2Object(key);
        }
      }
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

    // ── Display name ─────────────────────────────────────────────────────────
    socket.on('listener:name', ({ displayName }) => {
      const room = rooms.get(socket.data.code);
      if (!room || !room.followers.has(socket.id)) return;
      const safeName = (displayName || '').trim().slice(0, 32) || 'Listener';
      room.followers.get(socket.id).displayName = safeName;
      io.to(room.masterSid).emit('listener:name', { peerSid: socket.id, displayName: safeName });
      io.to(socket.id).emit('listener:name-ack', { displayName: safeName });
    });

    // ── Room chat ─────────────────────────────────────────────────────────────
    socket.on('chat:send', async ({ text }) => {
      const code = socket.data.code;
      const room = rooms.get(code);
      if (!room || !text) return;
      const msg = (text || '').trim().slice(0, 280);
      if (!msg) return;
      const user    = socket.request?.user;
      const senderName = (room.followers.get(socket.id)?.displayName)
        || (room.masterSid === socket.id ? (user?.name || 'Host') : (user?.name || 'Listener'));
      const role    = room.masterSid === socket.id ? 'master' : 'follower';
      const payload = { sid: socket.id, senderName, role, text: msg, ts: Date.now() };
      io.to(code).emit('chat:message', payload);
      // Award points
      if (user?.id) {
        db.addPoints(user.id, 'chat', 1).catch(() => {});
        // Update scoreboard for room
        const scores = await db.getUserScore(user.id).catch(() => ({}));
        io.to(code).emit('score:update', { userId: user.id, name: senderName, scores });
      }
    });

    // ── Reactions ─────────────────────────────────────────────────────────────
    socket.on('reaction:send', async ({ emoji }) => {
      const code = socket.data.code;
      const room = rooms.get(code);
      if (!room) return;
      const ALLOWED = ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💕","💞","💓","💗","💖","💘","💝","💟","❣️","😍","🥰","😘","😗","😚","😙","🎵","🎶","🎸","🥁","🎹","🎺","🎻","🎤","🎧","🔥","💯","✨","💥","🚀","⚡","🌟","👑","🏆","😂","🤩","😮","😢","🥺","😎","🤯","😱","🙏","👏","🙌","🤙","👍","🫶"];
      if (!ALLOWED.includes(emoji)) return;
      const user = socket.request?.user;
      const senderName = (room.followers.get(socket.id)?.displayName)
        || (user?.name || 'Someone');
      io.to(code).emit('reaction:broadcast', { emoji, senderName, sid: socket.id, ts: Date.now() });
      if (user?.id) {
        db.addPoints(user.id, 'reaction', 1).catch(() => {});
        const scores = await db.getUserScore(user.id).catch(() => ({}));
        io.to(code).emit('score:update', { userId: user.id, name: senderName, scores });
      }
    });

    // ── Seek request (listener → host) ───────────────────────────────────────
    socket.on('seek:request', ({ position }) => {
      const room = rooms.get(socket.data.code);
      if (!room || room.masterSid === socket.id) return;
      const senderName = room.followers.get(socket.id)?.displayName || 'A listener';
      if (room.masterSid)
        io.to(room.masterSid).emit('seek:request', { from: socket.id, senderName, position });
    });

    socket.on('seek:respond', ({ to, approved, position }) => {
      const room = rooms.get(socket.data.code);
      if (!room || room.masterSid !== socket.id) return;
      io.to(to).emit('seek:response', { approved, position });
      if (approved) {
        io.to(room.code).emit('sync:seek', { position, seekAt: Date.now() });
      }
    });

    // ── Analytics: session tracking ──────────────────────────────────────────
    socket.on('analytics:session-start', async ({ fileName, fileSize, transferMode }) => {
      const room = rooms.get(socket.data.code);
      if (!room || room.masterSid !== socket.id) return;
      const user = socket.request?.user;
      try {
        const sessionId = await db.startSession({
          roomCode: room.code, roomName: room.name,
          hostId: user?.id, listenerCount: room.followers.size,
          fileName, fileSize, transferMode,
        });
        room._sessionId   = sessionId;
        room._sessionStart = Date.now();
        if (user?.id) db.incrementSessions(user.id, 'master').catch(()=>{});
      } catch(e) { console.warn('[analytics]', e.message); }
    });

    socket.on('analytics:session-end', async ({ syncCorrections }) => {
      const room = rooms.get(socket.data.code);
      if (!room || !room._sessionId) return;
      try {
        const dur = Math.round((Date.now() - (room._sessionStart||Date.now())) / 1000);
        await db.endSession(room._sessionId, { syncCorrections, durationSecs: dur });
        if (user?.id) db.addPoints(user.id, 'session', 5).catch(()=>{});
        room._sessionId = null;
      } catch(e) { console.warn('[analytics]', e.message); }
    });

    // ── Permanent room status ────────────────────────────────────────────────
    socket.on('proom:status', ({ code }) => {
      const live = rooms.get((code||'').toUpperCase());
      socket.emit('proom:status-res', {
        code, live: !!live, hostOnline: !!(live?.masterSid),
        listenerCount: live?.followers.size || 0,
      });
    });

    // ── Leaderboard ───────────────────────────────────────────────────────────
    socket.on('leaderboard:get', async () => {
      const code = socket.data.code;
      if (!code) return;
      try {
        const board = await db.getLeaderboard(code, 20);
        socket.emit('leaderboard:data', { board });
      } catch(e) { console.warn('[leaderboard]', e.message); }
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
          // Clean up R2 file if room expires before all listeners downloaded
          if (room._r2Key) {
            clearTimeout(room._r2DeleteTimer);
            deleteR2Object(room._r2Key);
            room._r2Key = null;
          }
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

// ═══════════════════════════════════════════════════════════════════════════
//  NEW FEATURE SOCKET HANDLERS — appended after existing initSocket() end
//  Injected via a second io.on('connection') — Socket.IO merges them cleanly
// ═══════════════════════════════════════════════════════════════════════════
