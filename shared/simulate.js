'use strict';
/**
 * Gerador de ligas sintéticas com forças conhecidas — usado em testes para
 * validar o modelo e o backtest sem depender de APIs externas.
 */

function rng(seed = 42) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function samplePoisson(lambda, rand) {
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

/**
 * Simula `seasons` temporadas de round-robin duplo com `nTeams` equipas.
 * As forças derivam lentamente entre temporadas (random walk).
 */
function simulateLeague({ nTeams = 20, seasons = 4, seed = 7, gamma = 1.3, startYear = 2020, drift = 0.05 } = {}) {
  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const teams = Array.from({ length: nTeams }, (_, i) => ({
    name: `Team ${String.fromCharCode(65 + i)}`,
    att: Math.exp(0.3 * gauss()) * 1.25,
    def: Math.exp(0.25 * gauss()),
  }));
  const matches = [];
  for (let s = 0; s < seasons; s++) {
    const year = startYear + s;
    for (const t of teams) { t.att *= Math.exp(drift * gauss()); t.def *= Math.exp(drift * gauss()); }
    const pairs = [];
    for (let i = 0; i < nTeams; i++) for (let j = 0; j < nTeams; j++) if (i !== j) pairs.push([i, j]);
    // embaralha e distribui por ~38 jornadas semanais entre Agosto e Maio
    for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
    const start = Date.UTC(year, 7, 10);
    pairs.forEach(([i, j], n) => {
      const round = Math.floor(n / (nTeams / 2));
      const date = new Date(start + round * 7 * 86400000 + (n % 3) * 86400000);
      const h = teams[i], a = teams[j];
      const hg = samplePoisson(h.att * a.def * gamma, rand);
      const ag = samplePoisson(a.att * h.def, rand);
      matches.push({ date: date.toISOString(), season: year, home: h.name, away: a.name, hg, ag,
        trueLh: h.att * a.def * gamma, trueLa: a.att * h.def });
    });
  }
  matches.sort((x, y) => x.date.localeCompare(y.date));
  return { teams, matches };
}

module.exports = { simulateLeague, rng, samplePoisson };
