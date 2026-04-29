'use strict';

const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
const NodeCache  = require('node-cache');
const Database   = require('better-sqlite3');
const path       = require('path');
const fs         = require('fs');
const { spawn }  = require('child_process');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── Config ────────────────────────────────────────────────────
const API_KEY       = process.env.API_FOOTBALL_KEY  || '';
const ODDS_API_KEY  = process.env.ODDS_API_KEY       || '';
const FD_KEY        = process.env.FOOTBALL_DATA_KEY  || '';
const DB_PATH       = process.env.DB_PATH || path.join(__dirname, '../data/football.db');
const SOURCES_PATH  = process.env.SOURCES_CONFIG || '/data/sources.json';

// ── Caches ────────────────────────────────────────────────────
const cache        = new NodeCache({ stdTTL: 1800 });   // generic 30min
const oddsCache    = new NodeCache({ stdTTL: 900  });   // live odds 15min
const fixtureStore = new NodeCache({ stdTTL: 14400 });  // fixture lookup 4h — survives odds cache expiry

// ── SQLite ────────────────────────────────────────────────────
let db = null;
function getDb() {
  if (db) return db;
  try {
    if (fs.existsSync(DB_PATH)) {
      db = new Database(DB_PATH, { readonly: true });
      console.log('SQLite connected:', DB_PATH);
    }
  } catch (e) { console.warn('SQLite unavailable:', e.message); }
  return db;
}

// ── API-Football client ───────────────────────────────────────
const apiClient = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': API_KEY },
  timeout: 15000,
});

// ── Leagues ───────────────────────────────────────────────────
const TRACKED_LEAGUES = [
  { id: 2,   name: 'Champions League'  },
  { id: 3,   name: 'Europa League'     },
  { id: 39,  name: 'Premier League'    },
  { id: 140, name: 'La Liga'           },
  { id: 135, name: 'Serie A'           },
  { id: 78,  name: 'Bundesliga'        },
  { id: 61,  name: 'Ligue 1'           },
  { id: 94,  name: 'Primeira Liga'     },
  { id: 88,  name: 'Eredivisie'        },
];

// The Odds API — no Conference League on free plan
const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_API_MAP  = {
  2:   'soccer_uefa_champs_league',
  3:   'soccer_uefa_europa_league',
  39:  'soccer_epl',
  140: 'soccer_spain_la_liga',
  135: 'soccer_italy_serie_a',
  78:  'soccer_germany_bundesliga',
  61:  'soccer_france_ligue_one',
  94:  'soccer_portugal_primeira_liga',
  88:  'soccer_netherlands_eredivisie',
};

function currentSeason() {
  const n = new Date();
  return n.getMonth() >= 6 ? n.getFullYear() : n.getFullYear() - 1;
}

// ── Helpers ───────────────────────────────────────────────────
function impliedProb(odd) {
  return odd > 0 ? parseFloat(((1 / odd) * 100).toFixed(1)) : 0;
}

function valueRating(implied, estimated) {
  const diff = estimated - implied;
  if (diff > 10) return { label: 'HIGH VALUE', color: 'green',  diff };
  if (diff > 4)  return { label: 'VALUE',      color: 'lime',   diff };
  if (diff > 0)  return { label: 'SLIGHT',     color: 'yellow', diff };
  return              { label: 'NO VALUE',   color: 'red',    diff };
}

function estimateProbs(homeStats, awayStats) {
  let homeP = 45, drawP = 27, awayP = 28;
  const applyForm = (stats, side) => {
    if (!stats?.form) return;
    const w = (stats.form.match(/W/g)||[]).length;
    const d = (stats.form.match(/D/g)||[]).length;
    if (side === 'home') { homeP += w*2 + d*0.5; awayP -= w*1.5; }
    else                 { awayP += w*2 + d*0.5; homeP -= w*1.5; }
  };
  applyForm(homeStats, 'home');
  applyForm(awayStats, 'away');
  const hAvg    = parseFloat(homeStats?.goals?.for?.average?.home || 1.5);
  const aAvg    = parseFloat(awayStats?.goals?.for?.average?.away || 1.2);
  const total   = hAvg + aAvg;
  const over25P = total > 3.0 ? 68 : total > 2.5 ? 58 : total > 2.0 ? 45 : 35;
  const bttsP   = Math.round((hAvg > 1 ? 0.75 : 0.60) * (aAvg > 0.8 ? 0.65 : 0.50) * 100);
  const t       = homeP + drawP + awayP;
  homeP = Math.round((homeP/t)*100);
  drawP = Math.round((drawP/t)*100);
  awayP = 100 - homeP - drawP;
  return { homeP, drawP, awayP, over25P, bttsP, totalExpected: total.toFixed(2) };
}

