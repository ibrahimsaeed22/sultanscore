// Match Center API proxy (Cloudflare Worker).
//
// Data sources, in fallback order (only on failure / empty — never on every
// request, so the free quotas last):
//   1. football-data.org -> its 12 competitions (big European leagues + CL).
//      Free tier: 10 req/min, no daily cap, but no detailed match stats.
//   2. API-Football      -> ONLY leagues FD does not cover (Egypt 233, cups,
//      Turkey, Belgium, Scotland, ...), plus the things FD lacks: match
//      statistics, lineups, player ratings, H2H. Free tier: 100 req/day,
//      so it is spent sparingly — see the 85/day budget guard below.
//   3. ESPN (no key)    -> fixtures/live/standings/scorers when both keyed sources fail
//   4. FotMob (no key)   -> fixtures/live + match details (stats, events,
//      lineups, ratings) when ESPN also has nothing; real league ids via
//      the verified primaryId map. Unofficial, no SLA — fallback only.
//      Also the standings + top-scorers fallback for AF-only leagues
//      (Egypt etc.) via /api/data/leagues — see fmStandings/fmScorers.
//      (SportScore was source 5 until 2026-11-26, then removed: its
//      widget API has no date/league filter, so it injected ~50 fixtures
//      from untracked leagues under placeholder league 999001.)
// If one key is missing the other source covers what it can. With no keys at all it serves demo data.
//
// Answers are cached (Cloudflare KV when bound, memory otherwise) so users share the same upstream requests.
// On upstream failure the last cached copy is served with stale:true instead of an error.

import { mockUpstream } from './mock.js';

const AF_URL = 'https://v3.football.api-sports.io';
const FD_URL = 'https://api.football-data.org/v4';
// API-Football free tier is 100 requests/day. The guard below stops
// spending it on fixtures/live once 85 are used in a UTC day, keeping a
// 15-request reserve; detail calls (stats/lineups) then fall back to the
// cached/stale copy instead of spending more. Best-effort counter only —
// concurrent isolates can under-count slightly, and if the counter cannot
// be read at all, requests are NOT blocked.
const AF_DAILY_LIMIT = 100;
const AF_DAILY_BUDGET = 85;

// Latest app release — the app checks GET /version on startup and shows an
// update banner when this is newer than the version it was built with.
// IMPORTANT: put the real download link here (Google Play listing, or the
// GitHub Release / APK link) before you publish a new version, and bump
// the version number here AND in package.json AND in www/index.html
// (APP_VERSION) at the same time, or the banner will never show / never go away.
const LATEST_VERSION = {
  version: '1.1.2',
  downloadUrl: 'https://github.com/ibrahimsaeed22/sultanscore/releases',
  notes: { ar: 'تنضيف الكود، سرعة واستقرار أكتر', en: 'Code cleanup, faster and more stable' }
};

// League ids follow API-Football numbering (the app uses them for names/order).
export const DEFAULT_LEAGUES = [
  233,                       // Egyptian Premier League
  39, 140, 135, 78, 61,      // England, Spain, Italy, Germany, France
  94, 88, 203, 144, 179,     // Portugal, Netherlands, Turkey, Belgium, Scotland
  2, 3, 848,                 // Champions League, Europa League, Conference League
  45, 48, 143, 137, 81, 66,  // FA Cup, League Cup, Copa del Rey, Coppa Italia, DFB Pokal, Coupe de France
  1, 4, 6, 5                 // World Cup, Euro, Africa Cup of Nations, Nations League
];
// football-data.org free-tier competitions, mapped to the ids above.
const FD_CODE_TO_LEAGUE = { PL: 39, PD: 140, SA: 135, BL1: 78, FL1: 61, CL: 2, PPL: 94, DED: 88, EC: 4, WC: 1 };
const FD_LEAGUES = new Set(Object.values(FD_CODE_TO_LEAGUE));
const FD_LEAGUE_TO_CODE = {};
Object.entries(FD_CODE_TO_LEAGUE).forEach(([code, id]) => { FD_LEAGUE_TO_CODE[id] = code; });
// ESPN (no key needed) slugs, mapped to API-Football league ids.
const ESPN_SLUG_BY_LEAGUE = { 39: 'eng.1', 140: 'esp.1', 135: 'ita.1', 78: 'ger.1', 61: 'fra.1', 94: 'por.1', 88: 'ned.1', 203: 'tur.1', 233: 'egy.1', 2: 'uefa.champions', 3: 'uefa.europa', 848: 'uefa.europa.conf' };
// Football season year: a season starting in July belongs to that calendar year.
const currentSeason = () => { const n = new Date(); return n.getMonth() >= 6 ? n.getFullYear() : n.getFullYear() - 1; };
// 3s upstream timeout (was 8s — approved 2026-11-25: a slow source must fail
// fast so the fallback / stale cache answers instead of blocking the app).
// Cloudflare Workers have a short CPU / wall-clock budget; 3s per source
// still leaves room for the fallback chain inside one request.
// NOTE on cold starts: right after a deploy the first /fixtures call can
// return 0 fixtures (cold isolates + 3s timeouts on every upstream), the
// retry works. Mitigation is operational: call GET /warm right after a
// deploy and verify /fixtures before calling it done — never rely on the
// first cold request alone.
const UPSTREAM_TIMEOUT_MS = 3000;
// Last-known per-source availability. Values only (no keys, no secrets, no
// upstream error text) — surfaced by /health so a client can see what is up.
const sourceStatus = {
  apiFootball: { configured: false, available: null },
  footballData: { configured: false, available: null },
  espn: { configured: true, available: null },
  fotmob: { configured: true, available: null },
  sofascore: { configured: true, available: null }
};
function markSource(name, ok) { if (sourceStatus[name]) sourceStatus[name].available = !!ok; }

const AF_LIVE = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'INT', 'LIVE']);
const AF_FIN = new Set(['FT', 'AET', 'PEN']);
const AF_CANC = new Set(['CANC', 'ABD', 'AWD', 'WO']);

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' };

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

