#!/bin/bash
# Browserbase Browser Tool Log Hook
# Outputs the live debug URL when navigate tool is called

STATE_DIR="$HOME/.browserbase/state"
DEBUG_URL_FILE="$STATE_DIR/debug_url"

# Check if debug URL file exists
if [ -f "$DEBUG_URL_FILE" ]; then
    debug_url=$(cat "$DEBUG_URL_FILE")
    if [ -n "$debug_url" ]; then
        # Output JSON with systemMessage to show to user
        cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse"
  },
  "systemMessage": "[Browserbase] Watch live at: \n$debug_url"
}
EOF
        exit 0
    fi
fi

# No debug URL available, just allow the tool to proceed
exit 0
