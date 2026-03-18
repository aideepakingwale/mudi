# MuDi - The Digital Aux Cord

Sub-15ms synchronised audio playback for groups. One host shares a file,
everyone hears it at the same millisecond. No app store. Works in the browser.

Current version: 3.0.0

---

## Table of Contents

1. [What it does](#1-what-it-does)
2. [Quick start - local](#2-quick-start---local)
3. [Deploy on Render (free)](#3-deploy-on-render-free)
4. [Environment variables](#4-environment-variables)
5. [Database persistence](#5-database-persistence-free-zero-config-if-you-have-r2)
6. [Configure Cloudflare R2 - fast file transfer](#6-configure-cloudflare-r2---fast-file-transfer)
7. [Configure Google Sign-In](#7-configure-google-sign-in)
8. [Configure Facebook Login](#8-configure-facebook-login)
9. [Features guide](#9-features-guide)
10. [Gamification and scoring](#10-gamification-and-scoring)
11. [Analytics](#11-analytics)
12. [PWA - install as an app](#12-pwa---install-as-an-app)
13. [Troubleshooting](#13-troubleshooting)
14. [Project structure](#14-project-structure)

---

## 1. What it does

| Feature | Detail |
|---------|--------|
| Sync accuracy | Under 15 ms across all devices |
| Max listeners | 10 per room |
| File transfer | Cloudflare R2 CDN direct (or server-streamed fallback) |
| Compression | WAV and AIFF compressed in transit, 3 to 5 times smaller |
| File integrity | SHA-256 verified on every transfer |
| Auth | Email and password, Google, Facebook |
| Chat | Live room chat for host and all listeners |
| Reactions | Emoji reactions float on screen in real time |
| Waveform | Live frequency spectrum during playback |
| Lock screen | iOS and Android lock screen controls via Media Session API |
| Seek requests | Listeners can request a seek, host approves or denies |
| Permanent rooms | Fixed room codes with shareable links |
| Leaderboard | Points for chat, reactions, and sessions |
| Analytics | Session history, listener counts, data transferred |
| PWA | Installable to home screen on iOS and Android |
| Database | SQLite, no external database needed |

---

## 2. Quick start - local

Requires Node.js 18 or higher.

```bash
npm install
cp .env.example .env
# Edit .env and set SESSION_SECRET at minimum
npm start
# Open http://localhost:8080
```

Generate a SESSION_SECRET:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Test on a second device by finding your LAN IP:

```powershell
# Windows
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notmatch '^127'}).IPAddress
```

```bash
# macOS / Linux
ipconfig getifaddr en0
```

Open http://YOUR-IP:8080 on the second device.

Note: Google and Facebook OAuth, WebRTC, SHA-256, and the PWA install prompt
all require HTTPS. They work on localhost without SSL. For real devices on
different networks, use the Render deployment in Section 3.

---

## 3. Deploy on Render (free)

Render free tier requires no credit card and provides automatic HTTPS.
The service sleeps after 15 minutes of inactivity. Set up UptimeRobot to prevent that.

### Step 1 - Push to GitHub

```powershell
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOURUSERNAME/mudi.git
git branch -M main
git push -u origin main
```

### Step 2 - Create Render service

1. Go to render.com and sign up with GitHub
2. Click New then Web Service then connect your mudi repo
3. Set Runtime to Docker and Instance Type to Free
4. Add these environment variables:

| Key | Value |
|-----|-------|
| NODE_ENV | production |
| SESSION_SECRET | (run the generate command above) |
| BASE_URL | https://mudi.onrender.com |

5. Click Deploy Web Service
6. Once deployed, copy your actual .onrender.com URL
7. Update BASE_URL to match, then click Manual Deploy

### Step 3 - Keep awake with UptimeRobot (free)

1. Go to uptimerobot.com and register for a free account
2. Click Add New Monitor
3. Type: HTTP(s), URL: your Render URL, Interval: 5 minutes
4. Click Create Monitor

---

## 4. Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| PORT | No | Server port, default 8080 |
| BASE_URL | Yes | Full public URL with no trailing slash |
| SESSION_SECRET | Yes | Random hex string, 32+ bytes recommended |
| NODE_ENV | Production | Set to production on any deployed server |
| DATA_DIR | No | Path for SQLite database, default /app/data in production |
| R2_ACCOUNT_ID | R2 only | Cloudflare account ID |
| R2_ACCESS_KEY_ID | R2 only | R2 API token access key |
| R2_SECRET_ACCESS_KEY | R2 only | R2 API token secret key |
| R2_BUCKET_NAME | R2 only | R2 bucket name, default is mudi-transfers |
| GOOGLE_CLIENT_ID | Google only | From Google Cloud Console |
| GOOGLE_CLIENT_SECRET | Google only | From Google Cloud Console |
| FACEBOOK_APP_ID | Facebook only | From Meta Developers |
| FACEBOOK_APP_SECRET | Facebook only | From Meta Developers |

All OAuth and R2 variables are optional. The app works without any of them
using email and password auth and server-streamed file transfer.

---

## 5. Database persistence (free, zero config if you have R2)

MuDi uses SQLite running in memory via WebAssembly. On Render free tier the
filesystem resets on every redeploy, which would wipe all user accounts,
permanent rooms, scores, and analytics.

The database is kept alive for free using the same Cloudflare R2 bucket used
for file transfer. No new accounts or services needed.

How it works:

- On startup: MuDi downloads mudi.db from your R2 bucket and loads it
- On every write: the file is saved locally and an R2 upload is scheduled
- On shutdown: Render sends SIGTERM before stopping the process, MuDi
  catches it and flushes the latest database to R2 before exiting

This means your data survives redeploys, crashes, and service restarts.

### Setup (no steps needed beyond R2)

If you have already configured R2 following Section 6, database persistence
is automatic. No additional environment variables are needed.

The database is stored in your R2 bucket under the key db/mudi.db.
It is a small file (typically under 1 MB) and does not count meaningfully
toward your 10 GB R2 free tier allowance.

### Without R2

If R2 is not configured, the database works normally but data is lost on
every Render redeploy. The app logs a warning on startup:

```
[db] SQLite ready (no R2 - data lost on redeploy)
```

This is fine for development and testing. For a permanent deployment with
real user accounts, configure R2 first.

### Backup and restore

The database is a single file. To download a copy, go to your Cloudflare
R2 dashboard, open your bucket, and download db/mudi.db. You can open
it with any SQLite viewer such as DB Browser for SQLite.

---

## 7. Configure Cloudflare R2 - fast file transfer

Without R2, file transfer routes through the Render server which is throttled
on the free tier. A 10 MB file can take several minutes.

With R2, the host uploads directly to Cloudflare and listeners download
directly from Cloudflare. The Render server never touches the file data.
A 10 MB file typically transfers in under 10 seconds.

R2 free tier: 10 GB storage, unlimited egress, no credit card.

If R2 is not configured, MuDi silently falls back to server-streamed transfer.
No configuration is required for the fallback to work.

### Step 1 - Create a Cloudflare account

Go to cloudflare.com and sign up. No card needed for the R2 free tier.

### Step 2 - Create an R2 bucket

1. In the dashboard sidebar, click R2 Object Storage
2. Click Create bucket
3. Set the name to mudi-transfers
4. Leave all other settings as default
5. Click Create bucket

### Step 3 - Configure CORS on the bucket

This is required so the browser can upload directly to R2.

1. Open your mudi-transfers bucket
2. Click the Settings tab
3. Scroll to CORS Policy and click Add CORS policy
4. Paste this rule, replacing the URL with your actual app URL:

```json
[
  {
    "AllowedOrigins": ["https://mudi.onrender.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

5. Save the policy

The AllowedOrigins value must exactly match your app URL including https://.
If your URL changes, update this value.

### Step 4 - Create API credentials

1. On the R2 Object Storage overview page, click Manage R2 API tokens
2. Click Create API token
3. Token name: mudi
4. Permissions: Object Read and Write
5. Specify bucket: mudi-transfers
6. Leave TTL as no expiry
7. Click Create API Token
8. Copy all three values shown - they are displayed only once:
   - Access Key ID
   - Secret Access Key
   - (your Account ID is also shown here, or find it top-right on the R2 overview)

### Step 5 - Add to Render environment variables

In Render, go to your service, click Environment, and add:

```
R2_ACCOUNT_ID        = (your 32-character Cloudflare account ID)
R2_ACCESS_KEY_ID     = (your access key ID from Step 4)
R2_SECRET_ACCESS_KEY = (your secret access key from Step 4)
R2_BUCKET_NAME       = mudi-transfers
```

Save and wait for the service to redeploy automatically.

### Verify R2 is working

Select a file on the host. The progress bar should show Uploading to CDN
on the host side and Downloading from CDN on the listener side.

### R2 storage and auto-deletion

Files are automatically deleted from R2 after all listeners confirm their
download is complete and verified. If a listener disconnects before confirming,
the file is deleted after 30 minutes as a safety net. If the room closes,
the file is deleted immediately. Your bucket should stay nearly empty at all times.

### R2 free tier limits

| Resource | Free allowance |
|----------|----------------|
| Storage | 10 GB |
| PUT and LIST operations | 1,000,000 per month |
| GET operations | 10,000,000 per month |
| Egress to internet | Free, unlimited |

---

## 7. Configure Google Sign-In

Google Sign-In is optional. Without it, users can still register with
email and password.

### Step 1 - Create a Google Cloud project

1. Go to console.cloud.google.com
2. Click the project dropdown at the top then New Project
3. Name it MuDi and click Create
4. Make sure the new project is selected

### Step 2 - Enable the People API

1. Go to APIs and Services then Library
2. Search for Google People API
3. Click it and click Enable

### Step 3 - Configure OAuth consent screen

1. Go to APIs and Services then OAuth consent screen
2. Select External and click Create
3. Fill in:
   - App name: MuDi
   - User support email: your email
   - Developer contact email: your email
4. Click Save and Continue through all steps
5. On the Test Users step, add your own Gmail address
6. Complete the setup

### Step 4 - Create OAuth credentials

1. Go to APIs and Services then Credentials
2. Click + Create Credentials then OAuth 2.0 Client ID
3. Application type: Web application
4. Name: MuDi
5. Under Authorised redirect URIs, add:

```
https://mudi.onrender.com/auth/google/callback
```

6. Click Create
7. Copy the Client ID and Client Secret

### Step 5 - Add to Render

```
GOOGLE_CLIENT_ID     = xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET = GOCSPX-xxxx
```

Note: while the app is in Testing mode, only the test users you added in Step 3
can log in with Google. To allow anyone to log in, go to OAuth consent screen
and click Publish App. Google will show a verification warning for unverified
apps, which is normal for personal projects.

---

## 8. Configure Facebook Login

Facebook Login is optional. Without it, users can still register with
email and password.

### Step 1 - Create a Meta developer app

1. Go to developers.facebook.com
2. Click My Apps then Create App
3. Use case: Authenticate and request data from users
4. App name: MuDi
5. Complete the creation steps

### Step 2 - Add Facebook Login product

1. In your app dashboard, find Facebook Login and click Set Up
2. Select Web
3. Enter your Render URL as the Site URL
4. Click Save

### Step 3 - Set redirect URI

1. Go to Facebook Login then Settings in the left sidebar
2. Under Valid OAuth Redirect URIs, add:

```
https://mudi.onrender.com/auth/facebook/callback
```

3. Click Save Changes

### Step 4 - Fill in required fields and go Live

1. Go to App Settings then Basic
2. Fill in:
   - App Domains: mudi.onrender.com (without https)
   - Privacy Policy URL: https://mudi.onrender.com/privacy
   - Terms of Service URL: https://mudi.onrender.com/terms
3. Save Changes
4. Copy the App ID and App Secret
5. At the top of the page, toggle the app from In development to Live

The Live toggle is required. Without it, only you as the developer can log in.

### Step 5 - Add to Render

```
FACEBOOK_APP_ID     = 1234567890
FACEBOOK_APP_SECRET = abcdef1234
```

---

## 9. Features guide

### Room chat

Every room has a live chat panel. While in the room or player screen,
tap the speech bubble button in the top bar or the floating chat button.

- Messages are delivered instantly over the same Socket.IO connection used for sync
- The host's messages are tagged with a HOST label
- Unread message count shows on the floating button
- Each message earns 1 point toward the leaderboard

### Display names

When joining a room, enter your display name in the Name field. It is shown
to the host and other listeners. The name is saved to your browser so you
only need to enter it once across sessions.

### Permanent rooms

Tap My Rooms on the home screen to create a permanent room. Unlike regular
rooms which disappear when the host leaves, permanent rooms have a fixed code
stored in the database and a shareable link.

To create a permanent room:
1. Tap My Rooms on the home screen
2. Tap the + New button
3. Enter a room name
4. Copy the generated link to share

Share link format: https://your-app.onrender.com/join/ABC-123

The My Rooms screen shows a green dot next to rooms that are currently live
so members can see before joining whether the host is active.

### Reactions

During playback, tap the React button to open the emoji reaction bar.
Tap any emoji to send it. It floats up on screen for everyone in the room.
Each reaction earns 1 point toward the leaderboard.

Available reactions: heart, fire, surprised face, laughing, clapping hands,
music note, 100, raised hands.

### Seek requests

Listeners can ask the host to jump to a specific position in the track.
This is useful when a listener joins late or wants to replay a section.

How it works:
- Listener long-presses or taps a position on the seek bar then confirms
- Host sees a notification bar at the top with Allow and Deny buttons
- If approved, all listeners jump to that position together
- If denied, nothing changes

### Waveform visualiser

A live frequency spectrum animates under the track title during playback.
It uses the Web Audio API AnalyserNode connected to the audio pipeline.
It appears automatically when playback starts and disappears when stopped.

### Lock screen controls (Media Session API)

While playing, the track name and room name appear on the iOS and Android
lock screen. The host can play, pause, and seek directly from the lock screen
without opening the browser.

This works automatically on iOS Safari 15+, Chrome on Android, and most
modern mobile browsers that support the Media Session API.

### Share links

Every room has a direct join link. Tap Share on the host screen to share it.

Format: https://your-app.onrender.com/join/ABC-123

Anyone with the link lands directly on the join screen with the code pre-filled.

---

## 10. Gamification and scoring

MuDi awards points for activity in rooms. Points accumulate across all
sessions and are stored permanently in the database per user account.

### Point values

| Activity | Points |
|----------|--------|
| Sending a chat message | 1 point |
| Sending a reaction | 1 point |
| Completing a session as host | 5 points |

### Leaderboard

The leaderboard shows scores for all users who have participated in the
current room. To view it, open the chat panel and tap Scores.

The leaderboard refreshes each time you open it and also updates in real time
when other users earn points during the session.

### Score breakdown

Each entry shows the total points and a breakdown by category:
chat points, reaction points, and session points.

---

## 11. Analytics

The Analytics screen shows statistics for rooms you have hosted.
Tap Analytics on the home screen to open it.

### What is tracked

| Stat | Description |
|------|-------------|
| Total sessions | Number of times you have hosted a room |
| Peak listeners | Highest number of simultaneous listeners across all sessions |
| Total data shared | Sum of all file sizes transferred |
| Recent sessions | Last 10 sessions with file name, date, listener count, and duration |

### Privacy

Analytics data is stored locally in your MuDi database. It is not sent to
any third-party service. If you delete your account, the analytics data
is removed with it.

---

## 12. PWA - install as an app

MuDi is a Progressive Web App. You can install it to your home screen so
it behaves like a native app with its own icon, no browser chrome, and
faster loading.

### Install on iOS (Safari)

1. Open your MuDi URL in Safari
2. Tap the Share button at the bottom of the screen
3. Scroll down and tap Add to Home Screen
4. Tap Add

### Install on Android (Chrome)

1. Open your MuDi URL in Chrome
2. Tap the three-dot menu at the top right
3. Tap Install App or Add to Home Screen
4. Tap Install

### Install on desktop (Chrome or Edge)

1. Open your MuDi URL
2. Look for the install icon in the address bar (a square with a plus sign)
3. Click it and click Install

### What the PWA includes

- Offline fallback page when there is no connection
- Home screen icon
- Full-screen mode with no browser address bar
- Lock screen audio controls (via Media Session API)
- Faster loading on repeat visits via service worker caching

---

## 13. Troubleshooting

### Login and auth issues

**Login screen not showing - app loads directly into the room screen**

Make sure express.static in server.js has the option index set to false.
This forces all requests to go through requireAuth before serving index.html.

**Registration and login do nothing when the button is pressed**

Check all three of these in Render environment variables:
SESSION_SECRET must be set, BASE_URL must match your actual URL exactly
with no trailing slash, and NODE_ENV must be set to production.

**Google - redirect_uri_mismatch error**

The redirect URI in Google Cloud Console must be exactly:
https://mudi.onrender.com/auth/google/callback

**Google - error saying only test users can sign in**

The app is still in Testing mode. Add more test users in the OAuth consent
screen test users list, or click Publish App to open it to everyone.

**Facebook - button does nothing or shows an error**

The app is in Development mode. Switch it to Live in the Meta app dashboard.
This is a required step for anyone other than you to log in with Facebook.

### File transfer issues

**File transfer is slow with no CDN label on the progress bar**

Cloudflare R2 is not configured. Set it up following Section 5.
Without R2, transfers route through the Render server which is throttled.

**R2 upload fails immediately with a CORS error**

The AllowedOrigins value in the R2 CORS policy does not match your app URL.
It must include https:// and must not have a trailing slash.
Example: https://mudi.onrender.com (not http:// and not https://mudi.onrender.com/)

**R2 returns a 403 error during upload**

Check that the API token has Object Read and Write permissions and is
scoped to the correct bucket name.

**File transfer stuck at 0% on the listener side**

The host may have disconnected during transfer. When the host reconnects,
the file is automatically resent. If the progress bar stays stuck,
ask the host to re-select the file.

### Room and connection issues

**Room has expired error when rejoining**

The host was disconnected for more than 5 minutes. The room is automatically
deleted after that timeout. Create a new room or use Permanent Rooms so
the code persists across sessions.

**Host slot already taken error when reconnecting**

This was a known race condition and is fixed. The server now checks whether
the old socket is genuinely still connected before rejecting a rejoin.
If it still occurs, wait 10 seconds and try again.

**Listeners show as generic names instead of display names**

Listeners need to enter their name in the Name field on the join screen.
Names entered on one device are saved to localStorage on that device only.

### Feature-specific issues

**Leaderboard shows no scores**

Scores are only recorded for logged-in users with an account. Guest sessions
do not accumulate points. Make sure all participants are logged in.

**Chat messages not appearing**

Both devices need to be on the same room code. If the room was just created,
try sending a message from the host first to confirm the connection.

**Reactions not floating on screen**

Reactions only show during playback. If the player has not started, reactions
are still sent and recorded but the float animation only triggers on the player screen.

**Media Session controls not appearing on lock screen**

Media Session API requires HTTPS and is not supported on all browsers.
It works on Safari iOS 15+, Chrome Android, and most desktop browsers.
It does not work in Firefox on iOS.

**PWA install option not showing**

The app must be served over HTTPS for PWA installation to be available.
It will not appear on http://localhost. Deploy to Render and use the HTTPS URL.

**Analytics showing no data**

Analytics records sessions that the logged-in user has hosted. Listener
sessions are not currently tracked in analytics. At least one sync play
session must be completed for data to appear.

**App sleeping on Render**

Set up UptimeRobot following Section 3 Step 3 to ping the app every 5 minutes.

---

## 14. Project structure

```
mudi/
  server.js           Main server - rooms, auth, WebRTC, file transfer, chat, analytics
  auth.js             Passport.js strategies (local, Google, Facebook)
  db.js               SQLite via sql.js (WebAssembly, no build tools needed)
                      Tables: users, permanent_rooms, room_members, room_analytics, user_scores
  package.json
  Dockerfile
  .gitignore
  .env.example        Copy to .env for local development
  public/
    index.html        Main app - all screens in one file
    login.html        Auth page (sign in, register, Google, Facebook)
    sw.js             Service worker for PWA offline support
    icon-192.png      PWA home screen icon
    icon-512.png      PWA splash screen icon
    privacy.html      Privacy Policy (required for Facebook app Live mode)
    terms.html        Terms and Conditions (required for Facebook app Live mode)
```

### Database tables

| Table | Purpose |
|-------|---------|
| users | User accounts (email, OAuth provider, password hash) |
| permanent_rooms | Fixed rooms with persistent codes and member lists |
| room_members | Many-to-many: users that belong to permanent rooms |
| room_analytics | One row per session: file name, listener count, duration |
| user_scores | Cumulative gamification points per user |

### Key API routes

| Route | Description |
|-------|-------------|
| GET / | Main app (requires auth) |
| GET /login | Login and register page |
| GET /join/:code | Redirect to app with room code pre-filled |
| POST /auth/register | Create account |
| POST /auth/login | Sign in |
| GET /auth/google | Google OAuth flow |
| GET /auth/facebook | Facebook OAuth flow |
| GET /api/my-rooms | Permanent rooms for current user |
| POST /api/permanent-room | Create a permanent room |
| GET /api/analytics | Session analytics for current user |
| POST /transfer/r2/presign | Get R2 presigned upload URL |
| POST /transfer/r2/confirm/:token | Notify listeners that upload is complete |
| POST /transfer/init | Start server-streamed transfer (R2 fallback) |
| POST /transfer/upload/:token | Stream file to server |
| GET /transfer/stream/:token | Stream file to listener |
| GET /manifest.json | PWA manifest |
| GET /config | ICE server configuration for WebRTC |

---

MuDi - making the distance vanish, one song at a time.