/* ---------- settings ---------- */
const economy = env => env.ECONOMY !== '0';           // economy mode is ON unless ECONOMY="0"
function ttl(env, name) {
  const eco = economy(env);
  // 'today' is 1800s (was 600s): the cron warms every 30 min, so a 10-min
  // TTL meant the day cache was expired — and every answer flagged
  // stale:true with the in-app "last saved data" banner — most of the
  // time. 30 min matches the warm cadence; SWR still refreshes in the
  // background the moment it expires, so data never sits older than that.
  return ({ today: eco ? 1800 : 45, live: eco ? 180 : 20, detailLive: eco ? 120 : 30, team: eco ? 900 : 300 })[name];
}
function plan(env) {
  const mock = env.MOCK === '1' || (!env.API_KEY && !env.FD_KEY);
  const allowed = env.LEAGUES ? new Set(String(env.LEAGUES).split(',').map(s => +s.trim()).filter(Boolean)) : new Set(DEFAULT_LEAGUES);
  if (mock) return { mock: true, af: allowed, fd: new Set(), allowed };
  const fd = env.FD_KEY ? new Set([...allowed].filter(id => FD_LEAGUES.has(id))) : new Set();
  const af = env.API_KEY ? new Set([...allowed].filter(id => !fd.has(id))) : new Set();
  return { mock: false, af, fd, allowed };
}
const planKey = p => [...p.fd].join('.') + '|' + [...p.af].join('.') + (p.mock ? 'm' : '');
// Shared fixture helpers (defined up here: every normaliser below uses them).
const sortFx = (a, b) => a.ts - b.ts || a.league.id - b.league.id;
const utcDate = sec => new Date(sec * 1000).toISOString().slice(0, 10);
const addUtcDay = (ds, n) => new Date(Date.parse(ds + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/* ---------- cache (KV when bound, memory otherwise) + de-duplication ---------- */
const mem = new Map();
const pending = new Map();
async function cacheRead(env, key) {
  if (env.CACHE) { try { return await env.CACHE.get('c:' + key, 'json'); } catch (e) { return null; } }
  return mem.get(key) || null;
}
async function cacheWrite(env, key, entry) {
  if (env.CACHE) { try { await env.CACHE.put('c:' + key, JSON.stringify(entry), { expirationTtl: 86400 }); } catch (e) { /* ignore */ } return; }
  if (mem.size > 800) mem.clear();
  mem.set(key, entry);
}
// Background refresh runner, set per-request from ctx.waitUntil (see
// handle()). Without it, a background refresh still runs best-effort as a
// floating promise — the isolate may be frozen after the response, so the
// refresh is not guaranteed, but serving stale never depends on it.
let bgRunner = null;
function runBackground(p) {
  const q = p.catch(() => {});
  if (bgRunner) { try { bgRunner(q); } catch (e) { /* best effort */ } }
}
// Fresh copy for `ttlSec` seconds; if the source fails we fall back to the last copy (kept 24h) and flag it stale.
// Stale-while-revalidate (approved 2026-11-25): an expired copy is served
// IMMEDIATELY with stale:true and refreshed in the background, so the app
// never waits on a slow upstream when yesterday's data will do for a moment.
async function cached(env, key, ttlSec, producer) {
  const entry = await cacheRead(env, key);
  if (entry && entry.exp > Date.now()) return entry.v;
  if (pending.has(key)) {
    if (entry) return Object.assign({}, entry.v, { stale: true });
    return pending.get(key);
  }
  const p = (async () => {
    try {
      const v = await producer();
      await cacheWrite(env, key, { v, exp: Date.now() + ttlSec * 1000 });
      return v;
    } catch (e) {
      if (entry) {
        // Failed refresh with a stale copy in hand: back off 60s before
        // trying again (2026-11-26 — while API-Football 429s, every
        // request was re-spending AF budget on a refresh that fails, and
        // every answer stayed flagged stale). The copy is at most ~60s
        // older for it, and the next request after the backoff retries.
        try { await cacheWrite(env, key, { v: entry.v, exp: Date.now() + 60000 }); } catch (e2) { /* ignore */ }
        return Object.assign({}, entry.v, { stale: true });
      }
      throw e;
    } finally { pending.delete(key); }
  })();
  pending.set(key, p);
  if (entry) {
    runBackground(p);
    return Object.assign({}, entry.v, { stale: true });
  }
  return p;
}

/* ---------- upstream calls ---------- */
async function fetchTimeout(url, opts) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try { return await fetch(url, Object.assign({}, opts, { signal: ctrl.signal })); }
  catch (e) { if (e && e.name === 'AbortError') throw new HttpError(502, 'upstream timeout'); throw e; }
  finally { clearTimeout(to); }
}
/* ---------- API-Football daily budget guard (free tier: 100/day) ---------- */
const afBudgetKey = () => 'af:budget:' + new Date().toISOString().slice(0, 10);
async function afBudgetRead(env) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (env.CACHE) { const v = await env.CACHE.get(afBudgetKey(), 'json'); if (v && v.date === today) return v.used || 0; return 0; }
    const v = mem.get(afBudgetKey());
    if (v && v.date === today) return v.used || 0;
    return 0;
  } catch (e) { return 0; } // counter unreadable => do not block requests
}
async function afBudgetSpend(env) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const used = (await afBudgetRead(env)) + 1;
    const entry = { date: today, used };
    if (env.CACHE) await env.CACHE.put(afBudgetKey(), JSON.stringify(entry), { expirationTtl: 172800 });
    else mem.set(afBudgetKey(), entry);
    return used;
  } catch (e) { return 0; }
}
async function afGet(env, path, params) {
  if (env.MOCK === '1' || (!env.API_KEY && !env.FD_KEY)) return mockUpstream(path, params);
  // Budget guard: once 85 API-Football calls are spent today, stop spending
  // on any new upstream call. Callers already handle this: fixtures/live
  // fall through to ESPN / FotMob / stale cache, standings/scorers try
  // the next source, and stats/lineups/events return the cached copy (or
  // an empty list) via their .catch() handlers.
  if ((await afBudgetRead(env)) >= AF_DAILY_BUDGET) { markSource('apiFootball', false); throw new HttpError(503, 'af daily budget exhausted'); }
  await afBudgetSpend(env);
  const qs = new URLSearchParams(params).toString();
  let res;
  try {
    res = await fetchTimeout(AF_URL + '/' + path + (qs ? '?' + qs : ''), { headers: { 'x-apisports-key': env.API_KEY } });
  } catch (e) { markSource('apiFootball', false); throw e; }
  if (!res.ok) { markSource('apiFootball', false); throw new HttpError(502, 'af ' + res.status); }
  const j = await res.json();
  const errs = j && j.errors;
  if (Array.isArray(errs) ? errs.length : errs && Object.keys(errs).length) { markSource('apiFootball', false); throw new HttpError(502, 'af: ' + JSON.stringify(errs).slice(0, 160)); }
  markSource('apiFootball', true);
  return j;
}
async function fdGet(env, path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  let res;
  try {
    res = await fetchTimeout(FD_URL + path + qs, { headers: { 'X-Auth-Token': env.FD_KEY } });
  } catch (e) { markSource('footballData', false); throw e; }
  if (!res.ok) { markSource('footballData', false); throw new HttpError(502, 'fd ' + res.status); }
  markSource('footballData', true);
  return res.json();
}
// ESPN needs no key. Used only as a last-resort fallback (fixtures/live/
// standings/scorers) when both keyed providers fail for the same request.
async function espnGet(path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  let res;
  try {
    res = await fetchTimeout('https://site.api.espn.com/apis/site/v2/sports/soccer/' + path + qs, { headers: { accept: 'application/json' } });
  } catch (e) { markSource('espn', false); throw e; }
  if (!res.ok) { markSource('espn', false); throw new HttpError(502, 'espn ' + res.status); }
  markSource('espn', true);
  return res.json();
}
/* ---------- SofaScore / FotMob probe (unofficial, no key, no SLA) ----------
   Both are undocumented internal APIs: they can 403 / change shape at any
   time and their terms forbid automated use. FotMob passed the probe FROM
   THE WORKER (Cloudflare egress IP) on 2026-11-25 ~10:37 UTC (ok:true,
   200, 50 leagues / 131 matches) and is now wired as a fallback — see
   the FotMob section below. SofaScore 403s from the Worker, so it is
   probe-only and never a live source.
   GET /probe runs one lightweight call per source and returns only a
   summary (status + counts + one sample name) — never a full data dump. */
const FM_URL = 'https://www.fotmob.com/api/data';
const SOFA_URL = 'https://api.sofascore.com/api/v1';
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; SultanScore/1.1.2)', accept: 'application/json' };
async function probeFotmob(env) {
  const ds = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  try {
    const res = await fetchTimeout(FM_URL + '/matches?date=' + ds, { headers: UA });
    if (!res.ok) { markSource('fotmob', false); return { source: 'fotmob', ok: false, status: res.status }; }
    const j = await res.json();
    const leagues = Array.isArray(j.leagues) ? j.leagues : [];
    const matches = leagues.reduce((n, l) => n + ((l.matches || []).length), 0);
    markSource('fotmob', true);
    return { source: 'fotmob', ok: true, status: 200, leagues: leagues.length, matches, sample: leagues[0] ? leagues[0].name : null };
  } catch (e) { markSource('fotmob', false); return { source: 'fotmob', ok: false, status: null, error: e instanceof HttpError ? e.message : 'fetch failed' }; }
}
async function probeSofascore(env) {
  const ds = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetchTimeout(SOFA_URL + '/sport/football/scheduled-events/' + ds, { headers: UA });
    if (!res.ok) { markSource('sofascore', false); return { source: 'sofascore', ok: false, status: res.status }; }
    const j = await res.json();
    const events = Array.isArray(j.events) ? j.events : [];
    markSource('sofascore', true);
    return { source: 'sofascore', ok: true, status: 200, events: events.length, sample: events[0] && events[0].tournament ? events[0].tournament.name : null };
  } catch (e) { markSource('sofascore', false); return { source: 'sofascore', ok: false, status: null, error: e instanceof HttpError ? e.message : 'fetch failed' }; }
}

/* ---------- FotMob fallback (unofficial, no key, no SLA) ----------
   Wired 2026-11-25 as a fixtures/live fallback AFTER ESPN, and as a
   match-detail source for fm- fixtures. It is NEVER the only source: the
   keyed providers + ESPN are always tried first, and FotMob only fills
   in when they return nothing for that league/day.
   League ids are FotMob primaryIds, verified live 2026-11-21..27 from
   /api/data/matches (never guessed):
     ENG PL 47, ESP LaLiga 87, ITA Serie A 55, GER Bundesliga 54,
     FRA Ligue 1 53, POR Liga Portugal 61, NED Eredivisie 57,
     TUR Super Lig 71, BEL Pro League 40, SCO Premiership 64,
     EGY Premier League 519 (ccode EGY — NOT the Ukrainian PL, 441),
     UCL 42, UEL 73, UECL 10216.
   Cups (45/48/143/137/81/66) and internationals (1/4/6/5) are NOT mapped
   (no FotMob primaryId verified for them) — they keep the existing
   fallbacks. Team logos use FotMob's CDN pattern
   images.fotmob.com/image_resources/logo/teamlogo/<id>.png (verified 200).
   Match details come from /api/data/matchDetails?matchId=<id> (the
   /api/matchDetails path without /data 404s); details for matches older
   than ~2 days may 404, so a failed detail fetch returns empty sections,
   never an error, and the app still shows the fixture hero from its
   preview. */
