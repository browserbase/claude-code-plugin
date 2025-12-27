#!/bin/bash
# Browserbase Session Start Hook
# Loads credentials and starts the MCP Browser Bridge Forwarding Server
# Outputs JSON for Claude Code to display systemMessage to user

# Use CLAUDE_PLUGIN_ROOT if available, otherwise compute from script location
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
    PLUGIN_DIR="$CLAUDE_PLUGIN_ROOT"
    SCRIPT_DIR="$PLUGIN_DIR/scripts"
else
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
fi
CREDENTIALS_FILE="$HOME/.browserbase/credentials"
STATE_DIR="$HOME/.browserbase/state"
PID_FILE="$STATE_DIR/server.pid"
DEBUG_LOG="$STATE_DIR/hook-debug.log"

# Create state directory
mkdir -p "$STATE_DIR"

# Debug: Log that hook was called
echo "[$(date)] SessionStart hook called" >> "$DEBUG_LOG"

# Helper function to output JSON result
output_json() {
    local context="$1"
    local message="$2"

    # Escape special characters for JSON
    context=$(echo "$context" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ')
    message=$(echo "$message" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ')

    cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "$context"
  },
  "systemMessage": "$message"
}
EOF
}

# Check if configured by running setup.sh (non-interactive check)
if ! "$SCRIPT_DIR/setup.sh" 2>/dev/null; then
    echo "[$(date)] Not configured" >> "$DEBUG_LOG"
    output_json \
        "Browserbase plugin is not configured. User needs to run setup." \
        "[Browserbase] Not configured. Run: $PLUGIN_DIR/scripts/setup.sh"
    exit 0
fi

# Load credentials from file or env vars
if [ -n "$BROWSERBASE_API_KEY" ] && [ -n "$BROWSERBASE_PROJECT_ID" ]; then
    api_key="$BROWSERBASE_API_KEY"
    project_id="$BROWSERBASE_PROJECT_ID"
else
    api_key=$(grep -o '"apiKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$CREDENTIALS_FILE" | sed 's/.*"apiKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    project_id=$(grep -o '"projectId"[[:space:]]*:[[:space:]]*"[^"]*"' "$CREDENTIALS_FILE" | sed 's/.*"projectId"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
fi

# Final check
if [ -z "$api_key" ] || [ -z "$project_id" ]; then
    echo "[$(date)] Failed to load credentials" >> "$DEBUG_LOG"
    output_json \
        "Browserbase plugin failed to load credentials." \
        "[Browserbase] Error: Failed to load credentials"
    exit 1
fi

# Persist environment variables to CLAUDE_ENV_FILE so they're available to all commands
if [ -n "$CLAUDE_ENV_FILE" ]; then
    echo "export BROWSERBASE_API_KEY=\"$api_key\"" >> "$CLAUDE_ENV_FILE"
    echo "export BROWSERBASE_PROJECT_ID=\"$project_id\"" >> "$CLAUDE_ENV_FILE"
fi

# Check if Claude in Chrome extension is installed
EXTENSION_ID="fcoeoabgfenejglbffodgkkbkcdhcgfn"
CHROME_DIR="$HOME/Library/Application Support/Google/Chrome"
extension_found=false

if [ -d "$CHROME_DIR" ]; then
    # Check all Chrome profiles for the extension
    for profile_dir in "$CHROME_DIR"/*/Extensions/"$EXTENSION_ID" 2>/dev/null; do
        if [ -d "$profile_dir" ]; then
            extension_found=true
            break
        fi
    done
fi

if [ "$extension_found" = false ]; then
    echo "[$(date)] Chrome extension not found" >> "$DEBUG_LOG"
    output_json \
        "Browserbase plugin requires the Claude in Chrome extension to be installed. The extension intercepts browser commands." \
        "[Browserbase] Error: Claude in Chrome extension not found. Please install it from the Chrome Web Store."
    exit 1
fi

# Check if server is already running
if [ -f "$PID_FILE" ]; then
    old_pid=$(cat "$PID_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
        echo "[$(date)] Server already running (PID: $old_pid)" >> "$DEBUG_LOG"

        # Read debug URL if available
        debug_url=""
        if [ -f "$STATE_DIR/debug_url" ]; then
            debug_url=$(cat "$STATE_DIR/debug_url")
        fi

        context="[Browserbase Plugin Active] All browser automation commands (mcp__claude-in-chrome__*) are being forwarded to Browserbase cloud browsers instead of local Chrome. This provides: (1) Headless cloud browser execution, (2) Session recording and debugging, (3) No local Chrome dependency. When using browser tools, the user can watch the live session at the Browserbase dashboard."

        if [ -n "$debug_url" ]; then
            context="$context Live debug URL: $debug_url"
        fi

        output_json \
            "$context" \
            "[Browserbase] Cloud browser ready (server PID: $old_pid)"
        exit 0
    fi
fi

# Start the forwarding server in background
cd "$PLUGIN_DIR"
BROWSERBASE_API_KEY="$api_key" BROWSERBASE_PROJECT_ID="$project_id" node index.js > "$STATE_DIR/server.log" 2>&1 &
server_pid=$!

# Save PID
echo "$server_pid" > "$PID_FILE"

# Wait a moment for server to start
sleep 1

# Check if server started successfully
if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "[$(date)] Failed to start server" >> "$DEBUG_LOG"
    server_log=$(cat "$STATE_DIR/server.log" 2>/dev/null || echo "No log available")
    output_json \
        "Browserbase forwarding server failed to start. Log: $server_log" \
        "[Browserbase] Error: Failed to start forwarding server"
    exit 1
fi

echo "[$(date)] Server started (PID: $server_pid)" >> "$DEBUG_LOG"

# Read debug URL if available
debug_url=""
if [ -f "$STATE_DIR/debug_url" ]; then
    debug_url=$(cat "$STATE_DIR/debug_url")
fi

# Build context message for Claude
context="[Browserbase Plugin Active] All browser automation commands (mcp__claude-in-chrome__*) are being forwarded to Browserbase cloud browsers instead of local Chrome. This provides: (1) Headless cloud browser execution, (2) Session recording and debugging, (3) No local Chrome dependency. When using browser tools, the user can watch the live session at the Browserbase dashboard."

if [ -n "$debug_url" ]; then
    context="$context Live debug URL: $debug_url"
fi

output_json \
    "$context" \
    "[Browserbase] Browserbase plugin active (server PID: $server_pid)"
