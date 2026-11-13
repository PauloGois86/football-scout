/**
 * Football Scout — Importador football-data.co.uk
 *
 * Fonte GRATUITA, sem API key, com ~20 anos de histórico das principais ligas:
 * resultados, intervalo, remates, cantos, cartões e — o mais importante —
 * odds de ABERTURA e de FECHO (Pinnacle + média do mercado) para 1X2 e O/U 2.5.
 * É isto que permite fazer um backtest honesto contra o mercado.
 *
 * Uso:
 *   node import-fdcouk.js                       → todas as ligas, temporadas 2015 → actual
 *   node import-fdcouk.js --from=2019 --league=39
 *   node import-fdcouk.js --dir=/data/csv       → usa CSVs locais (ex.: E0_2324.csv) em vez de download
 */
require('dotenv').config();
const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { ensureSchema } = require('../shared/schema');
const { similarity, syntheticFixtureId } = require('../shared/names');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/football.db');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };

const LEAGUES = [
  { code: 'E0',  leagueId: 39,  name: 'Premier League' },
  { code: 'SP1', leagueId: 140, name: 'La Liga' },
  { code: 'I1',  leagueId: 135, name: 'Serie A' },
  { code: 'D1',  leagueId: 78,  name: 'Bundesliga' },
  { code: 'F1',  leagueId: 61,  name: 'Ligue 1' },
  { code: 'P1',  leagueId: 94,  name: 'Primeira Liga' },
  { code: 'N1',  leagueId: 88,  name: 'Eredivisie' },
];

function currentSeason() { const n = new Date(); return n.getMonth() >= 6 ? n.getFullYear() : n.getFullYear() - 1; }
const seasonCode = s => `${String(s % 100).padStart(2, '0')}${String((s + 1) % 100).padStart(2, '0')}`;

// CSV simples com suporte a aspas
function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const split = line => {
    const out = []; let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]).map(h => h.trim());
  return lines.slice(1).map(l => {
    const v = split(l); const r = {};
    header.forEach((h, i) => { if (h) r[h] = (v[i] ?? '').trim(); });
    return r;
  });
}

function parseDate(d, t) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(d || '');
  if (!m) return null;
  let y = +m[3]; if (y < 100) y += y > 50 ? 1900 : 2000;
  const time = /^\d{1,2}:\d{2}$/.test(t || '') ? t.padStart(5, '0') : '15:00';
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T${time}:00+00:00`;
}

const num = v => { const x = parseFloat(v); return Number.isFinite(x) && x > 0 ? x : null; };
const int = v => { const x = parseInt(v); return Number.isFinite(x) ? x : null; };
const first = (r, ...keys) => { for (const k of keys) { const v = num(r[k]); if (v) return v; } return null; };

function mapRow(r) {
  const date = parseDate(r.Date, r.Time);
  const hg = int(r.FTHG ?? r.HG), ag = int(r.FTAG ?? r.AG);
  if (!date || !r.HomeTeam || !r.AwayTeam || hg == null || ag == null) return null;
  return {
    date, home: r.HomeTeam, away: r.AwayTeam, hg, ag,
    result: hg > ag ? 'H' : hg < ag ? 'A' : 'D',
    ht_home: int(r.HTHG), ht_away: int(r.HTAG),
    shots_home: int(r.HS), shots_away: int(r.AS), shots_ot_home: int(r.HST), shots_ot_away: int(r.AST),
    corners_home: int(r.HC), corners_away: int(r.AC), fouls_home: int(r.HF), fouls_away: int(r.AF),
    yellows_home: int(r.HY), yellows_away: int(r.AY), reds_home: int(r.HR), reds_away: int(r.AR),
    odds: {
      open_h: first(r, 'PSH', 'AvgH', 'BbAvH', 'B365H'), open_d: first(r, 'PSD', 'AvgD', 'BbAvD', 'B365D'), open_a: first(r, 'PSA', 'AvgA', 'BbAvA', 'B365A'),
      close_h: first(r, 'PSCH', 'AvgCH'), close_d: first(r, 'PSCD', 'AvgCD'), close_a: first(r, 'PSCA', 'AvgCA'),
      max_h: first(r, 'MaxH', 'BbMxH'), max_d: first(r, 'MaxD', 'BbMxD'), max_a: first(r, 'MaxA', 'BbMxA'),
      over25_open: first(r, 'P>2.5', 'Avg>2.5', 'BbAv>2.5', 'B365>2.5'), under25_open: first(r, 'P<2.5', 'Avg<2.5', 'BbAv<2.5', 'B365<2.5'),
      over25_close: first(r, 'PC>2.5', 'AvgC>2.5'), under25_close: first(r, 'PC<2.5', 'AvgC<2.5'),
    },
  };
}

async function fetchCsv(code, season, dir) {
  if (dir) {
    const f = path.join(dir, `${code}_${seasonCode(season)}.csv`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'latin1') : null;
  }
  const url = `https://www.football-data.co.uk/mmz4281/${seasonCode(season)}/${code}.csv`;
  try {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 });
    return Buffer.from(r.data).toString('latin1');
  } catch (e) {
    console.warn(`  ✗ ${url}: ${e.response?.status || e.message}`);
    return null;
  }
}

