#!/usr/bin/env bash

set -euo pipefail

PORT="${1:-8000}"
BIND_ADDRESS="${BIND_ADDRESS:-0.0.0.0}"

get_local_ip() {
  local iface
  iface="$(route -n get default 2>/dev/null | awk '/interface: / {print $2; exit}')"

  if [[ -n "${iface:-}" ]]; then
    ipconfig getifaddr "$iface" 2>/dev/null && return 0
  fi

  for iface in en0 en1; do
    ipconfig getifaddr "$iface" 2>/dev/null && return 0
  done

  return 1
}

if [[ "$BIND_ADDRESS" == "0.0.0.0" ]]; then
  if LOCAL_IP="$(get_local_ip)"; then
    echo "Open locally: http://localhost:$PORT"
    echo "Open from another computer: http://$LOCAL_IP:$PORT"
  else
    echo "Open locally: http://localhost:$PORT"
    echo "Could not detect LAN IP automatically."
  fi
else
  echo "Server address: http://$BIND_ADDRESS:$PORT"
fi

exec python3 -m http.server "$PORT" --bind "$BIND_ADDRESS"
