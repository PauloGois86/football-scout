#!/bin/bash
# Semanal: importa a temporada actual do football-data.co.uk (resultados + odds de fecho)
# e volta a correr o backtest do modelo (resultado visível no dashboard → Base de Dados).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SCRIPT_DIR/data/logs/model-$(date +%Y%m%d).log"
mkdir -p "$SCRIPT_DIR/data/logs"
SEASON=$(( $(date +%m) >= 7 ? $(date +%Y) : $(date +%Y) - 1 ))
echo "=== Modelo $(date) ===" >> "$LOG"
cd "$SCRIPT_DIR"
docker compose run --rm collector node import-fdcouk.js --from=$SEASON >> "$LOG" 2>&1
docker compose run --rm collector node backtest.js >> "$LOG" 2>&1
echo "=== Done $(date) ===" >> "$LOG"
find "$SCRIPT_DIR/data/logs" -name "model-*.log" -mtime +60 -delete