function importRows(db, rows, league, season) {
  const candidatesStmt = db.prepare(`SELECT fixture_id, home_name, away_name FROM matches
                                     WHERE league_id=? AND substr(date,1,10) BETWEEN ? AND ?
                                       AND COALESCE(source,'') != 'football-data.co.uk'`);
  const mapGet = db.prepare(`SELECT canonical_name FROM team_name_map WHERE source='football-data.co.uk' AND source_name=?`);
  const mapPut = db.prepare(`INSERT OR IGNORE INTO team_name_map (source, source_name, canonical_name) VALUES ('football-data.co.uk', ?, ?)`);
  const insert = db.prepare(`INSERT OR IGNORE INTO matches (fixture_id, season, league_id, league_name, date, status, home_name, away_name,
      goals_home, goals_away, result, ht_home, ht_away, shots_home, shots_away, shots_ot_home, shots_ot_away,
      corners_home, corners_away, fouls_home, fouls_away, yellows_home, yellows_away, reds_home, reds_away, source)
    VALUES (@fixture_id, @season, @league_id, @league_name, @date, 'FT', @home, @away, @hg, @ag, @result, @ht_home, @ht_away,
      @shots_home, @shots_away, @shots_ot_home, @shots_ot_away, @corners_home, @corners_away, @fouls_home, @fouls_away,
      @yellows_home, @yellows_away, @reds_home, @reds_away, 'football-data.co.uk')`);
  const fill = db.prepare(`UPDATE matches SET
      goals_home=COALESCE(goals_home,@hg), goals_away=COALESCE(goals_away,@ag), result=COALESCE(result,@result),
      ht_home=COALESCE(ht_home,@ht_home), ht_away=COALESCE(ht_away,@ht_away),
      shots_home=COALESCE(shots_home,@shots_home), shots_away=COALESCE(shots_away,@shots_away),
      shots_ot_home=COALESCE(shots_ot_home,@shots_ot_home), shots_ot_away=COALESCE(shots_ot_away,@shots_ot_away),
      corners_home=COALESCE(corners_home,@corners_home), corners_away=COALESCE(corners_away,@corners_away),
      fouls_home=COALESCE(fouls_home,@fouls_home), fouls_away=COALESCE(fouls_away,@fouls_away),
      yellows_home=COALESCE(yellows_home,@yellows_home), yellows_away=COALESCE(yellows_away,@yellows_away),
      reds_home=COALESCE(reds_home,@reds_home), reds_away=COALESCE(reds_away,@reds_away)
    WHERE fixture_id=@fixture_id`);
  const upOdds = db.prepare(`INSERT INTO market_odds (fixture_id, source, open_h, open_d, open_a, close_h, close_d, close_a,
      max_h, max_d, max_a, over25_open, under25_open, over25_close, under25_close)
    VALUES (@fixture_id, 'football-data.co.uk', @open_h, @open_d, @open_a, @close_h, @close_d, @close_a,
      @max_h, @max_d, @max_a, @over25_open, @under25_open, @over25_close, @under25_close)
    ON CONFLICT(fixture_id) DO UPDATE SET source=excluded.source, open_h=excluded.open_h, open_d=excluded.open_d, open_a=excluded.open_a,
      close_h=excluded.close_h, close_d=excluded.close_d, close_a=excluded.close_a, max_h=excluded.max_h, max_d=excluded.max_d,
      max_a=excluded.max_a, over25_open=excluded.over25_open, under25_open=excluded.under25_open,
      over25_close=excluded.over25_close, under25_close=excluded.under25_close, updated_at=datetime('now')`);

  let inserted = 0, merged = 0, withOdds = 0;
  db.transaction(() => {
    for (const r of rows) {
      const day = r.date.slice(0, 10);
      const d = new Date(day + 'T00:00:00Z');
      const from = new Date(d - 86400000).toISOString().slice(0, 10);
      const to = new Date(+d + 86400000).toISOString().slice(0, 10);
      const home = mapGet.get(r.home)?.canonical_name || r.home;
      const away = mapGet.get(r.away)?.canonical_name || r.away;

      let best = null;
      for (const c of candidatesStmt.all(league.leagueId, from, to)) {
        const sh = similarity(home, c.home_name), sa = similarity(away, c.away_name);
        const s = Math.min(sh, sa);
        if (s >= 0.72 && (!best || s > best.s)) best = { ...c, s };
      }

      let fixtureId;
      if (best) {
        fixtureId = best.fixture_id;
        if (best.home_name !== r.home) mapPut.run(r.home, best.home_name);
        if (best.away_name !== r.away) mapPut.run(r.away, best.away_name);
        fill.run({ ...r, fixture_id: fixtureId });
        merged++;
      } else {
        fixtureId = syntheticFixtureId(league.leagueId, r.date, r.home, r.away);
        const res = insert.run({ ...r, fixture_id: fixtureId, season, league_id: league.leagueId, league_name: league.name });
        if (res.changes) inserted++;
      }
      if (r.odds.open_h || r.odds.close_h) { upOdds.run({ fixture_id: fixtureId, ...r.odds }); withOdds++; }
    }
  })();
  return { inserted, merged, withOdds };
}

