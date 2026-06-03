#!/usr/bin/env bash
# Run from project root or frontend/ — cwd is pinned to frontend/ so ../workspace resolves correctly.
cd "$(dirname "$0")"
exec npm run dev
