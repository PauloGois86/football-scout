'use strict';
/**
 * Esquema SQLite partilhado por todos os collectors / scripts.
 * Idempotente: pode ser chamado em cada arranque.
 */

function columns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name); } catch { return []; }
}

function addColumnIfMissing(db, table, col, type) {
  if (!columns(db, table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      fixture_id INTEGER PRIMARY KEY, season INTEGER NOT NULL, league_id INTEGER NOT NULL, league_name TEXT,
      date TEXT NOT NULL, status TEXT, home_id INTEGER, home_name TEXT, away_id INTEGER, away_name TEXT,
      goals_home INTEGER, goals_away INTEGER, result TEXT, ht_home INTEGER, ht_away INTEGER,
      shots_home INTEGER, shots_away INTEGER, shots_ot_home INTEGER, shots_ot_away INTEGER,
      poss_home INTEGER, poss_away INTEGER, corners_home INTEGER, corners_away INTEGER,
      fouls_home INTEGER, fouls_away INTEGER, yellows_home INTEGER, yellows_away INTEGER,
      reds_home INTEGER, reds_away INTEGER, xg_home REAL, xg_away REAL,
      collected_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS odds (
      id INTEGER PRIMARY KEY AUTOINCREMENT, fixture_id INTEGER NOT NULL, bookmaker_id INTEGER, bookmaker_name TEXT,
      market TEXT, value TEXT, odd REAL
    );
    CREATE TABLE IF NOT EXISTS team_season_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT, team_id INTEGER, team_name TEXT, season INTEGER, league_id INTEGER,
      played INTEGER, wins INTEGER, draws INTEGER, losses INTEGER, goals_for INTEGER, goals_against INTEGER,
      avg_goals_for REAL, avg_goals_against REAL, clean_sheets INTEGER, form TEXT,
      collected_at TEXT DEFAULT (datetime('now')), UNIQUE(team_id, season, league_id)
    );
    CREATE TABLE IF NOT EXISTS collection_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, league_id INTEGER, league_name TEXT, season INTEGER, status TEXT,
      fixtures_count INTEGER, odds_count INTEGER, started_at TEXT, finished_at TEXT DEFAULT (datetime('now')), notes TEXT
    );
    CREATE TABLE IF NOT EXISTS team_name_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, source_name TEXT NOT NULL, canonical_name TEXT,
      UNIQUE(source, source_name)
    );
    CREATE TABLE IF NOT EXISTS alt_collection_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, league_code TEXT, league_name TEXT, season INTEGER, status TEXT,
      fixtures_found INTEGER DEFAULT 0, inserted INTEGER DEFAULT 0, updated INTEGER DEFAULT 0,
      started_at TEXT, finished_at TEXT DEFAULT (datetime('now')), notes TEXT
    );
    -- Odds de abertura/fecho agregadas por jogo (football-data.co.uk) — base do backtest
    CREATE TABLE IF NOT EXISTS market_odds (
      fixture_id INTEGER PRIMARY KEY, source TEXT,
      open_h REAL, open_d REAL, open_a REAL,
      close_h REAL, close_d REAL, close_a REAL,
      max_h REAL, max_d REAL, max_a REAL,
      over25_open REAL, under25_open REAL, over25_close REAL, under25_close REAL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    -- Odds por casa de apostas e por momento (open = véspera do jogo, close = fecho)
    CREATE TABLE IF NOT EXISTS book_odds (
      fixture_id INTEGER NOT NULL, book TEXT NOT NULL, phase TEXT NOT NULL,
      h REAL, d REAL, a REAL, over25 REAL, under25 REAL,
      PRIMARY KEY (fixture_id, book, phase)
    );
    CREATE INDEX IF NOT EXISTS idx_matches_league_season ON matches(league_id, season);
    CREATE INDEX IF NOT EXISTS idx_matches_teams ON matches(home_id, away_id);
    CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date);
    CREATE INDEX IF NOT EXISTS idx_odds_fixture ON odds(fixture_id, market);
    CREATE INDEX IF NOT EXISTS idx_team_stats ON team_season_stats(team_id, season);
  `);
  addColumnIfMissing(db, 'matches', 'source', "TEXT DEFAULT 'api-football'");
  // evita duplicados na tabela odds (antes INSERT OR IGNORE nunca ignorava nada)
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_odds ON odds(fixture_id, bookmaker_id, market, value)`);
  } catch {
    db.exec(`DELETE FROM odds WHERE id NOT IN (SELECT MIN(id) FROM odds GROUP BY fixture_id, bookmaker_id, market, value)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_odds ON odds(fixture_id, bookmaker_id, market, value)`);
  }
}

module.exports = { ensureSchema, columns, addColumnIfMissing };