async function main() {
  const from = parseInt(arg('from', '2015'));
  const to = parseInt(arg('to', String(currentSeason())));
  const leagueArg = arg('league');
  const dir = arg('dir');
  const leagues = LEAGUES.filter(l => !leagueArg || String(l.leagueId) === leagueArg || l.code === leagueArg);

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  ensureSchema(db);

  console.log(`⚽ Import football-data.co.uk → ${DB_PATH}`);
  console.log(`   Temporadas ${from}–${to} | Ligas: ${leagues.map(l => l.code).join(', ')}\n`);
  let tot = { inserted: 0, merged: 0, withOdds: 0 };
  for (let s = from; s <= to; s++) {
    for (const lg of leagues) {
      const csv = await fetchCsv(lg.code, s, dir);
      if (!csv) continue;
      const rows = parseCsv(csv).map(mapRow).filter(Boolean);
      const r = importRows(db, rows, lg, s);
      for (const k of Object.keys(tot)) tot[k] += r[k];
      console.log(`  ${lg.name.padEnd(16)} ${s}/${(s + 1) % 100}: ${rows.length} jogos → +${r.inserted} novos, ${r.merged} fundidos, ${r.withOdds} c/ odds`);
      await new Promise(res => setTimeout(res, 300));
    }
  }
  db.close();
  console.log(`\n✓ Concluído: +${tot.inserted} novos | ${tot.merged} fundidos | ${tot.withOdds} com odds`);
  console.log('  Próximo passo: node backtest.js');
}

if (require.main === module) main().catch(e => { console.error('Erro fatal:', e.message); process.exit(1); });
module.exports = { parseCsv, mapRow, importRows, parseDate };
