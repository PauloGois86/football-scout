#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  Football Scout — Deploy Script
#  Corre este script UMA vez para instalar tudo no servidor.
#
#  Uso:
#    chmod +x deploy.sh
#    ./deploy.sh
# ─────────────────────────────────────────────────────────────────
set -e

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC}  $1"; }
err()  { echo -e "${RED}✗${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║     Football Scout — Deploy          ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. Verificar .env ─────────────────────────────────────────
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    warn ".env criado a partir do exemplo."
    warn "Edita o ficheiro .env e coloca a tua API key antes de continuar!"
    echo ""
    echo "  nano .env"
    echo "  # Altera: API_FOOTBALL_KEY=a_tua_chave_aqui"
    echo ""
    read -p "Pressiona ENTER quando tiveres a chave configurada..."
  else
    err "Ficheiro .env não encontrado!"
  fi
fi

# Verificar se a chave foi preenchida
if grep -q "a_tua_chave_aqui" .env; then
  err "A API key ainda está por preencher no ficheiro .env!"
fi
ok "Ficheiro .env encontrado"

# ── 2. Verificar Docker ───────────────────────────────────────
command -v docker >/dev/null 2>&1 || err "Docker não está instalado"
docker compose version >/dev/null 2>&1 || err "Docker Compose não está instalado"
ok "Docker disponível"

# ── 3. Criar directórios necessários ─────────────────────────
mkdir -p data/logs
ok "Directórios criados"

# ── 4. Parar versão anterior (se existir) ────────────────────
if docker compose ps -q 2>/dev/null | grep -q .; then
  log "A parar containers anteriores..."
  docker compose down
fi

# ── 5. Build e arranque ───────────────────────────────────────
log "A fazer build das imagens (pode demorar 1-2 min na primeira vez)..."
docker compose build --no-cache

log "A subir os serviços..."
docker compose up -d api frontend

# ── 6. Health check ───────────────────────────────────────────
log "A verificar que os serviços estão a responder..."
sleep 5

MAX_TRIES=15
COUNT=0
until curl -sf "http://localhost:3500/health" > /dev/null 2>&1; do
  COUNT=$((COUNT+1))
  if [ $COUNT -ge $MAX_TRIES ]; then
    err "API não respondeu após ${MAX_TRIES} tentativas. Verifica: docker compose logs api"
  fi
  echo -n "."
  sleep 2
done
echo ""
ok "API a responder em :3500"

if curl -sf "http://localhost:3501" > /dev/null 2>&1; then
  ok "Dashboard a responder em :3501"
else
  warn "Frontend ainda não responde — pode precisar de mais alguns segundos"
fi

# ── 7. Build do collector ─────────────────────────────────────
log "A fazer build do collector..."
docker compose --profile collector build collector
ok "Collector pronto"

# ── 8. Instalar cron diário ───────────────────────────────────
CRON_SCRIPT="$SCRIPT_DIR/run-daily.sh"
cat > "$CRON_SCRIPT" << DAILY
#!/bin/bash
SCRIPT_DIR="$SCRIPT_DIR"
LOG="\$SCRIPT_DIR/data/logs/daily-\$(date +%Y%m%d).log"
echo "=== Daily collect \$(date) ===" >> "\$LOG"
cd "\$SCRIPT_DIR"
docker compose run --rm collector node collect.js --mode=daily >> "\$LOG" 2>&1
echo "=== Done \$(date) ===" >> "\$LOG"
find "\$SCRIPT_DIR/data/logs" -name "daily-*.log" -mtime +30 -delete
DAILY

chmod +x "$CRON_SCRIPT"

CRON_LINE="30 6 * * * $CRON_SCRIPT"
if crontab -l 2>/dev/null | grep -q "football-scout"; then
  warn "Cron já instalado — a saltar"
else
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  ok "Cron diário instalado (todos os dias às 06:30)"
fi

# ── 9. Resumo final ───────────────────────────────────────────
SERVER_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║           Deploy concluído!                  ║"
echo "╠══════════════════════════════════════════════╣"
echo "║                                              ║"
printf "║  Dashboard:  http://%-25s║\n" "${SERVER_IP}:3501"
printf "║  API:        http://%-25s║\n" "${SERVER_IP}:3500/health"
echo "║                                              ║"
echo "║  Próximos passos:                            ║"
echo "║  1. Abre o dashboard no browser              ║"
echo "║  2. Corre o backfill para dados históricos   ║"
echo "║                                              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  Histórico gratuito c/ odds de fecho (recomendado, ~2 min):"
echo "  docker compose run --rm collector node import-fdcouk.js"
echo ""
echo "  Medir a qualidade do modelo (backtest):"
echo "  docker compose run --rm collector node backtest.js"
echo ""
echo "  Backfill API-Football (começa pela temporada 2024):"
echo "  docker compose run --rm collector \\"
echo "    node collect.js --mode=backfill --season=2024"
echo ""
echo "  Estado da base de dados:"
echo "  docker compose run --rm collector \\"
echo "    node collect.js --mode=status"
echo ""
echo "  Logs dos serviços:"
echo "  docker compose logs -f api"
echo ""
