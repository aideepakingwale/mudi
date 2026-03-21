/**
 * MuDi — server.js  (entry point, wiring only)
 *
 * Module map:
 *   routes/r2.js        — Cloudflare R2 presigned URL helpers
 *   routes/transfer.js  — File transfer HTTP routes
 *   routes/api.js       — REST API
 *   routes/pages.js     — HTML pages + static + PWA manifest
 *   sockets/room.js     — Room lifecycle
 *   sockets/sync.js     — NTP + playback commands
 *   sockets/file.js     — File relay + WebRTC signalling
 *   sockets/chat.js     — Chat, voice, reactions
 *   sockets/aux.js      — Aux cord transfer
 *   sockets/analytics.js— Session analytics + leaderboard
 *   sockets/disconnect.js — Disconnect + room expiry
 *   db.js               — SQLite + R2 backup
 *   auth.js             — Passport (local, Google, Facebook)
 */
'use strict';

require('dotenv').config();

// ── All requires at top level so missing files fail immediately ──────────────
// This prevents module errors from being swallowed as "DB init failed".
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const session  = require('express-session');
const db       = require('./db');

// routes
const { registerTransferRoutes } = require('./routes/transfer');
const { registerApiRoutes }      = require('./routes/api');
const { registerPageRoutes }     = require('./routes/pages');

// sockets
const { registerRoomHandlers, genCode, simpleHash } = require('./sockets/room');
const { registerSyncHandlers }       = require('./sockets/sync');
const { registerFileHandlers }       = require('./sockets/file');
const { registerChatHandlers }       = require('./sockets/chat');
const { registerAuxHandlers }        = require('./sockets/aux');
const { registerAnalyticsHandlers }  = require('./sockets/analytics');
const { registerDisconnectHandler }  = require('./sockets/disconnect');

// auth loaded separately — needs env vars to be set first, but still top-level
const { router: authRouter, passport, requireAuth } = require('./auth');

const PORT = parseInt(process.env.PORT || '8080', 10);

// ── Wait for SQLite before accepting connections ─────────────────────────────
db.ready.then(startServer).catch(err => {
  console.error('[MuDi] Fatal — DB init failed:', err);
  process.exit(1);
});

function startServer() {
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

  // Skip body parsers for raw upload route — express.json 100KB limit kills files
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
      maxAge:   30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  });

  app.use(sessionMiddleware);
  app.use(passport.initialize());
  app.use(passport.session());
  app.use('/auth', authRouter);

  // ── Shared room state ───────────────────────────────────────────────────────
  const rooms     = new Map(); // code       → room object
  const nameIndex = new Map(); // lowerName  → code

  // ── HTTP routes ─────────────────────────────────────────────────────────────
  registerTransferRoutes(app, io, rooms, requireAuth);
  registerApiRoutes(app, rooms, genCode, simpleHash, requireAuth);
  registerPageRoutes(app, requireAuth); // must be last — has catch-all

  // ── Share session with Socket.IO ────────────────────────────────────────────
  io.engine.use(sessionMiddleware);
  io.engine.use(passport.initialize());
  io.engine.use(passport.session());

  // ── Socket.IO ───────────────────────────────────────────────────────────────
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

  // ── Background: push leaderboard to all rooms every 30s ────────────────────
  setInterval(async () => {
    for (const [code] of rooms) {
      try {
        const board = await db.getLeaderboard(code, 20);
        io.to(code).emit('leaderboard:data', { board });
      } catch(e) {}
    }
  }, 30_000);

  // ── Listen ───────────────────────────────────────────────────────────────────
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  MuDi — The Digital Aux Cord\n  http://localhost:${PORT}\n`);
  });
}
