#!/usr/bin/env bash
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for pid_file in "$ROOT"/logs/*.pid; do
  [ -f "$pid_file" ] || continue
  pid=$(cat "$pid_file")
  name=$(basename "$pid_file" .pid)
  if kill -0 "$pid" 2>/dev/null; then
    echo "Stopping $name (PID $pid)..."
    kill "$pid"
  fi
  rm -f "$pid_file"
done

echo "All services stopped."
