#!/usr/bin/env bash
# Deploy completo del bot de cocheras: repo en GitHub (cuenta enginecpu1-cyber),
# secrets de Actions, Cloudflare Worker con Cron Trigger (cuenta enginecpu1@gmail.com),
# y primera corrida.
#
# Uso (una sola vez, desde Git Bash en la carpeta del bot):
#   bash deploy.sh
#
# Requisitos ya cumplidos en esta PC: gh logueado como enginecpu1-cyber,
# wrangler logueado como enginecpu1@gmail.com, node/npm.
# Los secretos del bot se leen de .env.deploy (gitignoreado).

set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
source .env.deploy   # define TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID

REPO="enginecpu1-cyber/bot-cocheras-caba"
PREV_GH_ACCOUNT="$(gh auth status --active 2>&1 | grep -oP '(?<=account )\S+' | head -1 || echo '')"

echo "==> gh: usando cuenta enginecpu1-cyber"
gh auth switch --user enginecpu1-cyber

echo "==> Creando repo $REPO (publico) y haciendo push"
if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "    ya existe, solo push"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$REPO.git"
  git push -u origin master
else
  gh repo create "$REPO" --public --source . --remote origin --push \
    --description "Bot Telegram: cocheras en alquiler para auto a <=5 cuadras de Corrientes 5753, Villa Crespo (CABA)"
fi

echo "==> Secrets de GitHub Actions"
gh secret set TELEGRAM_BOT_TOKEN --repo "$REPO" --body "$TELEGRAM_BOT_TOKEN"
gh secret set TELEGRAM_CHAT_ID  --repo "$REPO" --body "$TELEGRAM_CHAT_ID"

echo "==> Cloudflare Worker (cron trigger)"
GITHUB_DISPATCH_TOKEN="$(gh auth token --user enginecpu1-cyber)"
( cd worker
  npm install --silent --no-audit --no-fund
  npx --yes wrangler deploy
  printf '%s' "$GITHUB_DISPATCH_TOKEN" | npx --yes wrangler secret put GITHUB_DISPATCH_TOKEN
)

echo "==> Primera corrida del scraper"
gh workflow run buscar-cocheras.yml --repo "$REPO" --ref master

if [ -n "$PREV_GH_ACCOUNT" ] && [ "$PREV_GH_ACCOUNT" != "enginecpu1-cyber" ]; then
  echo "==> Restaurando cuenta gh activa: $PREV_GH_ACCOUNT"
  gh auth switch --user "$PREV_GH_ACCOUNT"
fi

echo
echo "LISTO. El bot corre cada 30 min. Ver corridas:"
echo "  https://github.com/$REPO/actions"
