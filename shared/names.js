'use strict';
/**
 * Normalização e comparação de nomes de equipas entre fontes diferentes
 * (API-Football, football-data.org, The Odds API, football-data.co.uk).
 */

// Aliases conhecidos → nome normalizado canónico
const ALIASES = {
  'man utd': 'manchester united', 'man united': 'manchester united',
  'man city': 'manchester city',
  'spurs': 'tottenham', 'tottenham hotspur': 'tottenham',
  'wolves': 'wolverhampton', 'wolverhampton wanderers': 'wolverhampton',
  'nottm forest': 'nottingham forest', "nott'm forest": 'nottingham forest',
  'newcastle utd': 'newcastle', 'newcastle united': 'newcastle',
  'west ham united': 'west ham', 'brighton and hove albion': 'brighton', 'brighton hove albion': 'brighton',
  'sheffield utd': 'sheffield united', 'leeds united': 'leeds',
  'psg': 'paris saint germain', 'paris sg': 'paris saint germain', 'paris s g': 'paris saint germain',
  'inter': 'inter milan', 'internazionale': 'inter milan', 'fc internazionale milano': 'inter milan', 'inter milano': 'inter milan',
  'milan': 'ac milan',
  'atletico madrid': 'atletico madrid', 'ath madrid': 'atletico madrid', 'atl madrid': 'atletico madrid', 'club atletico de madrid': 'atletico madrid',
  'ath bilbao': 'athletic bilbao', 'athletic club': 'athletic bilbao',
  'betis': 'real betis', 'sociedad': 'real sociedad',
  'bayern munchen': 'bayern munich', 'bayern': 'bayern munich', 'fc bayern munchen': 'bayern munich',
  'dortmund': 'borussia dortmund', 'bvb': 'borussia dortmund',
  'm gladbach': 'borussia monchengladbach', "m'gladbach": 'borussia monchengladbach', 'gladbach': 'borussia monchengladbach',
  'leverkusen': 'bayer leverkusen', 'bayer 04 leverkusen': 'bayer leverkusen',
  'ein frankfurt': 'eintracht frankfurt', 'rb leipzig': 'leipzig', 'rasenballsport leipzig': 'leipzig',
  'sporting cp': 'sporting', 'sporting lisbon': 'sporting', 'sp lisbon': 'sporting', 'sporting clube de portugal': 'sporting',
  'sl benfica': 'benfica', 'fc porto': 'porto', 'sc braga': 'braga', 'sp braga': 'braga',
  'vitoria guimaraes': 'guimaraes', 'vitoria sc': 'guimaraes',
  'psv eindhoven': 'psv', 'ajax amsterdam': 'ajax', 'afc ajax': 'ajax', 'az alkmaar': 'az',
  'olympique lyonnais': 'lyon', 'olympique marseille': 'marseille', 'olympique de marseille': 'marseille',
  'as monaco': 'monaco', 'as roma': 'roma', 'ss lazio': 'lazio', 'ssc napoli': 'napoli', 'juventus fc': 'juventus',
};

const SUFFIXES = [' football club', ' fc', ' cf', ' sc', ' ac', ' afc', ' fk', ' sk', ' if', ' club', ' calcio', ' cp'];
const PREFIXES = ['fc ', 'cf ', 'sc ', 'ac ', 'afc ', 'ssc ', 'ss ', 'as ', 'us ', 'rc ', 'cd ', 'ud ', 'sd ', 'ca ', 'sv ', 'vfl ', 'vfb ', 'tsg ', '1 fc ', '1 '];

function normalizeName(s) {
  let n = String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (ALIASES[n]) return ALIASES[n];
  for (const p of PREFIXES) if (n.startsWith(p) && n.length > p.length + 2) { n = n.slice(p.length); break; }
  for (const suf of SUFFIXES) if (n.endsWith(suf) && n.length > suf.length + 2) { n = n.slice(0, -suf.length).trim(); break; }
  n = n.replace(/\b(18|19|20)\d{2}\b/g, '').replace(/\s+/g, ' ').trim(); // "Mainz 05", "Schalke 04" etc. mantém-se; anos removidos
  return ALIASES[n] || n;
}

function bigrams(s) {
  const bg = new Set();
  for (let i = 0; i < s.length - 1; i++) bg.add(s.slice(i, i + 2));
  return bg;
}

/** Similaridade 0..1 entre dois nomes de equipa. */
function similarity(a, b) {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1.0;

  const tA = na.split(' ');
  const tB = nb.split(' ');
  // "Manchester United" vs "Manchester City" partilham um token mas são equipas diferentes:
  // a contenção só conta se o nome mais curto não for apenas um token genérico partilhado.
  if ((na.includes(nb) || nb.includes(na)) && Math.min(na.length, nb.length) >= 4) {
    const shorter = na.length < nb.length ? tA : tB;
    const longer  = na.length < nb.length ? tB : tA;
    const GENERIC = new Set(['manchester', 'real', 'athletic', 'sporting', 'borussia', 'inter', 'olympique', 'racing', 'deportivo', 'west', 'sheffield']);
    if (!(shorter.length === 1 && GENERIC.has(shorter[0]) && longer.length > 1)) return 0.9;
  }

  const setA = new Set(tA), setB = new Set(tB);
  let tokenScore = 0;
  if (setA.size && setB.size) {
    const inter = [...setA].filter(w => setB.has(w)).length;
    tokenScore = (2 * inter) / (setA.size + setB.size);
  }

  const bgA = bigrams(na.replace(/ /g, '')), bgB = bigrams(nb.replace(/ /g, ''));
  let bgScore = 0;
  if (bgA.size && bgB.size) {
    const inter = [...bgA].filter(x => bgB.has(x)).length;
    bgScore = (2 * inter) / (bgA.size + bgB.size);
  }
  return Math.max(tokenScore >= 0.99 ? tokenScore : tokenScore * 0.85, bgScore * 0.95);
}

/**
 * Encontra o melhor candidato para `name` numa lista de nomes.
 * @returns {{name:string, score:number}|null}
 */
function bestMatch(name, candidates, threshold = 0.72) {
  let best = null;
  for (const c of candidates) {
    const s = similarity(name, c);
    if (!best || s > best.score) best = { name: c, score: s };
    if (s === 1) break;
  }
  return best && best.score >= threshold ? best : null;
}

/** Hash estável (FNV-1a 32 bits) — usado para IDs sintéticos sem colisões triviais. */
function stableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** ID sintético negativo e estável para jogos sem ID do API-Football. */
function syntheticFixtureId(leagueId, date, home, away) {
  const key = `${leagueId}|${String(date).slice(0, 10)}|${normalizeName(home)}|${normalizeName(away)}`;
  // 31 bits para caber num INTEGER positivo antes de negar; nunca 0
  return -((stableHash(key) & 0x7fffffff) || 1);
}

module.exports = { normalizeName, similarity, bestMatch, stableHash, syntheticFixtureId, ALIASES };
