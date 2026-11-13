'use strict';
/**
 * Modelo de previsão Dixon-Coles (Poisson bivariado com correcção para
 * resultados baixos) com decaimento temporal e regularização bayesiana.
 *
 *   λ_casa = a_casa · b_fora · γ          a = força ofensiva (golos/jogo)
 *   λ_fora = a_fora · b_casa              b = fragilidade defensiva (≈1 = média)
 *                                          γ = vantagem de jogar em casa
 *
 * Referências: Dixon & Coles (1997), "Modelling Association Football Scores
 * and Inefficiencies in the Football Betting Market".
 *
 * Sem dependências — corre tanto no backend como no collector/backtest.
 */

const DAY_MS = 86400000;

const DEFAULTS = {
  xi: 0.0019,          // decaimento por dia (meia-vida ≈ 1 ano)
  windowDays: 1100,    // só usa ~3 temporadas
  priorGames: 4,       // pseudo-jogos que puxam equipas com poucos dados para a média
  iterations: 200,
  tol: 1e-7,
  maxGoals: 10,
};

function factorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
const FACT = Array.from({ length: 21 }, (_, i) => factorial(i));
function poisson(k, lambda) { return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k]; }

function tau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/**
 * Ajusta o modelo.
 * @param {Array<{date:string|Date, home:string, away:string, hg:number, ag:number}>} matches
 * @param {object} opts  { refDate, xi, windowDays, priorGames }
 */
function fit(matches, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ref = o.refDate ? new Date(o.refDate).getTime() : Date.now();

  const data = [];
  for (const m of matches) {
    if (m.hg == null || m.ag == null || !m.home || !m.away) continue;
    const t = new Date(m.date).getTime();
    if (!(t < ref)) continue;                       // só jogos anteriores à data de referência
    const days = (ref - t) / DAY_MS;
    if (days > o.windowDays) continue;
    data.push({ h: m.home, a: m.away, hg: +m.hg, ag: +m.ag, w: Math.exp(-o.xi * days) });
  }
  if (data.length < 30) return null;

  const teams = [...new Set(data.flatMap(d => [d.h, d.a]))];
  const idx = new Map(teams.map((t, i) => [t, i]));
  const n = teams.length;

  // Média de golos por equipa/jogo (ponderada) — escala da prior
  let wSum = 0, gSum = 0, hgSum = 0, agSum = 0;
  for (const d of data) { wSum += d.w; gSum += d.w * (d.hg + d.ag); hgSum += d.w * d.hg; agSum += d.w * d.ag; }
  const mean = gSum / (2 * wSum);

  const att = new Float64Array(n).fill(mean);
  const def = new Float64Array(n).fill(1);
  let gamma = Math.max(1, hgSum / Math.max(agSum, 1e-9));
  const games = new Float64Array(n);
  for (const d of data) { games[idx.get(d.h)] += d.w; games[idx.get(d.a)] += d.w; }

  const k = o.priorGames;
  for (let it = 0; it < o.iterations; it++) {
    // ── ataque
    const num = new Float64Array(n).fill(k * mean);
    const den = new Float64Array(n).fill(k * (gamma + 1) / 2);
    for (const d of data) {
      const i = idx.get(d.h), j = idx.get(d.a);
      num[i] += d.w * d.hg; den[i] += d.w * def[j] * gamma;
      num[j] += d.w * d.ag; den[j] += d.w * def[i];
    }
    let maxDelta = 0;
    for (let i = 0; i < n; i++) { const v = num[i] / den[i]; maxDelta = Math.max(maxDelta, Math.abs(v - att[i])); att[i] = v; }

    // ── defesa
    const dn = new Float64Array(n).fill(k * mean);
    const dd = new Float64Array(n).fill(k * mean * (gamma + 1) / 2);
    for (const d of data) {
      const i = idx.get(d.h), j = idx.get(d.a);
      dn[j] += d.w * d.hg; dd[j] += d.w * att[i] * gamma;   // defesa do visitante sofre golos do visitado
      dn[i] += d.w * d.ag; dd[i] += d.w * att[j];
    }
    for (let i = 0; i < n; i++) { const v = dn[i] / dd[i]; maxDelta = Math.max(maxDelta, Math.abs(v - def[i])); def[i] = v; }

    // normaliza média(def)=1 (identificabilidade)
    let md = 0; for (let i = 0; i < n; i++) md += def[i]; md /= n;
    for (let i = 0; i < n; i++) { def[i] /= md; att[i] *= md; }

    // ── vantagem casa
    let gn = 0, gd = 0;
    for (const d of data) { gn += d.w * d.hg; gd += d.w * att[idx.get(d.h)] * def[idx.get(d.a)]; }
    const ng = gn / gd;
    maxDelta = Math.max(maxDelta, Math.abs(ng - gamma));
    gamma = ng;

    if (maxDelta < o.tol) break;
  }

  // ── rho (correcção Dixon-Coles) por pesquisa em grelha na log-verosimilhança
  let rho = 0, bestLL = -Infinity;
  for (let r = -0.25; r <= 0.1001; r += 0.005) {
    let ll = 0;
    for (const d of data) {
      if (d.hg > 1 || d.ag > 1) continue;          // tau=1 fora destes resultados
      const lh = att[idx.get(d.h)] * def[idx.get(d.a)] * gamma;
      const la = att[idx.get(d.a)] * def[idx.get(d.h)];
      const t = tau(d.hg, d.ag, lh, la, r);
      if (t <= 0) { ll = -Infinity; break; }
      ll += d.w * Math.log(t);
    }
    if (ll > bestLL) { bestLL = ll; rho = r; }
  }

  const teamMap = {};
  teams.forEach((t, i) => { teamMap[t] = { att: att[i], def: def[i], games: games[i] }; });

  return {
    type: 'dixon-coles',
    teams: teamMap,
    gamma, rho, mean,
    homeGoalsAvg: hgSum / wSum,
    awayGoalsAvg: agSum / wSum,
    nMatches: data.length,
    refDate: new Date(ref).toISOString(),
    opts: { xi: o.xi, windowDays: o.windowDays, priorGames: o.priorGames },
  };
}

