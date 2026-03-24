#!/usr/bin/env node
/**
 * Mu Digital — Automated Data Collector
 * Pulls: PostHog (DAU/WAU/retention/growth), Monad RPC (token supply),
 *        ETH Mainnet RPC (token supply), Monadscan (whale holders)
 * Outputs: ../data/dashboard-data.json
 *
 * Usage: node collect.js
 * Env vars (set in GitHub Actions secrets or .env):
 *   POSTHOG_PERSONAL_API_KEY  — from PostHog Settings → Profile → Personal API keys
 *   POSTHOG_PROJECT_ID        — from PostHog URL: us.posthog.com/project/XXXXX
 *   POSTHOG_HOST              — default: https://us.posthog.com
 *   ALCHEMY_MONAD_URL         — https://monad-testnet.g.alchemy.com/v2/YOUR_KEY
 *   ALCHEMY_ETH_URL           — https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
 *   MONADSCAN_API_KEY         — from monadscan.com/apis
 *   ETHERSCAN_API_KEY         — from etherscan.io/apis (for ETH holder data)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const CONFIG = {
  posthog: {
    host: process.env.POSTHOG_HOST || 'https://us.posthog.com',
    personalApiKey: process.env.POSTHOG_PERSONAL_API_KEY || '',
    projectId: process.env.POSTHOG_PROJECT_ID || '',
  },
  monad: {
    rpc: process.env.ALCHEMY_MONAD_URL || 'https://testnet-rpc.monad.xyz',
    explorerApi: 'https://api.monadscan.com/api',
    explorerApiKey: process.env.MONADSCAN_API_KEY || '',
    contracts: {
      AZND:        { addr: '0x4917a5ec9fcb5e10f47cbb197abe6ab63be81fe8', type: 'core',  desc: 'Asia Dollar' },
      MUBOND:      { addr: '0x336d414754967c6682b5a665c7daf6f1409e63e8', type: 'core',  desc: 'mu Bond' },
      LOAZND:      { addr: '0x9c82eb49b51f7dc61e22ff347931ca32adc6cd90', type: 'core',  desc: 'Locked AZND' },
      CLOAZND:     { addr: '0xf7a6ab4af86966c141d3c5633df658e5cdb0a735', type: 'lp',    desc: 'Compounding loAZND' },
      CMUBOND:     { addr: '0x92ee4b4d33dc61bd93a88601f29131b08acedbf1', type: 'lp',    desc: 'Compounding muBOND' },
      NLOAZND:     { addr: '0x293e2f01a38fe690eb8e570ab952b24b225113a7', type: 'lp',    desc: 'Native loAZND' },
      MTUSD:       { addr: '0x0da39b740834090c146dc48357f6a435a1bb33b3', type: 'lp',    desc: 'mtUSD' },
      AZNDAUSD:    { addr: '0x2d84d79c852f6842abe0304b70bbaa1506add457', type: 'lp',    desc: 'AZND/AUSD LP' },
      MUBONDAUSD:  { addr: '0x1e8d78e9b3f0152d54d32904b7933f1cfe439df1', type: 'lp',    desc: 'muBOND/AUSD LP' },
      LOAZNDAZND:  { addr: '0x269b47978f4348c96f521658ef452ff85906fcfe', type: 'lp',    desc: 'loAZND/AZND LP' },
      SBMU:        { addr: '0x4c0d041889281531ff060290d71091401caa786d', type: 'lp',    desc: 'sbMU' },
    },
  },
  eth: {
    rpc: process.env.ALCHEMY_ETH_URL || '',
    explorerApi: 'https://api.etherscan.io/api',
    explorerApiKey: process.env.ETHERSCAN_API_KEY || '',
    contracts: {
      AZND:   { addr: '0x52c66B5E7f8Fde20843De900C5C8B4b0F23708A0', type: 'core', desc: 'Asia Dollar (OFT)' },
      MUBOND: { addr: '0x09AD9c6DcadCc3aB0b3E107E8E7DA69c2eEa8599', type: 'core', desc: 'mu Bond (OFT)' },
      LOAZND: { addr: '0xa6142276526724CFaEe9151d280385BdF43e0503', type: 'core', desc: 'Locked AZND' },
      // Integration contracts — add when confirmed:
      // EXAMPLE: { addr: '0x...', type: 'lp', desc: 'AZND/USDC LP' },
    },
  },
  outputPath: path.join(__dirname, '../data/dashboard-data.json'),
  historyPath: path.join(__dirname, '../data/history.json'),
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function warn(msg) {
  console.warn(`[${new Date().toISOString()}] ⚠️  ${msg}`);
}

// ─── RPC CALL ─────────────────────────────────────────────────────────────────

async function rpcCall(rpcUrl, method, params = []) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${data.error.message}`);
  return data.result;
}

async function getTokenSupply(rpcUrl, address) {
  try {
    const [supplyHex, decimalsHex] = await Promise.all([
      rpcCall(rpcUrl, 'eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']),
      rpcCall(rpcUrl, 'eth_call', [{ to: address, data: '0x313ce567' }, 'latest']),
    ]);
    const decimals = parseInt(decimalsHex, 16) || 18;
    const raw = BigInt(supplyHex);
    const divisor = BigInt(10 ** Math.min(decimals, 18));
    return Number(raw / divisor);
  } catch (e) {
    warn(`getTokenSupply failed for ${address}: ${e.message}`);
    return null;
  }
}

// ─── ON-CHAIN: TOKEN SUPPLIES ─────────────────────────────────────────────────

async function collectChainSupplies(chainKey) {
  const chain = CONFIG[chainKey];
  if (!chain.rpc) {
    warn(`No RPC URL for ${chainKey} — skipping`);
    return {};
  }

  log(`Fetching ${chainKey} token supplies (${Object.keys(chain.contracts).length} contracts)…`);
  const results = {};

  await Promise.all(
    Object.entries(chain.contracts).map(async ([sym, c]) => {
      const supply = await getTokenSupply(chain.rpc, c.addr);
      results[sym] = {
        address: c.addr,
        type: c.type,
        desc: c.desc,
        supply,
        fetchedAt: new Date().toISOString(),
      };
      log(`  ${chainKey}/${sym}: ${supply !== null ? supply.toLocaleString() : 'error'}`);
    })
  );

  return results;
}

// ─── ON-CHAIN: WHALE HOLDERS ──────────────────────────────────────────────────

async function collectWhales(chainKey) {
  const chain = CONFIG[chainKey];
  const azndAddr = chain.contracts.AZND?.addr;
  if (!azndAddr) return [];

  const apiKey = chainKey === 'monad' ? chain.explorerApiKey : chain.explorerApiKey;
  const apiBase = chainKey === 'monad' ? chain.explorerApi : chain.explorerApi;

  log(`Fetching ${chainKey} whale holders (AZND top 20)…`);
  try {
    const url = `${apiBase}?module=token&action=tokenholderlist&contractaddress=${azndAddr}&page=1&offset=20${apiKey ? `&apikey=${apiKey}` : ''}`;
    const data = await fetchJson(url);
    if (data.status !== '1' || !Array.isArray(data.result)) {
      warn(`Whale fetch returned status ${data.status}: ${data.message}`);
      return [];
    }
    return data.result.map((h, i) => ({
      rank: i + 1,
      address: h.TokenHolderAddress,
      azndBalance: Number(BigInt(h.TokenHolderQuantity || 0) / BigInt(10 ** 18)),
    }));
  } catch (e) {
    warn(`collectWhales(${chainKey}) failed: ${e.message}`);
    return [];
  }
}

// ─── POSTHOG: QUERY API ───────────────────────────────────────────────────────

async function posthogQuery(hogql) {
  const { host, personalApiKey, projectId } = CONFIG.posthog;
  if (!personalApiKey || !projectId) {
    warn('PostHog credentials not set — skipping PostHog queries');
    return null;
  }

  const url = `${host}/api/projects/${projectId}/query/`;
  const body = JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } });

  try {
    const data = await fetchJson(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${personalApiKey}`,
      },
      body,
    });
    return data.results || data;
  } catch (e) {
    warn(`PostHog query failed: ${e.message}`);
    return null;
  }
}

async function collectPosthog() {
  log('Fetching PostHog metrics…');
  const now = new Date();
  const results = {};

  // DAU — last 30 days
  const dauQuery = `
    SELECT toDate(timestamp) as day, count(distinct person_id) as dau
    FROM events
    WHERE timestamp >= now() - interval 30 day
    GROUP BY day
    ORDER BY day DESC
    LIMIT 30
  `;
  const dauRows = await posthogQuery(dauQuery);
  if (dauRows) {
    results.dau = dauRows.map(r => ({ date: r[0], value: r[1] }));
    results.dauLatest = dauRows[0]?.[1] ?? null;
    log(`  DAU latest: ${results.dauLatest}`);
  }

  // WAU — last 12 weeks
  const wauQuery = `
    SELECT toMonday(timestamp) as week, count(distinct person_id) as wau
    FROM events
    WHERE timestamp >= now() - interval 84 day
    GROUP BY week
    ORDER BY week DESC
    LIMIT 12
  `;
  const wauRows = await posthogQuery(wauQuery);
  if (wauRows) {
    results.wau = wauRows.map(r => ({ week: r[0], value: r[1] }));
    results.wauLatest = wauRows[0]?.[1] ?? null;
    log(`  WAU latest: ${results.wauLatest}`);
  }

  // Growth accounting — new / returning / resurrecting / dormant
  const growthQuery = `
    SELECT
      toMonday(timestamp) as week,
      count(distinct person_id) as total_users
    FROM events
    WHERE timestamp >= now() - interval 42 day
    GROUP BY week
    ORDER BY week DESC
    LIMIT 6
  `;
  const growthRows = await posthogQuery(growthQuery);
  if (growthRows) {
    results.weeklyUsers = growthRows.map(r => ({ week: r[0], value: r[1] }));
  }

  // Retention — weekly cohorts
  // PostHog retention is better queried via the insights API, 
  // but we can approximate with HogQL here
  const retentionQuery = `
    SELECT
      toMonday(first_seen) as cohort_week,
      count(distinct person_id) as cohort_size
    FROM (
      SELECT person_id, min(timestamp) as first_seen
      FROM events
      WHERE timestamp >= now() - interval 42 day
      GROUP BY person_id
    )
    GROUP BY cohort_week
    ORDER BY cohort_week DESC
    LIMIT 6
  `;
  const retRows = await posthogQuery(retentionQuery);
  if (retRows) {
    results.retentionCohorts = retRows.map(r => ({ week: r[0], cohortSize: r[1] }));
    log(`  Retention cohorts: ${retRows.length} weeks`);
  }

  // Referring domains — last 14 days
  const refQuery = `
    SELECT
      properties.$referring_domain as domain,
      count(distinct person_id) as users
    FROM events
    WHERE timestamp >= now() - interval 14 day
      AND properties.$referring_domain IS NOT NULL
      AND properties.$referring_domain != ''
    GROUP BY domain
    ORDER BY users DESC
    LIMIT 15
  `;
  const refRows = await posthogQuery(refQuery);
  if (refRows) {
    results.referringDomains = refRows.map(r => ({ domain: r[0] || '$direct', users: r[1] }));
  }

  // Earn → Swap → Lock funnel
  // NOTE: these events need to be instrumented in your app first.
  // Current status: earn_start / swap_initiated / lock_completed not yet firing.
  // Once instrumented, this query will return real data.
  const funnelQuery = `
    SELECT
      countIf(event = 'earn_start')       as earn_start,
      countIf(event = 'swap_initiated')   as swap_initiated,
      countIf(event = 'lock_completed')   as lock_completed,
      count(distinct if(event = 'earn_start', person_id, null))      as earn_users,
      count(distinct if(event = 'swap_initiated', person_id, null))  as swap_users,
      count(distinct if(event = 'lock_completed', person_id, null))  as lock_users
    FROM events
    WHERE timestamp >= now() - interval 7 day
  `;
  const funnelRows = await posthogQuery(funnelQuery);
  if (funnelRows?.[0]) {
    const [earnEvents, swapEvents, lockEvents, earnUsers, swapUsers, lockUsers] = funnelRows[0];
    results.funnel = {
      last7Days: {
        earnStart:      { events: earnEvents,  users: earnUsers },
        swapInitiated:  { events: swapEvents,  users: swapUsers },
        lockCompleted:  { events: lockEvents,  users: lockUsers },
        earnToSwapPct:  earnUsers > 0 ? +(swapUsers / earnUsers * 100).toFixed(1) : null,
        swapToLockPct:  swapUsers > 0 ? +(lockUsers / swapUsers * 100).toFixed(1) : null,
        earnToLockPct:  earnUsers > 0 ? +(lockUsers / earnUsers * 100).toFixed(1) : null,
        instrumented:   earnEvents > 0,
      }
    };
    log(`  Funnel earn→lock: ${results.funnel.last7Days.instrumented ? 'instrumented' : 'NOT YET INSTRUMENTED'}`);
  }

  // Pageview funnel (existing — 3 pageviews)
  const pvFunnelQuery = `
    SELECT
      count(distinct person_id) as step1,
      count(distinct if(pageview_count >= 2, person_id, null)) as step2,
      count(distinct if(pageview_count >= 3, person_id, null)) as step3
    FROM (
      SELECT person_id, count() as pageview_count
      FROM events
      WHERE event = '$pageview'
        AND timestamp >= now() - interval 7 day
      GROUP BY person_id
    )
  `;
  const pvRows = await posthogQuery(pvFunnelQuery);
  if (pvRows?.[0]) {
    const [s1, s2, s3] = pvRows[0];
    results.pageviewFunnel = {
      step1: s1, step2: s2, step3: s3,
      step1to2Pct: s1 > 0 ? +(s2/s1*100).toFixed(1) : null,
      step2to3Pct: s2 > 0 ? +(s3/s2*100).toFixed(1) : null,
    };
  }

  results.fetchedAt = now.toISOString();
  return results;
}

// ─── HISTORY ──────────────────────────────────────────────────────────────────

function loadHistory() {
  try {
    if (fs.existsSync(CONFIG.historyPath)) {
      return JSON.parse(fs.readFileSync(CONFIG.historyPath, 'utf8'));
    }
  } catch {}
  return { snapshots: [] };
}

function appendHistory(history, snapshot) {
  // Keep last 90 daily snapshots for trending
  history.snapshots.unshift({
    date: snapshot.collectedAt.slice(0, 10),
    monadSupplies: Object.fromEntries(
      Object.entries(snapshot.onchain.monad).map(([k, v]) => [k, v.supply])
    ),
    ethSupplies: Object.fromEntries(
      Object.entries(snapshot.onchain.eth).map(([k, v]) => [k, v.supply])
    ),
    dauLatest: snapshot.posthog?.dauLatest,
    wauLatest: snapshot.posthog?.wauLatest,
  });
  history.snapshots = history.snapshots.slice(0, 90);
  return history;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  log('═══ Mu Digital Data Collector starting ═══');

  const [monadSupplies, ethSupplies, monadWhales, ethWhales, posthog] = await Promise.allSettled([
    collectChainSupplies('monad'),
    collectChainSupplies('eth'),
    collectWhales('monad'),
    collectWhales('eth'),
    collectPosthog(),
  ]);

  const snapshot = {
    collectedAt: new Date().toISOString(),
    onchain: {
      monad: monadSupplies.status === 'fulfilled' ? monadSupplies.value : {},
      eth:   ethSupplies.status  === 'fulfilled' ? ethSupplies.value  : {},
    },
    whales: {
      monad: monadWhales.status === 'fulfilled' ? monadWhales.value : [],
      eth:   ethWhales.status   === 'fulfilled' ? ethWhales.value   : [],
    },
    posthog: posthog.status === 'fulfilled' ? posthog.value : null,
    meta: {
      version: '2.0',
      chains: {
        monad: { name: 'Monad Testnet', chainId: 10143, active: true },
        eth:   { name: 'Ethereum Mainnet', chainId: 1,     active: !!CONFIG.eth.rpc },
      },
    },
  };

  // Load and update history
  const history = loadHistory();
  appendHistory(history, snapshot);

  // Add WoW deltas from history
  if (history.snapshots.length >= 2) {
    const prev = history.snapshots[1];
    snapshot.deltas = {
      monadAZND: prev.monadSupplies?.AZND && snapshot.onchain.monad.AZND?.supply
        ? snapshot.onchain.monad.AZND.supply - prev.monadSupplies.AZND
        : null,
      wau: prev.wauLatest && snapshot.posthog?.wauLatest
        ? snapshot.posthog.wauLatest - prev.wauLatest
        : null,
    };
  }

  // Write files
  const outDir = path.dirname(CONFIG.outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(CONFIG.outputPath, JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(CONFIG.historyPath, JSON.stringify(history, null, 2));

  log(`✓ Wrote snapshot to ${CONFIG.outputPath}`);
  log(`✓ History now has ${history.snapshots.length} snapshots`);
  log('═══ Collection complete ═══');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
