/**
 * Football Scout — Backtest contra o mercado (Pinnacle como referência)
 *
 * Responde a uma pergunta: existe alguma estratégia com CLV positivo consistente?
 *
 *  A) "Soft vs sharp": aposta numa casa "soft" (Bet365, William Hill, ...) quando a odd dela
 *     supera o preço JUSTO da Pinnacle (odds Pinnacle sem margem) em mais de X%.
 *  B) Modelo Dixon-Coles (walk-forward) a apostar só em odds de ABERTURA,
 *     separado por ligas principais (tier 1) e secundárias (tier 2).
 *
 * Para cada variante: nº de apostas, ROI e CLV médio com intervalo de confiança a 95%.
 *   CLV = odd apostada × prob. justa no fecho da Pinnacle − 1
 *   O CLV é muito menos ruidoso que o ROI: é o melhor indicador de vantagem real.
 *
 * Uso:
 *   node backtest-market.js                     → tudo
 *   node backtest-market.js --from=2019         → só temporadas ≥ 2019
 *   node backtest-market.js --no-model          → só estratégia A (rápido)
 *   node backtest-market.js --tier=2            → só ligas secundárias
 *   node backtest-market.js --devig=proportional  → método antigo de remover a margem (comparação)
 *   node backtest-market.js --no-model --detail="A|1x2|interwetten|open|>0.02"  → por época e liga
 *
 * Requer: node import-fdcouk.js (guarda as odds por casa na tabela book_odds)
 * Resultado: terminal + $DB_DIR/market-backtest.json
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const M = require('../shared/model');
const { loadMatches } = require('../shared/dataset');
const { LEAGUES } = require('./import-fdcouk');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/football.db');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const flag = k => process.argv.includes(`--${k}`);
const OUT = arg('out', path.join(path.dirname(DB_PATH), 'market-backtest.json'));
const FROM = arg('from') ? parseInt(arg('from')) : null;
const TIER = arg('tier') ? parseInt(arg('tier')) : null;
const DEVIG = arg('devig', 'power');          // power (por defeito) | proportional
const DETAIL = arg('detail');                  // ex.: "A|1x2|interwetten|open|>0.02" → detalhe por época e liga
const fair = odds => M.devig(odds, DEVIG)?.probs;

const SOFT_BOOKS = ['bet365', 'bwin', 'interwetten', 'williamhill', 'vcbet', 'max'];
const EDGE_THRESHOLDS = [0, 0.02, 0.04, 0.06, 0.10];
const MODEL_THRESHOLDS = [0.02, 0.05, 0.10];
const MODEL_PRICES = ['pinnacle', 'bet365', 'max'];
const tierOf = new Map(LEAGUES.map(l => [l.leagueId, l.tier]));

// ── Acumuladores com intervalo de confiança ───────────────────
function acc() { return { n: 0, wins: 0, sP: 0, sP2: 0, sOdd: 0, cN: 0, sC: 0, sC2: 0 }; }
function addBet(a, odd, won, fairClose) {
  const p = won ? odd - 1 : -1;
  a.n++; a.wins += won ? 1 : 0; a.sP += p; a.sP2 += p * p; a.sOdd += odd;
  if (fairClose) { const c = odd * fairClose - 1; a.cN++; a.sC += c; a.sC2 += c * c; }
}
function ci(sum, sum2, n) {
  if (n < 2) return null;
  const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean) * n / (n - 1));
  return 1.96 * sd / Math.sqrt(n);
}
function fin(a) {
  if (!a.n) return { bets: 0 };
  const roi = a.sP / a.n, clv = a.cN ? a.sC / a.cN : null;
  return {
    bets: a.n, win_rate: +(a.wins / a.n).toFixed(4), avg_odd: +(a.sOdd / a.n).toFixed(2),
    roi: +roi.toFixed(4), roi_ci95: ci(a.sP, a.sP2, a.n) != null ? +ci(a.sP, a.sP2, a.n).toFixed(4) : null,
    clv: clv != null ? +clv.toFixed(4) : null, clv_ci95: ci(a.sC, a.sC2, a.cN) != null ? +ci(a.sC, a.sC2, a.cN).toFixed(4) : null,
    clv_bets: a.cN,
  };
}

const results = {};                      // chave → acumulador
function bump(parts, odd, won, fairClose) {
  for (const key of parts) {
    if (!results[key]) results[key] = acc();
    addBet(results[key], odd, won, fairClose);
  }
}
// regista no agregado "all", no tier e na liga
function record(base, m, odd, won, fairClose) {
  const tier = tierOf.get(m.league_id) || 0;
  bump([`${base}|all`, `${base}|tier${tier}`, `${base}|league:${m.league_id}`, `${base}|season:${m.season}`], odd, won, fairClose);
}

// ── Dados ─────────────────────────────────────────────────────
function loadData(db) {
  const books = new Map();
  for (const r of db.prepare('SELECT * FROM book_odds').all()) {
    if (!books.has(r.fixture_id)) books.set(r.fixture_id, { open: {}, close: {} });
    books.get(r.fixture_id)[r.phase][r.book] = r;
  }
  const matches = loadMatches(db).filter(m => books.has(m.fixture_id)
    && (!FROM || m.season >= FROM) && (!TIER || tierOf.get(m.league_id) === TIER));
  return { books, matches };
}

const x12 = o => (o && o.h > 1 && o.d > 1 && o.a > 1 ? [o.h, o.d, o.a] : null);
const xOU = o => (o && o.over25 > 1 && o.under25 > 1 ? [o.over25, o.under25] : null);
const res1x2 = m => (m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2);
const resOU = m => (m.hg + m.ag > 2 ? 0 : 1);
const LBL = ['casa', 'empate', 'fora'];

// ── Estratégia A: casa soft vs preço justo da Pinnacle ────────
function strategySoftVsSharp(matches, books) {
  for (const m of matches) {
    const b = books.get(m.fixture_id);
    const pinOpen = fair(x12(b.open.pinnacle));
    const pinClose = fair(x12(b.close.pinnacle));
    const ouOpen = fair(xOU(b.open.pinnacle));
    const ouClose = fair(xOU(b.close.pinnacle));
    const o = res1x2(m), ou = resOU(m);

    for (const book of SOFT_BOOKS) {
      // véspera: odd soft vs Pinnacle no mesmo momento → CLV medido contra o fecho
      const soft = x12(b.open[book]);
      if (soft && pinOpen) {
        for (let k = 0; k < 3; k++) {
          const edge = soft[k] * pinOpen[k] - 1;
          for (const X of EDGE_THRESHOLDS) if (edge > X) record(`A|1x2|${book}|open|>${X}`, m, soft[k], k === o, pinClose?.[k]);
        }
      }
      // fecho: odd soft no fecho vs Pinnacle no fecho (apostar mesmo antes do apito)
      const softC = x12(b.close[book]);
      if (softC && pinClose) {
        for (let k = 0; k < 3; k++) {
          const edge = softC[k] * pinClose[k] - 1;
          for (const X of EDGE_THRESHOLDS) if (edge > X) record(`A|1x2|${book}|close|>${X}`, m, softC[k], k === o, null);
        }
      }
      const softOU = xOU(b.open[book]);
      if (softOU && ouOpen) {
        for (let k = 0; k < 2; k++) {
          const edge = softOU[k] * ouOpen[k] - 1;
          for (const X of EDGE_THRESHOLDS) if (edge > X) record(`A|ou25|${book}|open|>${X}`, m, softOU[k], k === ou, ouClose?.[k]);
        }
      }
    }
  }
}

// ── Estratégia B: modelo (walk-forward) em odds de abertura ───
function strategyModel(allMatches, books) {
  const byLeague = new Map();
  for (const m of allMatches) {
    if (!byLeague.has(m.league_id)) byLeague.set(m.league_id, []);
    byLeague.get(m.league_id).push(m);
  }
  let li = 0;
  for (const [leagueId, ms] of byLeague) {
    li++;
    process.stdout.write(`\r   modelo: liga ${li}/${byLeague.size} (${ms[0].league_name || leagueId})                 `);
    const seasons = [...new Set(ms.map(m => m.season))].sort();
    const startSeason = seasons[1];                // 1ª temporada só serve de treino
    if (startSeason == null) continue;
    const test = ms.filter(m => m.season >= startSeason);
    let i = 0;
    while (i < test.length) {
      const weekStart = new Date(test[i].date); weekStart.setUTCHours(0, 0, 0, 0);
      const weekEnd = weekStart.getTime() + 7 * 86400000;
      const week = [];
      while (i < test.length && new Date(test[i].date).getTime() < weekEnd) week.push(test[i++]);
      const fitted = M.fit(ms, { refDate: weekStart });
      if (!fitted) continue;
      for (const m of week) {
        const b = books.get(m.fixture_id);
        const p = M.predict(fitted, m.home, m.away);
        if (!p.knownHome || !p.knownAway) continue;
        const probs = [p.home, p.draw, p.away];
        const pOU = [p.over['2.5'], 1 - p.over['2.5']];
        const pinClose = fair(x12(b.close.pinnacle));
        const ouClose = fair(xOU(b.close.pinnacle));
        const o = res1x2(m), ou = resOU(m);
        for (const book of MODEL_PRICES) {
          const price = x12(b.open[book]);
          if (price) for (let k = 0; k < 3; k++) {
            const ev = probs[k] * price[k] - 1;
            for (const X of MODEL_THRESHOLDS) if (ev > X) record(`B|1x2|${book}|open|>${X}`, m, price[k], k === o, pinClose?.[k]);
          }
          const pou = xOU(b.open[book]);
          if (pou) for (let k = 0; k < 2; k++) {
            const ev = pOU[k] * pou[k] - 1;
            for (const X of MODEL_THRESHOLDS) if (ev > X) record(`B|ou25|${book}|open|>${X}`, m, pou[k], k === ou, ouClose?.[k]);
          }
        }
      }
    }
  }
  process.stdout.write('\n');
}

// ── Diagnóstico: qual o método de devig mais bem calibrado? ───
// Compara a probabilidade justa (fecho Pinnacle) com a frequência real, por faixa de odd.
function devigCalibration(matches, books) {
  const bands = [[1, 1.5], [1.5, 2], [2, 3], [3, 4.5], [4.5, 7], [7, 12], [12, 1000]];
  const rows = bands.map(([lo, hi]) => ({ lo, hi, n: 0, won: 0, prop: 0, power: 0 }));
  for (const m of matches) {
    const c = x12(books.get(m.fixture_id).close.pinnacle);
    if (!c) continue;
    const pp = M.devig(c, 'proportional').probs, pw = M.devig(c, 'power').probs, o = res1x2(m);
    c.forEach((odd, k) => {
      const r = rows.find(b => odd >= b.lo && odd < b.hi); if (!r) return;
      r.n++; r.won += k === o ? 1 : 0; r.prop += pp[k]; r.power += pw[k];
    });
  }
  console.log('\n══ Calibração do preço justo (fecho Pinnacle, 1X2) — o método mais próximo do "real" ganha');
  console.log('   faixa de odd      n        real    proporcional   power');
  for (const r of rows) {
    if (!r.n) continue;
    const real = r.won / r.n, se = Math.sqrt(real * (1 - real) / r.n) * 1.96;
    console.log(`   ${(r.lo + '–' + (r.hi > 100 ? '∞' : r.hi)).padEnd(12)} ${String(r.n).padStart(7)}   ${pct(real, 2).padStart(6)} ±${pct(se, 2).padEnd(6)} ${pct(r.prop / r.n, 2).padStart(8)}    ${pct(r.power / r.n, 2).padStart(8)}`);
  }
  return rows;
}

function printDetail(base) {
  const keys = Object.keys(results).filter(k => k.startsWith(base + '|'));
  if (!keys.length) { console.log(`\nSem resultados para "${base}"`); return; }
  console.log(`\n══ Detalhe: ${base}`);
  console.log('   âmbito                     apostas   ROI (±IC95)          CLV (±IC95)');
  const label = k => { const sc = k.slice(base.length + 1);
    if (sc.startsWith('league:')) { const id = +sc.slice(7); return LEAGUES.find(l => l.leagueId === id)?.name || sc; }
    return sc; };
  for (const k of keys.sort()) {
    const r = fin(results[k]); if (!r.bets) continue;
    console.log(`   ${label(k).padEnd(26)} ${String(r.bets).padStart(7)}   ${(pct(r.roi) + ' ±' + pct(r.roi_ci95)).padEnd(20)} ${r.clv == null ? '—' : pct(r.clv, 2) + ' ±' + pct(r.clv_ci95, 2)}`);
  }
}

// ── Relatório ─────────────────────────────────────────────────
const pct = (x, d = 1) => (x == null ? '—' : (x * 100).toFixed(d) + '%');
function verdict(r) {
  if (!r.bets || r.clv == null || r.clv_bets < 100) return 'poucos dados';
  const lo = r.clv - r.clv_ci95, hi = r.clv + r.clv_ci95;
  if (lo > 0) return '✅ CLV > 0 (significativo)';
  if (hi < 0) return '❌ CLV < 0';
  return '≈ inconclusivo';
}
function printTable(title, prefix, scopes) {
  console.log(`\n${title}`);
  console.log('   variante                              âmbito     apostas  odd méd   ROI (±IC95)          CLV (±IC95)         veredicto');
  const order = k => { const p = k.split('|'); const scope = p[p.length - 1];
    return [p[2], p[3], parseFloat(p[4].slice(1)), scopes.indexOf(scope)]; };
  const cmp = (x, y) => { const a = order(x), b = order(y);
    for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
  const keys = Object.keys(results).filter(k => k.startsWith(prefix) && scopes.includes(k.split('|').pop())).sort(cmp).map(k => k.split('|'));
  const seen = new Set();
  for (const p of keys) {
    const scope = p.pop(); const base = p.join('|');
    const key = `${base}|${scope}`;
    if (seen.has(key)) continue; seen.add(key);
    const r = fin(results[key]);
    if (r.bets < 30) continue;
    const variant = p.slice(1).join(' ').replace('|', ' ');
    const roi = `${pct(r.roi)} ±${pct(r.roi_ci95)}`;
    const clv = r.clv == null ? '—' : `${pct(r.clv, 2)} ±${pct(r.clv_ci95, 2)}`;
    console.log(`   ${variant.padEnd(37)} ${scope.padEnd(9)} ${String(r.bets).padStart(8)}  ${String(r.avg_odd).padStart(6)}   ${roi.padEnd(20)} ${clv.padEnd(19)} ${base.includes('|close|') ? '(aposta ao fecho: sem CLV)' : verdict(r)}`);
  }
}

function main() {
  const Database = require('better-sqlite3');
  if (!fs.existsSync(DB_PATH)) { console.error(`BD não encontrada: ${DB_PATH}`); process.exit(1); }
  const db = new Database(DB_PATH, { readonly: true });
  let data;
  try { data = loadData(db); } catch (e) {
    console.error('Sem tabela book_odds. Corre primeiro: node import-fdcouk.js'); process.exit(1);
  }
  db.close();
  const { books, matches } = data;
  if (!matches.length) { console.error('Sem jogos com odds por casa. Corre: node import-fdcouk.js'); process.exit(1); }
  const leagues = new Set(matches.map(m => m.league_id));
  console.log(`⚽ Backtest de mercado — ${matches.length} jogos, ${leagues.size} ligas${FROM ? `, desde ${FROM}` : ''} · devig: ${DEVIG}`);
  const calibration = devigCalibration(matches, books);

  strategySoftVsSharp(matches, books);
  if (!flag('no-model')) strategyModel(matches, books);

  const scopes = TIER ? [`tier${TIER}`] : ['all', 'tier1', 'tier2'];
  printTable('══ A) Casa soft vs preço justo Pinnacle — 1X2', 'A|1x2|', scopes);
  printTable('══ A) Casa soft vs preço justo Pinnacle — Over/Under 2.5', 'A|ou25|', scopes);
  if (!flag('no-model')) {
    printTable('══ B) Modelo Dixon-Coles em odds de abertura — 1X2', 'B|1x2|', scopes);
    printTable('══ B) Modelo Dixon-Coles em odds de abertura — Over/Under 2.5', 'B|ou25|', scopes);
  }

  if (DETAIL) printDetail(DETAIL);

  console.log(`
Como ler:
  • CLV (closing line value) é o indicador principal: positivo e com IC95 acima de 0 = vantagem real.
  • ROI com poucas centenas de apostas é quase só ruído — repara na largura do ±IC95.
  • "max" = melhor odd do mercado nesse momento; nem sempre é possível apostar lá (limites, contas).
  • Casas soft limitam ou fecham contas que ganham de forma consistente.
  • Muitas variantes testadas ao mesmo tempo: ~5% dão "significativo" por puro acaso.
    Confirma uma variante com --detail="A|1x2|<casa>|open|>0.02" (consistência por época e liga).`);

  const out = { generated_at: new Date().toISOString(), calibration, params: { devig: DEVIG, from: FROM, tier: TIER, edge_thresholds: EDGE_THRESHOLDS, model_thresholds: MODEL_THRESHOLDS },
    leagues: Object.fromEntries(LEAGUES.map(l => [l.leagueId, { name: l.name, tier: l.tier }])), results: {} };
  for (const [k, a] of Object.entries(results)) out.results[k] = fin(a);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n✓ Resultados (incl. por liga) em ${OUT}`);
}

if (require.main === module) main();
