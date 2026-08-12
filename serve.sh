#!/usr/bin/env bash
# Refresh the data (unless --no-fetch) and serve the site on http://localhost:8899
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8899}"

if [[ "${1:-}" != "--no-fetch" ]]; then
  python3 fetch_data.py
fi

exec python3 serve.py "$PORT"
