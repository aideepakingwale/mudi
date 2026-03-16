# MuDi — The Digital Aux Cord 🎵

> Sub-15ms synchronised audio playback · WebRTC P2P · Up to 10 listeners · Email + Google + Facebook auth

---

## What it does

MuDi lets one **host** share a local audio file with up to **10 listeners** and have everyone hear it at exactly the same millisecond — no cloud storage, fully encrypted peer-to-peer.

| Feature | Detail |
|---------|--------|
| Sync accuracy | < 15 ms across all devices |
| File transfer | WebRTC DataChannel — server never sees your audio |
| File integrity | SHA-256 verified on every listener before playback |
| Authentication | Email/password · Google OAuth · Facebook OAuth |
| Database | SQLite (no external database needed) |
| Deployment | Docker — runs on Render, ngrok, any Node 18+ server |

---

## Quick Start — Run Locally

```bash
# 1. Install dependencies
npm install

# 2. Create your config file
cp .env.example .env

# 3. Edit .env — set SESSION_SECRET (required)
#    Generate one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Start the server
npm start

# 5. Open http://localhost:8080
```

### Test on a second device (phone / another laptop)

Find your local IP:

```powershell
# Windows
(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notmatch '^127'}).IPAddress
```

```bash
# macOS / Linux
ipconfig getifaddr en0
```

Then open `http://<YOUR-IP>:8080` on the second device.

> **Note:** Google/Facebook OAuth, SHA-256 file verification, and WebRTC all require **HTTPS**. They work on `localhost` without SSL — for real devices use the deployment options below.

---

## Deployment Options (Free, No Credit Card)

### Option A — Render + UptimeRobot (recommended — permanent public URL)

**Render** free tier: no credit card, automatic HTTPS, sleeps after 15 min idle.  
**UptimeRobot** free tier: pings your app every 5 minutes to keep it awake.

#### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
# Create a repo at github.com/new, then:
git remote add origin https://github.com/YOURUSERNAME/mudi.git
git branch -M main
git push -u origin main
```

#### Step 2 — Deploy on Render

1. Go to [render.com](https://render.com) → Sign up with GitHub
2. **New** → **Web Service** → connect your `mudi` repo
3. Settings:

| Field | Value |
|-------|-------|
| Name | `mudi` |
| Runtime | **Docker** |
| Instance Type | **Free** |

4. **Environment Variables** — click **Add** for each:

| Key | Value |
|-----|-------|
| `NODE_ENV` | `production` |
| `SESSION_SECRET` | *(generate — see above)* |
| `BASE_URL` | `https://mudi.onrender.com` *(update after first deploy)* |

5. Click **Deploy Web Service**
6. Once deployed, copy your URL from Render, update `BASE_URL` → **Manual Deploy**

#### Step 3 — Keep awake with UptimeRobot

1. Go to [uptimerobot.com](https://uptimerobot.com) → Register free
2. **Add New Monitor**:
   - Type: **HTTP(s)**
   - Friendly Name: `MuDi`
   - URL: `https://mudi.onrender.com`
   - Interval: **Every 5 minutes**
3. **Create Monitor** — done ✓

---

### Option B — ngrok (instant demo in 5 minutes, no server needed)

Runs on your machine, gives a public HTTPS URL anyone can access.

```powershell
# Install ngrok
winget install ngrok

# Add your auth token (get it from dashboard.ngrok.com after free signup)
ngrok config add-authtoken YOUR_TOKEN

# Start MuDi
npm start

# In a second terminal — expose it
ngrok http 8080
```

Copy the `https://xxxx.ngrok-free.app` URL. Update your `.env`:

```env
BASE_URL=https://xxxx.ngrok-free.app
```

Restart `npm start`. Share the URL — it works worldwide.

> The URL changes each time you restart ngrok on the free plan. Fine for demos.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default `8080`) |
| `BASE_URL` | **Yes** | Full public URL, no trailing slash |
| `SESSION_SECRET` | **Yes** | Random hex string for session cookies |
| `NODE_ENV` | Production | Set to `production` on any deployed server |
| `GOOGLE_CLIENT_ID` | OAuth | From Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth | From Google Cloud Console |
| `FACEBOOK_APP_ID` | OAuth | From Meta Developers |
| `FACEBOOK_APP_SECRET` | OAuth | From Meta Developers |

---

## Configure Google Sign-In

### 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Project dropdown → **New Project** → Name: `MuDi` → **Create**

