// Demo data in the same shape API-Football returns, so the whole app can be tried without a key.
// Used automatically when API_KEY is not set (or MOCK=1).

const LEAGUES = [
  { id: 233, name: 'Premier League', country: 'Egypt', teams: ['Al Ahly', 'Zamalek', 'Pyramids FC', 'Ceramica Cleopatra', 'Al Masry', 'ENPPI', 'Future FC', 'Smouha', 'Ismaily', 'Modern Sport'] },
  { id: 39, name: 'Premier League', country: 'England', teams: ['Arsenal', 'Chelsea', 'Liverpool', 'Manchester City', 'Tottenham', 'Newcastle', 'Aston Villa', 'Everton'] },
  { id: 140, name: 'La Liga', country: 'Spain', teams: ['Real Madrid', 'Barcelona', 'Atletico Madrid', 'Sevilla', 'Villarreal', 'Real Sociedad'] },
  { id: 135, name: 'Serie A', country: 'Italy', teams: ['Inter', 'AC Milan', 'Juventus', 'Napoli', 'Roma', 'Lazio'] },
  { id: 78, name: 'Bundesliga', country: 'Germany', teams: ['Bayern Munich', 'Borussia Dortmund', 'RB Leipzig', 'Bayer Leverkusen', 'Eintracht Frankfurt', 'Stuttgart'] },
  { id: 61, name: 'Ligue 1', country: 'France', teams: ['Paris Saint Germain', 'Marseille', 'Lyon', 'Monaco', 'Lille', 'Nice'] },
  { id: 2, name: 'UEFA Champions League', country: 'World', teams: ['Real Madrid', 'Manchester City', 'Bayern Munich', 'Inter', 'Arsenal', 'Barcelona', 'Paris Saint Germain', 'Liverpool'] }
];
const STATS = ['Shots on Goal', 'Shots off Goal', 'Total Shots', 'Blocked Shots', 'Corner Kicks', 'Offsides', 'Fouls', 'Ball Possession', 'Yellow Cards', 'Red Cards', 'Goalkeeper Saves', 'Total passes', 'Passes accurate', 'Passes %'];

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rnd(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const teamId = name => 1000 + (hash(name) % 9000);
const logoOf = () => '';

function build(ds, league, i, r) {
  const t = league.teams.slice();
  const a = t.splice(Math.floor(r() * t.length), 1)[0];
  const b = t[Math.floor(r() * t.length)];
  const hour = 11 + Math.floor(r() * 10), min = [0, 15, 30, 45][Math.floor(r() * 4)];
  const ts = Math.floor(Date.parse(ds + 'T' + String(hour).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':00Z') / 1000);
  const mins = (Date.now() / 1000 - ts) / 60;
  let short = 'NS', elapsed = null, hg = null, ag = null;
  const g = rnd(hash(ds + league.id + i));
  if (mins >= 0 && mins < 112) {
    elapsed = Math.min(90, Math.floor(mins));
    short = mins < 45 ? '1H' : mins < 60 ? 'HT' : '2H';
    if (short === 'HT') elapsed = 45; else if (short === '2H') elapsed = Math.min(90, Math.floor(mins - 15));
    hg = Math.floor(g() * 3 * (elapsed / 90 + 0.3)); ag = Math.floor(g() * 3 * (elapsed / 90 + 0.3));
  } else if (mins >= 112) {
    short = 'FT'; elapsed = 90; hg = Math.floor(g() * 4); ag = Math.floor(g() * 3);
  }
  return {
    fixture: { id: hash(ds + league.id + a + b) % 900000 + 100000, timestamp: ts, status: { short, elapsed }, venue: { name: a + ' Stadium' } },
    league: { id: league.id, name: league.name, logo: '', country: league.country, round: 'Regular Season' },
    teams: { home: { id: teamId(a), name: a, logo: logoOf(a) }, away: { id: teamId(b), name: b, logo: logoOf(b) } },
    goals: { home: hg, away: ag }
  };
}
function fixturesForDate(ds) {
  const out = [];
  LEAGUES.forEach(l => { const r = rnd(hash(ds + ':' + l.id)); const n = l.id === 233 ? 3 : 2; for (let i = 0; i < n; i++) out.push(build(ds, l, i, r)); });
  // Demo only: always have one match "in play" today so the Live tab is never empty.
  if (ds === new Date().toISOString().slice(0, 10)) {
    const l = LEAGUES[0]; const ts = Math.floor(Date.now() / 60000) * 60 - 33 * 60;
    out.push({
      fixture: { id: 777001, timestamp: ts, status: { short: '1H', elapsed: 33 }, venue: { name: 'Cairo International Stadium' } },
      league: { id: l.id, name: l.name, logo: '', country: l.country, round: 'Regular Season' },
      teams: { home: { id: teamId('Al Ahly'), name: 'Al Ahly', logo: '' }, away: { id: teamId('Zamalek'), name: 'Zamalek', logo: '' } },
      goals: { home: 1, away: 0 }
    });
  }
  return out;
}
const allKnown = () => {
  const out = []; const today = Date.now();
  for (let d = -10; d <= 10; d++) out.push(...fixturesForDate(new Date(today + d * 86400000).toISOString().slice(0, 10)));
  return out;
};

export function mockUpstream(path, p) {
  if (path === 'fixtures') {
    if (p.date) return { response: fixturesForDate(p.date) };
    if (p.live) { const now = Date.now(); const out = []; for (let d = -1; d <= 0; d++) out.push(...fixturesForDate(new Date(now + d * 86400000).toISOString().slice(0, 10))); return { response: out.filter(f => ['1H', 'HT', '2H'].includes(f.fixture.status.short)) }; }
    if (p.id) return { response: allKnown().filter(f => f.fixture.id === +p.id).slice(0, 1) };
    if (p.team) {
      const id = +p.team; const mine = allKnown().filter(f => f.teams.home.id === id || f.teams.away.id === id).sort((a, b) => a.fixture.timestamp - b.fixture.timestamp);
      const now = Date.now() / 1000;
      if (p.last) return { response: mine.filter(f => f.fixture.timestamp < now).slice(-p.last) };
      if (p.next) return { response: mine.filter(f => f.fixture.timestamp >= now).slice(0, p.next) };
    }
    return { response: [] };
  }
  if (path === 'teams') {
    const q = String(p.search || '').toLowerCase(); const seen = new Set(); const out = [];
    LEAGUES.forEach(l => l.teams.forEach(n => { if (n.toLowerCase().includes(q) && !seen.has(n)) { seen.add(n); out.push({ team: { id: teamId(n), name: n, country: l.country, logo: '' } }); } }));
    return { response: out };
  }
  if (path === 'fixtures/statistics') {
    const f = allKnown().find(x => x.fixture.id === +p.fixture);
    if (!f || f.fixture.status.short === 'NS') return { response: [] };
    const r = rnd(+p.fixture); const poss = 40 + Math.floor(r() * 21);
    const mk = (team, home) => ({ team: { id: team.id, name: team.name, logo: '' }, statistics: STATS.map(s => {
      let v; if (s === 'Ball Possession') v = (home ? poss : 100 - poss) + '%'; else if (s === 'Passes %') v = (78 + Math.floor(r() * 15)) + '%';
      else if (s === 'Total passes') v = 300 + Math.floor(r() * 300); else if (s === 'Passes accurate') v = 250 + Math.floor(r() * 250);
      else if (s === 'Red Cards') v = r() > 0.9 ? 1 : null; else v = Math.floor(r() * (s.includes('Shots') ? 12 : 8)); return { type: s, value: v }; }) });
    return { response: [mk(f.teams.home, true), mk(f.teams.away, false)] };
  }
  if (path === 'fixtures/events') {
    const f = allKnown().find(x => x.fixture.id === +p.fixture);
    if (!f || f.goals.home === null) return { response: [] };
    const r = rnd(+p.fixture + 7); const ev = [];
    const players = ['M. Salah', 'K. Mbappe', 'E. Haaland', 'V. Junior', 'Trezeguet', 'M. Abou Gabal', 'H. Kane', 'L. Yamal'];
    const mkEv = (team, type, detail) => ev.push({ time: { elapsed: 1 + Math.floor(r() * (f.fixture.status.elapsed || 90)), extra: null }, team: { id: team.id, name: team.name }, player: { name: players[Math.floor(r() * players.length)] }, assist: { name: r() > 0.5 ? players[Math.floor(r() * players.length)] : null }, type, detail });
    for (let i = 0; i < f.goals.home; i++) mkEv(f.teams.home, 'Goal', 'Normal Goal');
    for (let i = 0; i < f.goals.away; i++) mkEv(f.teams.away, 'Goal', 'Normal Goal');
    mkEv(f.teams.home, 'Card', 'Yellow Card'); mkEv(f.teams.away, 'Card', 'Yellow Card'); mkEv(f.teams.away, 'subst', 'Substitution 1');
    ev.sort((a, b) => a.time.elapsed - b.time.elapsed);
    return { response: ev };
  }
  if (path === 'fixtures/headtohead') {
    const parts = String(p.h2h || '').split('-').map(Number);
    const a = parts[0], b = parts[1];
    let mine = allKnown().filter(f => (f.teams.home.id === a && f.teams.away.id === b) || (f.teams.home.id === b && f.teams.away.id === a))
      .sort((x, y) => y.fixture.timestamp - x.fixture.timestamp);
    if (mine.length < 3) {
      // Demo only: synthesise a few past meetings so H2H is never empty.
      const nameOf = id => { const f = allKnown().find(x => x.teams.home.id === id || x.teams.away.id === id); return f ? (f.teams.home.id === id ? f.teams.home.name : f.teams.away.name) : 'Team ' + id; };
      const r = rnd(a * 31 + b * 7);
      const synth = [1, 2, 3].map(i => {
        const homeFirst = i % 2 === 1;
        const hg = Math.floor(r() * 3), ag = Math.floor(r() * 3);
        return {
          fixture: { id: 800000 + a % 1000 * 10 + i, timestamp: Math.floor(Date.now() / 1000) - i * 37 * 86400, status: { short: 'FT', elapsed: 90 }, venue: { name: nameOf(a) + ' Stadium' } },
          league: { id: 233, name: 'Premier League', logo: '', country: 'Egypt', round: 'Regular Season' },
          teams: { home: { id: homeFirst ? a : b, name: nameOf(homeFirst ? a : b), logo: '' }, away: { id: homeFirst ? b : a, name: nameOf(homeFirst ? b : a), logo: '' } },
          goals: { home: hg, away: ag }
        };
      });
      mine = [...mine, ...synth].sort((x, y) => y.fixture.timestamp - x.fixture.timestamp);
    }
    return { response: mine.slice(0, +p.last || 5) };
  }
  if (path === 'fixtures/players') {
    const f = allKnown().find(x => x.fixture.id === +p.fixture);
    if (!f) return { response: [] };
    const r = rnd(+p.fixture + 99);
    const mkSide = team => {
      const names = ['A. Keeper', 'D. Right', 'D. Centre', 'D. Left', 'M. Holding', 'M. Centre', 'M. Attack', 'W. Right', 'W. Left', 'F. Striker', 'F. Second'];
      const pos = ['GK', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW', 'FW'];
      const players = names.map((n, i) => ({
        player: { id: team.id * 100 + i, name: n, number: i + 1, pos: pos[i] },
        statistics: [{ games: { rating: (6.1 + r() * 2.6).toFixed(1) } }]
      }));
      [12, 13, 14].forEach(n => players.push({ player: { id: team.id * 100 + n, name: 'Sub ' + n, number: n, pos: 'MF' }, statistics: [{ games: { rating: null } }] }));
      return { team: { id: team.id, name: team.name, logo: '' }, players };
    };
    return { response: [mkSide(f.teams.home), mkSide(f.teams.away)] };
  }
  if (path === 'fixtures/lineups') {
    const f = allKnown().find(x => x.fixture.id === +p.fixture);
    if (!f) return { response: [] };
    const r2 = rnd(+p.fixture + 21);
    const mkSide = (team, formation) => {
      const names = ['A. Keeper', 'D. Right', 'D. Centre', 'D. Left', 'M. Holding', 'M. Centre', 'M. Attack', 'W. Right', 'W. Left', 'F. Striker', 'F. Second'];
      const pos = ['GK', 'DF', 'DF', 'DF', 'MF', 'MF', 'MF', 'FW', 'FW', 'FW', 'FW'];
      return {
        team: { id: team.id, name: team.name, logo: '' }, formation,
        coach: { name: team.name + ' Coach' },
        startXI: names.map((n, i) => ({ player: { id: team.id * 100 + i, name: n, number: i + 1, pos: pos[i] } })),
        substitutes: [12, 13, 14, 15, 16, 17].map(n => ({ player: { id: team.id * 100 + n, name: 'Sub ' + n, number: n, pos: n < 15 ? 'MF' : 'FW' } }))
      };
    };
    return { response: [mkSide(f.teams.home, '4-3-3'), mkSide(f.teams.away, '4-2-3-1')] };
  }
  if (path === 'standings') {
    const league = LEAGUES.find(l => l.id === +p.league) || LEAGUES[0];
    const r2 = rnd(league.id + 5);
    const rows = league.teams.map((name, i) => {
      const played = 20 + i, won = Math.max(0, 14 - i), drawn = 3 + Math.floor(r2() * 3), lost = Math.max(0, played - won - drawn);
      const gf = 30 - i * 2 + Math.floor(r2() * 5), ga = 12 + i * 2;
      return { rank: i + 1, team: { id: teamId(name), name, logo: '' }, points: won * 3 + drawn, goalsDiff: gf - ga, form: 'WDLWW'.slice(0, 5), all: { played, win: won, draw: drawn, lose: lost, goals: { for: gf, against: ga } } };
    });
    return { response: [{ league: { id: league.id, name: league.name, country: league.country, season: 2025, standings: [rows] } }] };
  }
  if (path === 'players/topscorers') {
    const league = LEAGUES.find(l => l.id === +p.league) || LEAGUES[0];
    const scorers = ['M. Salah', 'E. Haaland', 'K. Mbappe', 'H. Kane', 'V. Junior', 'L. Yamal', 'Trezeguet', 'O. Marmoush', 'B. Saka', 'J. Alvarez'];
    return { response: scorers.map((name, i) => ({ player: { name }, statistics: [{ team: { id: teamId(league.teams[i % league.teams.length]), name: league.teams[i % league.teams.length], logo: '' }, goals: { total: 18 - i, assists: 8 - Math.floor(i / 2) }, games: { appearences: 22 - Math.floor(i / 3) } }] })) };
  }
  return { response: [] };
}