const FM_LEAGUE_TO_AF = { 47: 39, 87: 140, 55: 135, 54: 78, 53: 61, 61: 94, 57: 88, 71: 203, 40: 144, 64: 179, 519: 233, 42: 2, 73: 3, 10216: 848 };
const AF_TO_FM_LEAGUE = {};
Object.entries(FM_LEAGUE_TO_AF).forEach(([fm, af]) => { AF_TO_FM_LEAGUE[af] = +fm; });
const FM_TEAM_LOGO = id => 'https://images.fotmob.com/image_resources/logo/teamlogo/' + id + '.png';
async function fmGet(path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  let res;
  try {
    res = await fetchTimeout(FM_URL + path + qs, { headers: UA });
  } catch (e) { markSource('fotmob', false); throw e; }
  if (!res.ok) { markSource('fotmob', false); throw new HttpError(502, 'fotmob ' + res.status); }
  markSource('fotmob', true);
  return res.json();
}
function fmState(m) {
  const st = m.status || {};
  if (st.cancelled) return 'cancelled';
  if (st.finished) return 'finished';
  if (st.started) return 'live';
  const lk = st.reason && st.reason.longKey;
  if (lk === 'postponed' || lk === 'suspended') return 'postponed';
  return 'upcoming';
}
function fmShort(m) {
  const st = fmState(m);
  const reason = (m.status && m.status.reason && m.status.reason.short) || '';
  if (st === 'live') return reason || 'LIVE';
  if (st === 'finished') return reason || 'FT';
  if (st === 'postponed') return 'PST';
  if (st === 'cancelled') return 'CANC';
  return 'NS';
}
function fmElapsed(m) {
  if (fmState(m) !== 'live') return null;
  const reason = (m.status && m.status.reason && m.status.reason.short) || '';
  const mm = /^(\d+)'/.exec(reason);
  return mm ? +mm[1] : null;
}
function fmTeam(t) {
  return { id: 'fm-' + t.id, name: t.name || t.shortName || '?', logo: t.id ? FM_TEAM_LOGO(t.id) : '' };
}
function fmFixture(m, afLeagueId, leagueName) {
  const state = fmState(m);
  const started = !!(m.status && (m.status.started || m.status.finished));
  return {
    id: 'fm-' + m.id, ts: Math.floor((m.timeTS || Date.parse((m.status && m.status.utcTime) || '')) / 1000),
    state, short: fmShort(m), elapsed: fmElapsed(m), venue: '',
    league: { id: afLeagueId, name: leagueName || '', logo: '', country: '', round: m.tournamentStage ? 'Matchday ' + m.tournamentStage : '' },
    home: fmTeam(m.home || {}), away: fmTeam(m.away || {}),
    hg: started ? (m.home && m.home.score != null ? m.home.score : null) : null,
    ag: started ? (m.away && m.away.score != null ? m.away.score : null) : null
  };
}
// One upstream call per date for ALL leagues (the endpoint returns every
// league at once); per-league filtering happens locally, so warming and
// fallback cost FotMob a single call per date, cached 5 minutes.
async function fmDayRaw(env, ds) {
  const ymd = ds.replace(/-/g, '');
  return cached(env, 'fm:dayraw:' + ymd, 300, async () => {
    const j = await fmGet('/matches', { date: ymd });
    return { leagues: Array.isArray(j.leagues) ? j.leagues : [] };
  });
}
async function fmDayFixtures(env, leagueId, ds) {
  const fmId = AF_TO_FM_LEAGUE[leagueId];
  if (!fmId) return { fixtures: [] };
  const raw = await fmDayRaw(env, ds);
  const seen = new Set(), out = [];
  for (const lg of raw.leagues) {
    if (lg.primaryId !== fmId) continue;
    for (const m of (lg.matches || [])) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      const f = fmFixture(m, leagueId, lg.name);
      if (utcDate(f.ts) === ds) out.push(f);
    }
  }
  return { fixtures: out.sort(sortFx) };
}
async function fmLiveFixtures(env) {
  const today = new Date().toISOString().slice(0, 10);
  return cached(env, 'fm:live:' + today, ttl(env, 'live'), async () => {
    const raw = await fmDayRaw(env, today);
    const seen = new Set(), out = [];
    for (const lg of raw.leagues) {
      const afId = FM_LEAGUE_TO_AF[lg.primaryId];
      if (!afId) continue;
      for (const m of (lg.matches || [])) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const f = fmFixture(m, afId, lg.name);
        if (f.state === 'live') out.push(f);
      }
    }
    return { fixtures: out.sort(sortFx) };
  });
}
/* ---------- FotMob standings & top scorers (added 2026-11-26) ----------
   Why: API-Football standings + topscorers fail for EVERY AF-only league
   (verified 2026-11-26: Egypt 233, Belgium 144, Scotland 179, Turkey 203,
   League Cup 48 — all "unavailable", while FD leagues work and AF
   fixtures/events still work, so it is NOT the season and NOT Egypt-only).
   FotMob GET /api/data/leagues?id=<primaryId> returns the current season's
   full table (table[0].data.table.all: played/wins/draws/losses, scoresStr
   "GF-GA", goalConDiff, pts, idx) plus stats.players "Top scorer" /
   "Assists" with fetchAllUrl links to full lists on data.fotmob.com.
   Verified live from a laptop IP for Egypt 519 (Pyramids 27pts/9, top
   scorer Mahmoud Mamdouh 8), EPL 47 (identical table to football-data:
   Arsenal 28pts/11) and Turkey 71 (Galatasaray 31). Only reached when
   AF + FD both return nothing, so FD-covered leagues never change. */
async function fmLeagueRaw(env, fmId) {
  return cached(env, 'fm:league:' + fmId, 3600, async () => fmGet('/leagues', { id: fmId }));
}
function fmStandingRow(r) {
  const m = /^(\d+)-(\d+)$/.exec(r.scoresStr || '');
  return {
    position: r.idx, team: { id: 'fm-' + r.id, name: r.name, logo: r.id ? FM_TEAM_LOGO(r.id) : '' },
    played: r.played || 0, won: r.wins || 0, drawn: r.draws || 0, lost: r.losses || 0,
    gf: m ? +m[1] : 0, ga: m ? +m[2] : 0, gd: r.goalConDiff == null ? 0 : r.goalConDiff,
    points: r.pts || 0, form: ''
  };
}
async function fmStandings(env, league) {
  const fmId = AF_TO_FM_LEAGUE[league];
  if (!fmId) return null;
  const j = await fmLeagueRaw(env, fmId);
  const tbl = j.table && j.table[0] && j.table[0].data && j.table[0].data.table && j.table[0].data.table.all;
  if (!tbl || !tbl.length) return null;
  return { league: { id: league, name: (j.details && j.details.name) || '' }, standings: tbl.map(fmStandingRow) };
}
// Absolute-URL fetch for FotMob's data host (fetchAllUrl links). Workers
// fetch handles the gzip encoding transparently.
async function fmFetchAbs(env, url, cacheKey) {
  return cached(env, cacheKey, 3600, async () => {
    let res;
    try { res = await fetchTimeout(url, { headers: UA }); }
    catch (e) { markSource('fotmob', false); throw e; }
    if (!res.ok) { markSource('fotmob', false); throw new HttpError(502, 'fotmob ' + res.status); }
    markSource('fotmob', true);
    return res.json();
  });
}
async function fmScorers(env, league) {
  const fmId = AF_TO_FM_LEAGUE[league];
  if (!fmId) return null;
  const j = await fmLeagueRaw(env, fmId);
  const players = (j.stats && j.stats.players) || [];
  const goalsEntry = players.find(p => /top scorer/i.test(p.header || ''));
  const topThree = (goalsEntry && goalsEntry.topThree) || [];
  let rows = null;
  if (goalsEntry && goalsEntry.fetchAllUrl) {
    const g = await fmFetchAbs(env, goalsEntry.fetchAllUrl, 'fm:stats:' + fmId + ':goals');
    const list = (g.TopLists && g.TopLists[0] && g.TopLists[0].StatList) || [];
    // Assists, joined by participant id, so the app's goals+assists shape holds.
    const assistsById = new Map();
    const astEntry = players.find(p => /^\s*assists\s*$/i.test(p.header || ''));
    if (astEntry && astEntry.fetchAllUrl) {
      try {
        const a = await fmFetchAbs(env, astEntry.fetchAllUrl, 'fm:stats:' + fmId + ':assists');
        ((a.TopLists && a.TopLists[0] && a.TopLists[0].StatList) || []).forEach(r => assistsById.set(r.ParticiantId, r.StatValue));
      } catch (e) { /* goals without assists is still useful */ }
    }
    rows = list.map(r => ({
      player: r.ParticipantName || '?',
      team: { id: r.TeamId ? 'fm-' + r.TeamId : '', name: r.TeamName || '', logo: r.TeamId ? FM_TEAM_LOGO(r.TeamId) : '' },
      goals: Math.round(r.StatValue || 0), assists: Math.round(assistsById.get(r.ParticiantId) || 0), played: r.MatchesPlayed || 0
    })).filter(r => r.goals > 0);
  }
  if ((!rows || !rows.length) && topThree.length) {
    rows = topThree.map(t => ({
      player: t.name || '?',
      team: { id: t.teamId ? 'fm-' + t.teamId : '', name: t.teamName || '', logo: t.teamId ? FM_TEAM_LOGO(t.teamId) : '' },
      goals: (t.stat && t.stat.value) || t.value || 0, assists: 0, played: 0
    })).filter(r => r.goals > 0);
  }
  if (!rows || !rows.length) return null;
  return { scorers: rows.slice(0, 20) };
}
/* ---------- match details from FotMob (fm- fixtures) ----------
   Ratings come from the lineup's performance.rating (FotMob rating);
   positions use playerStats usualPosition: 0 GK, 1 DEF, 2 MID, 3 FWD. */