### 2. Enable the People API

Left menu → **APIs & Services** → **Library** → search `Google People API` → **Enable**

### 3. Configure OAuth consent screen

1. **APIs & Services** → **OAuth consent screen**
2. User type: **External** → **Create**
3. App name: `MuDi` · Support & developer email: yours
4. Save through all screens
5. **Test Users** → add your own Google email (required while in Testing mode)

### 4. Create credentials

1. **Credentials** → **+ Create Credentials** → **OAuth 2.0 Client ID**
2. Type: **Web application**
3. **Authorised redirect URIs** → add:
   ```
   https://mudi.onrender.com/auth/google/callback
   ```
4. **Create** → copy **Client ID** and **Client Secret**

### 5. Add to Render

Render dashboard → your service → **Environment** → add:
```
GOOGLE_CLIENT_ID     = your-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET = GOCSPX-xxxx
```

Save → redeploy → Google button is active ✓

> **Anyone can sign in:** OAuth consent screen → **Publish App**. Until published, only test users you've added can use Google login.

---

## Configure Facebook Login

### 1. Create a Meta developer app

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App**
2. Use case: **Authenticate and request data from users**
3. Name: `MuDi` → **Create App**

### 2. Add Facebook Login product

Dashboard → **Facebook Login** → **Set Up** → **Web** → Site URL: your Render URL

### 3. Set redirect URI

**Facebook Login** → **Settings** → Valid OAuth Redirect URIs:
```
https://mudi.onrender.com/auth/facebook/callback
```
**Save Changes**

### 4. Get credentials + go Live

1. **App Settings** → **Basic**
2. Copy **App ID** and **App Secret**
3. Fill **App Domains**: `mudi.onrender.com`
4. **Privacy Policy URL**: `https://mudi.onrender.com/privacy`
5. **Terms of Service URL**: `https://mudi.onrender.com/terms`
6. **Save Changes**
7. Toggle at top: **In development** → **Live** ← required for anyone else to log in

### 5. Add to Render

```
FACEBOOK_APP_ID     = 1234567890
FACEBOOK_APP_SECRET = abcdef1234
```

Save → redeploy → Facebook button is active ✓

---

## Troubleshooting

**App starts directly without login screen**  
`server.js` must pass `{ index: false }` to `express.static`. This is already set — make sure you're running the latest code.

**Registration/login doesn't work after deploy**  
- Is `SESSION_SECRET` set in Render environment variables?
- Is `NODE_ENV` set to `production`?
- Is `BASE_URL` your actual Render URL (no trailing slash)?

**Google — "redirect_uri_mismatch"**  
The callback URI in Google Console must match exactly:
`https://mudi.onrender.com/auth/google/callback`

**Google — only you can sign in**  
App is in Testing mode. Add other users' Gmail addresses as Test Users, or Publish the app.

**Facebook — only developer account can sign in**  
App is in Development mode. Switch to **Live** in the Meta app dashboard.

**WebRTC stuck on "Connecting"**  
Both users are behind strict NAT. Add a free TURN relay from [metered.ca](https://www.metered.ca/tools/openrelay) to the `STUN_SERVERS` array in `public/index.html`.

**App sleeping on Render free tier**  
Set up UptimeRobot (see deployment guide above). It keeps the app awake with free 5-minute pings.

---

## Project Structure

```
mudi/
├── server.js           Main server — auth, rooms, WebRTC relay, sync
├── auth.js             Passport.js strategies (local, Google, Facebook)
├── db.js               SQLite wrapper using sql.js (pure WebAssembly)
├── package.json
├── Dockerfile          For Render / any Docker host
├── .gitignore          Excludes node_modules, .env, data/
├── .dockerignore
├── .env.example        Template — copy to .env
└── public/
    ├── index.html      Main app (room host / join / player)
    ├── login.html      Auth (sign in / register / Google / Facebook)
    ├── privacy.html    Privacy Policy
    └── terms.html      Terms & Conditions
```

---

## Render Free Tier Limits

| Resource | Allowance |
|----------|-----------|
| Web Services | 1 free |
| RAM | 512 MB |
| CPU | Shared |
| Bandwidth | 100 GB/month |
| Sleep | After 15 min idle (fix: UptimeRobot) |
| HTTPS | Automatic |
| Custom domain | Supported |

MuDi uses ~90 MB RAM at idle and ~220 MB with 10 active listeners.

---

*MuDi — making the distance vanish, one song at a time.*
