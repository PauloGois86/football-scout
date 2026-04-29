#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SCRIPT_DIR/data/logs/daily-$(date +%Y%m%d).log"
echo "=== Daily $(date) ===" >> "$LOG"
cd "$SCRIPT_DIR"
docker compose run --rm collector node collect.js --mode=daily    >> "$LOG" 2>&1
docker compose run --rm collector node collect.js --mode=backfill >> "$LOG" 2>&1
echo "=== Done $(date) ===" >> "$LOG"
find "$SCRIPT_DIR/data/logs" -name "daily-*.log" -mtime +30 -delete
