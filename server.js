/**
 * MuDi — server.js  (entry point, wiring only)
 *
 * Starts Express + Socket.IO then delegates everything to modules:
 *
 *   routes/
 *     r2.js        — Cloudflare R2 presigned URL helpers (AWS Signature V4)
 *     transfer.js  — File transfer HTTP routes (R2 + streaming pipe)
 *     api.js       — REST API (/api/my-rooms, /api/analytics, etc.)
 *     pages.js     — HTML pages + static assets + PWA manifest
 *
 *   sockets/
 *     room.js      — Room lifecycle (create, join, leave, rejoin)
 *     sync.js      — NTP clock sync + playback commands
 *     file.js      — File metadata relay + WebRTC signalling
 *     chat.js      — Chat messages, voice, emoji reactions
 *     aux.js       — Aux cord transfer (host handover)
 *     analytics.js — Session analytics + leaderboard
 *     disconnect.js— Disconnect + room expiry
 *
 *   db.js          — SQLite via sql.js + R2 backup persistence
 *   auth.js        — Passport.js (local, Google, Facebook)
 */
'use strict';

require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const session  = require('express-session');
const db       = require('./db');

const PORT = parseInt(process.env.PORT || '8080', 10);

// Wait for SQLite before accepting connections
db.ready.then(startServer).catch(err => {
  console.error('[MuDi] Fatal — DB init failed:', err);
  process.exit(1);
});

function startServer() {
  const { router: authRouter, passport, requireAuth } = require('./auth');

  const app    = express();
  const server = http.createServer(app);
  const io     = new Server(server, {
    cors:           { origin: '*' },
    pingInterval:   25000,
    pingTimeout:    120000,
    connectTimeout: 20000,
  });

  // ── Middleware ──────────────────────────────────────────────────────────────
  app.set('trust proxy', 1);

  // Skip body parsers for raw upload route (express.json limit would block files)
  app.use((req, res, next) => {
    if (req.path.startsWith('/transfer/upload')) return next();
    express.json()(req, res, next);
  });
  app.use((req, res, next) => {
    if (req.path.startsWith('/transfer/upload')) return next();
    express.urlencoded({ extended: true })(req, res, next);
  });

  const sessionMiddleware = session({
    secret:            process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave:            false,
    saveUninitialized: false,
    cookie: {
      secure:   process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: 'lax',
    },
  });
  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());
  app.use('/auth', authRouter);

  // ── Shared room state ───────────────────────────────────────────────────────
  // These Maps are passed into every socket module so they share the same state
  const rooms     = new Map(); // code  → room object
  const nameIndex = new Map(); // lowerName → code

  const { genCode, simpleHash } = require('./sockets/room');

  // ── HTTP routes ─────────────────────────────────────────────────────────────
  const { registerTransferRoutes } = require('./routes/transfer');
  const { registerApiRoutes }      = require('./routes/api');
  const { registerPageRoutes }     = require('./routes/pages');

  registerTransferRoutes(app, io, rooms, requireAuth);
  registerApiRoutes(app, rooms, genCode, simpleHash, requireAuth);
  registerPageRoutes(app, requireAuth);  // must be last (has catch-all)

  // ── Share session with Socket.IO ────────────────────────────────────────────
  io.engine.use(sessionMiddleware);
  io.engine.use(passport.initialize());
  io.engine.use(passport.session());

  // ── Socket.IO — register handlers for every connection ─────────────────────
  const { registerRoomHandlers }       = require('./sockets/room');
  const { registerSyncHandlers }       = require('./sockets/sync');
  const { registerFileHandlers }       = require('./sockets/file');
  const { registerChatHandlers }       = require('./sockets/chat');
  const { registerAuxHandlers }        = require('./sockets/aux');
  const { registerAnalyticsHandlers }  = require('./sockets/analytics');
  const { registerDisconnectHandler }  = require('./sockets/disconnect');

  io.on('connection', socket => {
    const user = socket.request?.user;
    console.log(`[ws] + ${socket.id.slice(0, 8)} "${user?.name || 'Guest'}"`);

    registerRoomHandlers(socket, io, rooms, nameIndex);
    registerSyncHandlers(socket, io, rooms);
    registerFileHandlers(socket, io, rooms);
    registerChatHandlers(socket, io, rooms);
    registerAuxHandlers(socket, io, rooms);
    registerAnalyticsHandlers(socket, io, rooms);
    registerDisconnectHandler(socket, io, rooms, nameIndex);
  });

  // ── Background jobs ─────────────────────────────────────────────────────────
  // Periodic leaderboard broadcast to all active rooms (every 30s)
  setInterval(async () => {
    for (const [code] of rooms) {
      try {
        const board = await db.getLeaderboard(code, 20);
        io.to(code).emit('leaderboard:data', { board });
      } catch(e) {}
    }
  }, 30_000);

  // ── Start listening ─────────────────────────────────────────────────────────
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`
  ╔══════════════════════════════════════╗
  ║   MuDi — The Digital Aux Cord        ║
  ║   http://localhost:${PORT}               ║
  ╚══════════════════════════════════════╝
`);
  });
}
