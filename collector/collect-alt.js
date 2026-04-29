/**
 * Football Scout — Collector Alternativo (football-data.org)
 * Responsabilidade: resultados, half-time, cantos, cartões, remates básicos
 *
 * NÃO recolhe: odds, xG, posse, stats avançadas (isso é do collect.js)
 * SEM limite diário — 10 req/min, corre tudo de uma vez
 *
 * Uso:
 *   node collect-alt.js --mode=backfill
 *   node collect-alt.js --mode=backfill --season=2024
 *   node collect-alt.js --mode=daily
 *   node collect-alt.js --mode=status
 *
 * Registo: https://www.football-data.org/client/register
 */

require('dotenv').config();
const axios    = require('axios');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// ── Config ────────────────────────────────────────────────────
const API_KEY  = process.env.FOOTBALL_DATA_KEY;
const DB_PATH  = process.env.DB_PATH || path.join(__dirname, '../data/football.db');
const DELAY_MS = 6200; // 10 req/min com margem de segurança

// Mapeamento: código football-data → league_id interno (API-Football)
const LEAGUE_MAP = [
  { fdCode: 'CL',  leagueId: 2,   name: 'Champions League' },
  { fdCode: 'EL',  leagueId: 3,   name: 'Europa League'    },
  { fdCode: 'PL',  leagueId: 39,  name: 'Premier League'   },
  { fdCode: 'PD',  leagueId: 140, name: 'La Liga'          },
  { fdCode: 'SA',  leagueId: 135, name: 'Serie A'          },
  { fdCode: 'BL1', leagueId: 78,  name: 'Bundesliga'       },
  { fdCode: 'FL1', leagueId: 61,  name: 'Ligue 1'          },
  { fdCode: 'PPL', leagueId: 94,  name: 'Primeira Liga'    },
  { fdCode: 'DED', leagueId: 88,  name: 'Eredivisie'       },
];

const BACKFILL_SEASONS = [2024, 2023, 2022, 2021, 2020, 2019, 2018, 2017, 2016, 2015];

// ── API Client ────────────────────────────────────────────────
const api = axios.create({
  baseURL: 'https://api.football-data.org/v4',
  headers: { 'X-Auth-Token': API_KEY },
  timeout: 15000,
});

let requestCount = 0;

async function apiGet(endpoint, params = {}) {
  await sleep(DELAY_MS);
  requestCount++;
  try {
    const res = await api.get(endpoint, { params });
    return res.data;
  } catch (err) {
    if (err.response?.status === 429) {
      log('Rate limit — a aguardar 65s...', 'warn');
      await sleep(65000);
      return apiGet(endpoint, params);
    }
    if (err.response?.status === 403) {
      log(`Sem acesso a ${endpoint} no plano FREE`, 'warn');
      return null;
    }
    log(`Erro API [${endpoint}]: ${err.message}`, 'error');
    return null;
  }
}

// ── Database ──────────────────────────────────────────────────
function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    log(`BD não encontrada: ${DB_PATH}`, 'error');
    log('Corre primeiro: node collect.js --mode=status', 'error');
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

