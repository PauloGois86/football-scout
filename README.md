# ⚽ Football Scout

Dashboard de análise de jogos de futebol: lista os próximos jogos com odds de várias casas,
calcula probabilidades com um **modelo Dixon-Coles** treinado no histórico e assinala apostas
com **valor esperado (EV) positivo**. Inclui um **backtest walk-forward** para medir se o modelo
acerta mesmo.

## Arquitectura

```
football-scout/
├── shared/               ← código partilhado (modelo, nomes, esquema da BD)
│   ├── model.js          ← Dixon-Coles + devig + EV + Kelly + métricas
│   ├── names.js          ← normalização/fuzzy-match de nomes de equipas entre fontes
│   ├── dataset.js        ← carrega jogos da BD para o modelo
│   ├── schema.js         ← esquema SQLite (idempotente)
│   ├── simulate.js       ← ligas sintéticas (testes)
│   └── model.test.js
├── backend/server.js     ← API Express (:3500)
├── collector/
│   ├── collect.js        ← API-Football (odds, xG, stats) — 100 req/dia no plano free
│   ├── collect-alt.js    ← football-data.org (resultados) — 10 req/min
│   ├── import-fdcouk.js  ← football-data.co.uk (histórico + odds de fecho, grátis, sem key)
│   └── backtest.js       ← avaliação walk-forward do modelo
├── frontend/index.html   ← dashboard (nginx :3501)
└── docker-compose.yml
```

## Arranque rápido

```bash
cp .env.example .env      # preenche as chaves e define ADMIN_TOKEN
docker compose up -d --build
docker compose run --rm collector node import-fdcouk.js   # ~10 anos de histórico c/ odds
docker compose run --rm collector node backtest.js        # mede a qualidade do modelo
./setup-cron.sh                                           # recolhas diárias + backtest semanal
```

Dashboard em `http://SERVIDOR:3501`. Para desenvolver no Windows, clona para `C:\dev`:

```bash
git clone https://github.com/PauloGois86/football-scout.git C:\dev\football-scout
```

## Como funciona a previsão

1. **Modelo Dixon-Coles** (`shared/model.js`) — cada equipa tem uma força de ataque e uma
   fragilidade defensiva, mais um factor casa. Os jogos recentes pesam mais (meia-vida ≈ 1 ano)
   e equipas com poucos jogos são puxadas para a média. Daí sai a matriz de resultados exactos
   → 1X2, Over/Under 1.5/2.5/3.5, Ambas Marcam e resultados mais prováveis.
2. **Mercado** — as odds de várias casas são agregadas e a margem é removida (probabilidade justa).
3. **Previsão final** = `MODEL_WEIGHT × modelo + (1 − MODEL_WEIGHT) × mercado` (por defeito 35% modelo).
   Se uma equipa não tem histórico, o peso do modelo desce automaticamente.
4. **Valor** = `probabilidade × melhor odd − 1`. Só é "VALUE" acima de `EV_THRESHOLD` (3%).

## Backtest

`node backtest.js` re-treina o modelo semana a semana usando **apenas jogos anteriores** e compara:

| Métrica | O que significa |
|---|---|
| Acerto | % de jogos em que o resultado mais provável aconteceu |
| Logloss / RPS | qualidade das probabilidades (menor = melhor) — a métrica que interessa |
| Mercado | as mesmas métricas usando as odds de fecho sem margem |
| ROI / CLV | resultado de apostar quando EV > limiar; CLV = odd apostada vs odd de fecho |

`node backtest.js --simulate` corre numa liga sintética onde as probabilidades verdadeiras são
conhecidas — útil para perceber os limites (ver abaixo).

## É viável ter "alta taxa de sucesso"?

Expectativas realistas, baseadas na literatura e no backtest simulado deste projecto:

- **1X2**: mesmo um modelo que conhecesse as probabilidades *verdadeiras* acerta ~50–55%
  (no simulador: oráculo 55.3%, modelo 53.9%). As casas de apostas também ficam por aí.
  O futebol tem muito acaso — 70–80% de acerto em 1X2 não é atingível por ninguém.
- **Over/Under 2.5**: ~55–60%.
- **Bater o mercado** (lucro a longo prazo) é muito difícil: as odds de fecho da Pinnacle são
  das previsões mais precisas que existem. Um modelo só com resultados raramente as bate.
- O objectivo útil é: **probabilidades bem calibradas** + encontrar **poucas apostas com valor**
  — e confirmar com CLV positivo no backtest antes de arriscar dinheiro.

Melhorias com mais impacto a seguir: xG por jogo (Understat/FBref) no modelo, lesões/onze
provável, odds de abertura vs fecho (movimentos de mercado), e calibrar `MODEL_WEIGHT` por liga
com o backtest.

## Segurança

- Define `ADMIN_TOKEN` no `.env` — protege `/api/admin/*` e o import da BD (o dashboard pede o token).
- Nunca faças commit do `.env`.

## Testes

```bash
cd collector && npm install && npm test        # testes do modelo
node backtest.js --simulate                     # backtest em liga sintética
```
