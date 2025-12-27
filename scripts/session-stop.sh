#!/bin/bash
# Browserbase Session Stop Hook
# Stops the forwarding server and cleans up resources

STATE_DIR="$HOME/.browserbase/state"
PID_FILE="$STATE_DIR/server.pid"
DEBUG_URL_FILE="$STATE_DIR/debug_url"
SESSION_FILE="$STATE_DIR/session_id"
CREDENTIALS_FILE="$HOME/.browserbase/credentials"

# Kill the forwarding server if running
if [ -f "$PID_FILE" ]; then
    server_pid=$(cat "$PID_FILE")
    if kill -0 "$server_pid" 2>/dev/null; then
        echo "Stopping Browserbase forwarding server (PID: $server_pid)..."
        kill "$server_pid" 2>/dev/null

        # Wait for graceful shutdown
        for i in {1..5}; do
            if ! kill -0 "$server_pid" 2>/dev/null; then
                break
            fi
            sleep 1
        done

        # Force kill if still running
        if kill -0 "$server_pid" 2>/dev/null; then
            kill -9 "$server_pid" 2>/dev/null
        fi
    fi
    rm -f "$PID_FILE"
fi

# Release any active Browserbase sessions via API
if [ -f "$SESSION_FILE" ] && [ -f "$CREDENTIALS_FILE" ]; then
    session_id=$(cat "$SESSION_FILE")
    api_key=$(cat "$CREDENTIALS_FILE" | grep -o '"apiKey"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"apiKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    project_id=$(cat "$CREDENTIALS_FILE" | grep -o '"projectId"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"projectId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

    if [ -n "$session_id" ] && [ -n "$api_key" ] && [ -n "$project_id" ]; then
        echo "Releasing Browserbase session: $session_id"
        curl -s -X POST \
            "https://api.browserbase.com/v1/sessions/$session_id" \
            -H "X-BB-API-Key: $api_key" \
            -H "Content-Type: application/json" \
            -d "{\"status\": \"REQUEST_RELEASE\", \"projectId\": \"$project_id\"}" \
            > /dev/null 2>&1
    fi
fi

# Clean up state files
rm -f "$DEBUG_URL_FILE" "$SESSION_FILE"

echo "Browserbase session cleanup complete"
