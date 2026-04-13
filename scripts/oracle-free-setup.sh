#!/usr/bin/env bash
set -euo pipefail

SWAP_FILE="${SWAP_FILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
SWAPPINESS="${SWAPPINESS:-20}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

if ! command -v fallocate >/dev/null 2>&1; then
  echo "fallocate no esta disponible. Instala util-linux o crea el swap manualmente."
  exit 1
fi

if swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
  echo "Swap ya activo en $SWAP_FILE"
else
  if [ ! -f "$SWAP_FILE" ]; then
    echo "Creando swap $SWAP_SIZE en $SWAP_FILE"
    $SUDO fallocate -l "$SWAP_SIZE" "$SWAP_FILE"
    $SUDO chmod 600 "$SWAP_FILE"
    $SUDO mkswap "$SWAP_FILE"
  else
    echo "Usando swapfile existente en $SWAP_FILE"
    $SUDO chmod 600 "$SWAP_FILE"
  fi

  $SUDO swapon "$SWAP_FILE"
fi

if ! grep -qxF "$SWAP_FILE none swap sw 0 0" /etc/fstab; then
  echo "Persistiendo swap en /etc/fstab"
  echo "$SWAP_FILE none swap sw 0 0" | $SUDO tee -a /etc/fstab >/dev/null
fi

if [ -w /etc/sysctl.conf ] || [ -n "$SUDO" ]; then
  if grep -q '^vm.swappiness=' /etc/sysctl.conf; then
    $SUDO sed -i "s/^vm.swappiness=.*/vm.swappiness=$SWAPPINESS/" /etc/sysctl.conf
  else
    echo "vm.swappiness=$SWAPPINESS" | $SUDO tee -a /etc/sysctl.conf >/dev/null
  fi
  $SUDO sysctl -p >/dev/null
fi

echo "Swap listo:"
free -h
swapon --show

echo ""
echo "Siguiente paso recomendado:"
echo "  npm install"
echo "  npm run pm2:start"
echo "  pm2 save"
echo "  pm2 startup"