const FM_POS = { 0: 'G', 1: 'D', 2: 'M', 3: 'F' };
function fmDetailFixture(d) {
  const g = d.general || {};
  const h = d.header || {};
  const st = h.status || {};
  const teams = h.teams || [];
  const home = teams[0] || {}, away = teams[1] || {};
  const infoBox = (d.content && d.content.matchFacts && d.content.matchFacts.infoBox) || {};
  const tourney = infoBox.Tournament || {};
  const parentId = tourney.parentLeagueId;
  const afId = parentId != null ? FM_LEAGUE_TO_AF[parentId] : undefined;
  const m = {
    id: g.matchId, timeTS: Date.parse(st.utcTime || g.matchTimeUTC || '') || Date.now(),
    status: st, home: { id: home.id, name: home.name, score: home.score }, away: { id: away.id, name: away.name, score: away.score }
  };
  const f = fmFixture(m, afId || 999002, tourney.leagueName || g.leagueName || '');
  f.id = 'fm-' + (g.matchId || '');
  f.venue = (infoBox.Stadium && infoBox.Stadium.name) || '';
  if (tourney.roundName) f.league.round = 'Matchday ' + tourney.roundName;
  // Goalscorers from the header goals (minute, scorer, team, own goal).
  const scorers = [];
  const goalLists = [[(h.events && h.events.homeTeamGoals) || {}, 'home'], [(h.events && h.events.awayTeamGoals) || {}, 'away']];
  for (const [dict, team] of goalLists) {
    for (const arr of Object.values(dict)) {
      for (const ev of (arr || [])) {
        const row = goalRow(ev.time, ev.player && ev.player.name, team, !!ev.ownGoal);
        if (row) scorers.push(row);
      }
    }
  }
  if (scorers.length) f.scorers = scorers.sort((a, b) => (a.min || 0) - (b.min || 0));
  return f;
}
function fmDetailEvents(d, homeId, awayId) {
  const evs = (((d.content || {}).matchFacts || {}).events || {}).events || [];
  const out = [];
  for (const e of evs) {
    const team = e.isHome ? 'fm-' + homeId : 'fm-' + awayId;
    const min = e.time == null ? null : +e.time;
    const extra = e.overloadTime || null;
    if (e.type === 'Goal') {
      const pen = e.goalDescriptionKey === 'penalty' || /penalty/i.test(e.goalDescription || '');
      out.push({ min, extra, team, player: (e.player && e.player.name) || '', assist: '', type: 'Goal', detail: e.ownGoal ? 'Own Goal' : pen ? 'Penalty' : 'Normal Goal' });
    } else if (e.type === 'Card') {
      const card = String(e.card || '').toLowerCase();
      out.push({ min, extra, team, player: (e.player && e.player.name) || '', assist: '', type: 'Card', detail: card === 'red' ? 'Red Card' : (card === 'secondyellow' || card === 'second yellow') ? 'Second Yellow card' : 'Yellow Card' });
    } else if (e.type === 'Substitution' && Array.isArray(e.swap) && e.swap.length >= 2) {
      out.push({ min, extra, team, player: e.swap[0].name || '', assist: e.swap[1].name || '', type: 'subst', detail: 'Substitution' });
    }
  }
  out.sort((a, b) => (a.min || 0) - (b.min || 0));
  return out;
}
function fmDetailStats(d, homeId, awayId) {
  const groups = (((d.content || {}).stats || {}).Periods || {}).All || {};
  const rowsH = [], rowsA = [];
  for (const g of (groups.stats || [])) {
    for (const s of (g.stats || [])) {
      const vals = s.stats || [];
      if (vals.length < 2) continue;
      rowsH.push({ type: s.title || '', value: vals[0] == null ? '' : String(vals[0]) });
      rowsA.push({ type: s.title || '', value: vals[1] == null ? '' : String(vals[1]) });
    }
  }
  if (!rowsH.length) return [];
  return [{ team: 'fm-' + homeId, rows: rowsH }, { team: 'fm-' + awayId, rows: rowsA }];
}
function fmDetailLineups(d) {
  const lu = (d.content || {}).lineup || {};
  const ps = (d.content || {}).playerStats || {};
  const posOf = pl => {
    const up = ps[String(pl.id)] && ps[String(pl.id)].usualPosition;
    return (up != null && FM_POS[up] !== undefined) ? FM_POS[up] : '';
  };
  const player = pl => ({ player: pl.name || '?', number: pl.shirtNumber != null ? +pl.shirtNumber : null, pos: posOf(pl), rating: pl.performance && pl.performance.rating != null ? +pl.performance.rating : null });
  const side = t => {
    if (!t) return null;
    return { formation: t.formation || '', coach: (t.coach && t.coach.name) || '', xi: (t.starters || []).map(player), subs: (t.subs || []).map(player) };
  };
  const out = {};
  const h = side(lu.homeTeam), a = side(lu.awayTeam);
  if (h) out.home = h;
  if (a) out.away = a;
  return out;
}
async function getFmFixture(env, rawNum) {
  const num = +rawNum;
  if (!num) throw new HttpError(400, 'bad id');
  // 2-minute cache: live details move fast, and FotMob has no quota to
  // protect; a finished match's cached copy is served stale for 24h if
  // FotMob has already pruned its details.
  const d = await cached(env, 'fm:match:' + num, 120, async () => {
    const j = await fmGet('/matchDetails', { matchId: num });
    if (!j || !j.header) throw new HttpError(404, 'not found');
    return j;
  });
  const fixture = fmDetailFixture(d);
  const homeId = (d.header.teams && d.header.teams[0] && d.header.teams[0].id) || '';
  const awayId = (d.header.teams && d.header.teams[1] && d.header.teams[1].id) || '';
  return {
    fixture,
    stats: fmDetailStats(d, homeId, awayId),
    events: fmDetailEvents(d, homeId, awayId),
    lineups: fmDetailLineups(d),
    stale: d.stale
  };
}

/* ---------- normalising: API-Football ---------- */
function afState(s) {
  if (AF_LIVE.has(s)) return 'live';
  if (AF_FIN.has(s)) return 'finished';
  if (s === 'PST' || s === 'SUSP') return 'postponed';
  if (AF_CANC.has(s)) return 'cancelled';
  return 'upcoming';
}
function afFixture(f) {
  const st = (f.fixture.status && f.fixture.status.short) || 'NS';
  const side = t => ({ id: 'af-' + t.id, name: t.name, logo: t.logo || '' });
  return {
    id: 'af-' + f.fixture.id, ts: f.fixture.timestamp, state: afState(st), short: st,
    elapsed: f.fixture.status ? f.fixture.status.elapsed : null, venue: (f.fixture.venue && f.fixture.venue.name) || '',
    league: { id: f.league.id, name: f.league.name, logo: f.league.logo || '', country: f.league.country || '', round: f.league.round || '' },
    home: side(f.teams.home), away: side(f.teams.away), hg: f.goals.home, ag: f.goals.away
  };
}
/* ---------- goalscorers under the score (FotMob-style) ---------- */
// One scored goal: {min, player, team:'home'|'away', og}. Shown under the
// score in the match card and in the match page hero.
function goalRow(min, player, team, og) {
  if (!player || (team !== 'home' && team !== 'away')) return null;
  return { min: min == null || isNaN(+min) ? null : +min, player: String(player), team, og: !!og };
}
/* ---------- normalising: football-data.org ---------- */
function fdState(s) {
  if (s === 'IN_PLAY' || s === 'PAUSED') return 'live';
  if (s === 'FINISHED' || s === 'AWARDED') return 'finished';
  if (s === 'POSTPONED' || s === 'SUSPENDED') return 'postponed';
  if (s === 'CANCELLED') return 'cancelled';
  return 'upcoming';
}
function fdFixture(m, allowUnknown) {
  const c = m.competition || {};
  let lid = FD_CODE_TO_LEAGUE[c.code];
  if (!lid) { if (!allowUnknown) return null; lid = 100000 + (c.id || 0); }
  const st = fdState(m.status);
  const side = t => ({ id: 'fd-' + t.id, name: t.shortName || t.name || '?', logo: t.crest || '' });
  const ft = (m.score && m.score.fullTime) || {};
  const short = m.status === 'PAUSED' ? 'HT' : st === 'finished' && m.score && m.score.duration === 'PENALTY_SHOOTOUT' ? 'PEN' : st === 'live' ? 'LIVE' : st === 'finished' ? 'FT' : 'NS';
  // football-data.org returns the scorers on the match itself (no extra call).
  const scorers = (m.goals || []).map(g => {
    const tid = g.team && g.team.id != null ? String(g.team.id) : null;
    const team = tid == null ? null : tid === String((m.homeTeam || {}).id) ? 'home' : tid === String((m.awayTeam || {}).id) ? 'away' : null;
    return goalRow(g.minute, g.scorer && g.scorer.name, team, (g.type || '') === 'OWN_GOAL');
  }).filter(Boolean);
  return {
    id: 'fd-' + m.id, ts: Math.floor(Date.parse(m.utcDate) / 1000), state: st, short,
    elapsed: st === 'live' && typeof m.minute === 'number' ? m.minute : null, venue: m.venue || '',
    league: { id: lid, name: c.name || '', logo: c.emblem || '', country: (m.area && m.area.name) || '', round: m.matchday ? 'Matchday ' + m.matchday : '' },
    home: side(m.homeTeam || {}), away: side(m.awayTeam || {}),
    hg: ft.home === undefined ? null : ft.home, ag: ft.away === undefined ? null : ft.away,
    scorers
  };
}
/* ---------- normalising: ESPN (no key) ---------- */
function espnFixture(ev, leagueId, leagueName) {
  const comp = (ev.competitions && ev.competitions[0]) || {};
  const comps = comp.competitors || [];
  const pick = side => comps.find(c => c.homeAway === side) || {};
  const side = c => {
    const tm = c.team || {};
    return { id: 'espn-' + (tm.id || '?'), name: tm.displayName || tm.shortDisplayName || tm.name || '?', logo: tm.logo || '' };
  };
  const st = (ev.status && ev.status.type && ev.status.type.state) || 'pre';
  const state = st === 'in' ? 'live' : st === 'post' ? 'finished' : 'upcoming';
  const score = c => { const n = parseInt(c.score, 10); return isNaN(n) ? null : n; };
  const clock = (ev.status && (ev.status.displayClock || ev.status.type.detail)) || '';
  const min = /(\d+)'/.exec(clock);
  // ESPN scoreboard details carry the scoring plays (best effort — the shape varies).
  const scorers = (comp.details || []).filter(dt => {
    const tx = (dt.type && dt.type.text) || '';
    return /goal/i.test(tx) && !/miss/i.test(tx);
  }).map(dt => {
    const ck = (dt.clock && dt.clock.displayValue) || (dt.type && dt.type.detail) || '';
    const mm = /(\d+)'/.exec(ck || '');
    const ath = (dt.athletesInvolved && dt.athletesInvolved[0]) || {};
    const tid = dt.team && dt.team.id != null ? String(dt.team.id) : null;
    const team = tid == null ? null : tid === String(((pick('home').team) || {}).id) ? 'home' : tid === String(((pick('away').team) || {}).id) ? 'away' : null;
    return goalRow(mm ? +mm[1] : null, ath.displayName || ath.shortName, team, /own/i.test((dt.type && dt.type.text) || ''));
  }).filter(Boolean);
  return {
    id: 'espn-' + ev.id, ts: Math.floor(Date.parse(ev.date) / 1000), state,
    short: state === 'live' ? (min ? min[1] : 'LIVE') : state === 'finished' ? 'FT' : 'NS',
    elapsed: state === 'live' && min ? +min[1] : null,
    venue: (comp.venue && comp.venue.fullName) || '',
    league: { id: leagueId, name: leagueName || (ev.league && ev.league.name) || '', logo: '', country: '', round: (comp.notes && comp.notes[0] && comp.notes[0].headline) || '' },
    home: side(pick('home')), away: side(pick('away')),
    hg: score(pick('home')), ag: score(pick('away')),
    scorers
  };
}
async function espnDayFixtures(env, leagueId, ds) {
  const slug = ESPN_SLUG_BY_LEAGUE[leagueId];
  if (!slug) return { fixtures: [] };
  return cached(env, 'espn:day:' + leagueId + ':' + ds, 300, async () => {
    const j = await espnGet(slug + '/scoreboard', { dates: ds.replace(/-/g, '') });
    const events = j.events || [];
    const name = j.leagues && j.leagues[0] && j.leagues[0].name;
    return { fixtures: events.map(e => espnFixture(e, leagueId, name)) };
  });
}
async function espnLiveFixtures(env) {
  const today = new Date().toISOString().slice(0, 10);
  return cached(env, 'espn:live:' + today, ttl(env, 'live'), async () => {
    const leagues = Object.keys(ESPN_SLUG_BY_LEAGUE).map(Number);
    const settled = await Promise.allSettled(leagues.map(id => espnDayFixtures(env, id, today)));
    const out = settled.filter(r => r.status === 'fulfilled').flatMap(r => r.value.fixtures).filter(f => f.state === 'live');
    return { fixtures: out.sort(sortFx) };
  });
}
/* ---------- fixtures by day / live ---------- */
async function dayFrom(env, p, src, ds) {
  const todayUtc = utcDate(Date.now() / 1000);
  const t = ds === todayUtc ? ttl(env, 'today') : ds > todayUtc ? 3600 : 6 * 3600;
  return cached(env, src + ':day:' + ds + ':' + planKey(p), t, async () => {
    if (src === 'fd') {
      const j = await fdGet(env, '/matches', { dateFrom: ds, dateTo: addUtcDay(ds, 1) }); // wider range, filtered below (safe whether dateTo is inclusive or not)
      return { fixtures: (j.matches || []).filter(m => String(m.utcDate || '').startsWith(ds)).map(m => fdFixture(m)).filter(f => f && p.fd.has(f.league.id)) };
    }
    const j = await afGet(env, 'fixtures', { date: ds });
    return { fixtures: (j.response || []).filter(f => p.af.has(f.league.id)).map(afFixture) };
  });
}
/* Cross-provider fallback for one day/source. Quota economy: the alternate
   provider is tried ONLY when the primary returns nothing (failure is
   surfaced by cached() as a stale copy when one exists, or as an empty
   result here) — never on every request. Order: other keyed provider,
   then ESPN, then FotMob. */
