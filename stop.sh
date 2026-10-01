#!/bin/sh
# Stop the Brain Dashboard server (started by start.sh or Brain.app).
PORT="${PORT:-4747}"
PIDS=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN)
if [ -n "$PIDS" ]; then
  kill $PIDS && echo "Stopped the dashboard server."
else
  echo "Not running."
fi
