/**
 * Football Scout — Historical Data Collector
 *
 * Uso:
 *   node collect.js --mode=backfill            → dados históricos (todas as temporadas)
 *   node collect.js --mode=backfill --season=2024
 *   node collect.js --mode=daily               → atualiza jogos recentes
 *   node collect.js --mode=status              → estado da BD
 *   node collect.js --mode=export              → exporta BD completa para JSON
 *   node collect.js --mode=export --out=/data/backup.json
 */

require('dotenv').config();
const axios    = require('axios');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const { ensureSchema } = require('../shared/schema');

// ── Config ────────────────────────────────────────────────────
const API_KEY  = process.env.API_FOOTBALL_KEY;
const DB_PATH  = process.env.DB_PATH || path.join(__dirname, '../data/football.db');
const DELAY_MS = parseInt(process.env.DELAY_MS) || 1200;

const LEAGUES = [
  { id: 2,   name: 'Champions League'  },
  { id: 3,   name: 'Europa League'     },
  { id: 848, name: 'Conference League' },
  { id: 39,  name: 'Premier League'    },
  { id: 140, name: 'La Liga'           },
  { id: 135, name: 'Serie A'           },
  { id: 78,  name: 'Bundesliga'        },
  { id: 61,  name: 'Ligue 1'           },
  { id: 94,  name: 'Primeira Liga'     },
  { id: 88,  name: 'Eredivisie'        },
];

const BACKFILL_SEASONS = [2024, 2023, 2022, 2021, 2020];

// ── API Client ────────────────────────────────────────────────
const api = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': API_KEY },
  timeout: 15000,
});

let requestCount = 0;

async function apiGet(endpoint, params = {}) {
  await sleep(DELAY_MS);
  requestCount++;
  try {
    const res = await api.get(endpoint, { params });
    const remaining = res.headers['x-ratelimit-requests-remaining'];
    if (remaining && parseInt(remaining) < 10) {
      log(`⚠  Apenas ${remaining} requests restantes hoje!`, 'warn');
    }
    return res.data.response || [];
  } catch (err) {
    if (err.response?.status === 429) {
      log('Rate limit atingido — a aguardar 60s...', 'warn');
      await sleep(60000);
      return apiGet(endpoint, params);
    }
    log(`Erro API [${endpoint}]: ${err.message}`, 'error');
    return [];
  }
}

// ── Database ──────────────────────────────────────────────────
function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

// Retorna as colunas reais de uma tabela
function getColumns(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  } catch { return []; }
}

// Adiciona coluna se não existir (migração segura)
function addColumnIfMissing(db, table, col, type) {
  const cols = getColumns(db, table);
  if (!cols.includes(col)) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      log(`  Migração: adicionada coluna ${table}.${col}`);
    } catch (e) {
      log(`  Migração falhou (${table}.${col}): ${e.message}`, 'warn');
    }
  }
}

function initDb(db) {
  ensureSchema(db);   // esquema partilhado (shared/schema.js), idempotente
  log('Base de dados iniciada ✓');
}