/** Matriz de probabilidades de resultado exacto [golosCasa][golosFora]. */
function scoreMatrix(lh, la, rho = 0, maxGoals = DEFAULTS.maxGoals) {
  const M = [];
  let total = 0;
  for (let x = 0; x <= maxGoals; x++) {
    M.push([]);
    for (let y = 0; y <= maxGoals; y++) {
      const p = poisson(x, lh) * poisson(y, la) * tau(x, y, lh, la, rho);
      M[x].push(p); total += p;
    }
  }
  for (const row of M) for (let y = 0; y < row.length; y++) row[y] /= total;
  return M;
}

/** Mercados derivados da matriz de resultados. */
function marketsFromMatrix(M) {
  let home = 0, draw = 0, away = 0, btts = 0;
  const over = { 0.5: 0, 1.5: 0, 2.5: 0, 3.5: 0, 4.5: 0 };
  const scores = [];
  for (let x = 0; x < M.length; x++) {
    for (let y = 0; y < M[x].length; y++) {
      const p = M[x][y];
      if (x > y) home += p; else if (x === y) draw += p; else away += p;
      if (x > 0 && y > 0) btts += p;
      for (const line of Object.keys(over)) if (x + y > +line) over[line] += p;
      scores.push({ score: `${x}-${y}`, p });
    }
  }
  scores.sort((a, b) => b.p - a.p);
  return { home, draw, away, btts, over, topScores: scores.slice(0, 6) };
}

/**
 * Previsão para um jogo. Equipas desconhecidas recebem uma prior de equipa
 * ligeiramente abaixo da média (tipicamente recém-promovidas).
 */
function predict(model, home, away) {
  if (!model) return null;
  const unknown = { att: model.mean * 0.85, def: 1.15, games: 0 };
  const h = model.teams[home] || unknown;
  const a = model.teams[away] || unknown;
  const lh = h.att * a.def * model.gamma;
  const la = a.att * h.def;
  const M = scoreMatrix(lh, la, model.rho);
  const mk = marketsFromMatrix(M);
  const minGames = Math.min(h.games, a.games);
  return {
    lambdaHome: lh, lambdaAway: la,
    ...mk,
    knownHome: !!model.teams[home], knownAway: !!model.teams[away],
    // confiança simples: depende do volume efectivo (ponderado) de jogos de cada equipa
    confidence: minGames >= 25 ? 'alta' : minGames >= 10 ? 'média' : 'baixa',
    effectiveGames: { home: +h.games.toFixed(1), away: +a.games.toFixed(1) },
  };
}

// ── Utilitários de mercado ────────────────────────────────────

/** Remove a margem da casa (método proporcional). odds: array de odds decimais. */
function devig(odds) {
  if (!odds || odds.some(o => !(o > 1))) return null;
  const inv = odds.map(o => 1 / o);
  const s = inv.reduce((a, b) => a + b, 0);
  return { probs: inv.map(p => p / s), margin: s - 1 };
}

/** Valor esperado de uma aposta (por unidade apostada). */
function expectedValue(prob, odd) { return odd > 1 ? prob * odd - 1 : null; }

/** Kelly fraccionado (stake sugerido em fracção da banca). */
function kelly(prob, odd, fraction = 0.25) {
  if (!(odd > 1)) return 0;
  const b = odd - 1;
  const f = (b * prob - (1 - prob)) / b;
  return Math.max(0, f * fraction);
}

/** Mistura linear de distribuições (modelo + mercado). */
function blend(pModel, pMarket, wModel) {
  if (!pMarket) return pModel;
  if (!pModel) return pMarket;
  return pModel.map((p, i) => wModel * p + (1 - wModel) * pMarket[i]);
}

// ── Métricas de avaliação ─────────────────────────────────────
function logLoss(probs, outcomeIdx) { return -Math.log(Math.max(probs[outcomeIdx], 1e-12)); }
function brier(probs, outcomeIdx) { return probs.reduce((s, p, i) => s + (p - (i === outcomeIdx ? 1 : 0)) ** 2, 0); }
/** Ranked Probability Score — métrica padrão para 1X2 (ordinal). */
function rps(probs, outcomeIdx) {
  let cumP = 0, cumO = 0, s = 0;
  for (let i = 0; i < probs.length - 1; i++) {
    cumP += probs[i]; cumO += i === outcomeIdx ? 1 : 0;
    s += (cumP - cumO) ** 2;
  }
  return s / (probs.length - 1);
}

module.exports = {
  DEFAULTS, fit, predict, scoreMatrix, marketsFromMatrix,
  devig, expectedValue, kelly, blend, logLoss, brier, rps, poisson,
};
