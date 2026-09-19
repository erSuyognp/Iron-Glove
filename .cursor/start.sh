#!/usr/bin/env bash
# Per-boot runtime initialization for the IRON GLOVE environment.
# Launches the SpacetimeDB standalone daemon (idempotently), waits until it is
# ready, then publishes the iron-glove module so the local database exists in
# this booted instance. Returns once the daemon is serving.
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
LOG="/tmp/spacetimedb.log"
PING="http://127.0.0.1:3000/v1/ping"

is_up() { curl -sf "$PING" >/dev/null 2>&1; }

if is_up; then
  echo "==> SpacetimeDB already running on :3000"
else
  echo "==> Starting SpacetimeDB daemon (logs: $LOG)"
  setsid bash -c 'exec spacetime start' >"$LOG" 2>&1 &
  for _ in $(seq 1 60); do
    if is_up; then break; fi
    sleep 1
  done
  if ! is_up; then
    echo "!! SpacetimeDB did not become ready in time" >&2
    tail -n 40 "$LOG" >&2 || true
    exit 1
  fi
  echo "==> SpacetimeDB is ready"
fi

echo "==> Publishing iron-glove module to the local instance"
( cd server && spacetime publish iron-glove --server local -y )

echo "==> start complete"
