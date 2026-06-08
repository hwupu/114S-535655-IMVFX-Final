#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

start_service() {
  local name=$1
  local port=$2
  echo "Starting $name on port $port..."
  bash "$ROOT/services/$name/start.sh" > "$ROOT/logs/${name}.log" 2>&1 &
  echo $! > "$ROOT/logs/${name}.pid"
}

mkdir -p "$ROOT/logs"

start_service instructpix2pix 8001
start_service qwen25vl 8002
start_service grounded_sam 8003
start_service sd2 8004
start_service fakeVLM 8005

echo ""
echo "All services started. Logs in ./logs/"
echo "Run ./scripts/stop_services.sh to stop them."
