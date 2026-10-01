#!/bin/sh
# Start the Brain Dashboard and open it in the browser.
cd "$(dirname "$0")"
PORT="${PORT:-4747}"
if curl -s -o /dev/null "http://localhost:$PORT/"; then
  echo "Already running on http://localhost:$PORT"
  open "http://localhost:$PORT"
  exit 0
fi
(sleep 1 && open "http://localhost:$PORT") &
exec python3 server.py