// One call per tracked league, in parallel; returns the combined fixture
// list (or []). The day + live fallback chains share it so the "try every
// league, keep the first hit" pattern lives in one place.
async function fixturesFromAllLeagues(env, leagueIds, ds, dayFn) {
  const settled = await Promise.allSettled(leagueIds.map(id => dayFn(env, id, ds)));
  return settled.filter(r => r.status === 'fulfilled').flatMap(r => r.value.fixtures).sort(sortFx);
}
function altPlan(p, src, leagueIds) {
  const ids = [...leagueIds];
  if (src === 'fd') return { mock: false, af: new Set(ids), fd: new Set(), allowed: p.allowed };
  return { mock: false, af: new Set(), fd: new Set(ids.filter(id => FD_LEAGUES.has(id))), allowed: p.allowed };
}
async function dayFromWithFallback(env, p, src, ds) {
  let primary, primaryErr = null;
  try { primary = await dayFrom(env, p, src, ds); }
  catch (e) { primaryErr = e; primary = { fixtures: [] }; }
  if (primary.fixtures && primary.fixtures.length) return primary;
  const leagueIds = [...p[src]];
  if (!leagueIds.length) { if (primaryErr) throw primaryErr; return primary; }
  const altSrc = src === 'fd' ? 'af' : 'fd';
  const hasAltKey = altSrc === 'af' ? !!env.API_KEY : !!env.FD_KEY;
  if (hasAltKey) {
    try {
      const alt = await dayFrom(env, altPlan(p, src, leagueIds), altSrc, ds);
      if (alt.fixtures && alt.fixtures.length) return Object.assign({}, alt, { partial: true });
    } catch (e) { /* fall through to ESPN */ }
  }
  // Keyless fallbacks, in order: ESPN, then FotMob (real league ids via
  // the verified primaryId map). Only when the keyed sources returned
  // nothing for this day.
  const espnOut = await fixturesFromAllLeagues(env, leagueIds, ds, espnDayFixtures);
  if (espnOut.length) return { fixtures: espnOut, partial: true };
  const fmOut = await fixturesFromAllLeagues(env, leagueIds, ds, fmDayFixtures);
  if (fmOut.length) return { fixtures: fmOut, partial: true };
  if (primaryErr) throw primaryErr;
  return primary;
}
/* ---------- API-Football goalscorers for one finished fixture ---------- */
// One cached /fixtures/events call per fixture (1h — a finished match's
// scorers never change), so enriching a day costs ~1 AF call per finished
// match, and the daily budget guard still caps everything at 85/day.
/* ---------- ESPN goalscorers (FD has no scorers anywhere) ---------- */
// ESPN's public scoreboard carries every scoring play (minute, scorer,
// team). One cached call per league+date; fixtures are matched to events by
// normalised team names (both teams must match). Cached as [key, scorers]
// pairs because the KV cache is JSON.
function normTeam(s) {
  // "Man City" / "Man Utd" (FD short names) vs "Manchester City" (ESPN).
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\bman\b/g, 'manchester');
}
// Loose team-name match: FD short names ("LASK", "PSV", "Sl. Bratislava")
// vs ESPN display names ("LASK Linz", "PSV Eindhoven", "Slovan Bratislava").
const TEAM_STOP = new Set(['real', 'club', 'united', 'city', 'athletic', 'town', 'rovers', 'albion', 'county', 'cf', 'sc', 'ac', 'as', 'fc']);
function teamMatch(a, b) {
  a = normTeam(a); b = normTeam(b);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  // A shared distinctive word ("aek" in "PAE AEK" / "AEK Athens"), except
  // a word that is the first word of both names ("Manchester" in both
  // Manchester clubs — that is the city, not the club).
  const ta = a.split(' ').filter(w => w.length >= 3 && !TEAM_STOP.has(w));
  const tb = b.split(' ').filter(w => w.length >= 3 && !TEAM_STOP.has(w));
  const firstA = a.split(' ')[0], firstB = b.split(' ')[0];
  return ta.some(w => tb.includes(w) && !(w === firstA && w === firstB));
}
async function espnScoreboardScorers(env, leagueId, ds) {
  const slug = ESPN_SLUG_BY_LEAGUE[leagueId];
  if (!slug) return [];
  const rows = await cached(env, 'espn:scorers:v2:' + leagueId + ':' + ds, 3600, async () => {
    const j = await espnGet(slug + '/scoreboard', { dates: ds.replace(/-/g, '') });
    const out = [];
    (j.events || []).forEach(ev => {
      const comp = (ev.competitions && ev.competitions[0]) || {};
      const comps = comp.competitors || [];
      const pick = side => comps.find(c => c.homeAway === side) || {};
      const homeTid = String(((pick('home').team) || {}).id);
      const scorers = (comp.details || []).filter(d => d.scoringPlay).map(d => {
        const mm = /(\d+)'/.exec((d.clock && d.clock.displayValue) || '');
        const ath = (d.athletesInvolved && d.athletesInvolved[0]) || {};
        const tid = d.team && d.team.id != null ? String(d.team.id) : null;
        return goalRow(mm ? +mm[1] : null, ath.displayName || ath.shortName, tid == null ? null : tid === homeTid ? 'home' : 'away', !!d.ownGoal);
      }).filter(Boolean);
      if (!scorers.length) return;
      const hn = ((pick('home').team) || {}).displayName, an = ((pick('away').team) || {}).displayName;
      if (hn && an) out.push([hn, an, scorers]);
    });
    return out;
  }).catch(() => []);
  return rows;
}
async function afGoalScorers(env, fixtureId, homeId, awayId) {
  return cached(env, 'af:scorers:' + fixtureId, 3600, async () => {
    const j = await afGet(env, 'fixtures/events', { fixture: fixtureId });
    return (j.response || []).filter(e => (e.type || '') === 'Goal' && (e.detail || '') !== 'Missed Penalty').map(e => goalRow(
      e.time && e.time.elapsed, e.player && e.player.name,
      String(e.team && e.team.id) === String(homeId) ? 'home' : 'away',
      (e.detail || '') === 'Own Goal'
    )).filter(Boolean);
  }).catch(() => []);
}
async function getRange(env, from, to) {
  if (!(from > 0 && to > from)) throw new HttpError(400, 'bad range');
  if (to - from > 3 * 86400) throw new HttpError(400, 'range too large');
  const p = plan(env);
  const dates = [...new Set([utcDate(from), utcDate(to - 1)])];
  const jobs = [];
  dates.forEach(d => { if (p.fd.size) jobs.push(dayFromWithFallback(env, p, 'fd', d)); if (p.af.size) jobs.push(dayFromWithFallback(env, p, 'af', d)); });
  const settled = await Promise.allSettled(jobs);
  const ok = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!ok.length) throw settled[0] && settled[0].reason instanceof HttpError ? settled[0].reason : new HttpError(502, 'no data');
  const seen = new Set(), out = [];
  ok.forEach(r => r.fixtures.forEach(f => { if (f.ts >= from && f.ts < to && !seen.has(f.id)) { seen.add(f.id); out.push(f); } }));
  out.sort(sortFx);
  // Goalscorers for finished fixtures. AF (Egypt/cups) via cached events
  // calls, in parallel (max 8). FD has no scorers at all, so its fixtures
  // are matched to ESPN's public scoreboard (one cached call per
  // league+date, no key, no quota).
  const needSc = out.filter(f => f.state === 'finished' && !(f.scorers && f.scorers.length));
  const needAf = needSc.filter(f => String(f.id || '').startsWith('af-'));
  const needFd = needSc.filter(f => String(f.id || '').startsWith('fd-'));
  await Promise.all(needAf.slice(0, 8).map(async f => {
    const rows = await afGoalScorers(env, String(f.id).slice(3), String(f.home.id).replace('af-', ''), String(f.away.id).replace('af-', ''));
    if (rows.length) f.scorers = rows;
  }));
  const byLeagueDate = new Map();
  for (const f of needFd.slice(0, 12)) {
    const key = f.league.id + ':' + utcDate(f.ts);
    if (!byLeagueDate.has(key)) byLeagueDate.set(key, espnScoreboardScorers(env, f.league.id, utcDate(f.ts)));
    const rows = await byLeagueDate.get(key);
    const hit = rows.find(([hn, an]) => teamMatch(f.home.name, hn) && teamMatch(f.away.name, an));
    if (hit && hit[2] && hit[2].length) f.scorers = hit[2];
  }
  const partial = settled.some(r => r.status === 'rejected');
  return { fixtures: out, stale: ok.some(r => r.stale) || undefined, partial: partial || undefined };
}
async function liveFrom(env, p, src) {
  if (src === 'fd') return cached(env, 'fd:live:' + planKey(p), ttl(env, 'live'), async () => {
    const j = await fdGet(env, '/matches', { status: 'IN_PLAY,PAUSED' });
    return { fixtures: (j.matches || []).map(m => fdFixture(m)).filter(f => f && p.fd.has(f.league.id)) };
  });
  return cached(env, 'af:live:' + planKey(p), ttl(env, 'live'), async () => {
    const j = await afGet(env, 'fixtures', { live: 'all' });
    return { fixtures: (j.response || []).filter(f => p.af.has(f.league.id)).map(afFixture) };
  });
}
async function getLive(env) {
  const p = plan(env);
  const jobs = [];
  if (p.fd.size) jobs.push(liveFrom(env, p, 'fd'));
  if (p.af.size) jobs.push(liveFrom(env, p, 'af'));
  const settled = await Promise.allSettled(jobs);
  const ok = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
  let out = ok.flatMap(r => r.fixtures).sort(sortFx);
  let partial = settled.some(r => r.status === 'rejected');
  let stale = ok.some(r => r.stale);
  // A source that failed entirely: try the other keyed provider for its leagues.
  const failedSrcs = [];
  if (p.fd.size && settled[0] && settled[0].status === 'rejected') failedSrcs.push('fd');
  if (p.af.size && settled[p.fd.size ? 1 : 0] && settled[p.fd.size ? 1 : 0].status === 'rejected') failedSrcs.push('af');
  for (const src of failedSrcs) {
    const altSrc = src === 'fd' ? 'af' : 'fd';
    const hasAltKey = altSrc === 'af' ? !!env.API_KEY : !!env.FD_KEY;
    if (!hasAltKey) continue;
    try {
      const alt = await liveFrom(env, altPlan(p, src, [...p[src]]), altSrc);
      const fresh = alt.fixtures.filter(f => p[src].has(f.league.id));
      if (fresh.length) { out = [...out, ...fresh].sort(sortFx); partial = true; }
    } catch (e) { /* fall through to ESPN */ }
  }
  // Both keyed providers failed (or returned nothing live): keyless
  // fallbacks in order — ESPN, then FotMob. An empty live list is the
  // honest answer when no tracked league has a live match.
  for (const get of [espnLiveFixtures, fmLiveFixtures]) {
    if (out.length) break;
    try {
      const r = await get(env);
      if (r.fixtures.length) { out = r.fixtures; partial = true; }
    } catch (e) { /* try the next source */ }
  }
  if (!ok.length && !out.length) throw settled[0] && settled[0].reason instanceof HttpError ? settled[0].reason : new HttpError(502, 'no data');
  return { fixtures: out, stale: stale || undefined, partial: partial || undefined };
}

