/**
 * MuDi — server.js  (entry point, wiring only)
 *
 * Module map:
 *   routes/r2.js         — Cloudflare R2 presigned URL helpers
 *   routes/transfer.js   — File transfer HTTP routes
 *   routes/api.js        — REST API
 *   routes/pages.js      — HTML pages + static + PWA manifest
 *   sockets/room.js      — Room lifecycle (create/join/leave/rejoin)
 *   sockets/index.js     — All other socket handlers (sync, file, chat, aux, analytics, disconnect)
 *   db.js                — SQLite + R2 backup
 *   auth.js              — Passport (local, Google, Facebook)
 */
'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const db         = require('./db');

// routes
const { registerTransferRoutes }  = require('./routes/transfer');
const { registerApiRoutes }       = require('./routes/api');
const { registerPageRoutes }      = require('./routes/pages');

// sockets
const { registerRoomHandlers, genCode, simpleHash } = require('./sockets/room');
const { registerAllSocketHandlers }                  = require('./sockets/index');

// auth
const { router: authRouter, passport, requireAuth } = require('./auth');

const PORT = parseInt(process.env.PORT || '8080', 10);

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

  app.set('trust proxy', 1);

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

  const rooms     = new Map();
  const nameIndex = new Map();

  registerTransferRoutes(app, io, rooms, requireAuth);
  registerApiRoutes(app, rooms, genCode, simpleHash, requireAuth);
  registerPageRoutes(app, requireAuth);

  io.engine.use(sessionMiddleware);
  io.engine.use(passport.initialize());
  io.engine.use(passport.session());

  io.on('connection', socket => {
    const user = socket.request?.user;
    console.log(`[ws] + ${socket.id.slice(0, 8)} "${user?.name || 'Guest'}"`);
    registerRoomHandlers(socket, io, rooms, nameIndex);
    registerAllSocketHandlers(socket, io, rooms, nameIndex);
  });

  setInterval(async () => {
    for (const [code] of rooms) {
      try {
        const board = await db.getLeaderboard(code, 20);
        io.to(code).emit('leaderboard:data', { board });
      } catch(e) {}
    }
  }, 30_000);

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  MuDi v3.1.0 — The Digital Aux Cord\n  http://localhost:${PORT}\n`);
  });
}
