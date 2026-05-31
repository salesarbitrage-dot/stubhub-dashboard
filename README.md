# StubHub Sales Dashboard — Netlify Deployment

A live sales dashboard that auto-refreshes every 5 hours from your Gmail "Sold StubHub Tickets" label, with processor assignments and CSV export.

## Project structure

```
stubhub-dashboard/
├── index.html                        ← The dashboard (your frontend)
├── netlify.toml                      ← Netlify config
├── netlify/
│   └── functions/
│       └── refresh-sales.js          ← Serverless function (hides your API key)
└── README.md
```

## Deploy in 5 steps

### 1. Get an Anthropic API key
- Go to https://console.anthropic.com
- Create an account (or sign in)
- Navigate to **API Keys** → **Create Key**
- Copy the key (starts with `sk-ant-…`) — you only see it once

### 2. Push to GitHub
```bash
cd stubhub-dashboard
git init
git add .
git commit -m "Initial dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/stubhub-dashboard.git
git push -u origin main
```

### 3. Connect to Netlify
- Go to https://app.netlify.com → **Add new site** → **Import an existing project**
- Choose **GitHub** and select your `stubhub-dashboard` repo
- Build settings will auto-detect from `netlify.toml` — leave them as-is
- Click **Deploy site**

### 4. Add your API key as an environment variable
- In your Netlify site dashboard: **Site configuration** → **Environment variables**
- Click **Add a variable**
- Key: `ANTHROPIC_API_KEY`
- Value: your `sk-ant-…` key
- Click **Save**
- Go to **Deploys** → **Trigger deploy** → **Deploy site** to apply the new variable

### 5. Visit your live URL
Netlify gives you a URL like `https://amazing-name-123456.netlify.app`

You can rename it under **Site configuration** → **Site details** → **Change site name**.

## How it works

```
Browser → /.netlify/functions/refresh-sales → Anthropic API
                         ↑
              Your API key lives here,
              never exposed to the browser
```

The serverless function (`netlify/functions/refresh-sales.js`) acts as a secure proxy:
- The browser never sees your API key
- The function reads `process.env.ANTHROPIC_API_KEY` server-side
- Refreshes pull the latest sales data and re-assign processors

## Auto-refresh schedule

The dashboard auto-refreshes every **5 hours** while the browser tab is open.
You can also click **Refresh** manually at any time.

## Customising processor assignment rules

Edit the `system` prompt in `netlify/functions/refresh-sales.js`:

```
Kassandra = World Cup matches
Tochukwu  = Sports (MLB / NHL / MLS / NCAA / NFL)
Joshua    = Multi-day festivals
Lydia     = All other concerts and single-day shows
```

Change these rules to match your team's preferences, then redeploy.