/* ---------- standings & top scorers ---------- */
function parseLeagueId(raw) {
  const n = +raw;
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'bad league');
  return n;
}
function afStandingRow(r) {
  const all = r.all || {};
  const goals = all.goals || {};
  return {
    position: r.rank, team: { id: 'af-' + r.team.id, name: r.team.name, logo: r.team.logo || '' },
    played: all.played || 0, won: all.win || 0, drawn: all.draw || 0, lost: all.lose || 0,
    gf: goals.for == null ? 0 : goals.for, ga: goals.against == null ? 0 : goals.against,
    gd: r.goalsDiff == null ? (goals.for || 0) - (goals.against || 0) : r.goalsDiff,
    points: r.points || 0, form: r.form || ''
  };
}
function fdStandingRow(r) {
  return {
    position: r.position, team: { id: 'fd-' + r.team.id, name: r.team.name, logo: r.team.crest || '' },
    played: r.playedGames || 0, won: r.won || 0, drawn: r.draw || 0, lost: r.lost || 0,
    gf: r.goalsFor || 0, ga: r.goalsAgainst || 0, gd: r.goalDifference || 0,
    points: r.points || 0, form: r.form || ''
  };
}
function espnStandingRow(e) {
  const stat = name => { const s = (e.stats || []).find(x => x.name === name); return s ? +s.value : 0; };
  const team = e.team || {};
  return {
    position: stat('rank') || e.rank || 0, team: { id: 'espn-' + (team.id || '?'), name: team.displayName || team.shortDisplayName || team.name || '?', logo: team.logo || '' },
    played: stat('gamesPlayed'), won: stat('wins'), drawn: stat('ties'), lost: stat('losses'),
    gf: stat('pointsFor'), ga: stat('pointsAgainst'), gd: stat('pointDifferential'),
    points: stat('points'), form: ''
  };
}
async function getStandings(env, rawLeague) {
  const league = parseLeagueId(rawLeague);
  const p = plan(env);
  return cached(env, 'standings:' + league + ':' + planKey(p), 3600, async () => {
    // 1) API-Football
    if (env.API_KEY || p.mock) {
      try {
        const j = await afGet(env, 'standings', { league, season: currentSeason() });
        const table = j.response && j.response[0] && j.response[0].league && j.response[0].league.standings && j.response[0].league.standings[0];
        if (table && table.length) return { league: { id: league, name: (j.response[0].league && j.response[0].league.name) || '' }, standings: table.map(afStandingRow) };
      } catch (e) { if (p.mock) throw e; /* try the next source */ }
    }
    // 2) football-data.org (only for its competitions)
    const code = FD_LEAGUE_TO_CODE[league];
    if (code && env.FD_KEY) {
      try {
        const j = await fdGet(env, '/competitions/' + code + '/standings');
        const table = j.standings && j.standings[0] && j.standings[0].table;
        if (table && table.length) return { league: { id: league, name: (j.competition && j.competition.name) || '' }, standings: table.map(fdStandingRow) };
      } catch (e) { /* try the next source */ }
    }
    // 3) FotMob (no key) — the only standings source for AF-only leagues
    // while AF standings fail (see fmStandings). Only reached when AF +
    // FD have nothing, so FD-covered leagues never change.
    try {
      const fm = await fmStandings(env, league);
      if (fm) return fm;
    } catch (e) { /* try the next source */ }
    // 4) ESPN, no key — except Egypt (233): ESPN answers
    // {"code":404,"message":"League 'egy.1' not found"} for egy.1 standings
    // (verified 2026-11-25 09:33 UTC), so there is no ESPN standings
    // fallback for Egypt; AF is the only standings source there.
    const slug = ESPN_SLUG_BY_LEAGUE[league];
    if (slug && league !== 233) {
      try {
        const j = await espnGet(slug + '/standings', { season: currentSeason() });
        const entries = j.children && j.children[0] && j.children[0].standings && j.children[0].standings.entries;
        if (entries && entries.length) return { league: { id: league, name: (j.name || j.shortName || '') }, standings: entries.map(espnStandingRow).sort((a, b) => a.position - b.position) };
      } catch (e) { /* no more sources */ }
    }
    throw new HttpError(502, 'standings unavailable');
  });
}
async function getScorers(env, rawLeague) {
  const league = parseLeagueId(rawLeague);
  const p = plan(env);
  return cached(env, 'scorers:' + league + ':' + planKey(p), 3600, async () => {
    // 1) API-Football
    if (env.API_KEY || p.mock) {
      try {
        const j = await afGet(env, 'players/topscorers', { league, season: currentSeason() });
        const rows = (j.response || []).map(r => {
          const s = (r.statistics && r.statistics[0]) || {};
          const tm = s.team || {};
          return {
            player: (r.player && r.player.name) || '?', team: { id: tm.id ? 'af-' + tm.id : '', name: tm.name || '', logo: tm.logo || '' },
            goals: (s.goals && s.goals.total) || 0, assists: (s.goals && s.goals.assists) || 0, played: (s.games && s.games.appearences) || 0
          };
        }).filter(r => r.goals > 0);
        if (rows.length) return { scorers: rows.slice(0, 20) };
      } catch (e) { if (p.mock) throw e; /* try the next source */ }
    }
    // 2) football-data.org
    const code = FD_LEAGUE_TO_CODE[league];
    if (code && env.FD_KEY) {
      try {
        const j = await fdGet(env, '/competitions/' + code + '/scorers');
        const rows = (j.scorers || []).map(s => ({
          player: (s.player && s.player.name) || '?', team: { id: s.team ? 'fd-' + s.team.id : '', name: (s.team && s.team.name) || '', logo: (s.team && s.team.crest) || '' },
          goals: s.goals || 0, assists: s.assists || 0, played: s.playedGames || 0
        }));
        if (rows.length) return { scorers: rows.slice(0, 20) };
      } catch (e) { /* try the next source */ }
    }
    // 3) FotMob (no key) — full top-scorers list with assists, see fmScorers.
    // Only reached when AF + FD have nothing.
    try {
      const fm = await fmScorers(env, league);
      if (fm) return fm;
    } catch (e) { /* try the next source */ }
    // 4) ESPN leaders (best effort — the shape varies by league, so parse defensively).
    const slug = ESPN_SLUG_BY_LEAGUE[league];
    if (slug) {
      try {
        const j = await espnGet(slug + '/leaders');
        const cats = (j.leaders || []).flatMap(g => g.categories || []);
        const goalsCat = cats.find(c => /goal/i.test(c.name || c.displayName || ''));
        const rows = (goalsCat && goalsCat.leaders ? goalsCat.leaders : []).map(l => ({
          player: (l.athlete && l.athlete.displayName) || '?', team: { id: l.team ? 'espn-' + l.team.id : '', name: (l.team && l.team.displayName) || '', logo: (l.team && l.team.logo) || '' },
          goals: +l.value || 0, assists: 0, played: 0
        }));
        if (rows.length) return { scorers: rows.slice(0, 20) };
      } catch (e) { /* no more sources */ }
    }
    throw new HttpError(502, 'scorers unavailable');
  });
}

