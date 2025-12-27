#!/bin/bash
# Browserbase Plugin Setup Script
# Configures API credentials for the Browserbase Claude plugin

set -e

CREDENTIALS_DIR="$HOME/.browserbase"
CREDENTIALS_FILE="$CREDENTIALS_DIR/credentials"

# Create credentials directory if it doesn't exist
mkdir -p "$CREDENTIALS_DIR"

# Check if we're running interactively (TTY available)
if [ ! -t 0 ]; then
    # Non-interactive mode (called from hook)
    # Just check if credentials exist and exit with appropriate code
    if [ -f "$CREDENTIALS_FILE" ]; then
        # Credentials exist, exit success
        exit 0
    else
        # No credentials, exit with error
        exit 1
    fi
fi

# Interactive mode - proceed with setup
echo "==================================="
echo "Browserbase Plugin Setup"
echo "==================================="
echo ""

# Check if credentials already exist
if [ -f "$CREDENTIALS_FILE" ]; then
    echo "Existing credentials found at $CREDENTIALS_FILE"
    read -p "Do you want to overwrite them? (y/N): " overwrite
    if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
        echo "Setup cancelled."
        exit 0
    fi
fi

# Prompt for API key
echo ""
read -p "Enter your Browserbase API Key: " api_key

if [ -z "$api_key" ]; then
    echo "Error: API key cannot be empty"
    exit 1
fi

# Prompt for project ID
echo ""
read -p "Enter your Browserbase Project ID: " project_id

if [ -z "$project_id" ]; then
    echo "Error: Project ID cannot be empty"
    exit 1
fi

# Validate credentials by making a test API call
echo ""
echo "Validating credentials..."

response=$(curl -s -w "\n%{http_code}" -X GET \
    "https://api.browserbase.com/v1/projects/$project_id" \
    -H "X-BB-API-Key: $api_key" \
    -H "Content-Type: application/json")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" != "200" ]; then
    echo "Error: Failed to validate credentials (HTTP $http_code)"
    echo "Please check your API key and project ID"
    exit 1
fi

echo "Credentials validated successfully!"

# Save credentials
cat > "$CREDENTIALS_FILE" << EOF
{
  "apiKey": "$api_key",
  "projectId": "$project_id"
}
EOF

chmod 600 "$CREDENTIALS_FILE"

echo ""
echo "==================================="
echo "Setup complete!"
echo "==================================="
echo ""
echo "Credentials saved to: $CREDENTIALS_FILE"
echo ""
echo "On each session start, credentials will be automatically loaded"
echo "and persisted to CLAUDE_ENV_FILE for all commands to use."
echo ""
echo "To use the plugin:"
echo "  1. Copy this plugin folder to ~/.claude/plugins/browserbase/"
echo "  2. Restart Claude Code"
echo ""
echo "Alternative: You can also set environment variables directly:"
echo "  export BROWSERBASE_API_KEY=\"$api_key\""
echo "  export BROWSERBASE_PROJECT_ID=\"$project_id\""
echo ""
