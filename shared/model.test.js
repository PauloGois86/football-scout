'use strict';
const test = require('node:test');
const assert = require('node:assert');
const model = require('./model');
const names = require('./names');
const { simulateLeague } = require('./simulate');

test('scoreMatrix soma 1 e mercados são coerentes', () => {
  const M = model.scoreMatrix(1.6, 1.1, -0.08);
  const total = M.flat().reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  const mk = model.marketsFromMatrix(M);
  assert.ok(Math.abs(mk.home + mk.draw + mk.away - 1) < 1e-9);
  assert.ok(mk.home > mk.away);
  assert.ok(mk.over['1.5'] > mk.over['2.5'] && mk.over['2.5'] > mk.over['3.5']);
});

test('fit recupera forças de uma liga simulada e bate baselines', () => {
  const { teams, matches } = simulateLeague({ seasons: 4, seed: 11 });
  const split = matches.findIndex(m => m.season === 2023);
  const train = matches.slice(0, split);
  const testSet = matches.slice(split);

  const fitted = model.fit(train, { refDate: testSet[0].date });
  assert.ok(fitted, 'modelo ajustado');
  assert.ok(fitted.gamma > 1.1 && fitted.gamma < 1.5, `gamma=${fitted.gamma}`);

  // correlação entre ataque real (temporada anterior) e estimado
  const xs = teams.map(t => t.att), ys = teams.map(t => fitted.teams[t.name].att);
  const corr = pearson(xs, ys);
  assert.ok(corr > 0.7, `correlação ataque ${corr.toFixed(2)}`);

  // avaliação out-of-sample vs prior de frequências
  let llModel = 0, llBase = 0;
  const freq = [0, 0, 0];
  for (const m of train) freq[m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2]++;
  const base = freq.map(f => f / train.length);
  for (const m of testSet) {
    const p = model.predict(fitted, m.home, m.away);
    const o = m.hg > m.ag ? 0 : m.hg === m.ag ? 1 : 2;
    llModel += model.logLoss([p.home, p.draw, p.away], o);
    llBase += model.logLoss(base, o);
  }
  assert.ok(llModel < llBase, `modelo ${llModel / testSet.length} vs base ${llBase / testSet.length}`);
});

test('devig, EV e kelly', () => {
  const d = model.devig([2.0, 3.5, 4.0]);
  assert.ok(Math.abs(d.probs.reduce((a, b) => a + b) - 1) < 1e-12);
  assert.ok(d.margin > 0);
  const pw = model.devig([1.5, 4.2, 7.0], 'power');
  const pr = model.devig([1.5, 4.2, 7.0]);
  assert.ok(Math.abs(pw.probs.reduce((a, b) => a + b) - 1) < 1e-9);
  assert.ok(pw.probs[2] < pr.probs[2], 'power dá menos probabilidade ao azarão');
  assert.ok(pw.probs[0] > pr.probs[0], 'e mais ao favorito');
  assert.ok(Math.abs(model.expectedValue(0.55, 2.0) - 0.1) < 1e-12);
  assert.strictEqual(model.kelly(0.4, 2.0), 0);
  assert.ok(model.kelly(0.6, 2.0) > 0);
});

test('nomes: aliases e equipas parecidas', () => {
  assert.ok(names.similarity('Man Utd', 'Manchester United') === 1);
  assert.ok(names.similarity('Manchester United', 'Manchester City') < 0.72);
  assert.ok(names.similarity('Paris Saint Germain', 'Paris Saint-Germain FC') >= 0.9);
  assert.ok(names.similarity('Sporting CP', 'Sporting Lisbon') === 1);
  assert.ok(names.similarity('Real Madrid', 'Real Sociedad') < 0.72);
  assert.strictEqual(names.bestMatch('Inter', ['AC Milan', 'Inter Milan', 'Juventus']).name, 'Inter Milan');
  const a = names.syntheticFixtureId(39, '2024-01-01', 'Arsenal', 'Chelsea');
  const b = names.syntheticFixtureId(39, '2024-01-01', 'Brighton', 'Brentford');
  assert.notStrictEqual(a, b);
  assert.ok(a < 0 && b < 0);
});

function pearson(x, y) {
  const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return num / Math.sqrt(dx * dy);
}
