#!/usr/bin/env node
/**
 * Entry point for the MCP Browser Bridge Forwarding Server.
 * Forwards Claude Code browser commands to Browserbase.
 *
 * Environment Variables:
 *   BROWSERBASE_API_KEY    - Your Browserbase API key
 *   BROWSERBASE_PROJECT_ID - Your Browserbase project ID
 *   MCP_SOCKET_PATH        - Override the socket path (optional)
 *
 * Usage:
 *   export BROWSERBASE_API_KEY="your-api-key"
 *   export BROWSERBASE_PROJECT_ID="your-project-id"
 *   node index.js
 */

import os from 'node:os';
import { ForwardingServer } from './forwarding-server.js';

function getDefaultSocketPath() {
  const tmpdir = process.env.TMPDIR || '/tmp';
  const logname = process.env.USER || os.userInfo().username;
  return `${tmpdir.replace(/\/$/, '')}/claude-mcp-browser-bridge-${logname}`;
}

async function main() {
  // Check environment variables
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;

  if (!apiKey) {
    console.error('Error: BROWSERBASE_API_KEY environment variable not set');
    process.exit(1);
  }

  if (!projectId) {
    console.error('Error: BROWSERBASE_PROJECT_ID environment variable not set');
    process.exit(1);
  }

  // Get socket path
  const socketPath = process.env.MCP_SOCKET_PATH || getDefaultSocketPath();

  console.log('Starting MCP Browser Bridge Forwarding Server');
  console.log(`  Socket: ${socketPath}`);
  console.log(`  Project: ${projectId}`);
  console.log();

  const server = new ForwardingServer(socketPath);

  // Handle shutdown signals
  const shutdown = async () => {
    console.log('\nShutting down...');
    await server.stop();
    console.log('Server stopped');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await server.start();

    // Keep the process running
    await new Promise(() => {});
  } catch (err) {
    console.error('Server error:', err);
    await server.stop();
    process.exit(1);
  }
}

main();
