#!/bin/bash
{{MARKER}}
# Called by Cursor hooks (beforeSubmitPrompt / stop) to notify Superset of agent lifecycle events

# Drain stdin — Cursor pipes JSON context that we don't need, but we must consume it
# to prevent broken-pipe errors from blocking Cursor
cat > /dev/null 2>&1

EVENT_TYPE="$1"

# Only process Start and Stop events
case "$EVENT_TYPE" in
  Start|Stop) ;;
  *) exit 0 ;;
esac

# --- Context resolution ---
# Fast path: env vars set by the Superset terminal (cursor wrapper wrote session file,
# but if Cursor was launched FROM a Superset terminal the env vars are already present)
PANE_ID="$SUPERSET_PANE_ID"
TAB_ID="$SUPERSET_TAB_ID"
WORKSPACE_ID="$SUPERSET_WORKSPACE_ID"
PORT="${SUPERSET_PORT:-{{DEFAULT_PORT}}}"
ENV_VAL="$SUPERSET_ENV"

# Slow path: read from session file written by the cursor wrapper
if [ -z "$TAB_ID" ]; then
  # Cursor sets CURSOR_WORKSPACE to the project root
  PROJECT_DIR="${CURSOR_WORKSPACE:-}"
  if [ -z "$PROJECT_DIR" ]; then
    exit 0
  fi

  # Hash the project path to find the session file (must match wrapper's hashing)
  PROJECT_HASH=$(printf '%s' "$PROJECT_DIR" | shasum -a 256 | cut -d' ' -f1)
  SESSION_FILE="{{SESSIONS_DIR}}/${PROJECT_HASH}"

  if [ ! -f "$SESSION_FILE" ]; then
    exit 0
  fi

  # Source the session file (sets SUPERSET_PANE_ID, SUPERSET_TAB_ID, etc.)
  . "$SESSION_FILE"
  PANE_ID="$SUPERSET_PANE_ID"
  TAB_ID="$SUPERSET_TAB_ID"
  WORKSPACE_ID="$SUPERSET_WORKSPACE_ID"
  PORT="${SUPERSET_PORT:-{{DEFAULT_PORT}}}"
  ENV_VAL="$SUPERSET_ENV"
fi

# Still no context — nothing to notify
[ -z "$TAB_ID" ] && exit 0

curl -sG "http://127.0.0.1:${PORT}/hook/complete" \
  --connect-timeout 1 --max-time 2 \
  --data-urlencode "paneId=$PANE_ID" \
  --data-urlencode "tabId=$TAB_ID" \
  --data-urlencode "workspaceId=$WORKSPACE_ID" \
  --data-urlencode "eventType=$EVENT_TYPE" \
  --data-urlencode "env=$ENV_VAL" \
  > /dev/null 2>&1

exit 0
