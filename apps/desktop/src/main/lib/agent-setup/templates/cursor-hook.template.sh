#!/bin/bash
{{MARKER}}
# Called by cursor-agent hooks (beforeSubmitPrompt / stop) to notify Superset of agent lifecycle events

# Drain stdin — Cursor pipes JSON context that we don't need, but we must consume it
# to prevent broken-pipe errors from blocking the agent
cat > /dev/null 2>&1

EVENT_TYPE="$1"

# Only process Start and Stop events
case "$EVENT_TYPE" in
  Start|Stop) ;;
  *) exit 0 ;;
esac

# cursor-agent runs inside a Superset terminal, so env vars are inherited directly
[ -z "$SUPERSET_TAB_ID" ] && exit 0

curl -sG "http://127.0.0.1:${SUPERSET_PORT:-{{DEFAULT_PORT}}}/hook/complete" \
  --connect-timeout 1 --max-time 2 \
  --data-urlencode "paneId=$SUPERSET_PANE_ID" \
  --data-urlencode "tabId=$SUPERSET_TAB_ID" \
  --data-urlencode "workspaceId=$SUPERSET_WORKSPACE_ID" \
  --data-urlencode "eventType=$EVENT_TYPE" \
  --data-urlencode "env=$SUPERSET_ENV" \
  --data-urlencode "version=$SUPERSET_HOOK_VERSION" \
  > /dev/null 2>&1

exit 0
