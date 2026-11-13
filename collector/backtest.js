/**
 * Football Scout — Backtest walk-forward do modelo
 *
 * Para cada semana do período de teste, re-ajusta o modelo SÓ com jogos
 * anteriores e prevê os jogos dessa semana (sem "olhar para o futuro").
 * Compara com: frequências históricas (baseline ingénuo) e o mercado
 * (odds sem margem) quando existem odds na BD.
 *
 * Uso:
 *   node backtest.js                         → todas as ligas domésticas na BD
 *   node backtest.js --league=39 --from-season=2023
 *   node backtest.js --threshold=0.05 --weight=0.3
 *   node backtest.js --simulate              → liga sintética (teste sem dados reais)
 *
 * Resultado: tabela no terminal + JSON em $DB_DIR/model-performance.json
 * (o dashboard mostra este ficheiro no separador Base de Dados).
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const M = require('../shared/model');
const { loadMatches, loadMarketOdds, EUROPEAN } = require('../shared/dataset');
const { simulateLeague, rng } = require('../shared/simulate');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/football.db');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const flag = k => process.argv.includes(`--${k}`);

const THRESHOLD = parseFloat(arg('threshold', '0.03'));   // EV mínimo para "apostar"
const W_MODEL = parseFloat(arg('weight', process.env.MODEL_WEIGHT || '0.5'));
const OUT = arg('out', path.join(path.dirname(DB_PATH), 'model-performance.json'));

const outcome = m => (m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2);

function newAcc() { return { n: 0, hits: 0, ll: 0, brier: 0, rps: 0 }; }
function addAcc(acc, probs, o) {
  acc.n++; acc.ll += M.logLoss(probs, o); acc.brier += M.brier(probs, o); acc.rps += M.rps(probs, o);
  const best = probs.indexOf(Math.max(...probs));
  if (best === o) acc.hits++;
}
function finAcc(a) {
  return a.n ? { n: a.n, accuracy: +(a.hits / a.n).toFixed(4), logloss: +(a.ll / a.n).toFixed(4), brier: +(a.brier / a.n).toFixed(4), rps: +(a.rps / a.n).toFixed(4) } : { n: 0 };
}
function newBets() { return { bets: 0, wins: 0, staked: 0, profit: 0, clvSum: 0, clvN: 0 }; }
function finBets(b) {
  return { bets: b.bets, wins: b.wins, roi: b.staked ? +(b.profit / b.staked).toFixed(4) : null,
    profit: +b.profit.toFixed(2), avg_clv: b.clvN ? +(b.clvSum / b.clvN).toFixed(4) : null };
}

function backtestLeague(matches, odds, { fromSeason, label }) {
  const seasons = [...new Set(matches.map(m => m.season))].sort();
  const startSeason = fromSeason || seasons[Math.min(1, seasons.length - 1)];
  const test = matches.filter(m => m.season >= startSeason);
  if (!test.length) return null;

  const acc = { oracle: newAcc(), model: newAcc(), base: newAcc(), modelMkt: newAcc(), market: newAcc(), blend: newAcc() };
  const ou = { model: newAcc(), modelMkt: newAcc(), market: newAcc() };
  const bets = { model: newBets(), blend: newBets() };
  const calib = Array.from({ length: 10 }, () => ({ p: 0, o: 0, n: 0 }));
  let skipped = 0;

  // agrupa por semana
  let i = 0;
  while (i < test.length) {
    const weekStart = new Date(test[i].date);
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekEnd = weekStart.getTime() + 7 * 86400000;
    const week = [];
    while (i < test.length && new Date(test[i].date).getTime() < weekEnd) week.push(test[i++]);

    const fitted = M.fit(matches, { refDate: weekStart });
    if (!fitted) { skipped += week.length; continue; }

    // baseline: frequências 1X2 da janela de treino
    const prior = matches.filter(m => new Date(m.date) < weekStart).slice(-760);
    const f = [0, 0, 0]; prior.forEach(m => f[outcome(m)]++);
    const base = f.map(x => (x + 1) / (prior.length + 3));

    for (const m of week) {
      const p = M.predict(fitted, m.home, m.away);
      const pm = [p.home, p.draw, p.away];
      const o = outcome(m);
      addAcc(acc.model, pm, o);
      addAcc(acc.base, base, o);
      if (m.trueLh) { const t = M.marketsFromMatrix(M.scoreMatrix(m.trueLh, m.trueLa, 0)); addAcc(acc.oracle, [t.home, t.draw, t.away], o); }
      pm.forEach((v, k) => { const b = calib[Math.min(9, Math.floor(v * 10))]; b.p += v; b.o += (k === o ? 1 : 0); b.n++; });

      const over = p.over['2.5'];
      const ouO = m.hg + m.ag > 2 ? 0 : 1;
      addAcc(ou.model, [over, 1 - over], ouO);

      const mo = odds.get(m.fixture_id);
      if (!mo) continue;
      const closeArr = [mo.close_h, mo.close_d, mo.close_a];
      const openArr = [mo.open_h, mo.open_d, mo.open_a];
      const fairClose = M.devig(closeArr)?.probs;
      const fairOpen = M.devig(openArr)?.probs;
      const market = fairClose || fairOpen;
      if (market) {
        addAcc(acc.market, market, o);
        addAcc(acc.modelMkt, pm, o);
        const bl = M.blend(pm, market === fairClose && fairOpen ? fairOpen : market, W_MODEL);
        addAcc(acc.blend, bl, o);

        // simulação de apostas: aposta ao preço de abertura (o que estaria disponível antes do jogo)
        const price = openArr.every(x => x > 1) ? openArr : closeArr;
        for (const [name, probs] of [['model', pm], ['blend', bl]]) {
          for (let k = 0; k < 3; k++) {
            const ev = M.expectedValue(probs[k], price[k]);
            if (ev == null || ev < THRESHOLD) continue;
            const b = bets[name];
            b.bets++; b.staked++;
            if (k === o) { b.wins++; b.profit += price[k] - 1; } else b.profit -= 1;
            if (fairClose) { b.clvSum += price[k] * fairClose[k] - 1; b.clvN++; }
          }
        }
      }
      const ouMkt = M.devig([mo.over25_close || mo.over25_open, mo.under25_close || mo.under25_open])?.probs;
      if (ouMkt) { addAcc(ou.market, ouMkt, ouO); addAcc(ou.modelMkt, [over, 1 - over], ouO); }
    }
  }

  return {
    label, test_from_season: startSeason, matches_tested: test.length - skipped,
    one_x_two: {
      oracle: finAcc(acc.oracle), model: finAcc(acc.model), baseline_freq: finAcc(acc.base),
      model_on_odds_subset: finAcc(acc.modelMkt), market: finAcc(acc.market), blend: finAcc(acc.blend),
    },
    over_under_25: { model: finAcc(ou.model), model_on_odds_subset: finAcc(ou.modelMkt), market: finAcc(ou.market) },
    value_bets: { threshold: THRESHOLD, model: finBets(bets.model), blend: finBets(bets.blend) },
    calibration: calib.filter(b => b.n).map((b, k) => ({ bin: `${k * 10}-${k * 10 + 10}%`, predicted: +(b.p / b.n).toFixed(3), observed: +(b.o / b.n).toFixed(3), n: b.n })),
  };
}

function simulatedData() {
  const { matches } = simulateLeague({ seasons: 5, seed: 3 });
  const rand = rng(99);
  const odds = new Map();
  matches.forEach((m, i) => {
    m.fixture_id = i + 1; m.league_id = 0;
    // "mercado" sintético: probabilidades verdadeiras + ruído + margem de 5%
    const mk = M.marketsFromMatrix(M.scoreMatrix(m.trueLh, m.trueLa, -0.05));
    const noisy = [mk.home, mk.draw, mk.away].map(p => p * Math.exp(0.08 * (rand() - 0.5)));
    const s = noisy.reduce((a, b) => a + b);
    const toOdd = p => +(1 / ((p / s) * 1.05)).toFixed(2);
    const o25 = mk.over['2.5'];
    odds.set(m.fixture_id, {
      open_h: toOdd(noisy[0]), open_d: toOdd(noisy[1]), open_a: toOdd(noisy[2]),
      close_h: +(1 / (mk.home * 1.03)).toFixed(2), close_d: +(1 / (mk.draw * 1.03)).toFixed(2), close_a: +(1 / (mk.away * 1.03)).toFixed(2),
      over25_close: +(1 / (o25 * 1.03)).toFixed(2), under25_close: +(1 / ((1 - o25) * 1.03)).toFixed(2),
    });
  });
  return { groups: [{ id: 0, name: 'Liga simulada', matches }], odds };
}

function realData() {
  const Database = require('better-sqlite3');
  if (!fs.existsSync(DB_PATH)) { console.error(`BD não encontrada: ${DB_PATH}`); process.exit(1); }
  const db = new Database(DB_PATH, { readonly: true });
  const leagueArg = arg('league');
  const all = loadMatches(db);
  const odds = loadMarketOdds(db);
  db.close();
  const byLeague = new Map();
  for (const m of all) {
    if (EUROPEAN.has(m.league_id)) continue;            // competições europeias: poucos jogos por equipa
    if (leagueArg && String(m.league_id) !== leagueArg) continue;
    if (!byLeague.has(m.league_id)) byLeague.set(m.league_id, { id: m.league_id, name: m.league_name, matches: [] });
    byLeague.get(m.league_id).matches.push(m);
  }
  return { groups: [...byLeague.values()], odds };
}

function pct(x) { return x == null ? '—' : (x * 100).toFixed(1) + '%'; }

function printReport(r) {
  const t = r.one_x_two;
  console.log(`\n── ${r.label} — ${r.matches_tested} jogos testados (desde ${r.test_from_season})`);
  console.log('   1X2                     n     acerto   logloss   RPS');
  const row = (name, a) => a.n && console.log(`   ${name.padEnd(22)} ${String(a.n).padStart(5)}   ${pct(a.accuracy).padStart(6)}   ${a.logloss.toFixed(4)}   ${a.rps.toFixed(4)}`);
  row('Baseline (frequências)', t.baseline_freq);
  row('Modelo', t.model);
  if (t.oracle.n) row('Oráculo (prob. reais)', t.oracle);
  if (t.market.n) {
    row('Modelo (c/ odds)', t.model_on_odds_subset);
    row('Mercado (odds s/ marg)', t.market);
    row(`Mistura (${W_MODEL} modelo)`, t.blend);
  }
  const ou = r.over_under_25;
  console.log(`   O/U 2.5: modelo ${pct(ou.model.accuracy)} acerto (logloss ${ou.model.logloss})` +
    (ou.market.n ? ` | mercado ${pct(ou.market.accuracy)} (logloss ${ou.market.logloss}) em ${ou.market.n}` : ''));
  if (t.market.n) {
    for (const k of ['model', 'blend']) {
      const b = r.value_bets[k];
      console.log(`   Apostas EV>${pct(THRESHOLD)} [${k}]: ${b.bets} apostas, ${b.wins} ganhas, ROI ${pct(b.roi)}, CLV médio ${pct(b.avg_clv)}`);
    }
  } else {
    console.log('   (sem odds na BD para estes jogos — importa com: node import-fdcouk.js)');
  }
}

function main() {
  const sim = flag('simulate');
  const { groups, odds } = sim ? simulatedData() : realData();
  if (!groups.length) { console.error('Sem jogos terminados na BD. Corre primeiro um backfill/import.'); process.exit(1); }
  const fromSeason = arg('from-season') ? parseInt(arg('from-season')) : null;

  const results = {};
  for (const g of groups) {
    const r = backtestLeague(g.matches, odds, { fromSeason, label: g.name || `Liga ${g.id}` });
    if (!r) continue;
    results[g.id] = r;
    printReport(r);
  }

  const out = { generated_at: new Date().toISOString(), simulated: sim, params: { threshold: THRESHOLD, model_weight: W_MODEL, ...M.DEFAULTS }, leagues: results };
  if (!sim || flag('save')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`\n✓ Resultados guardados em ${OUT}`);
  }
}

if (require.main === module) main();
module.exports = { backtestLeague };
