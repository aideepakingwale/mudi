/**
 * routes/pages.js — HTML page routes + static assets
 *
 * GET /login   — login/register page (public)
 * GET /privacy — privacy policy (public, required by Facebook)
 * GET /terms   — terms of service (public, required by Facebook)
 * GET /config  — ICE server config for WebRTC (authenticated)
 * GET /        — main app (authenticated)
 */
'use strict';

const path    = require('path');
const express = require('express');

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls:       'turn:openrelay.metered.ca:80',
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls:       'turn:openrelay.metered.ca:443',
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls:       'turn:openrelay.metered.ca:443?transport=tcp',
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls:       'turns:openrelay.metered.ca:443',
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
];

function registerPageRoutes(app, requireAuth) {
  const PUB = path.join(__dirname, '..', 'public');

  // ── Auth providers list (for login page) ─────────────────────────────────
  app.get('/auth/providers', (_req, res) => res.json({
    google:   !!(process.env.GOOGLE_CLIENT_ID),
    facebook: !!(process.env.FACEBOOK_APP_ID),
  }));

  // ── ICE / STUN / TURN config ──────────────────────────────────────────────
  app.get('/config', requireAuth, (_req, res) => res.json({ iceServers: STUN_SERVERS }));

  // ── Public pages ──────────────────────────────────────────────────────────
  app.get('/login', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/');
    res.sendFile(path.join(PUB, 'login.html'));
  });

  app.get('/privacy', (_req, res) => res.sendFile(path.join(PUB, 'privacy.html')));
  app.get('/terms',   (_req, res) => res.sendFile(path.join(PUB, 'terms.html')));

  // ── Static assets (CSS, JS, icons — NOT index.html) ──────────────────────
  app.use(express.static(PUB, { index: false }));

  // ── Main app — requires authentication ────────────────────────────────────
  app.get('/', requireAuth, (_req, res) => res.sendFile(path.join(PUB, 'index.html')));

  // ── Catch-all ─────────────────────────────────────────────────────────────
  app.use((req, res) => {
    if (req.accepts('html')) return res.redirect('/login');
    res.status(404).json({ error: 'Not found' });
  });
}

module.exports = { registerPageRoutes };
