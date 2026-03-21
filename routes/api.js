/**
 * routes/api.js — REST API routes
 *
 * GET  /api/my-rooms            — permanent rooms for current user
 * POST /api/permanent-room      — create a permanent room
 * GET  /api/room-members/:code  — member list for a room
 * GET  /api/analytics           — session stats for current user
 * GET  /manifest.json           — PWA manifest
 * GET  /join/:code              — share-link redirect
 */
'use strict';

const db = require('../db');

function registerApiRoutes(app, rooms, genCode, simpleHash, requireAuth) {

  // ── Share-link redirect ──────────────────────────────────────────────────
  app.get('/join/:code', (req, res) => {
    const code = (req.params.code || '').toUpperCase().trim();
    res.redirect(`/?join=${code}`);
  });

  // ── Permanent rooms ──────────────────────────────────────────────────────
  app.get('/api/my-rooms', requireAuth, async (req, res) => {
    try {
      const userRooms = await db.getPermanentRoomsForUser(req.user.id);
      const result = userRooms.map(r => ({
        ...r,
        live:          rooms.has(r.code),
        hostOnline:    !!(rooms.get(r.code)?.masterSid),
        listenerCount: rooms.get(r.code)?.followers.size || 0,
      }));
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/permanent-room', requireAuth, async (req, res) => {
    try {
      const { name, password } = req.body;
      if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
      let code;
      do { code = genCode(); } while (rooms.has(code));
      const pwHash = password ? simpleHash(password.trim()) : null;
      const room = await db.createPermanentRoom({
        code,
        name: name.trim().slice(0, 32),
        ownerId: req.user.id,
        passwordHash: pwHash,
      });
      res.json(room);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/room-members/:code', requireAuth, async (req, res) => {
    try {
      const members = await db.getRoomMembers(req.params.code.toUpperCase());
      res.json(members);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── Analytics ────────────────────────────────────────────────────────────
  app.get('/api/analytics', requireAuth, async (req, res) => {
    try {
      const data = await db.getAnalytics(req.user.id);
      res.json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ── PWA manifest ─────────────────────────────────────────────────────────
  app.get('/manifest.json', (_req, res) => {
    res.json({
      name:             'MuDi',
      short_name:       'MuDi',
      description:      'The Digital Aux Cord — sync music with friends',
      start_url:        '/',
      display:          'standalone',
      background_color: '#09091A',
      theme_color:      '#00ADB5',
      orientation:      'portrait-primary',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
      categories: ['music', 'entertainment'],
      shortcuts: [
        { name: 'Host a Room', url: '/?action=host', description: 'Create a new listening room' },
        { name: 'Join a Room', url: '/?action=join',  description: 'Join an existing room' },
      ],
    });
  });
}

module.exports = { registerApiRoutes };