// ── Statements ────────────────────────────────────────────────
function prepareStatements(db) {
  return {
    upsertMatch: db.prepare(`
      INSERT INTO matches (
        fixture_id, season, league_id, league_name, date, status,
        home_id, home_name, away_id, away_name,
        goals_home, goals_away, result, ht_home, ht_away,
        shots_home, shots_away, shots_ot_home, shots_ot_away,
        poss_home, poss_away, corners_home, corners_away,
        fouls_home, fouls_away, yellows_home, yellows_away,
        reds_home, reds_away, xg_home, xg_away
      ) VALUES (
        @fixture_id, @season, @league_id, @league_name, @date, @status,
        @home_id, @home_name, @away_id, @away_name,
        @goals_home, @goals_away, @result, @ht_home, @ht_away,
        @shots_home, @shots_away, @shots_ot_home, @shots_ot_away,
        @poss_home, @poss_away, @corners_home, @corners_away,
        @fouls_home, @fouls_away, @yellows_home, @yellows_away,
        @reds_home, @reds_away, @xg_home, @xg_away
      )
      ON CONFLICT(fixture_id) DO UPDATE SET
        status=COALESCE(excluded.status,status),
        league_name=COALESCE(excluded.league_name,league_name),
        goals_home=COALESCE(excluded.goals_home,goals_home), goals_away=COALESCE(excluded.goals_away,goals_away),
        result=COALESCE(excluded.result,result), ht_home=COALESCE(excluded.ht_home,ht_home), ht_away=COALESCE(excluded.ht_away,ht_away),
        shots_home=COALESCE(excluded.shots_home,shots_home), shots_away=COALESCE(excluded.shots_away,shots_away),
        shots_ot_home=COALESCE(excluded.shots_ot_home,shots_ot_home), shots_ot_away=COALESCE(excluded.shots_ot_away,shots_ot_away),
        poss_home=COALESCE(excluded.poss_home,poss_home), poss_away=COALESCE(excluded.poss_away,poss_away),
        corners_home=COALESCE(excluded.corners_home,corners_home), corners_away=COALESCE(excluded.corners_away,corners_away),
        fouls_home=COALESCE(excluded.fouls_home,fouls_home), fouls_away=COALESCE(excluded.fouls_away,fouls_away),
        yellows_home=COALESCE(excluded.yellows_home,yellows_home), yellows_away=COALESCE(excluded.yellows_away,yellows_away),
        reds_home=COALESCE(excluded.reds_home,reds_home), reds_away=COALESCE(excluded.reds_away,reds_away),
        xg_home=COALESCE(excluded.xg_home,xg_home), xg_away=COALESCE(excluded.xg_away,xg_away)
    `),

    upsertOdd: db.prepare(`
      INSERT OR IGNORE INTO odds (fixture_id, bookmaker_id, bookmaker_name, market, value, odd)
      VALUES (@fixture_id, @bookmaker_id, @bookmaker_name, @market, @value, @odd)
    `),

    upsertTeamStats: db.prepare(`
      INSERT INTO team_season_stats (
        team_id, team_name, season, league_id,
        played, wins, draws, losses,
        goals_for, goals_against, avg_goals_for, avg_goals_against,
        clean_sheets, form
      ) VALUES (
        @team_id, @team_name, @season, @league_id,
        @played, @wins, @draws, @losses,
        @goals_for, @goals_against, @avg_goals_for, @avg_goals_against,
        @clean_sheets, @form
      )
      ON CONFLICT(team_id, season, league_id) DO UPDATE SET
        played=excluded.played, wins=excluded.wins,
        draws=excluded.draws, losses=excluded.losses,
        goals_for=excluded.goals_for, goals_against=excluded.goals_against,
        avg_goals_for=excluded.avg_goals_for,
        avg_goals_against=excluded.avg_goals_against,
        clean_sheets=excluded.clean_sheets, form=excluded.form
    `),

    logCollection: db.prepare(`
      INSERT INTO collection_log (league_id, league_name, season, status, fixtures_count, odds_count, started_at, notes)
      VALUES (@league_id, @league_name, @season, @status, @fixtures_count, @odds_count, @started_at, @notes)
    `),

    alreadyDone: db.prepare(`
      SELECT id FROM collection_log WHERE league_id=? AND season=? AND status='done'
    `),
  };
}