function migrateDb(db) {
  // Coluna source para rastrear origem dos dados
  const cols = db.prepare('PRAGMA table_info(matches)').all().map(r => r.name);
  if (!cols.includes('source')) {
    db.exec(`ALTER TABLE matches ADD COLUMN source TEXT DEFAULT 'api-football'`);
    log('Migração: adicionada coluna matches.source');
  }

  // Tabela de mapeamento de nomes entre fontes
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_name_map (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source         TEXT NOT NULL,
      source_name    TEXT NOT NULL,
      canonical_name TEXT,
      UNIQUE(source, source_name)
    );

    CREATE TABLE IF NOT EXISTS alt_collection_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source          TEXT,
      league_code     TEXT,
      league_name     TEXT,
      season          INTEGER,
      status          TEXT,
      fixtures_found  INTEGER DEFAULT 0,
      inserted        INTEGER DEFAULT 0,
      updated         INTEGER DEFAULT 0,
      started_at      TEXT,
      finished_at     TEXT DEFAULT (datetime('now')),
      notes           TEXT
    );
  `);
}

// ── Fuzzy match entre nomes de equipas de fontes diferentes ──
// Normaliza nome: remove sufixos comuns, acentos, pontuação
function normalizeName(s) {
  const suffixes = [' fc', ' cf', ' sc', ' ac', ' afc', ' fk', ' sk', ' if',
                    ' club', ' football club', ' calcio', ' united', ' city'];
  let n = s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  for (const suf of suffixes) {
    if (n.endsWith(suf)) { n = n.slice(0, -suf.length).trim(); break; }
  }
  return n;
}

function similarity(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.9;

  // Token overlap (palavras em comum)
  const tA = new Set(na.split(' ').filter(w => w.length > 2));
  const tB = new Set(nb.split(' ').filter(w => w.length > 2));
  const tokenInter = [...tA].filter(w => tB.has(w)).length;
  if (tA.size > 0 && tB.size > 0) {
    const tokenScore = (2 * tokenInter) / (tA.size + tB.size);
    if (tokenScore >= 0.7) return tokenScore;
  }

  // Bigram similarity como fallback
  const bigrams = s => { const bg = new Set(); for (let i=0;i<s.length-1;i++) bg.add(s.slice(i,i+2)); return bg; };
  const bgA = bigrams(na.replace(/ /g,'')), bgB = bigrams(nb.replace(/ /g,''));
  if (bgA.size === 0 || bgB.size === 0) return 0;
  const inter = [...bgA].filter(x => bgB.has(x)).length;
  return (2 * inter) / (bgA.size + bgB.size);
}

function findExistingFixture(db, homeFd, awayFd, datePart, leagueId) {
  // 1. Verifica mapeamento já aprendido
  const mapHome = db.prepare(`SELECT canonical_name FROM team_name_map WHERE source='football-data' AND source_name=?`).get(homeFd);
  const mapAway = db.prepare(`SELECT canonical_name FROM team_name_map WHERE source='football-data' AND source_name=?`).get(awayFd);
  const searchHome = mapHome?.canonical_name || homeFd;
  const searchAway = mapAway?.canonical_name || awayFd;

  // 2. Match exato com nome mapeado
  const exact = db.prepare(`
    SELECT fixture_id, home_name, away_name FROM matches
    WHERE league_id=? AND date LIKE ? AND home_name=? AND away_name=?
  `).get(leagueId, datePart+'%', searchHome, searchAway);
  if (exact) return { ...exact, score: 1.0 };

  // 3. Match no dia ±1 (jogos com timezone diferente podem aparecer no dia errado)
  const d = new Date(datePart);
  const dayBefore = new Date(d - 86400000).toISOString().slice(0,10);
  const dayAfter  = new Date(d + 86400000).toISOString().slice(0,10);

  const candidates = db.prepare(`
    SELECT fixture_id, home_name, away_name, date FROM matches
    WHERE league_id=? AND (date LIKE ? OR date LIKE ? OR date LIKE ?)
    LIMIT 50
  `).all(leagueId, datePart+'%', dayBefore+'%', dayAfter+'%');

  // 4. Score composto: similaridade de nome + penalidade por diferença de dia
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const nameSim = (similarity(homeFd, c.home_name) + similarity(awayFd, c.away_name)) / 2;
    const cDay = c.date?.slice(0,10);
    const dayPenalty = cDay === datePart ? 0 : 0.05; // penaliza match noutro dia
    const score = nameSim - dayPenalty;
    if (score > bestScore) { bestScore = score; best = { ...c, score }; }
  }

  // Threshold mais baixo para matches com mapeamento já confirmado
  const threshold = (mapHome || mapAway) ? 0.55 : 0.65;
  return bestScore >= threshold ? best : null;
}

// ── Processar e guardar jogos ─────────────────────────────────
function processMatches(db, matches, leagueId, leagueName, season) {
  let inserted = 0, updated = 0;

  // INSERT para jogos novos — só campos básicos (sem sobrescrever odds/xG)
  const insertNew = db.prepare(`
    INSERT OR IGNORE INTO matches (
      fixture_id, season, league_id, league_name, date, status,
      home_name, away_name, goals_home, goals_away, result,
      ht_home, ht_away,
      shots_home, shots_away,
      corners_home, corners_away,
      yellows_home, yellows_away,
      reds_home, reds_away,
      source
    ) VALUES (
      @fixture_id, @season, @league_id, @league_name, @date, 'FT',
      @home_name, @away_name, @goals_home, @goals_away, @result,
      @ht_home, @ht_away,
      @shots_home, @shots_away,
      @corners_home, @corners_away,
      @yellows_home, @yellows_away,
      @reds_home, @reds_away,
      'football-data'
    )
  `);

  // UPDATE para jogos existentes — COALESCE garante que só preenche NULLs
  // Nunca sobrescreve dados que o API-Football já preencheu
  const fillNulls = db.prepare(`
    UPDATE matches SET
      goals_home   = COALESCE(goals_home,   @goals_home),
      goals_away   = COALESCE(goals_away,   @goals_away),
      result       = COALESCE(result,       @result),
      ht_home      = COALESCE(ht_home,      @ht_home),
      ht_away      = COALESCE(ht_away,      @ht_away),
      shots_home   = COALESCE(shots_home,   @shots_home),
      shots_away   = COALESCE(shots_away,   @shots_away),
      corners_home = COALESCE(corners_home, @corners_home),
      corners_away = COALESCE(corners_away, @corners_away),
      yellows_home = COALESCE(yellows_home, @yellows_home),
      yellows_away = COALESCE(yellows_away, @yellows_away),
      reds_home    = COALESCE(reds_home,    @reds_home),
      reds_away    = COALESCE(reds_away,    @reds_away)
    WHERE fixture_id = @fixture_id
  `);

  const saveMap = db.prepare(`
    INSERT OR IGNORE INTO team_name_map (source, source_name, canonical_name)
    VALUES ('football-data', @source_name, @canonical_name)
  `);

  const run = db.transaction(() => {
    for (const m of matches) {
      if (m.status !== 'FINISHED') continue;

      const homeFd   = m.homeTeam?.shortName || m.homeTeam?.name || '';
      const awayFd   = m.awayTeam?.shortName || m.awayTeam?.name || '';
      const datePart = m.utcDate?.slice(0, 10);

      const gh = m.score?.fullTime?.home ?? null;
      const ga = m.score?.fullTime?.away ?? null;
      const result = gh === null ? null : gh > ga ? 'H' : gh < ga ? 'A' : 'D';

      // football-data.org v4 — stats vêm em m.statistics (array por equipa)
      const hSt = (m.statistics || [])[0] || {};
      const aSt = (m.statistics || [])[1] || {};
      const getStat = (obj, ...keys) => {
        for (const k of keys) { if (obj[k] !== undefined && obj[k] !== null) return parseInt(obj[k]) || null; }
        return null;
      };

      const row = {
        goals_home:   gh,
        goals_away:   ga,
        result,
        ht_home:      m.score?.halfTime?.home ?? null,
        ht_away:      m.score?.halfTime?.away ?? null,
        shots_home:   getStat(hSt, 'Total Shots', 'total_shots', 'totalShots'),
        shots_away:   getStat(aSt, 'Total Shots', 'total_shots', 'totalShots'),
        corners_home: getStat(hSt, 'Corner Kicks', 'corner_kicks', 'cornerKicks'),
        corners_away: getStat(aSt, 'Corner Kicks', 'corner_kicks', 'cornerKicks'),
        yellows_home: getStat(hSt, 'Yellow Cards', 'yellow_cards', 'yellowCards'),
        yellows_away: getStat(aSt, 'Yellow Cards', 'yellow_cards', 'yellowCards'),
        reds_home:    getStat(hSt, 'Red Cards', 'red_cards', 'redCards'),
        reds_away:    getStat(aSt, 'Red Cards', 'red_cards', 'redCards'),
      };

      const existing = findExistingFixture(db, homeFd, awayFd, datePart, leagueId);

      if (existing) {
        // Guarda mapeamento para futuras runs (mais rápido)
        if (existing.home_name !== homeFd) saveMap.run({ source_name: homeFd, canonical_name: existing.home_name });
        if (existing.away_name !== awayFd) saveMap.run({ source_name: awayFd, canonical_name: existing.away_name });

        fillNulls.run({ ...row, fixture_id: existing.fixture_id });
        updated++;
      } else {
        // Jogo não existe — insere com ID sintético negativo
        // Negativo para nunca colidir com IDs reais do API-Football
        const synId = -Math.abs(
          (leagueId * 1e8 + season * 1e4 +
          parseInt(datePart.replace(/-/g,'').slice(-4)) +
          (homeFd.charCodeAt(0) || 0) + (awayFd.charCodeAt(0) || 0)) % 2147483647
        );
        insertNew.run({
          fixture_id: synId, season, league_id: leagueId, league_name: leagueName,
          date: m.utcDate, home_name: homeFd, away_name: awayFd, ...row,
        });
        inserted++;
      }
    }
  });

  run();
  return { inserted, updated };
}

// ── Modos ─────────────────────────────────────────────────────
async function modeBackfill(db) {
  const arg = process.argv.find(a => a.startsWith('--season='));
  const target = arg ? [parseInt(arg.split('=')[1])] : BACKFILL_SEASONS;

  log('\n══════════════════════════════════════════');
  log(' COLLECTOR ALT — Backfill (football-data.org)');
  log(' Responsabilidade: resultados + stats básicas');
  log(` Temporadas: ${target.join(', ')} | Ligas: ${LEAGUE_MAP.length}`);
  log(' Sem limite diário — a correr tudo de uma vez');
  log('══════════════════════════════════════════\n');

  let totalIns = 0, totalUpd = 0;

  for (const season of target) {
    for (const league of LEAGUE_MAP) {
      const startedAt = new Date().toISOString();
      log(`\n📥 ${league.name} ${season}...`);

      const data = await apiGet(`/competitions/${league.fdCode}/matches`, {
        season,
        status: 'FINISHED',
      });

      if (!data) {
        db.prepare(`INSERT INTO alt_collection_log (source,league_code,league_name,season,status,started_at,notes) VALUES ('football-data',?,?,?,'skipped',?,'no access')`
        ).run(league.fdCode, league.name, season, startedAt);
        continue;
      }

      const matches = data.matches || [];
      log(`   ${matches.length} jogos`);
      if (!matches.length) continue;

      const { inserted, updated } = processMatches(db, matches, league.leagueId, league.name, season);
      totalIns += inserted; totalUpd += updated;
      log(`   ✓ Novos: ${inserted} | Atualizados: ${updated}`);

      db.prepare(`INSERT INTO alt_collection_log (source,league_code,league_name,season,status,fixtures_found,inserted,updated,started_at) VALUES ('football-data',?,?,?,'done',?,?,?,?)`
      ).run(league.fdCode, league.name, season, matches.length, inserted, updated, startedAt);
    }
  }

  log(`\n✓ Concluído — Novos: ${totalIns} | Atualizados: ${totalUpd} | Requests: ${requestCount}`);
}

async function modeDaily(db) {
  log('\n📅 DAILY ALT — Últimos 14 dias');
  const today    = new Date();
  const dateTo   = today.toISOString().slice(0,10);
  const dateFrom = new Date(today - 14*86400000).toISOString().slice(0,10);
  const season   = getCurrentSeason();

  for (const league of LEAGUE_MAP) {
    log(`\n  ${league.name}...`);
    const data = await apiGet(`/competitions/${league.fdCode}/matches`, {
      dateFrom, dateTo, status: 'FINISHED',
    });
    if (!data?.matches?.length) continue;
    const { inserted, updated } = processMatches(db, data.matches, league.leagueId, league.name, season);
    log(`   ✓ Novos: ${inserted} | Atualizados: ${updated}`);
  }
}

function modeStatus(db) {
  try {
    const src = db.prepare(`SELECT COUNT(*) as n FROM matches WHERE source='football-data'`).get();
    const map = db.prepare(`SELECT COUNT(*) as n FROM team_name_map`).get();
    const logs = db.prepare(`SELECT league_name,season,status,fixtures_found,inserted,updated,finished_at FROM alt_collection_log ORDER BY finished_at DESC LIMIT 20`).all();

    console.log('\n══════════════════════════════════════════');
    console.log(' ESTADO — Collector Alternativo (football-data.org)');
    console.log('══════════════════════════════════════════');
    console.log(` Jogos inseridos por este collector: ${src?.n || 0}`);
    console.log(` Mapeamentos de equipas:             ${map?.n || 0}`);
    if (logs.length) {
      console.log('\n Últimas recolhas:');
      logs.forEach(r => {
        const ts = r.finished_at?.slice(0,16)||'—';
        console.log(`   ${ts}  ${(r.league_name||'').padEnd(22)} ${r.season}  [${r.status}]  +${r.inserted||0} novos  ~${r.updated||0} atualizados`);
      });
    } else {
      console.log('\n Ainda sem recolhas. Corre: node collect-alt.js --mode=backfill');
    }
    console.log('══════════════════════════════════════════\n');
  } catch (e) {
    console.log('\nAinda sem tabelas alt — corre o backfill primeiro.\n');
  }
}

// ── Utils ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function getCurrentSeason() { const n=new Date(); return n.getMonth()>=6?n.getFullYear():n.getFullYear()-1; }
function log(msg, level='info') {
  const ts = new Date().toLocaleTimeString('pt-PT');
  console.log(`[${ts}] ${level==='warn'?'⚠ ':level==='error'?'✗ ':''}${msg}`);
}

// ── Entry point ───────────────────────────────────────────────
async function main() {
  if (!API_KEY) {
    console.error('✗ FOOTBALL_DATA_KEY não definida no .env');
    console.error('  Regista em: https://www.football-data.org/client/register');
    process.exit(1);
  }

  const mode = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] || 'status';
  log(`⚽ Collector ALT (football-data.org) — ${mode.toUpperCase()}`);
  log(`   BD: ${DB_PATH}`);

  const db = openDb();
  migrateDb(db);

  try {
    if      (mode === 'backfill') await modeBackfill(db);
    else if (mode === 'daily')    await modeDaily(db);
    else if (mode === 'status')   modeStatus(db);
    else { console.error(`Modo desconhecido: ${mode}`); process.exit(1); }
  } finally {
    db.close();
    log(`Total requests: ${requestCount}`);
  }
}

main().catch(err => { console.error('Erro fatal:', err.message); process.exit(1); });