/* ---------- team search ---------- */
const flat = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
async function fdTeamIndex(env) {
  return cached(env, 'fd:teams', 7 * 86400, async () => {
    const j = await fdGet(env, '/teams', { limit: 500 });
    return { teams: (j.teams || []).map(t => ({ id: 'fd-' + t.id, name: t.shortName || t.name, full: t.name, tla: t.tla || '', country: (t.area && t.area.name) || '', logo: t.crest || '' })) };
  });
}
async function searchTeams(env, q) {
  q = q.trim();
  if (q.length < 3) return { teams: [] };
  const p = plan(env), nq = flat(q);
  return cached(env, 'search:' + nq + ':' + planKey(p), 86400, async () => {
    let out = [];
    if (p.fd.size) {
      try {
        const idx = await fdTeamIndex(env);
        out = idx.teams.filter(t => flat(t.name).includes(nq) || flat(t.full).includes(nq) || flat(t.tla) === nq)
          .slice(0, 15).map(t => ({ id: t.id, name: t.name, country: t.country, logo: t.logo }));
      } catch (e) { if (!p.af.size) throw e; }
    }
    // Only spend an API-Football request when the other source found nothing (saves the small daily quota).
    if (!out.length && p.af.size) {
      const j = await afGet(env, 'teams', { search: q });
      out = (j.response || []).slice(0, 15).map(r => ({ id: 'af-' + r.team.id, name: r.team.name, country: r.team.country || '', logo: r.team.logo || '' }));
    }
    return { teams: out };
  });
}

/* ---------- team page ---------- */
function parseId(raw) {
  const m = /^(af|fd)-(\d+)$/.exec(raw || '');
  if (!m) throw new HttpError(400, 'bad id');
  return { src: m[1], num: +m[2] };
}
async function getTeam(env, raw) {
  const { src, num } = parseId(raw);
  const p = plan(env);
  if (src === 'fd' && !env.FD_KEY) throw new HttpError(404, 'source not configured');
  if (src === 'af' && !env.API_KEY && !p.mock) throw new HttpError(404, 'source not configured');
  // Last-5 form, most recent last: W/D/L from the team's point of view.
  const teamForm = (list, teamNum) => {
    const fin = list.filter(f => f.state === 'finished').slice(-5);
    return fin.map(f => {
      const isHome = String(f.home.id).replace(/^(af|fd|espn)-/, '') === String(teamNum);
      const gf = isHome ? f.hg : f.ag, ga = isHome ? f.ag : f.hg;
      if (gf == null || ga == null) return 'D';
      return gf > ga ? 'W' : gf < ga ? 'L' : 'D';
    });
  };
  return cached(env, 'team:' + raw + ':' + p.mock, ttl(env, 'team'), async () => {
    if (src === 'fd') {
      const j = await fdGet(env, '/teams/' + num + '/matches'); // current season
      const list = (j.matches || []).map(m => fdFixture(m, true)).filter(Boolean).sort(sortFx);
      const now = Date.now() / 1000;
      const past = list.filter(f => f.ts < now).slice(-8), next = list.filter(f => f.ts >= now).slice(0, 8);
      return { fixtures: [...past, ...next], form: teamForm(list, num) };
    }
    const [last, next] = await Promise.all([afGet(env, 'fixtures', { team: num, last: 8 }), afGet(env, 'fixtures', { team: num, next: 8 })]);
    const seen = new Set(), out = [];
    [...(last.response || []), ...(next.response || [])].forEach(f => { if (!seen.has(f.fixture.id)) { seen.add(f.fixture.id); out.push(afFixture(f)); } });
    out.sort(sortFx);
    return { fixtures: out, form: teamForm(out, num) };
  });
}

/* ---------- head-to-head (API-Football only) ---------- */
async function getH2H(env, homeRaw, awayRaw) {
  const home = /^(af|fd)-(\d+)$/.exec(homeRaw || '');
  const away = /^(af|fd)-(\d+)$/.exec(awayRaw || '');
  if (!home || !away) throw new HttpError(400, 'bad team id');
  const empty = { matches: [], summary: { homeWins: 0, draws: 0, awayWins: 0 }, unavailable: true };
  // Only API-Football exposes head-to-head; FD/ESPN teams have no equivalent.
  if (home[1] !== 'af' || away[1] !== 'af') return empty;
  const p = plan(env);
  if (!env.API_KEY && !p.mock) return empty;
  const homeNum = +home[2], awayNum = +away[2];
  return cached(env, 'h2h:' + homeNum + '-' + awayNum + ':' + p.mock, 3600, async () => {
    const j = await afGet(env, 'fixtures/headtohead', { h2h: homeNum + '-' + awayNum, last: 5 });
    const matches = (j.response || []).map(afFixture).sort((a, b) => b.ts - a.ts);
    const summary = { homeWins: 0, draws: 0, awayWins: 0 };
    matches.forEach(f => {
      if (f.hg == null || f.ag == null || f.state !== 'finished') return;
      if (f.hg === f.ag) { summary.draws++; return; }
      const winnerHome = f.hg > f.ag;
      const winnerId = winnerHome ? f.home.id : f.away.id;
      if (winnerId === 'af-' + homeNum) summary.homeWins++; else summary.awayWins++;
    });
    return { matches, summary };
  });
}