// ── Recolha de uma liga/temporada ─────────────────────────────
// Responsabilidade: odds + xG + posse + stats avançadas
// Resultados e stats básicas são da responsabilidade do collect-alt.js
async function collectLeagueSeason(db, stmts, leagueId, leagueName, season) {
  const alreadyDone = stmts.alreadyDone.get(leagueId, season);
  if (alreadyDone && !process.argv.includes('--force')) {
    log(`  ↳ Já recolhido: ${leagueName} ${season} — a saltar`);
    return { fixtures: 0, odds: 0 };
  }

  const startedAt = new Date().toISOString();
  log(`\n📥 ${leagueName} (${season})...`);

  // Buscar lista de fixtures para ter os IDs (necessário para stats e odds)
  const fixtures = await apiGet('/fixtures', { league: leagueId, season });
  if (!fixtures.length) {
    log(`   Sem fixtures`);
    return { fixtures: 0, odds: 0 };
  }

  const finished = fixtures.filter(f =>
    ['FT', 'AET', 'PEN', 'AWD', 'WO'].includes(f.fixture.status.short)
  );
  log(`   ${fixtures.length} total → ${finished.length} terminados`);

  // Garante que os jogos existem na BD (o alt pode ainda não ter corrido)
  // Usa INSERT OR IGNORE — não sobrescreve dados do alt collector
  const insertMany = db.transaction((rows) => {
    for (const f of rows) stmts.upsertMatch.run(f);
  });
  insertMany(finished.map(f => mapFixture(f, season, leagueId, leagueName)));

  // ── Odds (1X2, Over/Under, BTTS) — PRIORIDADE 1 ──────────────
  // Odds primeiro — se não há odds (plano FREE), não perde requests em xG
  let oddsCount = 0;
  const insertOdds = db.transaction((rows) => {
    for (const o of rows) stmts.upsertOdd.run(o);
  });

  for (const betId of [1, 5, 8]) { // 1=1X2, 5=O/U, 8=BTTS
    const oddsRes = await apiGet('/odds', { league: leagueId, season, bookmaker: 6, bet: betId });
    const rows = parseOddsResponse(oddsRes);
    insertOdds(rows);
    oddsCount += rows.length;
  }
  log(`   Odds: ${oddsCount}`);

  // ── Stats avançadas (xG, posse) — PRIORIDADE 2 ────────────────
  // Só recolhe se encontrou odds (confirma que o plano suporta dados históricos)
  // ou se é a temporada atual (dados em tempo real disponíveis no FREE)
  const currentSeason = getCurrentSeason();
  const shouldCollectXg = oddsCount > 0 || season >= currentSeason;

  if (shouldCollectXg) {
    const missingXg = db.prepare(`
      SELECT fixture_id FROM matches
      WHERE league_id=? AND season=? AND xg_home IS NULL AND status IN ('FT','AET','PEN')
      LIMIT 50
    `).all(leagueId, season);

    log(`   xG/posse em falta: ${missingXg.length} jogos`);
    let advStats = 0;
    for (const { fixture_id } of missingXg) {
      if (await collectAdvancedStats(db, fixture_id)) advStats++;
    }
    if (advStats > 0) log(`   Stats avançadas: ${advStats}`);
  } else {
    log(`   xG: a saltar (plano FREE sem odds históricas — a poupar requests)`);
  }

  // ── Stats de equipa (tabela, forma, médias) ───────────────────
  await collectTeamStats(db, stmts, leagueId, leagueName, season, finished);

  stmts.logCollection.run({
    league_id: leagueId, league_name: leagueName, season, status: 'done',
    fixtures_count: finished.length, odds_count: oddsCount,
    started_at: startedAt, notes: `requests:${requestCount}`
  });

  return { fixtures: finished.length, odds: oddsCount };
}

// Stats avançadas — xG e posse (exclusivo API-Football)
// Cantos/cartões/remates básicos ficam para o collect-alt.js
async function collectAdvancedStats(db, fixtureId) {
  const stats = await apiGet('/fixtures/statistics', { fixture: fixtureId });
  if (!stats.length) return false;

  const p = (teamStats, key) => {
    const s = teamStats?.statistics?.find(s => s.type === key);
    const v = s?.value;
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.endsWith('%')) return parseInt(v);
    return parseInt(v) || null;
  };

  const home = stats[0], away = stats[1];

  // Actualiza só campos que o football-data.org não tem:
  //   xG, posse, shots on target, fouls
  // Usa COALESCE para não sobrescrever dados do alt collector
  db.prepare(`
    UPDATE matches SET
      xg_home      = COALESCE(xg_home,      ?),
      xg_away      = COALESCE(xg_away,      ?),
      poss_home    = COALESCE(poss_home,    ?),
      poss_away    = COALESCE(poss_away,    ?),
      shots_ot_home = COALESCE(shots_ot_home, ?),
      shots_ot_away = COALESCE(shots_ot_away, ?),
      fouls_home   = COALESCE(fouls_home,   ?),
      fouls_away   = COALESCE(fouls_away,   ?)
    WHERE fixture_id=?
  `).run(
    p(home,'expected_goals'), p(away,'expected_goals'),
    p(home,'Ball Possession'), p(away,'Ball Possession'),
    p(home,'Shots on Goal'), p(away,'Shots on Goal'),
    p(home,'Fouls'), p(away,'Fouls'),
    fixtureId
  );
  return true;
}

async function collectTeamStats(db, stmts, leagueId, leagueName, season, fixtures) {
  const teamIds = new Set();
  const teamNames = {};
  fixtures.forEach(f => {
    teamIds.add(f.teams.home.id); teamNames[f.teams.home.id] = f.teams.home.name;
    teamIds.add(f.teams.away.id); teamNames[f.teams.away.id] = f.teams.away.name;
  });
  log(`   Equipas: ${teamIds.size}`);

  for (const teamId of teamIds) {
    const s = await apiGet('/teams/statistics', { team: teamId, league: leagueId, season });
    if (!s || !s.team) continue;
    stmts.upsertTeamStats.run({
      team_id: teamId, team_name: teamNames[teamId] || s.team?.name,
      season, league_id: leagueId,
      played: s.fixtures?.played?.total || 0,
      wins:   s.fixtures?.wins?.total   || 0,
      draws:  s.fixtures?.draws?.total  || 0,
      losses: s.fixtures?.loses?.total  || 0,
      goals_for:         s.goals?.for?.total?.total    || 0,
      goals_against:     s.goals?.against?.total?.total || 0,
      avg_goals_for:     parseFloat(s.goals?.for?.average?.total  || 0),
      avg_goals_against: parseFloat(s.goals?.against?.average?.total || 0),
      clean_sheets: s.clean_sheet?.total || 0,
      form: s.form?.slice(-5) || '',
    });
  }
}

