#!/usr/bin/env bash
# Compila o servidor, copia o jar e a pasta public/ para o celular e reinicia o servidor.
# Uso: scripts/implantar.sh [host]   (padrão: celular-wifi, em casa; fora de casa use "celular")
set -euo pipefail
HOST=${1:-celular-wifi}
cd "$(dirname "$0")/.."

# cache do sw.js e ?v= do HTML têm que estar em dia, senão o celular mistura versões
node --test tests/versao.test.js >/dev/null || { echo "versão fora de sincronia: rode node scripts/versao.js"; exit 1; }
# clean: a compilação incremental já deixou uma classe velha no jar (NoSuchMethodError ao subir)
(cd servidor && mvn -B -q -DskipTests clean package)

ssh -o BatchMode=yes "$HOST" 'cd ~/contador && rm -rf public.novo contador.jar.novo'
scp -q -r public "$HOST":contador/public.novo
scp -q servidor/target/contador.jar "$HOST":contador/contador.jar.novo
# troca de uma vez: nunca fica um app pela metade
ssh -o BatchMode=yes "$HOST" 'cd ~/contador && rm -rf public.velho && mv public public.velho && mv public.novo public && mv contador.jar.novo contador.jar && rm -rf public.velho && ./contador.sh restart && for i in 1 2 3 4 5 6 7 8 9 10 11 12; do sleep 5; ./contador.sh status | grep -q "contador ok" && break; done; ./contador.sh status'

echo "conferindo pela URL pública..."
curl -fsS -m 15 https://grodev.com.br/contador/api/saude; echo
destino=$(curl -s -m 15 -o /dev/null -w '%{http_code} %{redirect_url}' https://grodev.com.br/contador)
echo "/contador -> $destino"