/* ---------- match details ---------- */
async function getFixture(env, raw) {
  // FotMob-sourced fixtures (fm- ids) get their detail from FotMob's
  // matchDetails endpoint — stats, events, lineups and ratings included.
  if (String(raw || '').startsWith('fm-')) return getFmFixture(env, raw.slice(3));
  const { src, num } = parseId(raw);
  const p = plan(env);
  if (src === 'fd') {
    if (!env.FD_KEY) throw new HttpError(404, 'source not configured');
    const m = await cached(env, 'fd:match:' + num, 60, async () => {
      const j = await fdGet(env, '/matches/' + num);
      if (!j || !j.id) throw new HttpError(404, 'not found');
      return j;
    });
    const fx = fdFixture(m, true);
    const tid = t => 'fd-' + t.id;
    const events = [];
    (m.goals || []).forEach(g => events.push({ min: g.minute, extra: g.injuryTime || null, team: g.team ? tid(g.team) : '', player: (g.scorer && g.scorer.name) || '', assist: (g.assist && g.assist.name) || '', type: 'Goal', detail: g.type === 'OWN' ? 'Own Goal' : g.type === 'PENALTY' ? 'Penalty' : 'Normal Goal' }));
    (m.bookings || []).forEach(b => events.push({ min: b.minute, extra: null, team: b.team ? tid(b.team) : '', player: (b.player && b.player.name) || '', assist: '', type: 'Card', detail: b.card === 'RED' ? 'Red Card' : b.card === 'YELLOW_RED' ? 'Second Yellow card' : 'Yellow Card' }));
    (m.substitutions || []).forEach(s => events.push({ min: s.minute, extra: null, team: s.team ? tid(s.team) : '', player: (s.playerOut && s.playerOut.name) || '', assist: (s.playerIn && s.playerIn.name) || '', type: 'subst', detail: 'Substitution' }));
    events.sort((a, b) => (a.min || 0) - (b.min || 0));
    return { fixture: fx, stats: [], events, lineups: {}, noStats: true, stale: m.stale };
  }
  if (!env.API_KEY && !p.mock) throw new HttpError(404, 'source not configured');
  const base = await cached(env, 'af:fx:' + num + ':' + p.mock, ttl(env, 'detailLive'), async () => {
    const j = await afGet(env, 'fixtures', { id: num });
    if (!j.response || !j.response.length) throw new HttpError(404, 'not found');
    return { fixture: afFixture(j.response[0]) };
  });
  const st = base.fixture.state;
  const t = st === 'live' ? ttl(env, 'detailLive') : st === 'upcoming' ? 600 : 3600;
  // Player ratings (API-Football /fixtures/players). Never fail the fixture
  // if ratings are missing — they only exist once a match has started.
  const ratings = await cached(env, 'af:players:' + num + ':' + p.mock, t, async () => {
    const j = await afGet(env, 'fixtures/players', { fixture: num });
    const byId = {}, byName = {};
    (j.response || []).forEach(r => (r.players || []).forEach(pl => {
      const st0 = (pl.statistics && pl.statistics[0]) || {};
      const raw = st0.games && st0.games.rating;
      const rating = raw == null ? null : parseFloat(raw);
      if (rating == null || isNaN(rating)) return;
      if (pl.player && pl.player.id != null) byId[pl.player.id] = rating;
      if (pl.player && pl.player.name) byName[pl.player.name.toLowerCase()] = rating;
    }));
    return { byId, byName };
  }).catch(() => ({ byId: {}, byName: {} }));
  const [stats, events, lineups] = await Promise.all([
    cached(env, 'af:stats:' + num + ':' + p.mock, t, async () => {
      const j = await afGet(env, 'fixtures/statistics', { fixture: num });
      return { stats: (j.response || []).map(r => ({ team: 'af-' + r.team.id, rows: (r.statistics || []).map(s => ({ type: s.type, value: s.value })) })) };
    }).catch(() => ({ stats: [] })),
    cached(env, 'af:events:' + num + ':' + p.mock, t, async () => {
      const j = await afGet(env, 'fixtures/events', { fixture: num });
      return { events: (j.response || []).map(e => ({ min: e.time.elapsed, extra: e.time.extra, team: 'af-' + e.team.id, player: (e.player && e.player.name) || '', assist: (e.assist && e.assist.name) || '', type: e.type, detail: e.detail || '' })) };
    }).catch(() => ({ events: [] })),
    // Lineups are only available from API-Football. Unavailable (not yet
    // announced, or a cup match) => empty object, never an error.
    cached(env, 'af:lineups:' + num + ':' + p.mock, t, async () => {
      const j = await afGet(env, 'fixtures/lineups', { fixture: num });
      return { lineups: normalizeLineups(j.response || [], base.fixture, ratings) };
    }).catch(() => ({ lineups: {} }))
  ]);
  return { fixture: base.fixture, stats: stats.stats, events: events.events, lineups: lineups.lineups || {}, stale: base.stale };
}
function normalizeLineups(rows, fixture, ratings) {
  const ratingFor = pl => {
    if (!pl || !pl.player) return null;
    if (ratings && ratings.byId && pl.player.id != null && ratings.byId[pl.player.id] != null) return ratings.byId[pl.player.id];
    if (ratings && ratings.byName && pl.player.name && ratings.byName[pl.player.name.toLowerCase()] != null) return ratings.byName[pl.player.name.toLowerCase()];
    if (pl.player.rating != null) { const r = parseFloat(pl.player.rating); return isNaN(r) ? null : r; }
    return null;
  };
  const player = pl => ({ player: (pl.player && pl.player.name) || '?', number: (pl.player && pl.player.number) || null, pos: (pl.player && pl.player.pos) || '', rating: ratingFor(pl) });
  const side = r => ({
    formation: r.formation || '',
    coach: (r.coach && r.coach.name) || '',
    xi: (r.startXI || []).map(player),
    subs: (r.substitutes || []).map(player)
  });
  const out = {};
  rows.forEach(r => {
    const id = r.team && r.team.id;
    if (String(id) === String((fixture.home.id || '').replace('af-', ''))) out.home = side(r);
    else if (String(id) === String((fixture.away.id || '').replace('af-', ''))) out.away = side(r);
  });
  return out;
}

/* ---------- cache warming (approved 2026-11-25) ----------
   Warms ONLY the cheap sources, never API-Football: a warm that spent AF
   would burn the 100/day budget (already at 85/100 on 2026-11-25 09:28 UTC).
   - football-data.org day fixtures for today (its 10 leagues, no daily cap)
   - ESPN day fixtures for today (no key)
   - FotMob's whole day in one call (no key; all leagues at once)
   Called by GET /warm (manual test) and by the Cron Trigger in
   wrangler.toml ([triggers] crons, every 30 minutes) via scheduled(). */
export async function warmCache(env) {
  const p = plan(env);
  const today = new Date().toISOString().slice(0, 10);
  const jobs = [];
  if (p.fd.size) jobs.push(dayFrom(env, p, 'fd', today).catch(() => null));
  jobs.push(...Object.keys(ESPN_SLUG_BY_LEAGUE).map(id => espnDayFixtures(env, +id, today).catch(() => null)));
  // FotMob's whole day in ONE call (all leagues), so its fallback cache is
  // warm too. No key, no AF budget involved.
  jobs.push(fmDayRaw(env, today).catch(() => null));
  const settled = await Promise.allSettled(jobs);
  return { warmed: settled.filter(r => r.status === 'fulfilled' && r.value).length, attempted: jobs.length, date: today };
}

/* ---------- entry ---------- */
export async function handle(request, env, ctx) {
  env = env || {};
  if (ctx && typeof ctx.waitUntil === 'function') bgRunner = ctx.waitUntil.bind(ctx);
  else bgRunner = null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;
  try {
    if (path === '/' || path === '/health') {
      const p = plan(env);
      sourceStatus.apiFootball.configured = !!env.API_KEY;
      sourceStatus.footballData.configured = !!env.FD_KEY;
      const afUsed = p.mock ? 0 : await afBudgetRead(env);
      return json({
        ok: true, mock: p.mock, economy: economy(env), cache: env.CACHE ? 'kv' : 'memory',
        sources: {
          footballData: { configured: sourceStatus.footballData.configured, leagues: p.fd.size, available: sourceStatus.footballData.available },
          apiFootball: { configured: sourceStatus.apiFootball.configured, leagues: p.af.size, available: sourceStatus.apiFootball.available, dailyUsed: afUsed, dailyBudget: AF_DAILY_LIMIT, budgetGuard: AF_DAILY_BUDGET },
          espn: { configured: true, keyless: true, available: sourceStatus.espn.available },
          fotmob: { configured: true, keyless: true, unofficial: true, available: sourceStatus.fotmob.available },
          sofascore: { configured: true, keyless: true, unofficial: true, available: sourceStatus.sofascore.available }
        }
      }, 200, 30);
    }
    if (path === '/probe') {
      const which = (q.get('source') || 'all').toLowerCase();
      const out = {};
      if (which === 'all' || which === 'fotmob') out.fotmob = await probeFotmob(env);
      if (which === 'all' || which === 'sofascore') out.sofascore = await probeSofascore(env);
      return json(out, 200, 0);
    }
    if (path === '/warm') return json(await warmCache(env), 200, 0);
    if (path === '/fixtures') return json(await getRange(env, +q.get('from'), +q.get('to')), 200, 20);
    if (path === '/version') return json({ version: LATEST_VERSION.version, downloadUrl: LATEST_VERSION.downloadUrl, notes: LATEST_VERSION.notes }, 200, 300);
    if (path === '/live') return json(await getLive(env), 200, 15);
    if (path === '/search') return json(await searchTeams(env, q.get('q') || ''), 200, 3600);
    if (path === '/standings') return json(await getStandings(env, q.get('league') || ''), 200, 3600);
    if (path === '/scorers') return json(await getScorers(env, q.get('league') || ''), 200, 3600);
    if (path === '/h2h') return json(await getH2H(env, q.get('home') || '', q.get('away') || ''), 200, 3600);
    let m;
    if ((m = path.match(/^\/team\/([\w-]+)$/))) return json(await getTeam(env, m[1]), 200, 60);
    if ((m = path.match(/^\/fixture\/([\w-]+)$/))) return json(await getFixture(env, m[1]), 200, 15);
    return json({ error: 'not found' }, 404);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e instanceof HttpError ? e.message : 'server error' }, status);
  }
}
function json(body, status, maxAge) {
  const headers = Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS);
  if (maxAge && status === 200) headers['cache-control'] = 'public, max-age=' + maxAge;
  return new Response(JSON.stringify(body), { status, headers });
}
