/**
 * MuDi — auth.js  v2.1
 * Passport strategies: local email/password, Google OAuth, Facebook OAuth
 * Handles: unconfigured providers, account linking by email, better errors
 */

const passport         = require('passport');
const LocalStrategy    = require('passport-local').Strategy;
const GoogleStrategy   = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const bcrypt = require('bcryptjs');
const db     = require('./db');

// ── Serialise / Deserialise ──────────────────────────────────────────────────
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try { done(null, (await db.findById(id)) || false); }
  catch(e) { done(e); }
});

// ── Local Strategy ───────────────────────────────────────────────────────────
passport.use('local', new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  async (email, password, done) => {
    try {
      const user = await db.findByEmail(email);
      if (!user)
        return done(null, false, { message: 'No account found with that email address.' });
      if (!user.password_hash)
        return done(null, false, {
          message: `This account was created with ${user.provider}. Click the ${user.provider === 'google' ? 'Google' : 'Facebook'} button to sign in.`
        });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok)
        return done(null, false, { message: 'Incorrect password. Please try again.' });
      await db.touchLogin(user.id);
      return done(null, user);
    } catch(e) { done(e); }
  }
));

// ── Google Strategy ──────────────────────────────────────────────────────────
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use('google', new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.BASE_URL + '/auth/google/callback',
    scope: ['profile', 'email'],
  }, async (_at, _rt, profile, done) => {
    try {
      const email  = profile.emails?.[0]?.value || null;
      const avatar = profile.photos?.[0]?.value || null;
      const name   = profile.displayName || email || 'Google User';
      // findOrCreate handles account linking by email automatically
      const user = await db.findOrCreate({
        provider: 'google', providerId: profile.id,
        email, name, avatar,
      });
      await db.touchLogin(user.id);
      done(null, user);
    } catch(e) { done(e); }
  }));
} else {
  console.warn('[auth] Google OAuth not configured — GOOGLE_CLIENT_ID missing');
}

// ── Facebook Strategy ────────────────────────────────────────────────────────
if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  passport.use('facebook', new FacebookStrategy({
    clientID:     process.env.FACEBOOK_APP_ID,
    clientSecret: process.env.FACEBOOK_APP_SECRET,
    callbackURL:  process.env.BASE_URL + '/auth/facebook/callback',
    profileFields: ['id', 'displayName', 'emails', 'picture.type(large)'],
    enableProof: true,
  }, async (_at, _rt, profile, done) => {
    try {
      const email  = profile.emails?.[0]?.value || null;
      const avatar = profile.photos?.[0]?.value || null;
      const name   = profile.displayName || email || 'Facebook User';
      const user = await db.findOrCreate({
        provider: 'facebook', providerId: profile.id,
        email, name, avatar,
      });
      await db.touchLogin(user.id);
      done(null, user);
    } catch(e) { done(e); }
  }));
} else {
  console.warn('[auth] Facebook OAuth not configured — FACEBOOK_APP_ID missing');
}

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  // API requests get JSON; browser requests get redirect
  if (req.xhr || req.headers.accept?.includes('application/json'))
    return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}

// ── Router ───────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

// Registration
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name?.trim())    return res.json({ ok: false, error: 'Please enter your display name.' });
  if (!email?.trim())   return res.json({ ok: false, error: 'Please enter your email address.' });
  if (!email.includes('@')) return res.json({ ok: false, error: 'Please enter a valid email address.' });
  if (!password || password.length < 8)
    return res.json({ ok: false, error: 'Password must be at least 8 characters.' });
  try {
    const existing = await db.findByEmail(email);
    if (existing) {
      if (existing.provider !== 'local')
        return res.json({ ok: false, error: `An account with that email already exists via ${existing.provider}. Use the ${existing.provider === 'google' ? 'Google' : 'Facebook'} button to sign in.` });
      return res.json({ ok: false, error: 'An account with that email already exists. Please sign in.' });
    }
    const hash = await bcrypt.hash(password, 12);
    const user = await db.create({ email: email.trim(), name: name.trim(), provider: 'local', passwordHash: hash });
    req.login(user, err => {
      if (err) return res.json({ ok: false, error: 'Account created but login failed — please sign in.' });
      res.json({ ok: true, redirect: '/' });
    });
  } catch(e) {
    console.error('[register]', e);
    res.json({ ok: false, error: 'Registration failed. Please try again.' });
  }
});

// Login
router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err)   return res.json({ ok: false, error: 'Server error — please try again.' });
    if (!user) return res.json({ ok: false, error: info?.message || 'Login failed.' });
    req.login(user, loginErr => {
      if (loginErr) return res.json({ ok: false, error: 'Session error — please try again.' });
      res.json({ ok: true, redirect: '/' });
    });
  })(req, res, next);
});

// Logout
router.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/login?msg=signed-out'));
});

// Current user
router.get('/me', requireAuth, (req, res) => {
  const { id, name, email, avatar, provider } = req.user;
  res.json({ id, name, email, avatar, provider });
});

// ── Google OAuth routes ───────────────────────────────────────────────────────
router.get('/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID)
    return res.redirect('/login?error=google_not_configured');
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});
router.get('/google/callback',
  (req, res, next) => {
    passport.authenticate('google', {
      failureRedirect: '/login?error=google_failed',
      failureMessage: true,
    })(req, res, next);
  },
  (req, res) => res.redirect('/')
);

// ── Facebook OAuth routes ─────────────────────────────────────────────────────
router.get('/facebook', (req, res, next) => {
  if (!process.env.FACEBOOK_APP_ID)
    return res.redirect('/login?error=facebook_not_configured');
  passport.authenticate('facebook', { scope: ['email'] })(req, res, next);
});
router.get('/facebook/callback',
  (req, res, next) => {
    passport.authenticate('facebook', {
      failureRedirect: '/login?error=facebook_failed',
      failureMessage: true,
    })(req, res, next);
  },
  (req, res) => res.redirect('/')
);

module.exports = { router, passport, requireAuth };
