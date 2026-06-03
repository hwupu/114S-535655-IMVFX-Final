#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
exec uv run uvicorn server:app --host 127.0.0.1 --port 8002 --reload
