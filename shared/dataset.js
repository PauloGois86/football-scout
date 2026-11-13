'use strict';
/**
 * Carrega jogos terminados da BD num formato pronto para o modelo:
 *   { fixture_id, date, season, league_id, home, away, hg, ag, homeName, awayName }
 * - Os nomes passam pelo team_name_map e são normalizados (chave única por equipa)
 * - Remove duplicados (o mesmo jogo vindo de fontes diferentes)
 */
const { normalizeName } = require('./names');

const EUROPEAN = new Set([2, 3, 848]);

function loadNameMap(db) {
  const map = new Map();
  try {
    for (const r of db.prepare('SELECT source_name, canonical_name FROM team_name_map WHERE canonical_name IS NOT NULL').all()) {
      map.set(r.source_name, r.canonical_name);
    }
  } catch { /* tabela pode não existir */ }
  return map;
}

function loadMatches(db, { leagueIds = null, since = null } = {}) {
  const nameMap = loadNameMap(db);
  const key = n => normalizeName(nameMap.get(n) || n);

  let sql = `SELECT fixture_id, date, season, league_id, league_name, home_name, away_name, goals_home, goals_away
             FROM matches WHERE goals_home IS NOT NULL AND goals_away IS NOT NULL AND home_name IS NOT NULL`;
  const p = [];
  if (leagueIds?.length) { sql += ` AND league_id IN (${leagueIds.map(() => '?').join(',')})`; p.push(...leagueIds); }
  if (since) { sql += ' AND date >= ?'; p.push(since); }
  sql += ' ORDER BY date';

  const seen = new Set();
  const out = [];
  for (const r of db.prepare(sql).all(...p)) {
    const home = key(r.home_name), away = key(r.away_name);
    const dedupe = `${r.date.slice(0, 10)}|${home}|${away}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      fixture_id: r.fixture_id, date: r.date, season: r.season, league_id: r.league_id, league_name: r.league_name,
      home, away, homeName: r.home_name, awayName: r.away_name, hg: r.goals_home, ag: r.goals_away,
    });
  }
  return out;
}

/** Odds de mercado por fixture_id: prefere market_odds (fecho Pinnacle/média), senão tabela odds. */
function loadMarketOdds(db) {
  const res = new Map();
  try {
    for (const r of db.prepare('SELECT * FROM market_odds').all()) res.set(r.fixture_id, r);
  } catch { /* sem tabela */ }
  try {
    const rows = db.prepare(`SELECT fixture_id, market, value, AVG(odd) as odd FROM odds
                             WHERE market IN ('Match Winner','Goals Over/Under') GROUP BY fixture_id, market, value`).all();
    for (const r of rows) {
      const cur = res.get(r.fixture_id) || { fixture_id: r.fixture_id, source: 'api-football' };
      if (cur.source !== 'api-football') continue;                     // market_odds tem prioridade
      if (r.market === 'Match Winner') {
        if (r.value === 'Home') cur.open_h = r.odd; else if (r.value === 'Draw') cur.open_d = r.odd; else if (r.value === 'Away') cur.open_a = r.odd;
      } else if (r.value === 'Over 2.5') cur.over25_open = r.odd; else if (r.value === 'Under 2.5') cur.under25_open = r.odd;
      res.set(r.fixture_id, cur);
    }
  } catch { /* sem tabela */ }
  return res;
}

module.exports = { loadMatches, loadMarketOdds, loadNameMap, EUROPEAN };
