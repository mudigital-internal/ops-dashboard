# Mu Digital Ops Dashboard — Automated Data Pipeline

## Architecture

```
GitHub Actions (every hour)
  └── collector/collect.js
        ├── Monad RPC → token supplies (11 contracts)
        ├── ETH Mainnet RPC → token supplies (3 contracts, + integrations TBA)
        ├── Monadscan API → top AZND holders (whale tracker)
        ├── Etherscan API → top AZND holders on ETH
        └── PostHog Query API → DAU, WAU, retention, growth, funnel
              │
              ▼
        data/dashboard-data.json  ←── committed back to repo
        data/history.json         ←── rolling 90-day snapshot log

Dashboard (index.html)
  └── fetches data/dashboard-data.json on load + every 5 min
```

## Setup (one-time, ~15 minutes)

### 1. Create the GitHub repo

```bash
git init mu-digital-dashboard
cd mu-digital-dashboard
# copy all files from this package into the repo
git add .
git commit -m "initial dashboard setup"
git remote add origin https://github.com/YOUR_ORG/mu-digital-dashboard
git push -u origin main
```

### 2. Enable GitHub Pages

GitHub → repo → Settings → Pages → Source: "Deploy from branch" → branch: `main` → folder: `/ (root)`

Your dashboard will be live at `https://YOUR_ORG.github.io/mu-digital-dashboard/`

### 3. Add GitHub Secrets

GitHub → repo → Settings → Secrets and variables → Actions → New repository secret

| Secret name | Where to get it |
|---|---|
| `POSTHOG_PERSONAL_API_KEY` | PostHog → Settings → Profile → Personal API keys → Create |
| `POSTHOG_PROJECT_ID` | PostHog URL: `us.posthog.com/project/XXXXX` — the number |
| `ALCHEMY_MONAD_URL` | Alchemy → Create App → Monad Testnet → HTTPS URL |
| `ALCHEMY_ETH_URL` | Alchemy → Create App → Ethereum Mainnet → HTTPS URL |
| `MONADSCAN_API_KEY` | monadscan.com → API → Get API Key (free) |
| `ETHERSCAN_API_KEY` | etherscan.io → API Keys → Add (free tier: 5 req/sec) |

### 4. Trigger the first run

GitHub → repo → Actions → "Collect Dashboard Data" → Run workflow

Check the run logs — you'll see each data source succeed or warn.
The `data/dashboard-data.json` file will appear in your repo after the first run.

### 5. Verify the dashboard

Open your GitHub Pages URL or open `index.html` locally.
The dashboard auto-fetches `data/dashboard-data.json` and renders live.

---

## Adding ETH integration contracts

When you have the integration contract addresses, add them to `collector/collect.js`
under `CONFIG.eth.contracts`:

```js
eth: {
  contracts: {
    AZND:   { addr: '0x52c66...', type: 'core', desc: 'Asia Dollar (OFT)' },
    MUBOND: { addr: '0x09AD9...', type: 'core', desc: 'mu Bond (OFT)' },
    LOAZND: { addr: '0xa6142...', type: 'core', desc: 'Locked AZND' },
    // Add here:
    AZNDUSDC: { addr: '0xNEW...', type: 'lp', desc: 'AZND/USDC LP' },
  }
}
```

Commit and push — the next hourly run picks it up automatically.

---

## Adding Earn → Swap → Lock funnel events

Ask engineering to fire these PostHog events in the app:

```js
// When user lands on the Earn page / initiates earning
posthog.capture('earn_start', { wallet_address: account })

// When user submits a swap
posthog.capture('swap_initiated', { wallet_address: account, amount_usd: amount })

// When lock transaction is confirmed on-chain
posthog.capture('lock_completed', { wallet_address: account, amount_usd: amount, lock_duration_days: days })
```

Once these fire, the Funnel tab in the dashboard will show real conversion rates
instead of the "not instrumented" placeholder.

---

## Run locally

```bash
cd collector
cp .env.example .env    # fill in your keys
node collect.js         # outputs data/dashboard-data.json
open ../index.html      # open dashboard in browser
```

## Schedule

The GitHub Action runs **every hour** (`0 * * * *`).
To change frequency, edit `.github/workflows/collect.yml`:

```yaml
- cron: '0 * * * *'     # every hour
- cron: '*/30 * * * *'  # every 30 min
- cron: '0 9 * * 1'     # every Monday at 9am UTC
```
