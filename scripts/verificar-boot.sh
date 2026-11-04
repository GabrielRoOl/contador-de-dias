#!/usr/bin/env bash
# Confere, depois de reiniciar o celular, se o Termux:Boot subiu o servidor sozinho.
# Uso: scripts/verificar-boot.sh [host]   (padrão: celular-wifi)
# Antes: reinicie o celular e NÃO abra o Termux (o teste só vale se o boot fez tudo sozinho). Espere ~2 min.
set -uo pipefail
HOST=${1:-celular-wifi}
saida=$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" '
  agora=$(date +%s)
  ultima=$(tail -1 ~/logs/boot-contador.log 2>/dev/null)
  echo "AGORA=$agora"
  echo "ULTIMA=$ultima"
  echo "JAVA_IDADE=$(ps -eo etimes,args 2>/dev/null | grep "contador.jar" | grep -v grep | head -1 | awk "{print \$1}")"
  echo "STATUS=$(~/contador/contador.sh status)"
  echo "---- log do boot"; tail -6 ~/logs/boot-contador.log 2>/dev/null
') || { echo "não consegui falar com o celular por ssh ($HOST). Ele já terminou de ligar?"; exit 2; }
echo "$saida"
agora=$(echo "$saida" | sed -n 's/^AGORA=//p')
epoch=$(echo "$saida" | sed -n 's/^ULTIMA=\([0-9]*\) .*/\1/p')
idade=$(echo "$saida" | sed -n 's/^JAVA_IDADE=//p')
echo
if [ -z "$epoch" ]; then echo "FALHA: o script de boot nunca escreveu no log (Termux:Boot não rodou 30-contador)."; exit 1; fi
if [ $((agora - epoch)) -gt 1800 ]; then echo "FALHA: a última linha do log de boot tem mais de 30 min. O celular reiniciou agora há pouco?"; exit 1; fi
if ! echo "$saida" | grep -q "STATUS=contador ok"; then echo "FALHA: o boot rodou, mas o servidor não responde. Veja ~/logs/contador.log."; exit 1; fi
echo "BOOT OK: o Termux:Boot subiu o servidor sozinho (processo java com ${idade:-?} s de vida)."
