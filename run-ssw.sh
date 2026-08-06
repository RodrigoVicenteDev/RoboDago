#!/bin/bash

# timezone
export TZ=America/Sao_Paulo

# diretório base
BASE_DIR="/home/rodrigo/projetodago/opt/ssw-bot"
cd "$BASE_DIR" || exit 1

# carrega variáveis do .env (cron não carrega sozinho)
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# logs do cron
LOG_DIR="$BASE_DIR/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/cron_$(date +%F).log"

# lock file (impede rodar 2x ao mesmo tempo)
LOCK_FILE="/tmp/ssw-bot.lock"

{
  echo "[$(date)] 🔐 Tentando adquirir lock..."

  # fd 200 controla o lock
  flock -n 200
  if [ $? -ne 0 ]; then
    echo "[$(date)] ⛔ Já existe uma execução em andamento. Abortando."
    exit 0
  fi

  echo "[$(date)] ✅ Lock adquirido. Iniciando robô..."

  /usr/bin/node rodar_todos.js

  echo "[$(date)] ✅ Robô finalizado."

} 200>"$LOCK_FILE" >> "$LOG" 2>&1
