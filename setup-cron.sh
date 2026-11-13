#!/bin/bash
# Football Scout — Instala cron jobs para ambos os collectors
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$SCRIPT_DIR/data/logs"

# ── 1. Script football-data.org (03h00) ───────────────────────
# Corre primeiro — sem limite diário, preenche resultados e stats básicas
cat > "$SCRIPT_DIR/run-alt.sh" << 'ALTEOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SCRIPT_DIR/data/logs/alt-$(date +%Y%m%d).log"
echo "=== football-data.org $(date) ===" >> "$LOG"
cd "$SCRIPT_DIR"
docker compose run --rm collector node collect-alt.js --mode=daily    >> "$LOG" 2>&1
docker compose run --rm collector node collect-alt.js --mode=backfill >> "$LOG" 2>&1
echo "=== Done $(date) ===" >> "$LOG"
find "$SCRIPT_DIR/data/logs" -name "alt-*.log" -mtime +30 -delete
ALTEOF
chmod +x "$SCRIPT_DIR/run-alt.sh"

# ── 2. Script API-Football (04h30) ────────────────────────────
# Corre depois do alt — usa os 100 requests só para odds, xG e posse
cat > "$SCRIPT_DIR/run-main.sh" << 'MAINEOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$SCRIPT_DIR/data/logs/main-$(date +%Y%m%d).log"
echo "=== API-Football $(date) ===" >> "$LOG"
cd "$SCRIPT_DIR"
docker compose run --rm collector node collect.js --mode=daily    >> "$LOG" 2>&1
docker compose run --rm collector node collect.js --mode=backfill >> "$LOG" 2>&1
echo "=== Done $(date) ===" >> "$LOG"
find "$SCRIPT_DIR/data/logs" -name "main-*.log" -mtime +30 -delete
MAINEOF
chmod +x "$SCRIPT_DIR/run-main.sh"

# ── Instalar crons ────────────────────────────────────────────
TMP=$(mktemp)
crontab -l 2>/dev/null > "$TMP" || true

# Remove entradas antigas se existirem
grep -v "football-scout\|run-daily\|run-alt\|run-main\|run-model" "$TMP" > "${TMP}.clean" && mv "${TMP}.clean" "$TMP" || true

# Adiciona os dois crons
# 03h00 — football-data.org (sem limite, corre antes)
echo "0 3 * * * $SCRIPT_DIR/run-alt.sh" >> "$TMP"
# 04h30 — API-Football (depois do reset UTC 01h00, com folga)
echo "30 4 * * * $SCRIPT_DIR/run-main.sh" >> "$TMP"

# Segunda 05h30 — import football-data.co.uk + backtest do modelo
echo "30 5 * * 1 $SCRIPT_DIR/run-model.sh" >> "$TMP"

crontab "$TMP"
rm "$TMP"

echo ""
echo "╔═══════════════════════════════════════════════════════╗"
echo "║            Cron jobs instalados!                      ║"
echo "╠═══════════════════════════════════════════════════════╣"
echo "║  03:00 — football-data.org (resultados + stats base)  ║"
echo "║           Sem limite diário — preenche tudo           ║"
echo "║                                                       ║"
echo "║  04:30 — API-Football (odds + xG + posse)             ║"
echo "║           100 req/dia — usa só para o essencial       ║"
echo "║                                                       ║"
echo "║  Seg 05:30 — import histórico + backtest do modelo    ║"
echo "╚═══════════════════════════════════════════════════════╝"
echo ""
echo "Verifica:  crontab -l"
echo "Logs em:   $SCRIPT_DIR/data/logs/"
echo ""
echo "Para testar já agora (football-data, sem limite):"
echo "  docker compose run --rm collector node collect-alt.js --mode=backfill"