// ── Mappers ───────────────────────────────────────────────────
function mapFixture(f, season, leagueId, leagueName) {
  const gh = f.goals.home, ga = f.goals.away;
  return {
    fixture_id: f.fixture.id, season, league_id: leagueId, league_name: leagueName,
    date: f.fixture.date, status: f.fixture.status.short,
    home_id: f.teams.home.id, home_name: f.teams.home.name,
    away_id: f.teams.away.id, away_name: f.teams.away.name,
    goals_home: gh, goals_away: ga,
    result: gh === null ? null : gh > ga ? 'H' : gh < ga ? 'A' : 'D',
    ht_home: f.score?.halftime?.home ?? null,
    ht_away: f.score?.halftime?.away ?? null,
    shots_home: null, shots_away: null, shots_ot_home: null, shots_ot_away: null,
    poss_home: null, poss_away: null, corners_home: null, corners_away: null,
    fouls_home: null, fouls_away: null, yellows_home: null, yellows_away: null,
    reds_home: null, reds_away: null, xg_home: null, xg_away: null,
  };
}

function parseOddsResponse(oddsRes) {
  const rows = [];
  for (const item of oddsRes) {
    const fixtureId = item.fixture?.id;
    if (!fixtureId) continue;
    for (const bm of (item.bookmakers || [])) {
      for (const bet of (bm.bets || [])) {
        for (const v of (bet.values || [])) {
          rows.push({
            fixture_id: fixtureId, bookmaker_id: bm.id, bookmaker_name: bm.name,
            market: bet.name, value: v.value, odd: parseFloat(v.odd),
          });
        }
      }
    }
  }
  return rows;
}

// ── Modos ─────────────────────────────────────────────────────
async function modeBackfill(db, stmts) {
  const arg = process.argv.find(a => a.startsWith('--season='));
  const targetSeason = arg ? parseInt(arg.split('=')[1]) : null;
  const seasons = targetSeason ? [targetSeason] : BACKFILL_SEASONS;

  log('\n══════════════════════════════════════════');
  log(' MODO BACKFILL — Recolha histórica');
  log(`  Temporadas: ${seasons.join(', ')}`);
  log(`  Ligas:      ${LEAGUES.length}`);
  log('══════════════════════════════════════════\n');
  log('💡 Plano FREE: 100 req/dia → o script retoma onde parou.\n');

  let totalFixtures = 0, totalOdds = 0;
  for (const season of seasons) {
    for (const league of LEAGUES) {
      // Para quando sobram poucos requests (guarda margem para o daily)
      if (requestCount > 85) {
        log(`\n⚠ Limite de requests próximo (${requestCount}) — a parar backfill para hoje`);
        log(`   Retoma amanhã automaticamente`);
        return;
      }
      const { fixtures, odds } = await collectLeagueSeason(db, stmts, league.id, league.name, season);
      totalFixtures += fixtures; totalOdds += odds;
      log(`   Acumulado: ${totalFixtures} jogos | ${totalOdds} odds | ${requestCount} requests`);
    }
  }

  log(`\n✓ Backfill concluído: ${totalFixtures} jogos | ${totalOdds} odds`);
}

async function modeDaily(db, stmts) {
  const season = getCurrentSeason();
  log('\n📅 MODO DAILY');
  process.argv.push('--force');
  for (const league of LEAGUES) {
    await collectLeagueSeason(db, stmts, league.id, league.name, season);
  }
  process.argv.pop();
}

