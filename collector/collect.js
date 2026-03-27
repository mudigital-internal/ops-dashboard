#!/usr/bin/env node
/**
 * Mu Digital — Automated Data Collector v3.0
 *
 * Data sources:
 *   1. app.mudigital.net internal API  — real TVL history, APY, yields (no key needed!)
 *   2. PostHog Query API               — DAU, WAU, retention, funnel, page views
 *   3. Monad RPC (Alchemy)             — token supplies for all 11 contracts
 *   4. ETH Mainnet RPC (Alchemy)       — ETH token supplies (3 core contracts)
 *   5. Monadscan / Etherscan API       — whale top holders
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  muApp: { base: 'https://app.mudigital.net', chainId: 143 },
  posthog: {
    host: process.env.POSTHOG_HOST || 'https://us.posthog.com',
    personalApiKey: process.env.POSTHOG_PERSONAL_API_KEY || '',
    projectId: process.env.POSTHOG_PROJECT_ID || '',
  },
  monad: {
    rpc: process.env.ALCHEMY_MONAD_URL || 'https://rpc.monad.xyz',
    explorerApi: 'https://api.monadscan.com/api',
    explorerApiKey: process.env.MONADSCAN_API_KEY || '',
    contracts: {
      AZND:       { addr: '0x4917a5ec9fcb5e10f47cbb197abe6ab63be81fe8', type: 'core', desc: 'Asia Dollar' },
      MUBOND:     { addr: '0x336d414754967c6682b5a665c7daf6f1409e63e8', type: 'core', desc: 'mu Bond' },
      LOAZND:     { addr: '0x9c82eb49b51f7dc61e22ff347931ca32adc6cd90', type: 'core', desc: 'Locked AZND' },
      CLOAZND:    { addr: '0xf7a6ab4af86966c141d3c5633df658e5cdb0a735', type: 'lp',   desc: 'Compounding loAZND' },
      CMUBOND:    { addr: '0x92ee4b4d33dc61bd93a88601f29131b08acedbf1', type: 'lp',   desc: 'Compounding muBOND' },
      NLOAZND:    { addr: '0x293e2f01a38fe690eb8e570ab952b24b225113a7', type: 'lp',   desc: 'Native loAZND' },
      MTUSD:      { addr: '0x0da39b740834090c146dc48357f6a435a1bb33b3', type: 'lp',   desc: 'mtUSD' },
      AZNDAUSD:   { addr: '0x2d84d79c852f6842abe0304b70bbaa1506add457', type: 'lp',   desc: 'AZND/AUSD LP' },
      MUBONDAUSD: { addr: '0x1e8d78e9b3f0152d54d32904b7933f1cfe439df1', type: 'lp',   desc: 'muBOND/AUSD LP' },
      LOAZNDAZND: { addr: '0x269b47978f4348c96f521658ef452ff85906fcfe', type: 'lp',   desc: 'loAZND/AZND LP' },
      SBMU:       { addr: '0x4c0d041889281531ff060290d71091401caa786d', type: 'lp',   desc: 'sbMU' },
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
    },
  },
  outputPath: path.join(__dirname, '../data/dashboard-data.json'),
  historyPath: path.join(__dirname, '../data/history.json'),
};

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'User-Agent': 'mu-ops-dashboard/3.0', ...options.headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function log(msg)  { console.log(`[${new Date().toISOString()}] ${msg}`); }
function warn(msg) { console.warn(`[${new Date().toISOString()}] WARN  ${msg}`); }
function fmt(n)    { return n != null ? Math.round(n * 100) / 100 : null; }

// ── MU APP INTERNAL API (no auth needed) ─────────────────────────────────────

async function collectMuAppData() {
  log('Fetching Mu Digital internal API…');
  const { base, chainId } = CONFIG.muApp;
  const result = {};

  try {
    const tvlData = await fetchJson(`${base}/api/v2/tvl/historical?chainId=all&period=All&type=tvl`);
    const rows = tvlData.data || [];
    if (rows.length >= 2) {
      const latest = rows[rows.length - 1];
      const prev7  = rows[Math.max(0, rows.length - 8)];
      const latestTvl = (latest.aznd_tvl || 0) + (latest.mubond_tvl || 0);
      const prev7Tvl  = (prev7.aznd_tvl  || 0) + (prev7.mubond_tvl  || 0);
      result.tvl = {
        current:     fmt(latestTvl),
        aznd:        fmt(latest.aznd_tvl),
        mubond:      fmt(latest.mubond_tvl),
        wowDeltaPct: prev7Tvl > 0 ? fmt((latestTvl - prev7Tvl) / prev7Tvl * 100) : null,
        wowDeltaAbs: fmt(latestTvl - prev7Tvl),
        history: rows.slice(-90).map(r => ({
          date:   r.timestamp.slice(0, 10),
          aznd:   fmt(r.aznd_tvl),
          mubond: fmt(r.mubond_tvl),
          total:  fmt((r.aznd_tvl || 0) + (r.mubond_tvl || 0)),
        })),
        fetchedAt: new Date().toISOString(),
      };
      log(`  TVL: $${(latestTvl/1e6).toFixed(2)}M  WoW: ${result.tvl.wowDeltaPct}%`);
    }
  } catch (e) { warn(`TVL history: ${e.message}`); }

  try {
    const [azndY, mubondY] = await Promise.all([
      fetchJson(`${base}/api/v2/chains/${chainId}/tokens/AZND/yields?period=24h`),
      fetchJson(`${base}/api/v2/chains/${chainId}/tokens/muBOND/yields?period=24h`),
    ]);
    result.apy = {
      aznd:      azndY.data?.[0]?.yield   ?? null,
      mubond:    mubondY.data?.[0]?.yield  ?? null,
      fetchedAt: new Date().toISOString(),
    };
    log(`  APY: AZND ${result.apy.aznd}%  muBOND ${result.apy.mubond}%`);
  } catch (e) { warn(`APY: ${e.message}`); }

  try {
    const loPrice = await fetchJson(`${base}/api/chains/${chainId}/tokens/loAZND/prices?period=All`);
    const prices = loPrice.data || loPrice;
    if (Array.isArray(prices) && prices.length) {
      const latest = prices[prices.length - 1];
      result.loAzndPrice = {
        current:   fmt(latest.price ?? latest.value ?? latest),
        history:   prices.slice(-30),
        fetchedAt: new Date().toISOString(),
      };
      log(`  loAZND price: ${result.loAzndPrice.current}`);
    }
  } catch (e) { warn(`loAZND price: ${e.message}`); }

  return result;
}

// ── RPC: TOKEN SUPPLIES ───────────────────────────────────────────────────────

async function rpcCall(rpcUrl, method, params = []) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await res.json();
  if (d.error) throw new Error(`RPC: ${d.error.message}`);
  return d.result;
}

async function getTokenSupply(rpcUrl, address) {
  try {
    const [sh, dh] = await Promise.all([
      rpcCall(rpcUrl, 'eth_call', [{ to: address, data: '0x18160ddd' }, 'latest']),
      rpcCall(rpcUrl, 'eth_call', [{ to: address, data: '0x313ce567' }, 'latest']),
    ]);
    const dec = parseInt(dh, 16) || 18;
    return Number(BigInt(sh) / BigInt(10 ** Math.min(dec, 18)));
  } catch (e) { warn(`Supply ${address}: ${e.message}`); return null; }
}

async function collectChainSupplies(chainKey) {
  const chain = CONFIG[chainKey];
  if (!chain.rpc) { warn(`No RPC for ${chainKey}`); return {}; }
  log(`Fetching ${chainKey} supplies (${Object.keys(chain.contracts).length} contracts)…`);
  const results = {};
  await Promise.all(Object.entries(chain.contracts).map(async ([sym, c]) => {
    const supply = await getTokenSupply(chain.rpc, c.addr);
    results[sym] = { address: c.addr, type: c.type, desc: c.desc, supply, fetchedAt: new Date().toISOString() };
    log(`  ${chainKey}/${sym}: ${supply != null ? supply.toLocaleString() : 'error'}`);
  }));
  return results;
}

// ── WHALES ────────────────────────────────────────────────────────────────────

async function collectWhales(chainKey) {
  const chain = CONFIG[chainKey];
  const azndAddr = chain.contracts.AZND?.addr;
  if (!azndAddr) return [];
  log(`Fetching ${chainKey} whale holders…`);
  try {
    const url = `${chain.explorerApi}?module=token&action=tokenholderlist&contractaddress=${azndAddr}&page=1&offset=20${chain.explorerApiKey ? `&apikey=${chain.explorerApiKey}` : ''}`;
    const data = await fetchJson(url);
    if (data.status !== '1' || !Array.isArray(data.result)) { warn(`Whales ${chainKey}: ${data.message}`); return []; }
    return data.result.map((h, i) => ({
      rank:        i + 1,
      address:     h.TokenHolderAddress,
      azndBalance: Number(BigInt(h.TokenHolderQuantity || 0) / BigInt(10 ** 18)),
    }));
  } catch (e) { warn(`Whales ${chainKey}: ${e.message}`); return []; }
}

// ── POSTHOG ───────────────────────────────────────────────────────────────────

async function posthogQuery(hogql) {
  const { host, personalApiKey, projectId } = CONFIG.posthog;
  if (!personalApiKey || !projectId) { warn('PostHog credentials not set'); return null; }
  try {
    const data = await fetchJson(`${host}/api/projects/${projectId}/query/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${personalApiKey}` },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
    });
    return data.results || data;
  } catch (e) { warn(`PostHog query: ${e.message}`); return null; }
}

async function collectPosthog() {
  log('Fetching PostHog metrics…');
  const results = {};

  const dauRows = await posthogQuery(`
    SELECT toDate(timestamp) as day, count(distinct person_id) as dau
    FROM events WHERE timestamp >= now() - interval 30 day
    GROUP BY day ORDER BY day DESC LIMIT 30`);
  if (dauRows) {
    results.dau       = dauRows.map(r => ({ date: r[0], value: r[1] }));
    results.dauLatest = dauRows[0]?.[1] ?? null;
    results.dauWoW    = dauRows.length >= 8 ? fmt((dauRows[0][1] - dauRows[7][1]) / dauRows[7][1] * 100) : null;
    log(`  DAU: ${results.dauLatest}  WoW: ${results.dauWoW}%`);
  }

  const wauRows = await posthogQuery(`
    SELECT toMonday(timestamp) as week, count(distinct person_id) as wau
    FROM events WHERE timestamp >= now() - interval 84 day
    GROUP BY week ORDER BY week DESC LIMIT 12`);
  if (wauRows) {
    results.wau       = wauRows.map(r => ({ week: r[0], value: r[1] }));
    results.wauLatest = wauRows[0]?.[1] ?? null;
    results.wauWoW    = wauRows.length >= 2 ? fmt((wauRows[0][1] - wauRows[1][1]) / wauRows[1][1] * 100) : null;
    log(`  WAU: ${results.wauLatest}  WoW: ${results.wauWoW}%`);
  }

  const retRows = await posthogQuery(`
    SELECT toMonday(first_seen) as cohort_week, count(distinct person_id) as cohort_size
    FROM (SELECT person_id, min(timestamp) as first_seen FROM events
          WHERE timestamp >= now() - interval 42 day GROUP BY person_id)
    GROUP BY cohort_week ORDER BY cohort_week DESC LIMIT 6`);
  if (retRows) results.retentionCohorts = retRows.map(r => ({ week: r[0], cohortSize: r[1] }));

  const refRows = await posthogQuery(`
    SELECT properties.$referring_domain as domain, count(distinct person_id) as users
    FROM events WHERE timestamp >= now() - interval 14 day
      AND properties.$referring_domain IS NOT NULL AND properties.$referring_domain != ''
    GROUP BY domain ORDER BY users DESC LIMIT 15`);
  if (refRows) results.referringDomains = refRows.map(r => ({ domain: r[0] || '$direct', users: r[1] }));

  // Earn→Swap→Lock funnel (needs events instrumented in app)
  const funnelRows = await posthogQuery(`
    SELECT
      countIf(event = 'earn_start') as ee, countIf(event = 'swap_initiated') as se, countIf(event = 'lock_completed') as le,
      count(distinct if(event = 'earn_start', person_id, null)) as eu,
      count(distinct if(event = 'swap_initiated', person_id, null)) as su,
      count(distinct if(event = 'lock_completed', person_id, null)) as lu
    FROM events WHERE timestamp >= now() - interval 7 day`);
  if (funnelRows?.[0]) {
    const [ee, se, le, eu, su, lu] = funnelRows[0];
    results.funnel = { last7Days: {
      earnStart:     { events: ee, users: eu },
      swapInitiated: { events: se, users: su },
      lockCompleted: { events: le, users: lu },
      earnToSwapPct: eu > 0 ? fmt(su / eu * 100) : null,
      swapToLockPct: su > 0 ? fmt(lu / su * 100) : null,
      earnToLockPct: eu > 0 ? fmt(lu / eu * 100) : null,
      instrumented:  ee > 0,
    }};
  }

  // Per-page views (trust/conversion signal)
  const pageRows = await posthogQuery(`
    SELECT
      countIf(properties.$pathname LIKE '%transparency%') as transparency_views,
      countIf(properties.$pathname LIKE '%rewards%')      as rewards_views,
      countIf(properties.$pathname LIKE '%earn%')         as earn_views,
      countIf(properties.$pathname LIKE '%swap%')         as swap_views,
      countIf(properties.$pathname LIKE '%dashboard%')    as dashboard_views,
      count(distinct person_id)                           as total_users
    FROM events WHERE event = '$pageview' AND timestamp >= now() - interval 7 day`);
  if (pageRows?.[0]) {
    const [tv, rv, ev, sv, dv, tu] = pageRows[0];
    results.pageViews = { last7Days: { transparency: tv, rewards: rv, earn: ev, swap: sv, dashboard: dv, totalUsers: tu } };
    log(`  Page views — earn: ${ev}, swap: ${sv}, transparency: ${tv}`);
  }

  results.fetchedAt = new Date().toISOString();
  return results;
}

// ── HISTORY ───────────────────────────────────────────────────────────────────

function loadHistory() {
  try { if (fs.existsSync(CONFIG.historyPath)) return JSON.parse(fs.readFileSync(CONFIG.historyPath, 'utf8')); }
  catch {}
  return { snapshots: [] };
}

function appendHistory(history, snapshot) {
  history.snapshots.unshift({
    date:      snapshot.collectedAt.slice(0, 10),
    tvl:       snapshot.muApp?.tvl?.current,
    azndApy:   snapshot.muApp?.apy?.aznd,
    mubondApy: snapshot.muApp?.apy?.mubond,
    dauLatest: snapshot.posthog?.dauLatest,
    wauLatest: snapshot.posthog?.wauLatest,
    monadSupplies: Object.fromEntries(
      Object.entries(snapshot.onchain?.monad || {}).map(([k, v]) => [k, v.supply])
    ),
  });
  history.snapshots = history.snapshots.slice(0, 90);
  return history;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  log('═══ Mu Digital Data Collector v3.0 ═══');

  const [muApp, monadSupplies, ethSupplies, monadWhales, ethWhales, posthog] =
    await Promise.allSettled([
      collectMuAppData(),
      collectChainSupplies('monad'),
      collectChainSupplies('eth'),
      collectWhales('monad'),
      collectWhales('eth'),
      collectPosthog(),
    ]);

  const snapshot = {
    collectedAt: new Date().toISOString(),
    muApp:    muApp.status          === 'fulfilled' ? muApp.value          : null,
    onchain: {
      monad:  monadSupplies.status  === 'fulfilled' ? monadSupplies.value  : {},
      eth:    ethSupplies.status    === 'fulfilled' ? ethSupplies.value    : {},
    },
    whales: {
      monad:  monadWhales.status    === 'fulfilled' ? monadWhales.value    : [],
      eth:    ethWhales.status      === 'fulfilled' ? ethWhales.value      : [],
    },
    posthog:  posthog.status        === 'fulfilled' ? posthog.value        : null,
    meta: {
      version: '3.0',
      chains: {
        monad: { name: 'Monad Mainnet',    chainId: 143, active: true },
        eth:   { name: 'Ethereum Mainnet', chainId: 1,   active: !!CONFIG.eth.rpc },
      },
    },
  };

  const history = loadHistory();
  appendHistory(history, snapshot);

  if (history.snapshots.length >= 2) {
    const prev = history.snapshots[1];
    snapshot.deltas = {
      tvlWoW:     snapshot.muApp?.tvl?.wowDeltaPct ?? null,
      tvlAbs:     snapshot.muApp?.tvl?.wowDeltaAbs ?? null,
      dauWoW:     snapshot.posthog?.dauWoW ?? null,
      wauWoW:     snapshot.posthog?.wauWoW ?? null,
    };
  }

  const outDir = path.dirname(CONFIG.outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(CONFIG.outputPath, JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(CONFIG.historyPath, JSON.stringify(history, null, 2));

  log(`✓ Snapshot written → ${CONFIG.outputPath}`);
  log(`✓ History: ${history.snapshots.length} snapshots`);
  log('═══ Done ═══');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });