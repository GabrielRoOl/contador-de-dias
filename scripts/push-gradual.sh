#!/usr/bin/env bash
# Envia ao GitHub os próximos commits da main que ainda não subiram, em lotes (padrão: 5), sem force.
# Uso: scripts/push-gradual.sh            (LOTE=3 scripts/push-gradual.sh para mudar o tamanho)
# É chamado uma vez por dia pelo timer push-gradual (systemd do usuário). Quando a fila acaba, o script desliga o timer:
# commits novos depois disso só sobem quando você pedir (ou religar com: systemctl --user enable --now push-gradual.timer).
set -euo pipefail
LOTE=${LOTE:-5}
cd "$(dirname "$0")/.."

git fetch -q origin main
pendentes=$(git rev-list --reverse --topo-order origin/main..main)   # topo-order: cada commit vem depois dos seus pais
total=$(printf '%s' "$pendentes" | grep -c . || true)
if [ "$total" -eq 0 ]; then
  echo "nada a enviar"
else
  alvo=$(printf '%s\n' "$pendentes" | sed -n "${LOTE}p")
  [ -n "$alvo" ] || alvo=$(git rev-parse main)
  # só avanço de linha reta: se o GitHub tem algo que a main local não tem, para e avisa
  git merge-base --is-ancestor origin/main "$alvo" || { echo "origin/main não é ancestral do lote: não vou enviar (resolva à mão)"; exit 1; }
  echo "enviando até $(git log -1 --format='%h %s' "$alvo") ($total na fila, lote de $LOTE)"
  git push -q origin "$alvo:refs/heads/main"
fi

faltam=$(git rev-list --count origin/main..main)
echo "faltam $faltam commits"
if [ "$faltam" -eq 0 ] && command -v systemctl >/dev/null; then
  systemctl --user disable --now push-gradual.timer 2>/dev/null && echo "fila vazia: timer desligado" || true
fi