// ── The Odds API helpers ──────────────────────────────────────
async function fetchLiveOdds(leagueId) {
  const sportKey = ODDS_API_MAP[leagueId];
  if (!sportKey || !ODDS_API_KEY) return null;
  const cKey = `lo_${leagueId}`;
  const hit  = oddsCache.get(cKey);
  if (hit) return hit;
  try {
    const r = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/odds`, {
      params: { apiKey: ODDS_API_KEY, regions: 'eu', markets: 'h2h,totals', oddsFormat: 'decimal' },
      timeout: 10000,
    });
    const data = r.data || [];
    oddsCache.set(cKey, data);
    return data;
  } catch (e) {
    console.warn(`Odds API [${sportKey}]:`, e.response?.data?.message || e.message);
    return null;
  }
}

function normName(s) {
  return (s||'').toLowerCase().replace(/fc|cf|sc|ac|afc|united|city|club/gi,'').replace(/[^a-z0-9]/g,'').trim();
}

function matchOddsEvent(events, home, away) {
  if (!events?.length) return null;
  const nh = normName(home), na = normName(away);
  for (const ev of events) {
    const eh = normName(ev.home_team||''), ea = normName(ev.away_team||'');
    if ((nh.includes(eh)||eh.includes(nh)) && (na.includes(ea)||ea.includes(na))) return ev;
  }
  return null;
}

function parseOddsEvent(ev, market) {
  const books = (ev?.bookmakers||[]).map(bm => ({
    name: bm.title,
    outcomes: (bm.markets||[]).find(m=>m.key===market)?.outcomes || []
  })).filter(b => b.outcomes.length);
  if (!books.length) return null;
  const outcomes = {};
  for (const bk of books) {
    for (const o of bk.outcomes) {
      if (!outcomes[o.name]) outcomes[o.name] = { prices: [], bookmakers: [] };
      outcomes[o.name].prices.push(parseFloat(o.price));
      outcomes[o.name].bookmakers.push({ name: bk.name, price: parseFloat(o.price) });
    }
  }
  const result = {};
  for (const [name, data] of Object.entries(outcomes)) {
    const s = [...data.prices].sort((a,b)=>b-a);
    result[name] = {
      best: s[0], avg: parseFloat((data.prices.reduce((a,b)=>a+b,0)/data.prices.length).toFixed(3)),
      worst: s[s.length-1], bookmakers: data.bookmakers.sort((a,b)=>b.price-a.price), count: data.prices.length,
    };
  }
  return { outcomes: result, books_count: books.length };
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// GET /health
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date(), apiKey: !!API_KEY, oddsKey: !!ODDS_API_KEY }));

// GET /api/leagues
app.get('/api/leagues', (req, res) => res.json(TRACKED_LEAGUES));

// ── Fixtures — uses The Odds API (no season restriction) ──────
app.get('/api/fixtures', async (req, res) => {
  const days   = Math.min(parseInt(req.query.days)||7, 14);
  const cKey   = `fixtures_${days}`;
  const cached = cache.get(cKey);
  if (cached) return res.json(cached);

  if (!ODDS_API_KEY) return res.status(503).json({ error: 'ODDS_API_KEY não configurada' });

  try {
    const now    = new Date();
    const cutoff = new Date(now.getTime() + days * 86400000);
    const from   = now.toISOString().split('.')[0] + 'Z';
    const to     = cutoff.toISOString().split('.')[0] + 'Z';

    console.log(`Fetching fixtures: ${from} → ${to}`);

    const promises = Object.entries(ODDS_API_MAP).map(([lid, sportKey]) =>
      axios.get(`${ODDS_API_BASE}/sports/${sportKey}/odds`, {
        params: { apiKey: ODDS_API_KEY, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal', commenceTimeFrom: from, commenceTimeTo: to },
        timeout: 10000,
      }).then(r => ({ leagueId: parseInt(lid), events: r.data||[] }))
        .catch(e => { console.warn(`[${sportKey}]:`, e.response?.data?.message||e.message); return { leagueId: parseInt(lid), events: [] }; })
    );

    const results  = await Promise.all(promises);
    const fixtures = [];

    for (const { leagueId, events } of results) {
      const league = TRACKED_LEAGUES.find(l => l.id === leagueId);
      if (!league) continue;
      for (const ev of events) {
        const h2hBets  = ev.bookmakers?.[0]?.markets?.find(m=>m.key==='h2h');
        const homeOdd  = h2hBets?.outcomes?.find(o=>o.name===ev.home_team)?.price||null;
        const awayOdd  = h2hBets?.outcomes?.find(o=>o.name===ev.away_team)?.price||null;
        const drawOdd  = h2hBets?.outcomes?.find(o=>o.name==='Draw')?.price||null;
        const country  = {39:'England',140:'Spain',135:'Italy',78:'Germany',61:'France',94:'Portugal',88:'Netherlands',2:'Europe',3:'Europe'}[leagueId]||'';
        const f = {
          fixture: { id: ev.id, date: ev.commence_time, venue: { name:null, city:null }, status: { short:'NS', long:'Not Started' } },
          league:  { id: leagueId, name: league.name, country, logo: null },
          teams:   { home: { id: null, name: ev.home_team, logo: null }, away: { id: null, name: ev.away_team, logo: null } },
          goals:   { home: null, away: null },
          _odds_preview: { home: homeOdd, draw: drawOdd, away: awayOdd },
          _source: 'odds-api',
        };
        fixtures.push(f);
        // Store for later analysis lookup — key is the odds event ID
        fixtureStore.set(ev.id, { leagueId, leagueName: league.name, country, homeName: ev.home_team, awayName: ev.away_team, date: ev.commence_time });
      }
    }

    fixtures.sort((a,b) => new Date(a.fixture.date) - new Date(b.fixture.date));
    console.log(`Found ${fixtures.length} fixtures`);
    cache.set(cKey, fixtures, 1800);
    res.json(fixtures);
  } catch (err) {
    console.error('fixtures error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Analysis ──────────────────────────────────────────────────
app.get('/api/analysis/:fixtureId', async (req, res) => {
  const fixtureId = req.params.fixtureId;
  const cKey      = `analysis_${fixtureId}`;
  const cached    = cache.get(cKey);
  if (cached) return res.json(cached);

  // Detect source: pure integer = API-Football, anything else = Odds API
  const isOddsApi = isNaN(parseInt(fixtureId)) || String(parseInt(fixtureId)) !== fixtureId;

  try {
    let fixture, homeName, awayName, leagueId;

    if (isOddsApi) {
      // Look up from fixture store (populated when /api/fixtures was called)
      let stored = fixtureStore.get(fixtureId);

      if (!stored) {
        // Not in store — re-fetch all leagues to rebuild the store
        console.log(`Fixture ${fixtureId} not in store, re-fetching...`);
        const now    = new Date();
        const cutoff = new Date(now.getTime() + 14 * 86400000);
        const from   = now.toISOString().split('.')[0] + 'Z';
        const to     = cutoff.toISOString().split('.')[0] + 'Z';

        for (const [lid, sportKey] of Object.entries(ODDS_API_MAP)) {
          try {
            const r = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/odds`, {
              params: { apiKey: ODDS_API_KEY, regions: 'eu', markets: 'h2h', oddsFormat: 'decimal', commenceTimeFrom: from, commenceTimeTo: to },
              timeout: 10000,
            });
            for (const ev of (r.data||[])) {
              const league = TRACKED_LEAGUES.find(l => l.id === parseInt(lid));
              fixtureStore.set(ev.id, { leagueId: parseInt(lid), leagueName: league?.name||'', homeName: ev.home_team, awayName: ev.away_team, date: ev.commence_time });
              if (ev.id === fixtureId) stored = fixtureStore.get(fixtureId);
            }
          } catch {}
          if (stored) break;
        }
      }

      if (!stored) return res.status(404).json({ error: 'Jogo não encontrado. Recarrega a lista de jogos.' });

      leagueId = stored.leagueId;
      homeName = stored.homeName;
      awayName = stored.awayName;
      fixture  = {
        fixture: { id: fixtureId, date: stored.date, venue: { name: null, city: null }, status: { short: 'NS' } },
        league:  { id: leagueId, name: stored.leagueName, country: stored.country||'' },
        teams:   { home: { id: null, name: homeName }, away: { id: null, name: awayName } },
        goals:   { home: null, away: null },
      };
    } else {
      if (!API_KEY) return res.status(503).json({ error: 'API_FOOTBALL_KEY não configurada' });
      const r = await apiClient.get('/fixtures', { params: { id: fixtureId } });
      fixture  = r.data.response?.[0];
      if (!fixture) return res.status(404).json({ error: 'Fixture not found' });
      homeName = fixture.teams.home.name;
      awayName = fixture.teams.away.name;
      leagueId = fixture.league.id;
    }

    // ── Stats from local DB ───────────────────────────────────
    const database  = getDb();
    let homeStats   = {}, awayStats = {};
    let h2hMatches  = [];

    if (database) {
      const hKey = homeName.split(' ').slice(0,2).join('%');
      const aKey = awayName.split(' ').slice(0,2).join('%');

      const hSt = database.prepare('SELECT * FROM team_season_stats WHERE team_name LIKE ? ORDER BY season DESC LIMIT 1').get(`%${hKey}%`);
      const aSt = database.prepare('SELECT * FROM team_season_stats WHERE team_name LIKE ? ORDER BY season DESC LIMIT 1').get(`%${aKey}%`);

      const toStats = (s, venue) => s ? {
        goals: {
          for:     { average: { [venue]: (s.goals_for     / Math.max(s.played/2,1)).toFixed(2) } },
          against: { average: { [venue]: (s.goals_against / Math.max(s.played/2,1)).toFixed(2) } },
        },
        form: s.form || '',
      } : {};

      homeStats  = toStats(hSt, 'home');
      awayStats  = toStats(aSt, 'away');
      h2hMatches = database.prepare(`
        SELECT * FROM matches
        WHERE (home_name LIKE ? AND away_name LIKE ?) OR (home_name LIKE ? AND away_name LIKE ?)
        ORDER BY date DESC LIMIT 10
      `).all(`%${hKey}%`,`%${aKey}%`,`%${aKey}%`,`%${hKey}%`);
    }

    // ── H2H stats ────────────────────────────────────────────
    let h2hHW=0, h2hD=0, h2hAW=0, h2hO25=0, h2hBTTS=0;
    for (const m of h2hMatches) {
      if (m.result==='H') h2hHW++; else if (m.result==='D') h2hD++; else h2hAW++;
      if ((m.goals_home||0)+(m.goals_away||0) > 2.5) h2hO25++;
      if ((m.goals_home||0)>0 && (m.goals_away||0)>0) h2hBTTS++;
    }
    const h2hN = h2hMatches.length || 1;

    // ── Odds from API-Football (may be empty on free plan) ───
    let parsedOdds = {};
    if (!isOddsApi && API_KEY) {
      try {
        const or = await apiClient.get('/odds', { params: { fixture: fixtureId, bookmaker: 6 } });
        const bets = or.data.response?.[0]?.bookmakers?.[0]?.bets || [];
        bets.forEach(b => { parsedOdds[b.name] = b.values; });
      } catch {}
    }

    const mw       = parsedOdds['Match Winner']       || [];
    const goalsB   = parsedOdds['Goals Over/Under']   || [];
    const bttsB    = parsedOdds['Both Teams Score']    || [];
    const cornersB = parsedOdds['Total Corners']       || [];
    const getOdd   = (arr, val) => parseFloat(arr.find(v=>v.value===val)?.odd||0);

    const homeOdd    = getOdd(mw,     'Home');
    const drawOdd    = getOdd(mw,     'Draw');
    const awayOdd    = getOdd(mw,     'Away');
    const over25Odd  = getOdd(goalsB, 'Over 2.5');
    const under25Odd = getOdd(goalsB, 'Under 2.5');
    const bttsYes    = getOdd(bttsB,  'Yes');
    const bttsNo     = getOdd(bttsB,  'No');

    const est = estimateProbs(homeStats, awayStats);

    const analysis = {
      fixture,
      odds: {
        matchWinner: { homeOdd, drawOdd, awayOdd },
        goals:       { over25Odd, under25Odd },
        btts:        { bttsYesOdd: bttsYes, bttsNoOdd: bttsNo },
        corners:     cornersB,
        raw:         parsedOdds,
      },
      implied: {
        home:    impliedProb(homeOdd),
        draw:    impliedProb(drawOdd),
        away:    impliedProb(awayOdd),
        over25:  impliedProb(over25Odd),
        bttsYes: impliedProb(bttsYes),
      },
      estimated: est,
      value: {
        home:   valueRating(impliedProb(homeOdd),   est.homeP),
        draw:   valueRating(impliedProb(drawOdd),   est.drawP),
        away:   valueRating(impliedProb(awayOdd),   est.awayP),
        over25: valueRating(impliedProb(over25Odd), est.over25P),
        btts:   valueRating(impliedProb(bttsYes),   est.bttsP),
      },
      h2h: {
        matches: h2hMatches.slice(0,5).map(m=>({
          fixture: { id: m.fixture_id, date: m.date, status: { short:'FT' } },
          teams:   { home: { id:null, name: m.home_name }, away: { id:null, name: m.away_name } },
          goals:   { home: m.goals_home, away: m.goals_away },
        })),
        stats: { homeWins: h2hHW, draws: h2hD, awayWins: h2hAW,
                 over25Pct: Math.round((h2hO25/h2hN)*100), bttsPct: Math.round((h2hBTTS/h2hN)*100), total: h2hMatches.length },
      },
      teamStats:  { home: homeStats, away: awayStats },
      _source:    isOddsApi ? 'odds-api' : 'api-football',
    };

    cache.set(cKey, analysis, 3600);
    res.json(analysis);
  } catch (err) {
    console.error('analysis error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Live odds for a fixture ───────────────────────────────────
app.get('/api/odds/fixture/:fixtureId', async (req, res) => {
  if (!ODDS_API_KEY) return res.status(503).json({ error: 'ODDS_API_KEY não configurada' });

  try {
    const stored = fixtureStore.get(req.params.fixtureId);
    if (!stored) return res.json({ found: false, message: 'Jogo não encontrado no store' });

    const events = await fetchLiveOdds(stored.leagueId);
    const ev     = matchOddsEvent(events, stored.homeName, stored.awayName);
    if (!ev) return res.json({ found: false, message: 'Odds ainda não disponíveis', home: stored.homeName, away: stored.awayName });

    const h2h    = parseOddsEvent(ev, 'h2h');
    const totals = parseOddsEvent(ev, 'totals');

    res.json({ found: true, home: stored.homeName, away: stored.awayName, commence_time: ev.commence_time, h2h, totals, raw_bookmakers: ev.bookmakers?.map(b=>b.title)||[] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/odds/status', async (req, res) => {
  if (!ODDS_API_KEY) return res.json({ configured: false });
  try {
    const r = await axios.get(`${ODDS_API_BASE}/sports`, { params: { apiKey: ODDS_API_KEY }, timeout: 8000 });
    res.json({ configured: true, requests_remaining: r.headers['x-requests-remaining'], requests_used: r.headers['x-requests-used'], sports_available: r.data?.length||0 });
  } catch (e) { res.json({ configured: true, error: e.message }); }
});

// ── DB Status ─────────────────────────────────────────────────
app.get('/api/db/status', (req, res) => {
  const database = getDb();
  if (!database) return res.json({ available: false, message: 'Base de dados não encontrada.' });
  try {
    const matches = database.prepare('SELECT COUNT(*) as n FROM matches').get();
    const odds    = database.prepare('SELECT COUNT(*) as n FROM odds').get();
    const teams   = database.prepare('SELECT COUNT(*) as n FROM team_season_stats').get();
    const leagues = database.prepare('SELECT league_name, COUNT(*) as jogos FROM matches GROUP BY league_name ORDER BY jogos DESC').all();
    const recent  = database.prepare('SELECT league_name, season, status, fixtures_count, finished_at FROM collection_log ORDER BY finished_at DESC LIMIT 10').all();
    res.json({ available: true, counts: { matches: matches.n, odds: odds.n, teams: teams.n }, leagues, recent_collections: recent });
  } catch (e) { res.status(500).json({ available: false, error: e.message }); }
});

// ── DB Matches ────────────────────────────────────────────────
app.get('/api/db/matches', (req, res) => {
  const database = getDb();
  if (!database) return res.json({ matches: [], total: 0 });
  try {
    const { league_id, season, team, result, limit=50, page=1 } = req.query;
    const offset = (parseInt(page)-1) * parseInt(limit);
    let where = 'WHERE 1=1'; const params = [];
    if (league_id) { where += ' AND league_id=?';  params.push(parseInt(league_id)); }
    if (season)    { where += ' AND season=?';     params.push(parseInt(season)); }
    if (result)    { where += ' AND result=?';     params.push(result); }
    if (team)      { where += ' AND (home_name LIKE ? OR away_name LIKE ?)'; params.push(`%${team}%`,`%${team}%`); }
    const total   = database.prepare(`SELECT COUNT(*) as n FROM matches ${where}`).get(...params).n;
    const matches = database.prepare(`SELECT fixture_id,date,league_name,season,home_name,away_name,goals_home,goals_away,result,xg_home,xg_away,shots_home,shots_away,corners_home,corners_away,poss_home,poss_away FROM matches ${where} ORDER BY date DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), offset);
    res.json({ matches, total, page: parseInt(page), pages: Math.ceil(total/parseInt(limit)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Export ────────────────────────────────────────────────────
app.get('/api/db/export', (req, res) => {
  const database = getDb();
  if (!database) return res.status(503).json({ error: 'Base de dados não disponível' });
  const { format='json', table='ALL', season, league_id } = req.query;
  const VALID = ['matches','odds','team_season_stats','collection_log'];
  if (table !== 'ALL' && !VALID.includes(table)) return res.status(400).json({ error: 'Tabela inválida' });
  try {
    const ts = new Date().toISOString().slice(0,10);
    if (table === 'ALL') {
      const exp = { exported_at: new Date().toISOString(), version: '1.0', summary: {}, tables: {} };
      for (const tbl of VALID) {
        try {
          let where = 'WHERE 1=1'; const p = [];
          if (tbl !== 'collection_log') {
            if (season)    { where += ' AND season=?';    p.push(parseInt(season)); }
            if (league_id) { where += ' AND league_id=?'; p.push(parseInt(league_id)); }
          }
          const rows = database.prepare(`SELECT * FROM ${tbl} ${where} ORDER BY rowid`).all(...p);
          exp.tables[tbl] = rows; exp.summary[tbl] = rows.length;
        } catch { exp.tables[tbl]=[]; exp.summary[tbl]=0; }
      }
      res.setHeader('Content-Type','application/json');
      res.setHeader('Content-Disposition',`attachment; filename="football-scout-backup-${ts}.json"`);
      return res.json(exp);
    }
    let where='WHERE 1=1'; const p=[];
    if (season)    { where+=' AND season=?';    p.push(parseInt(season)); }
    if (league_id) { where+=' AND league_id=?'; p.push(parseInt(league_id)); }
    const rows = database.prepare(`SELECT * FROM ${table} ${where} ORDER BY rowid`).all(...p);
    if (format==='csv') {
      if (!rows.length) return res.status(404).json({ error: 'Sem dados' });
      const cols = Object.keys(rows[0]);
      const esc  = v => v===null||v===undefined?'':String(v).includes(',')||String(v).includes('"')?`"${String(v).replace(/"/g,'""')}"`:String(v);
      res.setHeader('Content-Type','text/csv');
      res.setHeader('Content-Disposition',`attachment; filename="football-scout_${table}_${ts}.csv"`);
      return res.send([cols.join(','),...rows.map(r=>cols.map(c=>esc(r[c])).join(','))].join('\n'));
    }
    res.setHeader('Content-Type','application/json');
    res.setHeader('Content-Disposition',`attachment; filename="football-scout_${table}_${ts}.json"`);
    res.json({ exported_at: new Date().toISOString(), table, count: rows.length, data: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Import ────────────────────────────────────────────────────
app.post('/api/db/import', (req, res) => {
  let wdb;
  try {
    fs.mkdirSync(path.dirname(DB_PATH),{recursive:true});
    wdb = new Database(DB_PATH);
    wdb.pragma('journal_mode=WAL');
    const { table, data } = req.body;
    if (!table||!data||!Array.isArray(data)) return res.status(400).json({ error: 'Body inválido' });
    if (!['matches','odds','team_season_stats'].includes(table)) return res.status(400).json({ error: 'Tabela inválida' });
    if (!data.length) return res.json({ imported:0, skipped:0 });
    const cols = Object.keys(data[0]);
    const stmt = wdb.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`);
    let imported=0, skipped=0;
    wdb.transaction(rows=>{ for(const r of rows){ const x=stmt.run(...cols.map(c=>r[c]??null)); if(x.changes>0)imported++;else skipped++; }})(data);
    db=null;
    res.json({ success:true, imported, skipped, total: data.length });
  } catch(e){ res.status(500).json({error:e.message}); } finally { if(wdb)wdb.close(); }
});

// ── Statistical Report ────────────────────────────────────────
app.get('/api/report', (req, res) => {
  const database = getDb();
  if (!database) return res.status(503).json({ error: 'Base de dados não disponível. Corre o backfill primeiro.' });
  const { home, away, n=30 } = req.query;
  if (!home||!away) return res.status(400).json({ error: 'home e away são obrigatórios' });
  const maxN = Math.min(parseInt(n)||30, 50);

  try {
    function pct(c,t){ return t>0?Math.round((c/t)*100):0; }

    function getMatches(teamName, venue, limit) {
      const col = venue==='home'?'home_name':'away_name';
      const opp = venue==='home'?'away_name':'home_name';
      const gf  = venue==='home'?'goals_home':'goals_away';
      const ga  = venue==='home'?'goals_away':'goals_home';
      const hgf = venue==='home'?'ht_home':'ht_away';
      const hga = venue==='home'?'ht_away':'ht_home';
      const key = teamName.split(' ').slice(0,2).join('%');
      return database.prepare(`
        SELECT fixture_id,date,league_name,
          ${col} as team, ${opp} as opponent,
          ${gf} as gf, ${ga} as ga,
          ${hgf} as ht_gf, ${hga} as ht_ga,
          result, corners_home,corners_away,shots_home,shots_away,poss_home,poss_away,xg_home,xg_away
        FROM matches WHERE ${col} LIKE ? AND result IS NOT NULL
        ORDER BY date DESC LIMIT ?
      `).all(`%${key}%`, limit);
    }

    function calcStats(matches, venue) {
      if (!matches.length) return null;
      const n   = matches.length;
      const isW = m => m.result===(venue==='home'?'H':'A');
      const wins   = matches.filter(isW).length;
      const draws  = matches.filter(m=>m.result==='D').length;
      const losses = n-wins-draws;
      const totalGf = matches.reduce((s,m)=>s+(m.gf||0),0);
      const totalGa = matches.reduce((s,m)=>s+(m.ga||0),0);
      const withHT  = matches.filter(m=>m.ht_gf!==null);
      const htGf    = withHT.reduce((s,m)=>s+(m.ht_gf||0),0);
      const htGa    = withHT.reduce((s,m)=>s+(m.ht_ga||0),0);

      const scored      = matches.filter(m=>(m.gf||0)>0).length;
      const scoredHT    = withHT.filter(m=>(m.ht_gf||0)>0).length;
      const conceded    = matches.filter(m=>(m.ga||0)>0).length;
      const concededHT  = withHT.filter(m=>(m.ht_ga||0)>0).length;
      const cleanSheets = matches.filter(m=>(m.ga||0)===0).length;
      const btts        = matches.filter(m=>(m.gf||0)>0&&(m.ga||0)>0).length;
      const over15      = matches.filter(m=>(m.gf||0)+(m.ga||0)>1).length;
      const over25      = matches.filter(m=>(m.gf||0)+(m.ga||0)>2).length;
      const over35      = matches.filter(m=>(m.gf||0)+(m.ga||0)>3).length;

      function streak(arr, pred){ let c=0; for(const m of arr){if(pred(m))c++;else break;} return c; }
      const winStreak      = streak(matches, isW);
      const unbeatenStreak = streak(matches, m=>m.result!==(venue==='home'?'A':'H'));
      const scoreStreak    = streak(matches, m=>(m.gf||0)>0);
      const noWinStreak    = streak(matches, m=>!isW(m));
      const cleanStreak    = streak(matches, m=>(m.ga||0)===0);

      const withXg   = matches.filter(m=>m.xg_home!==null);
      const avgXgF   = withXg.length>0?(withXg.reduce((s,m)=>s+(venue==='home'?m.xg_home:m.xg_away||0),0)/withXg.length).toFixed(2):null;
      const avgXgA   = withXg.length>0?(withXg.reduce((s,m)=>s+(venue==='home'?m.xg_away:m.xg_home||0),0)/withXg.length).toFixed(2):null;

      const form = matches.slice(0,10).map(m=>({
        result: isW(m)?'W':m.result==='D'?'D':'L',
        score:  `${m.gf}-${m.ga}`,
        opponent: m.opponent,
        date: m.date?.slice(0,10),
        ht: m.ht_gf!==null?`${m.ht_gf}-${m.ht_ga}`:null,
      }));

      return {
        n, wins, draws, losses,
        summary: `${n} jogos: ${wins}V ${draws}E ${losses}D`,
        win_pct: pct(wins,n), draw_pct: pct(draws,n), loss_pct: pct(losses,n),
        avg_scored:      parseFloat((totalGf/n).toFixed(2)),
        avg_conceded:    parseFloat((totalGa/n).toFixed(2)),
        avg_ht_scored:   withHT.length>0?parseFloat((htGf/withHT.length).toFixed(2)):null,
        avg_ht_conceded: withHT.length>0?parseFloat((htGa/withHT.length).toFixed(2)):null,
        scored_pct:      pct(scored,n),
        scored_ht_pct:   withHT.length>0?pct(scoredHT,withHT.length):null,
        conceded_pct:    pct(conceded,n),
        conceded_ht_pct: withHT.length>0?pct(concededHT,withHT.length):null,
        clean_sheet_pct: pct(cleanSheets,n),
        btts_pct:        pct(btts,n),
        over15_pct:      pct(over15,n),
        over25_pct:      pct(over25,n),
        over35_pct:      pct(over35,n),
        win_streak, unbeaten_streak: unbeatenStreak, score_streak: scoreStreak,
        no_win_streak: noWinStreak, clean_streak: cleanStreak,
        avg_xg_for: avgXgF, avg_xg_against: avgXgA,
        scored_in: scored, clean_sheets: cleanSheets, btts_count: btts,
        form,
        matches: matches.slice(0,10).map(m=>({
          date: m.date?.slice(0,10), league: m.league_name, opponent: m.opponent,
          score: `${m.gf}-${m.ga}`, ht: m.ht_gf!==null?`${m.ht_gf}-${m.ht_ga}`:null,
          result: isW(m)?'W':m.result==='D'?'D':'L',
        })),
      };
    }

    function highlights(stats, venue) {
      if (!stats) return [];
      const hl = [], v = venue==='home'?'em casa':'fora';
      if (stats.win_streak>=3)          hl.push({type:'positive',text:`🔥 Série de ${stats.win_streak} vitórias consecutivas ${v}`});
      if (stats.unbeaten_streak>=5)     hl.push({type:'positive',text:`💪 Invicto nos últimos ${stats.unbeaten_streak} jogos ${v}`});
      if (stats.win_pct>=70)            hl.push({type:'positive',text:`✅ Ganha ${stats.win_pct}% dos jogos ${v} (${stats.wins}/${stats.n})`});
      if (stats.clean_sheet_pct>=50)    hl.push({type:'positive',text:`🛡 Folha limpa em ${stats.clean_sheet_pct}% dos jogos ${v}`});
      if (stats.scored_pct>=90)         hl.push({type:'positive',text:`⚽ Marcou em ${stats.scored_pct}% dos jogos ${v}`});
      if (stats.score_streak>=5)        hl.push({type:'positive',text:`🎯 Marcou nos últimos ${stats.score_streak} jogos seguidos ${v}`});
      if (stats.avg_scored>=2.0)        hl.push({type:'positive',text:`💥 Média de ${stats.avg_scored} golos marcados ${v}`});
      if (stats.avg_conceded<=0.8)      hl.push({type:'positive',text:`🔒 Média de apenas ${stats.avg_conceded} golos sofridos ${v}`});
      if (stats.scored_ht_pct>=50&&stats.scored_ht_pct!==null) hl.push({type:'info',text:`1ª parte: Marcou em ${stats.scored_ht_pct}% dos jogos ${v}`});
      if (stats.conceded_ht_pct!==null&&stats.conceded_ht_pct<=25) hl.push({type:'positive',text:`🧱 Sofreu golo na 1ª parte em apenas ${stats.conceded_ht_pct}% dos jogos ${v}`});
      if (stats.over25_pct>=65)         hl.push({type:'info',text:`📊 Over 2.5 em ${stats.over25_pct}% dos jogos ${v}`});
      if (stats.btts_pct>=65)           hl.push({type:'info',text:`⚡ Ambas marcam em ${stats.btts_pct}% dos jogos ${v}`});
      if (stats.no_win_streak>=4)       hl.push({type:'negative',text:`⚠ Sem vencer há ${stats.no_win_streak} jogos ${v}`});
      if (stats.loss_pct>=50)           hl.push({type:'negative',text:`❌ Perde ${stats.loss_pct}% dos jogos ${v}`});
      if (stats.avg_conceded>=2.0)      hl.push({type:'negative',text:`💣 Sofre em média ${stats.avg_conceded} golos ${v}`});
      if (stats.scored_pct<=50)         hl.push({type:'negative',text:`😶 Só marcou em ${stats.scored_pct}% dos jogos ${v}`});
      return hl;
    }

    function getH2H(homeName, awayName, limit) {
      const hKey = homeName.split(' ').slice(0,2).join('%');
      const aKey = awayName.split(' ').slice(0,2).join('%');
      const ms = database.prepare(`
        SELECT fixture_id,date,league_name,home_name,away_name,goals_home,goals_away,result,ht_home,ht_away
        FROM matches WHERE (home_name LIKE ? AND away_name LIKE ?) OR (home_name LIKE ? AND away_name LIKE ?)
        ORDER BY date DESC LIMIT ?
      `).all(`%${hKey}%`,`%${aKey}%`,`%${aKey}%`,`%${hKey}%`,limit);
      if (!ms.length) return null;
      let hw=0,d=0,aw=0,g=0,o25=0,btts=0;
      for (const m of ms) {
        const isNH = m.home_name.toLowerCase().includes(hKey.split('%')[0].toLowerCase());
        if (isNH){ if(m.result==='H')hw++;else if(m.result==='D')d++;else aw++; }
        else      { if(m.result==='A')hw++;else if(m.result==='D')d++;else aw++; }
        const tot=(m.goals_home||0)+(m.goals_away||0); g+=tot;
        if(tot>2.5)o25++;
        if((m.goals_home||0)>0&&(m.goals_away||0)>0)btts++;
      }
      return {
        n:ms.length, homeWins:hw, draws:d, awayWins:aw,
        home_win_pct:pct(hw,ms.length), draw_pct:pct(d,ms.length), away_win_pct:pct(aw,ms.length),
        avg_goals:(g/ms.length).toFixed(2), over25_pct:pct(o25,ms.length), btts_pct:pct(btts,ms.length),
        matches: ms.slice(0,10).map(m=>({ date:m.date?.slice(0,10), league:m.league_name, home:m.home_name, away:m.away_name, score:`${m.goals_home}-${m.goals_away}`, ht:m.ht_home!==null?`${m.ht_home}-${m.ht_away}`:null, result:m.result })),
      };
    }

    const homeHome = calcStats(getMatches(home,'home',maxN),'home');
    const homeAway = calcStats(getMatches(home,'away',maxN),'away');
    const awayHome = calcStats(getMatches(away,'home',maxN),'home');
    const awayAway = calcStats(getMatches(away,'away',maxN),'away');
    const h2h      = getH2H(home,away,10);

    res.json({
      home: { name:home, at_home:{ stats:homeHome, highlights:highlights(homeHome,'home') }, away:{ stats:homeAway, highlights:highlights(homeAway,'away') } },
      away: { name:away, at_home:{ stats:awayHome, highlights:highlights(awayHome,'home') }, away:{ stats:awayAway, highlights:highlights(awayAway,'away') } },
      h2h, generated_at: new Date().toISOString(), n: maxN,
    });
  } catch (e) {
    console.error('report error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: Sources ────────────────────────────────────────────
function loadSources() {
  const defaults = [
    { id:'api-football', name:'API-Football', type:'api-football', key: API_KEY, enabled:!!API_KEY, role:'odds,xg,advanced', limit_daily:100 },
    { id:'football-data', name:'football-data.org', type:'football-data', key: FD_KEY, enabled:!!FD_KEY, role:'results,basic-stats', limit_per_minute:10 },
    { id:'odds-api', name:'The Odds API', type:'odds-api', key: ODDS_API_KEY, enabled:!!ODDS_API_KEY, role:'fixtures,live-odds', limit_monthly:500 },
  ];
  try {
    if (fs.existsSync(SOURCES_PATH)) {
      const saved = JSON.parse(fs.readFileSync(SOURCES_PATH,'utf8'));
      const merged = [...defaults];
      for (const s of saved) { const i=merged.findIndex(d=>d.id===s.id); if(i>=0)merged[i]={...merged[i],...s};else merged.push(s); }
      return merged;
    }
  } catch {}
  return defaults;
}

function saveSources(sources) {
  fs.mkdirSync(path.dirname(SOURCES_PATH),{recursive:true});
  fs.writeFileSync(SOURCES_PATH, JSON.stringify(sources,null,2));
}

app.get('/api/admin/sources', (req, res) => {
  const sources = loadSources();
  res.json(sources.map(s=>({...s, key: s.key?s.key.slice(0,8)+'••••••••':'', key_set:!!s.key})));
});

app.get('/api/admin/sources/status', async (req, res) => {
  const sources = loadSources().filter(s=>s.enabled&&s.key);
  const results = await Promise.all(sources.map(async s => {
    try {
      if (s.type==='api-football') {
        const r = await axios.get('https://v3.football.api-sports.io/status',{headers:{'x-apisports-key':s.key},timeout:8000});
        const d = r.data?.response;
        return { id:s.id, name:s.name, role:s.role, status:{ ok:true, plan:d?.subscription?.plan||'—', requests_used:d?.requests?.current||0, requests_limit:d?.requests?.limit_day||100, requests_remaining:(d?.requests?.limit_day||100)-(d?.requests?.current||0) } };
      }
      if (s.type==='football-data') {
        const r = await axios.get('https://api.football-data.org/v4/competitions',{headers:{'X-Auth-Token':s.key},timeout:8000});
        return { id:s.id, name:s.name, role:s.role, status:{ ok:true, plan:'FREE', requests_remaining_per_min:parseInt(r.headers['x-requests-available-minute'])||10, limit_daily:'unlimited' } };
      }
      if (s.type==='odds-api') {
        const r = await axios.get(`${ODDS_API_BASE}/sports`,{params:{apiKey:s.key},timeout:8000});
        return { id:s.id, name:s.name, role:s.role, status:{ ok:true, requests_remaining:r.headers['x-requests-remaining'], requests_used:r.headers['x-requests-used'], limit_monthly:500 } };
      }
      return { id:s.id, name:s.name, role:s.role, status:{ ok:false, error:'Tipo desconhecido' } };
    } catch(e) {
      return { id:s.id, name:s.name, role:s.role, status:{ ok:false, error:e.response?.data?.message||e.message } };
    }
  }));
  res.json(results);
});

app.put('/api/admin/sources/:id', (req, res) => {
  const sources = loadSources();
  const idx = sources.findIndex(s=>s.id===req.params.id);
  if (idx<0) sources.push({ id:req.params.id,...req.body,created_at:new Date().toISOString() });
  else { const {id:_,...u}=req.body; sources[idx]={...sources[idx],...u}; }
  saveSources(sources);
  res.json({ ok:true });
});

app.delete('/api/admin/sources/:id', (req, res) => {
  if (['api-football','football-data','odds-api'].includes(req.params.id)) return res.status(400).json({ error:'Não podes remover fontes built-in' });
  saveSources(loadSources().filter(s=>s.id!==req.params.id));
  res.json({ ok:true });
});

// ── Admin: Trigger collector ──────────────────────────────────
app.post('/api/admin/trigger', (req, res) => {
  const { collector='main', mode='daily', season } = req.body;
  const script   = collector==='alt'?'collect-alt.js':'collect.js';
  const args     = ['node', script, `--mode=${mode}`];
  if (season) args.push(`--season=${season}`);
  const jobId    = Date.now().toString(36);
  const logsDir  = path.join(path.dirname(DB_PATH),'logs');
  fs.mkdirSync(logsDir,{recursive:true});
  const logPath  = path.join(logsDir,`job-${jobId}.log`);
  const child    = spawn('docker',['compose','-f','/app/../docker-compose.yml','run','--rm','collector',...args],{ cwd:path.dirname(DB_PATH)+'/..',detached:true,stdio:['ignore','pipe','pipe'] });
  const ls       = fs.createWriteStream(logPath,{flags:'a'});
  child.stdout.pipe(ls); child.stderr.pipe(ls); child.unref();
  if (!global.activeJobs) global.activeJobs={};
  global.activeJobs[jobId]={ script,mode,season,started:new Date().toISOString(),logPath,pid:child.pid };
  res.json({ ok:true, jobId, message:`${collector==='alt'?'football-data.org':'API-Football'} ${mode} iniciado`, script, mode, season:season||'current' });
});

app.get('/api/admin/job/:jobId/log', (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-z0-9]+$/.test(jobId)) return res.status(400).json({ error:'jobId inválido' });
  const logPath = path.join(path.dirname(DB_PATH),'logs',`job-${jobId}.log`);
  if (!fs.existsSync(logPath)) return res.json({ lines:[], offset:0, done:false });
  try {
    const offset   = parseInt(req.query.offset)||0;
    const all      = fs.readFileSync(logPath,'utf8').split('\n').filter(Boolean);
    const newLines = all.slice(offset);
    res.json({ lines:newLines, offset:all.length, done:newLines.length===0&&offset>0, meta:global.activeJobs?.[jobId]||null });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Admin: Mappings ───────────────────────────────────────────
app.get('/api/admin/mappings', (req, res) => {
  const database = getDb();
  if (!database) return res.json({ mappings:[], total:0 });
  try {
    const { source, q, page=1, limit=50 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    let where='WHERE 1=1'; const p=[];
    if (source){ where+=' AND source=?'; p.push(source); }
    if (q)     { where+=' AND (source_name LIKE ? OR canonical_name LIKE ?)'; p.push(`%${q}%`,`%${q}%`); }
    const total    = database.prepare(`SELECT COUNT(*) as n FROM team_name_map ${where}`).get(...p).n;
    const mappings = database.prepare(`SELECT id,source,source_name,canonical_name FROM team_name_map ${where} ORDER BY source_name LIMIT ? OFFSET ?`).all(...p,parseInt(limit),offset);
    res.json({ mappings, total, page:parseInt(page), pages:Math.ceil(total/parseInt(limit)) });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/admin/mappings/:id', (req, res) => {
  let wdb; try { wdb=new Database(DB_PATH); wdb.prepare('UPDATE team_name_map SET canonical_name=? WHERE id=?').run(req.body.canonical_name,parseInt(req.params.id)); db=null; res.json({ok:true}); } catch(e){res.status(500).json({error:e.message});}finally{if(wdb)wdb.close();}
});

app.delete('/api/admin/mappings/:id', (req, res) => {
  let wdb; try { wdb=new Database(DB_PATH); wdb.prepare('DELETE FROM team_name_map WHERE id=?').run(parseInt(req.params.id)); db=null; res.json({ok:true}); } catch(e){res.status(500).json({error:e.message});}finally{if(wdb)wdb.close();}
});

app.post('/api/admin/mappings', (req, res) => {
  let wdb; try { wdb=new Database(DB_PATH); const {source='football-data',source_name,canonical_name}=req.body; wdb.prepare('INSERT INTO team_name_map (source,source_name,canonical_name) VALUES (?,?,?) ON CONFLICT(source,source_name) DO UPDATE SET canonical_name=excluded.canonical_name').run(source,source_name,canonical_name); db=null; res.json({ok:true}); } catch(e){res.status(500).json({error:e.message});}finally{if(wdb)wdb.close();}
});

app.get('/api/admin/collection-log', (req, res) => {
  const database = getDb();
  if (!database) return res.json({ logs:[] });
  try {
    const { limit=50 } = req.query;
    const main = database.prepare('SELECT \'api-football\' as source,league_name,season,status,fixtures_count as fixtures,odds_count,finished_at,notes FROM collection_log ORDER BY finished_at DESC LIMIT ?').all(parseInt(limit));
    let alt=[];
    try { alt=database.prepare('SELECT source,league_name,season,status,fixtures_found as fixtures,null as odds_count,finished_at,notes FROM alt_collection_log ORDER BY finished_at DESC LIMIT ?').all(parseInt(limit)); } catch {}
    const all=[...main,...alt].sort((a,b)=>(b.finished_at||'').localeCompare(a.finished_at||''));
    res.json({ logs:all.slice(0,parseInt(limit)) });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3500;
app.listen(PORT, () => {
  console.log(`⚽ Football Scout API — port ${PORT}`);
  console.log(`   API-Football: ${API_KEY?'✓':'✗'}`);
  console.log(`   The Odds API: ${ODDS_API_KEY?'✓':'✗'}`);
  console.log(`   Football Data: ${FD_KEY?'✓':'✗'}`);
  console.log(`   DB: ${fs.existsSync(DB_PATH)?DB_PATH+' ✓':'not found (run backfill)'}`);
});