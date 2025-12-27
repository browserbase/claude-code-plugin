# Browserbase Plugin for Claude Code

Use [Browserbase](https://browserbase.com) cloud browsers with Claude Code instead of local Chrome.

## What it does

This plugin intercepts Claude Code's browser automation commands (`mcp__claude-in-chrome__*`) and forwards them to Browserbase's cloud browser infrastructure. This gives you:

- **Headless cloud browser execution** - No need to have Chrome open locally
- **Session recording and debugging** - Watch Claude browse in real-time via debug URLs
- **Scalable browser automation** - Cloud browsers with built-in proxy and stealth capabilities

## Requirements

- [Claude Code](https://claude.com/claude-code) CLI
- [Claude in Chrome](https://chromewebstore.google.com/detail/claude-in-chrome/fcoeoabgfenejglbffodgkkbkcdhcgfn) extension installed
- [Browserbase](https://browserbase.com) account with API key
- Node.js 18+

## Installation

### From Browserbase Marketplace

First, add the Browserbase plugin marketplace to Claude Code:

```bash
claude marketplace add https://marketplace.browserbase.com/plugins
```

Then install the plugin:

```bash
claude plugin install browserbase
```

### Manual Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/browserbase/claude-code-plugin.git
   ```

2. Copy to your Claude plugins directory:
   ```bash
   cp -r claude-code-plugin ~/.claude/plugins/browserbase
   ```

3. Install dependencies:
   ```bash
   cd ~/.claude/plugins/browserbase
   npm install
   ```

## Setup

Run the setup script to configure your Browserbase credentials:

```bash
~/.claude/plugins/browserbase/scripts/setup.sh
```

You'll be prompted for:
- **Browserbase API Key** - Get this from [browserbase.com/settings](https://www.browserbase.com/settings)
- **Project ID** - Find this in your Browserbase dashboard

Credentials are stored in `~/.browserbase/credentials`.

### Alternative: Environment Variables

You can also set credentials via environment variables:

```bash
export BROWSERBASE_API_KEY="your-api-key"
export BROWSERBASE_PROJECT_ID="your-project-id"
```

## Usage

Once installed and configured, just use Claude Code normally. The plugin automatically:

1. **On session start**: Launches a cloud browser and starts the forwarding server
2. **On browser commands**: Forwards all `mcp__claude-in-chrome__*` commands to Browserbase
3. **On navigation**: Shows you the live debug URL to watch the browser
4. **On session end**: Cleans up the browser session

### Example

```
$ claude

> Navigate to github.com and take a screenshot

[Browserbase] Cloud browser ready (server PID: 12345)
[Browserbase] Watch live at: https://www.browserbase.com/sessions/abc123/debug

I'll navigate to GitHub and capture a screenshot...
```

## How it works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Claude Code   │────▶│ Forwarding Server│────▶│   Browserbase   │
│                 │     │  (Unix Socket)   │     │  Cloud Browser  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                                                │
         │              ┌──────────────────┐              │
         └─────────────▶│ Claude in Chrome │◀─────────────┘
                        │    Extension     │   (CDP over WebSocket)
                        └──────────────────┘
```

1. Claude Code sends browser commands via the MCP browser bridge socket
2. The forwarding server intercepts these commands
3. Commands are translated to CDP (Chrome DevTools Protocol) and sent to Browserbase
4. Browserbase executes commands on a cloud browser
5. Results are returned through the same path

## Plugin Structure

```
browserbase/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest
├── hooks/
│   └── hooks.json           # Hook configuration
├── scripts/
│   ├── setup.sh             # Credential setup
│   ├── session-start.sh     # Starts forwarding server
│   ├── session-stop.sh      # Cleanup on session end
│   └── browser-tool-log.sh  # Shows debug URL on navigate
├── index.js                 # Entry point
├── forwarding-server.js     # Socket interception & forwarding
├── browserbase-client.js    # Browserbase API & CDP client
└── package.json
```

## Troubleshooting

### "Claude in Chrome extension not found"

The plugin requires the Claude in Chrome extension to be installed, even though commands are forwarded to Browserbase. Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/claude-in-chrome/fcoeoabgfenejglbffodgkkbkcdhcgfn).

### "Failed to load credentials"

Run the setup script again:
```bash
~/.claude/plugins/browserbase/scripts/setup.sh
```

### Server won't start

Check the server logs:
```bash
cat ~/.browserbase/state/server.log
```

### Debug hook execution

Check the hook debug log:
```bash
cat ~/.browserbase/state/hook-debug.log
```

## Development

To test the plugin during development:

```bash
claude --plugin-dir /path/to/browserbase-plugin
```

## License

MIT

## Links

- [Browserbase](https://browserbase.com)
- [Claude Code](https://claude.com/claude-code)
- [Claude in Chrome Extension](https://chromewebstore.google.com/detail/claude-in-chrome/fcoeoabgfenejglbffodgkkbkcdhcgfn)