function modeStatus(db) {
  // Usa only colunas que sabemos existir com certeza
  const cols = getColumns(db, 'collection_log');
  const hasLeagueName = cols.includes('league_name');

  const matches = db.prepare('SELECT COUNT(*) as n FROM matches').get();
  const odds    = db.prepare('SELECT COUNT(*) as n FROM odds').get();
  const teams   = db.prepare('SELECT COUNT(*) as n FROM team_season_stats').get();

  // Agrupa por league_id (sempre existe) com nome se disponível
  const matchCols = getColumns(db, 'matches');
  const hasMatchLeagueName = matchCols.includes('league_name');

  const byLeague = hasMatchLeagueName
    ? db.prepare(`SELECT league_name, season, COUNT(*) as jogos FROM matches GROUP BY league_name, season ORDER BY league_name, season DESC`).all()
    : db.prepare(`SELECT league_id, season, COUNT(*) as jogos FROM matches GROUP BY league_id, season ORDER BY league_id, season DESC`).all();

  const logQuery = hasLeagueName
    ? `SELECT league_name, season, status, fixtures_count, finished_at FROM collection_log ORDER BY finished_at DESC LIMIT 20`
    : `SELECT league_id, season, status, fixtures_count, finished_at FROM collection_log ORDER BY finished_at DESC LIMIT 20`;
  const logs = db.prepare(logQuery).all();

  console.log('\n══════════════════════════════════════════');
  console.log(' ESTADO DA BASE DE DADOS');
  console.log('══════════════════════════════════════════');
  console.log(` Jogos:    ${matches.n.toLocaleString()}`);
  console.log(` Odds:     ${odds.n.toLocaleString()}`);
  console.log(` Equipas:  ${teams.n.toLocaleString()}`);
  console.log('\n Por liga/temporada:');
  byLeague.forEach(r => {
    const name = (r.league_name || `Liga #${r.league_id}`).padEnd(22);
    console.log(`   ${name} ${r.season}  → ${r.jogos} jogos`);
  });
  if (logs.length) {
    console.log('\n Últimas recolhas:');
    logs.forEach(r => {
      const ts   = r.finished_at?.slice(0,16) || '—';
      const name = (r.league_name || `Liga #${r.league_id}` || '—').padEnd(22);
      console.log(`   ${ts}  ${name} ${r.season}  [${r.status}]  ${r.fixtures_count||0} jogos`);
    });
  }
  console.log('══════════════════════════════════════════\n');
}

// ── EXPORT COMPLETO ───────────────────────────────────────────
function modeExport(db) {
  const arg    = process.argv.find(a => a.startsWith('--out='));
  const outDir = process.env.EXPORT_DIR || '/data';
  const ts     = new Date().toISOString().slice(0,19).replace(/:/g,'-');
  const outPath = arg
    ? arg.split('=')[1]
    : path.join(outDir, `football-scout-backup-${ts}.json`);

  log(`\n📦 EXPORT COMPLETO → ${outPath}`);

  const tables = ['matches', 'odds', 'team_season_stats', 'collection_log'];
  const export_ = {
    exported_at:   new Date().toISOString(),
    version:       '1.0',
    generator:     'football-scout-collector',
    tables:        {},
    summary:       {},
  };

  for (const table of tables) {
    try {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      export_.tables[table] = rows;
      export_.summary[table] = rows.length;
      log(`   ${table}: ${rows.length.toLocaleString()} registos`);
    } catch (e) {
      log(`   ${table}: erro — ${e.message}`, 'warn');
      export_.tables[table] = [];
      export_.summary[table] = 0;
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(export_, null, 2), 'utf8');

  const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(2);
  log(`\n✓ Exportado: ${outPath} (${sizeMB} MB)`);
  log(`  Resumo: ${JSON.stringify(export_.summary)}`);

  return outPath;
}

// ── Utils ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getCurrentSeason() {
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

function log(msg, level = 'info') {
  const ts = new Date().toLocaleTimeString('pt-PT');
  const pre = level === 'warn' ? '⚠ ' : level === 'error' ? '✗ ' : '';
  console.log(`[${ts}] ${pre}${msg}`);
}

// ── Entry point ───────────────────────────────────────────────
async function main() {
  const mode = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] || 'status';

  log(`⚽ Football Scout Collector — modo: ${mode.toUpperCase()}`);
  log(`   BD: ${DB_PATH}`);

  const db    = openDb();
  initDb(db);

  // export não precisa de API key
  if (mode === 'export') {
    modeExport(db);
    db.close();
    return;
  }

  if (mode === 'status') {
    modeStatus(db);
    db.close();
    log(`Total requests API: ${requestCount}`);
    return;
  }

  if (!API_KEY) {
    console.error('✗ API_FOOTBALL_KEY não definida no .env');
    db.close();
    process.exit(1);
  }

  const stmts = prepareStatements(db);

  try {
    if (mode === 'backfill')    await modeBackfill(db, stmts);
    else if (mode === 'daily')  await modeDaily(db, stmts);
    else {
      console.error(`Modo desconhecido: ${mode}`);
      console.error('Usa: --mode=backfill | --mode=daily | --mode=status | --mode=export');
      process.exit(1);
    }
  } finally {
    db.close();
    log(`Total requests API: ${requestCount}`);
  }
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
