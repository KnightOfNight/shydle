#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/server.pid"
LOG_FILE="$SCRIPT_DIR/server.log"
PORT="${PORT:-8000}"
BIND_ADDRESS="${BIND_ADDRESS:-0.0.0.0}"
VERB="${1:-}"

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

cleanup_pid_file() {
  if [[ -f "$PID_FILE" ]]; then
    rm -f "$PID_FILE"
    echo "Removed stale PID file."
  fi
}

running_pid_from_file() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(tr -d '[:space:]' <"$PID_FILE")"

  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    echo "PID file is invalid."
    cleanup_pid_file
    return 1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "$pid"
    return 0
  fi

  echo "PID file points to a non-running process."
  cleanup_pid_file
  return 1
}

print_addresses() {
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
}

start_server() {
  local running_pid
  if running_pid="$(running_pid_from_file)"; then
    echo "Server is already running with PID $running_pid."
    echo "Log file: $LOG_FILE"
    return 0
  fi

  (
    cd "$SCRIPT_DIR"
    exec python3 -m http.server "$PORT" --bind "$BIND_ADDRESS"
  ) >>"$LOG_FILE" 2>&1 &

  local server_pid=$!
  echo "$server_pid" >"$PID_FILE"
  echo "Started server with PID $server_pid."
  echo "PID file: $PID_FILE"
  echo "Log file: $LOG_FILE"
  print_addresses
}

stop_server() {
  local running_pid
  if ! running_pid="$(running_pid_from_file)"; then
    echo "Server is not running."
    return 1
  fi

  kill "$running_pid"
  echo "Stopped server with PID $running_pid."
  cleanup_pid_file
}

status_server() {
  local running_pid
  if running_pid="$(running_pid_from_file)"; then
    echo "Server is running with PID $running_pid."
    echo "PID file: $PID_FILE"
    echo "Log file: $LOG_FILE"
    print_addresses
    return 0
  fi

  echo "Server is not running."
  return 1
}

case "${VERB:-status}" in
  start)
    start_server
    ;;
  stop)
    stop_server
    ;;
  status)
    status_server
    ;;
  *)
    echo "Usage: ./simple-server.sh <start|stop|status>"
    exit 1
    ;;
esac
