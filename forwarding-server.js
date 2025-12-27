/**
 * Forwarding server that intercepts Claude Code MCP browser commands
 * and forwards them to Browserbase.
 */

import net from 'node:net';
import fs from 'node:fs';
import { getClient } from './browserbase-client.js';

class ForwardingServer {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.backupPath = socketPath + '.backup';
    this.server = null;
    this.client = null;
    this.tabGroupId = Math.floor(Math.random() * 900000000) + 100000000;
    this.hadExistingSocket = false;
    this._stopping = false;
  }

  async start() {
    // Backup existing socket if present
    if (fs.existsSync(this.socketPath)) {
      this.hadExistingSocket = true;
      if (fs.existsSync(this.backupPath)) {
        fs.unlinkSync(this.backupPath);
      }
      fs.renameSync(this.socketPath, this.backupPath);
      console.log(`Backed up existing socket to ${this.backupPath}`);
    }

    this.client = getClient();

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', reject);

      this.server.listen(this.socketPath, () => {
        // Set socket permissions
        fs.chmodSync(this.socketPath, 0o600);
        console.log(`Forwarding server listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  handleConnection(socket) {
    console.log('Client connected');

    let buffer = Buffer.alloc(0);

    socket.on('data', async (data) => {
      buffer = Buffer.concat([buffer, data]);

      // Process complete messages
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);

        if (buffer.length < 4 + length) {
          // Wait for more data
          break;
        }

        const payloadBytes = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);

        try {
          const payload = JSON.parse(payloadBytes.toString('utf-8'));
          console.log(`Received: ${JSON.stringify(payload).substring(0, 200)}...`);

          // Process the command
          const response = await this.processCommand(payload);

          // Send response
          const responseBytes = Buffer.from(JSON.stringify(response), 'utf-8');
          const responseLength = Buffer.alloc(4);
          responseLength.writeUInt32LE(responseBytes.length, 0);

          socket.write(Buffer.concat([responseLength, responseBytes]));
        } catch (err) {
          console.error('Error processing message:', err);
        }
      }
    });

    socket.on('close', () => {
      console.log('Client disconnected');
    });

    socket.on('error', (err) => {
      console.error('Socket error:', err.message);
    });
  }

  async processCommand(payload) {
    const method = payload.method;
    const params = payload.params || {};

    if (method !== 'execute_tool') {
      return { error: { message: `Unknown method: ${method}` } };
    }

    const tool = params.tool;
    const args = params.args || {};

    try {
      switch (tool) {
        case 'tabs_context_mcp':
          return await this.handleTabsContext(args);
        case 'tabs_create_mcp':
          return await this.handleTabsCreate(args);
        case 'navigate':
          return await this.handleNavigate(args);
        case 'computer':
          return await this.handleComputer(args);
        case 'read_page':
          return await this.handleReadPage(args);
        case 'find':
          return await this.handleFind(args);
        case 'get_page_text':
          return await this.handleGetPageText(args);
        case 'form_input':
          return await this.handleFormInput(args);
        case 'javascript_tool':
          return await this.handleJavaScript(args);
        case 'resize_window':
          return await this.handleResizeWindow(args);
        case 'update_plan':
          return await this.handleUpdatePlan(args);
        case 'upload_image':
          return await this.handleUploadImage(args);
        case 'read_console_messages':
          return await this.handleReadConsoleMessages(args);
        case 'read_network_requests':
          return await this.handleReadNetworkRequests(args);
        case 'gif_creator':
          return await this.handleGifCreator(args);
        case 'shortcuts_list':
          return await this.handleShortcutsList(args);
        case 'shortcuts_execute':
          return await this.handleShortcutsExecute(args);
        default:
          return { error: { message: `Unsupported tool: ${tool}` } };
      }
    } catch (err) {
      console.error(`Error processing ${tool}:`, err);
      return { error: { message: err.message } };
    }
  }

  async handleTabsContext(args) {
    const createIfEmpty = args.createIfEmpty || false;

    let tabs = this.client.getAvailableTabs();

    if (tabs.length === 0 && createIfEmpty) {
      // Create a new session
      const [tabId, sessionInfo] = await this.client.createSession();
      tabs = [
        {
          tabId,
          title: 'New Tab',
          url: 'about:blank',
        },
      ];
    }

    // Format response
    const tabsJson = JSON.stringify({
      availableTabs: tabs,
      tabGroupId: this.tabGroupId,
    });

    let tabsText = '\n\nTab Context:\n- Available tabs:\n';
    for (const tab of tabs) {
      tabsText += `  - tabId ${tab.tabId}: "${tab.title}" (${tab.url})\n`;
    }

    return {
      result: {
        content: [
          { type: 'text', text: tabsJson },
          { type: 'text', text: tabsText },
        ],
      },
    };
  }

  async handleNavigate(args) {
    const url = args.url;
    const tabId = args.tabId;

    if (!url || !tabId) {
      return { error: { message: 'url and tabId required' } };
    }

    const message = await this.client.navigate(tabId, url);

    // Update stored URL
    const session = this.client.sessions.get(tabId);
    if (session) {
      session.current_url = url;
    }

    const tabs = this.client.getAvailableTabs();
    let tabsText = `\n\nTab Context:\n- Executed on tabId: ${tabId}\n- Available tabs:\n`;
    for (const tab of tabs) {
      tabsText += `  - tabId ${tab.tabId}: "${tab.title}" (${tab.url})\n`;
    }

    return {
      result: {
        content: [
          { type: 'text', text: message },
          { type: 'text', text: tabsText },
        ],
      },
    };
  }

  async handleComputer(args) {
    const action = args.action;
    const tabId = args.tabId;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    const getTabContext = async () => {
      const [url, title] = await this.client.getPageUrl(tabId);
      let tabsText = `\n\nTab Context:\n- Executed on tabId: ${tabId}\n- Available tabs:\n`;
      tabsText += `  - tabId ${tabId}: "${title}" (${url})\n`;
      return tabsText;
    };

    switch (action) {
      case 'screenshot': {
        const [data, width, height] = await this.client.screenshot(tabId);
        const tabsText = await getTabContext();

        return {
          result: {
            content: [
              { type: 'text', text: `Successfully captured screenshot (${width}x${height}, jpeg)` },
              { type: 'text', text: tabsText },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data,
                },
              },
            ],
          },
        };
      }

      case 'wait': {
        const duration = Math.min(args.duration || 1, 30);
        await new Promise((resolve) => setTimeout(resolve, duration * 1000));
        return {
          result: {
            content: [{ type: 'text', text: `Waited ${duration} seconds` }],
          },
        };
      }

      case 'left_click': {
        const [x, y] = args.coordinate || [];
        if (x === undefined || y === undefined) {
          return { error: { message: 'coordinate [x, y] required for left_click' } };
        }
        const message = await this.client.click(tabId, x, y, 'left', 1);
        const tabsText = await getTabContext();
        return {
          result: {
            content: [
              { type: 'text', text: message },
              { type: 'text', text: tabsText },
            ],
          },
        };
      }

      case 'right_click': {
        const [x, y] = args.coordinate || [];
        if (x === undefined || y === undefined) {
          return { error: { message: 'coordinate [x, y] required for right_click' } };
        }
        const message = await this.client.rightClick(tabId, x, y);
        const tabsText = await getTabContext();
        return {
          result: {
            content: [
              { type: 'text', text: message },
              { type: 'text', text: tabsText },
            ],
          },
        };
      }

      case 'double_click': {
        const [x, y] = args.coordinate || [];
        if (x === undefined || y === undefined) {
          return { error: { message: 'coordinate [x, y] required for double_click' } };
        }
        const message = await this.client.doubleClick(tabId, x, y);
        const tabsText = await getTabContext();
        return {
          result: {
            content: [
              { type: 'text', text: message },
              { type: 'text', text: tabsText },
            ],
          },
        };
      }

      case 'triple_click': {
        const [x, y] = args.coordinate || [];
        if (x === undefined || y === undefined) {
          return { error: { message: 'coordinate [x, y] required for triple_click' } };
        }
        const message = await this.client.tripleClick(tabId, x, y);
        const tabsText = await getTabContext();
        return {
          result: {
            content: [
              { type: 'text', text: message },
              { type: 'text', text: tabsText },
            ],
          },
        };
      }

      case 'hover': {
        const [x, y] = args.coordinate || [];
        if (x === undefined || y === undefined) {
          return { error: { message: 'coordinate [x, y] required for hover' } };
        }
        const message = await this.client.hover(tabId, x, y);
        const tabsText = await getTabContext();
        return {
          result: {
            content: [
              { type: 'text', text: message },
              { type: 'text', text: tabsText },
            ],
          },
        };
      }

      case 'left_click_drag': {
        const [startX, startY] = args.start_coordinate || [];
        const [endX, endY] = args.coordinate || [];
        if (startX === undefined || startY === undefined) {
          return { error: { message: 'start_coordinate [x, y] required for left_click_drag' } };
        }
        if (endX === undefined || endY === undefined) {
          return { error: { message: 'coordinate [x, y] required for left_click_drag' } };
        }
        const message = await this.client.drag(tabId, startX, startY, endX, endY);
        const tabsText = await getTabContext();
        return {
          result: {
            content: [
              { type: 'text', text: message },
              { type: 'text', text: tabsText },
            ],
          },
        };
      }

      case 'type': {
        const text = args.text;
        if (!text) {
          return { error: { message: 'text required for type action' } };
        }
        const message = await this.client.type(tabId, text);
        const tabsText = await getTabContext();
        return {
          result: {
            content: [
              { type: 'text', text: message },
              { type: 'text', text: tabsText },
            ],
          },
        };
      }

      case 'key': {
        const text = args.text;
        if (!text) {
          return { error: { message: 'text (key name) required for key action' } };
        }

        // Parse key string - supports modifiers like "ctrl+a" or "cmd+shift+s"
        const repeat = args.repeat || 1;
        const keys = text.split(' ').filter(k => k);

        let resultMessages = [];
        for (let i = 0; i < repeat; i++) {
          for (const keyCombo of keys) {
            const parts = keyCombo.toLowerCase().split('+');
            const key = parts.pop();
            const modifiers = parts;

            // Normalize key names
            const normalizedKey = this.normalizeKeyName(key);
            const message = await this.client.pressKey(tabId, normalizedKey, modifiers);
            resultMessages.push(message);
          }
        }

        const tabsText = await getTabContext();
        return {
          result: {
            content: [
              { type: 'text', text: resultMessages.join(', ') },
              { type: 'text', text: tabsText },
            ],
          },
        };
      }

      case 'scroll': {
        const [x, y] = args.coordinate || [0, 0];
        const direction = args.scroll_direction;
        const amount = args.scroll_amount || 3;

        if (!direction) {
          return { error: { message: 'scroll_direction required for scroll action' } };
        }

        const message = await this.client.scroll(tabId, x, y, direction, amount);
        const tabsText = await getTabContext();
        return {
          result: {
            content: [
              { type: 'text', text: message },
              { type: 'text', text: tabsText },
            ],
          },
        };
      }

      case 'scroll_to': {
        const ref = args.ref;
        if (!ref) {
          return { error: { message: 'ref required for scroll_to action' } };
        }

        // Use JavaScript to scroll element into view
        const script = `
          (function() {
            const element = window.__claudeElementMap && window.__claudeElementMap['${ref}']?.deref();
            if (!element) return { success: false, error: 'Element not found' };
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return { success: true };
          })()
        `;
        await this.client.executeScript(tabId, script);
        const tabsText = await getTabContext();
        return {
          result: {
            content: [
              { type: 'text', text: `Scrolled element ${ref} into view` },
              { type: 'text', text: tabsText },
            ],
          },
        };
      }

      case 'zoom': {
        const region = args.region;
        if (!region || region.length !== 4) {
          return { error: { message: 'region [x0, y0, x1, y1] required for zoom action' } };
        }

        const [x0, y0, x1, y1] = region;
        const [data, width, height] = await this.client.screenshotRegion(tabId, x0, y0, x1, y1);
        const tabsText = await getTabContext();

        return {
          result: {
            content: [
              { type: 'text', text: `Captured zoomed region (${width}x${height}, jpeg)` },
              { type: 'text', text: tabsText },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data,
                },
              },
            ],
          },
        };
      }

      default:
        return { error: { message: `Unsupported computer action: ${action}` } };
    }
  }

  normalizeKeyName(key) {
    const keyMap = {
      'enter': 'Enter',
      'return': 'Enter',
      'backspace': 'Backspace',
      'delete': 'Delete',
      'tab': 'Tab',
      'escape': 'Escape',
      'esc': 'Escape',
      'up': 'ArrowUp',
      'down': 'ArrowDown',
      'left': 'ArrowLeft',
      'right': 'ArrowRight',
      'arrowup': 'ArrowUp',
      'arrowdown': 'ArrowDown',
      'arrowleft': 'ArrowLeft',
      'arrowright': 'ArrowRight',
      'home': 'Home',
      'end': 'End',
      'pageup': 'PageUp',
      'pagedown': 'PageDown',
      'space': ' ',
    };
    return keyMap[key.toLowerCase()] || key;
  }

  async handleReadPage(args) {
    const tabId = args.tabId;
    const depth = args.depth || 15;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    const tree = await this.client.getAccessibilityTree(tabId, depth);

    // The aria_snapshot returns a string in Playwright
    let treeText;
    if (typeof tree.nodes === 'string') {
      treeText = `Accessibility tree:\n${tree.nodes}`;
    } else {
      // Handle if it returns an object/array
      const nodes = tree.nodes || [];
      if (Array.isArray(nodes) && nodes.length > 0) {
        treeText = `Accessibility tree (${nodes.length} nodes):\n`;
        for (const node of nodes.slice(0, 50)) {
          const role = node.role?.value || '';
          const name = node.name?.value || '';
          if (role || name) {
            treeText += `  ${role}: ${name}\n`;
          }
        }
      } else {
        treeText = `Accessibility tree:\n${JSON.stringify(nodes, null, 2)}`;
      }
    }

    return {
      result: {
        content: [{ type: 'text', text: treeText }],
      },
    };
  }

  async handleFind(args) {
    const query = args.query;
    const tabId = args.tabId;

    if (!tabId || !query) {
      return { error: { message: 'tabId and query required' } };
    }

    // Use accessibility tree to find elements
    const tree = await this.client.getAccessibilityTree(tabId);
    const nodes = tree.nodes || [];

    const matches = [];
    const queryLower = query.toLowerCase();

    // Handle string snapshot (Playwright's ariaSnapshot returns a string)
    if (typeof nodes === 'string') {
      const lines = nodes.split('\n');
      for (const line of lines) {
        if (line.toLowerCase().includes(queryLower)) {
          matches.push(line.trim());
        }
      }
    } else if (Array.isArray(nodes)) {
      for (const node of nodes) {
        const name = node.name?.value || '';
        const role = node.role?.value || '';
        if (name.toLowerCase().includes(queryLower) || role.toLowerCase().includes(queryLower)) {
          matches.push({
            role,
            name,
            nodeId: node.nodeId,
          });
        }
      }
    }

    let resultText = `Found ${matches.length} matches for '${query}':\n`;
    for (const match of matches.slice(0, 20)) {
      if (typeof match === 'string') {
        resultText += `  - ${match}\n`;
      } else {
        resultText += `  - ${match.role}: ${match.name}\n`;
      }
    }

    return {
      result: {
        content: [{ type: 'text', text: resultText }],
      },
    };
  }

  async handleGetPageText(args) {
    const tabId = args.tabId;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    const text = await this.client.getPageText(tabId);

    return {
      result: {
        content: [{ type: 'text', text: text.substring(0, 10000) }],
      },
    };
  }

  async handleTabsCreate(args) {
    // Create a new tab by creating a new session
    const tabId = Date.now();

    // Initialize a new Browserbase session
    await this.client.initSession(tabId);

    // Navigate to about:blank initially
    await this.client.navigate(tabId, 'about:blank');

    return {
      result: {
        content: [
          {
            type: 'text',
            text: `Created new tab with tabId: ${tabId}`,
          },
        ],
      },
    };
  }

  async handleFormInput(args) {
    const tabId = args.tabId;
    const ref = args.ref;
    const value = args.value;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    if (!ref) {
      return { error: { message: 'ref (element reference) required' } };
    }

    if (value === undefined) {
      return { error: { message: 'value required' } };
    }

    // Use JavaScript to set the form value based on element reference
    const script = `
      (function() {
        const element = window.__claudeElementMap && window.__claudeElementMap['${ref}']?.deref();
        if (!element) return { success: false, error: 'Element not found for ref: ${ref}' };

        if (element.tagName === 'SELECT') {
          element.value = ${JSON.stringify(String(value))};
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (element.type === 'checkbox' || element.type === 'radio') {
          element.checked = ${Boolean(value)};
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          element.focus();
          element.value = ${JSON.stringify(String(value))};
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { success: true };
      })()
    `;

    const result = await this.client.executeScript(tabId, script);

    if (result && !result.success) {
      return { error: { message: result.error || 'Failed to set form value' } };
    }

    return {
      result: {
        content: [{ type: 'text', text: `Set value for element ${ref} to: ${value}` }],
      },
    };
  }

  async handleJavaScript(args) {
    const tabId = args.tabId;
    const script = args.text;
    const action = args.action;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    if (action !== 'javascript_exec') {
      return { error: { message: "action must be 'javascript_exec'" } };
    }

    if (!script) {
      return { error: { message: 'text (JavaScript code) required' } };
    }

    try {
      const result = await this.client.executeScript(tabId, script);
      const resultText = result === undefined ? 'undefined' : JSON.stringify(result, null, 2);

      return {
        result: {
          content: [{ type: 'text', text: `Result: ${resultText}` }],
        },
      };
    } catch (err) {
      return {
        result: {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
        },
      };
    }
  }

  async handleResizeWindow(args) {
    const tabId = args.tabId;
    const width = args.width;
    const height = args.height;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    if (!width || !height) {
      return { error: { message: 'width and height required' } };
    }

    const message = await this.client.setViewportSize(tabId, width, height);

    return {
      result: {
        content: [{ type: 'text', text: message }],
      },
    };
  }

  async handleUpdatePlan(args) {
    const domains = args.domains || [];
    const approach = args.approach || [];

    // In this implementation, we simply acknowledge the plan
    // The actual plan approval would be handled by the MCP client
    let planText = 'Plan submitted for approval:\n\n';
    planText += `Domains: ${domains.join(', ')}\n\n`;
    planText += 'Approach:\n';
    for (const step of approach) {
      planText += `  - ${step}\n`;
    }

    return {
      result: {
        content: [{ type: 'text', text: planText }],
      },
    };
  }

  async handleUploadImage(args) {
    const tabId = args.tabId;
    const imageId = args.imageId;
    const ref = args.ref;
    const coordinate = args.coordinate;
    const filename = args.filename || 'image.png';

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    if (!imageId) {
      return { error: { message: 'imageId required' } };
    }

    // For now, this is a placeholder - actual implementation would need
    // access to stored screenshots and file upload via CDP
    return {
      result: {
        content: [
          {
            type: 'text',
            text: `Upload image feature requires image storage. imageId: ${imageId}, target: ${ref || coordinate}`,
          },
        ],
      },
    };
  }

  async handleReadConsoleMessages(args) {
    const tabId = args.tabId;
    const pattern = args.pattern;
    const limit = args.limit || 100;
    const onlyErrors = args.onlyErrors || false;
    const clear = args.clear || false;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    // Get messages from the client's storage
    const messages = this.client.consoleMessages?.get(tabId) || [];
    let filtered = messages;

    // Filter by errors only
    if (onlyErrors) {
      filtered = filtered.filter((m) => m.type === 'error' || m.type === 'exception');
    }

    // Filter by pattern
    if (pattern) {
      const regex = new RegExp(pattern, 'i');
      filtered = filtered.filter((m) => regex.test(m.text));
    }

    // Apply limit
    filtered = filtered.slice(-limit);

    // Clear if requested
    if (clear && this.client.consoleMessages) {
      this.client.consoleMessages.set(tabId, []);
    }

    let resultText = `Console messages (${filtered.length}):\n`;
    for (const msg of filtered) {
      resultText += `[${msg.type}] ${msg.text}\n`;
    }

    return {
      result: {
        content: [{ type: 'text', text: resultText }],
      },
    };
  }

  async handleReadNetworkRequests(args) {
    const tabId = args.tabId;
    const urlPattern = args.urlPattern;
    const limit = args.limit || 100;
    const clear = args.clear || false;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    // Get requests from the client's storage
    const requests = this.client.networkRequests?.get(tabId) || [];
    let filtered = requests;

    // Filter by URL pattern
    if (urlPattern) {
      filtered = filtered.filter((r) => r.url.includes(urlPattern));
    }

    // Apply limit
    filtered = filtered.slice(-limit);

    // Clear if requested
    if (clear && this.client.networkRequests) {
      this.client.networkRequests.set(tabId, []);
    }

    let resultText = `Network requests (${filtered.length}):\n`;
    for (const req of filtered) {
      resultText += `${req.method} ${req.url} - ${req.status || 'pending'}\n`;
    }

    return {
      result: {
        content: [{ type: 'text', text: resultText }],
      },
    };
  }

  async handleGifCreator(args) {
    const tabId = args.tabId;
    const action = args.action;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    // Initialize GIF recording state
    if (!this.gifRecordings) {
      this.gifRecordings = new Map();
    }

    switch (action) {
      case 'start_recording': {
        this.gifRecordings.set(tabId, { frames: [], recording: true, startTime: Date.now() });
        return {
          result: {
            content: [{ type: 'text', text: 'Started GIF recording. Take screenshots to capture frames.' }],
          },
        };
      }

      case 'stop_recording': {
        const recording = this.gifRecordings.get(tabId);
        if (recording) {
          recording.recording = false;
        }
        return {
          result: {
            content: [
              {
                type: 'text',
                text: `Stopped GIF recording. ${recording?.frames?.length || 0} frames captured.`,
              },
            ],
          },
        };
      }

      case 'export': {
        const recording = this.gifRecordings.get(tabId);
        const filename = args.filename || `recording-${Date.now()}.gif`;

        // In a full implementation, this would use a library like gif-encoder
        // to create an actual GIF from the frames
        return {
          result: {
            content: [
              {
                type: 'text',
                text: `GIF export placeholder. Filename: ${filename}, Frames: ${recording?.frames?.length || 0}. Full GIF encoding would require additional libraries.`,
              },
            ],
          },
        };
      }

      case 'clear': {
        this.gifRecordings.delete(tabId);
        return {
          result: {
            content: [{ type: 'text', text: 'Cleared GIF recording frames.' }],
          },
        };
      }

      default:
        return { error: { message: `Unknown gif_creator action: ${action}` } };
    }
  }

  async handleShortcutsList(args) {
    const tabId = args.tabId;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    // This would return available shortcuts configured in the extension
    // For now, return an empty list
    return {
      result: {
        content: [
          {
            type: 'text',
            text: 'No shortcuts configured. Shortcuts can be added through the extension settings.',
          },
        ],
      },
    };
  }

  async handleShortcutsExecute(args) {
    const tabId = args.tabId;
    const shortcutId = args.shortcutId;
    const command = args.command;

    if (!tabId) {
      return { error: { message: 'tabId required' } };
    }

    if (!shortcutId && !command) {
      return { error: { message: 'shortcutId or command required' } };
    }

    // This would execute a configured shortcut
    // For now, return a placeholder response
    return {
      result: {
        content: [
          {
            type: 'text',
            text: `Shortcut execution placeholder. Shortcut: ${shortcutId || command}`,
          },
        ],
      },
    };
  }

  async stop() {
    if (this._stopping) {
      return;
    }
    this._stopping = true;

    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }

    // Close all Browserbase sessions
    if (this.client) {
      for (const tabId of this.client.sessions.keys()) {
        await this.client.closeSession(tabId);
      }
    }

    // Remove our socket file
    if (fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
    }

    // Restore original socket if we backed one up
    if (this.hadExistingSocket && fs.existsSync(this.backupPath)) {
      fs.renameSync(this.backupPath, this.socketPath);
      console.log('Restored original socket from backup');
    }
  }
}

export { ForwardingServer };
