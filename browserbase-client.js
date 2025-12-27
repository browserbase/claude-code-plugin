/**
 * Browserbase client using raw CDP (Chrome DevTools Protocol).
 * Uses ws package for WebSocket (Node.js 18 compatibility).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const BROWSERBASE_API_URL = 'https://api.browserbase.com';
const STATE_DIR = path.join(os.homedir(), '.browserbase', 'state');

class CDPConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.messageId = 1;
    this.pendingMessages = new Map();
    this.eventListeners = new Map(); // CDP event listeners
    this.sessionId = null; // Target session ID for page
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => reject(err));
      this.ws.on('message', (data) => {
        // ws package sends Buffer or string, convert to string
        const str = typeof data === 'string' ? data : data.toString();
        this._handleMessage(str);
      });
    });
  }

  _handleMessage(data) {
    const message = JSON.parse(data);

    // Handle response to a request
    if (message.id && this.pendingMessages.has(message.id)) {
      const { resolve, reject } = this.pendingMessages.get(message.id);
      this.pendingMessages.delete(message.id);

      if (message.error) {
        reject(new Error(`CDP error: ${message.error.message}`));
      } else {
        resolve(message.result);
      }
    }

    // Handle CDP events (e.g., Runtime.consoleAPICalled)
    if (message.method) {
      const listeners = this.eventListeners.get(message.method) || [];
      for (const listener of listeners) {
        try {
          listener(message.params);
        } catch (err) {
          console.error(`Error in CDP event listener for ${message.method}:`, err);
        }
      }
    }
  }

  /**
   * Register a listener for a CDP event.
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
  }

  async send(method, params = {}, sessionId = null) {
    const id = this.messageId++;
    const message = { id, method, params };

    if (sessionId) {
      message.sessionId = sessionId;
    }

    return new Promise((resolve, reject) => {
      this.pendingMessages.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(message));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingMessages.has(id)) {
          this.pendingMessages.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }
      }, 30000);
    });
  }

  async close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

class BrowserbaseClient {
  constructor(apiKey, projectId) {
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.sessions = new Map(); // tab_id -> session info
    this.cdpConnections = new Map(); // tab_id -> CDPConnection
    this.targetSessionIds = new Map(); // tab_id -> page session ID
    this.nextTabId = 1000000000;
  }

  _getHeaders() {
    return {
      'X-BB-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  async _apiRequest(method, path, data = null) {
    const url = `${BROWSERBASE_API_URL}${path}`;
    const options = {
      method,
      headers: this._getHeaders(),
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`API error ${response.status}: ${errorBody}`);
    }

    return response.json();
  }

  async createSession() {
    // Create session via API with keepAlive and 6 hour timeout
    const sessionData = await this._apiRequest('POST', '/v1/sessions', {
      projectId: this.projectId,
      keepAlive: true,
      timeout: 21600, // 6 hours in seconds
    });

    const tabId = this.nextTabId;
    this.nextTabId += 1;

    const connectUrl = sessionData.connectUrl;

    // Get debug URL from separate endpoint
    const debugData = await this._apiRequest('GET', `/v1/sessions/${sessionData.id}/debug`);

    this.sessions.set(tabId, {
      session_id: sessionData.id,
      connect_url: connectUrl,
      debug_url: debugData.debuggerFullscreenUrl,
    });

    // Write session info to state files for hooks to read
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(path.join(STATE_DIR, 'debug_url'), debugData.debuggerFullscreenUrl);
      fs.writeFileSync(path.join(STATE_DIR, 'session_id'), sessionData.id);
    } catch (err) {
      console.error('Failed to write state files:', err.message);
    }

    // Connect via raw CDP WebSocket
    const cdp = new CDPConnection(connectUrl);
    await cdp.connect();
    this.cdpConnections.set(tabId, cdp);

    // Get available targets and attach to a page
    const targets = await cdp.send('Target.getTargets');
    let pageTarget = targets.targetInfos.find(t => t.type === 'page');

    if (!pageTarget) {
      // Create a new page target
      const result = await cdp.send('Target.createTarget', { url: 'about:blank' });
      pageTarget = { targetId: result.targetId };
    }

    // Attach to the page target
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });

    this.targetSessionIds.set(tabId, sessionId);

    // Enable necessary domains
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);

    // Set up console message listener
    if (!this.consoleMessages) {
      this.consoleMessages = new Map();
    }
    this.consoleMessages.set(tabId, []);

    cdp.on('Runtime.consoleAPICalled', (params) => {
      const messages = this.consoleMessages.get(tabId) || [];
      const text = params.args?.map(arg => arg.value || arg.description || '').join(' ') || '';
      messages.push({
        type: params.type,
        text,
        timestamp: params.timestamp,
      });
      // Keep last 1000 messages
      if (messages.length > 1000) {
        messages.shift();
      }
      this.consoleMessages.set(tabId, messages);
    });

    // Set up network request listener
    if (!this.networkRequests) {
      this.networkRequests = new Map();
    }
    this.networkRequests.set(tabId, []);

    cdp.on('Network.requestWillBeSent', (params) => {
      const requests = this.networkRequests.get(tabId) || [];
      requests.push({
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        timestamp: params.timestamp,
        status: 'pending',
      });
      // Keep last 500 requests
      if (requests.length > 500) {
        requests.shift();
      }
      this.networkRequests.set(tabId, requests);
    });

    cdp.on('Network.responseReceived', (params) => {
      const requests = this.networkRequests.get(tabId) || [];
      const request = requests.find(r => r.requestId === params.requestId);
      if (request) {
        request.status = params.response.status;
        request.statusText = params.response.statusText;
      }
    });

    return [tabId, this.sessions.get(tabId)];
  }

  /**
   * Initialize a new session with an externally provided tabId.
   * This is a wrapper around createSession for compatibility.
   */
  async initSession(externalTabId) {
    // Create session via API with keepAlive and 6 hour timeout
    const sessionData = await this._apiRequest('POST', '/v1/sessions', {
      projectId: this.projectId,
      keepAlive: true,
      timeout: 21600, // 6 hours in seconds
    });

    const tabId = externalTabId;
    const connectUrl = sessionData.connectUrl;

    // Get debug URL from separate endpoint
    const debugData = await this._apiRequest('GET', `/v1/sessions/${sessionData.id}/debug`);

    this.sessions.set(tabId, {
      session_id: sessionData.id,
      connect_url: connectUrl,
      debug_url: debugData.debuggerFullscreenUrl,
    });

    // Write session info to state files for hooks to read
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(path.join(STATE_DIR, 'debug_url'), debugData.debuggerFullscreenUrl);
      fs.writeFileSync(path.join(STATE_DIR, 'session_id'), sessionData.id);
    } catch (err) {
      console.error('Failed to write state files:', err.message);
    }

    // Connect via raw CDP WebSocket
    const cdp = new CDPConnection(connectUrl);
    await cdp.connect();
    this.cdpConnections.set(tabId, cdp);

    // Get available targets and attach to a page
    const targets = await cdp.send('Target.getTargets');
    let pageTarget = targets.targetInfos.find(t => t.type === 'page');

    if (!pageTarget) {
      // Create a new page target
      const result = await cdp.send('Target.createTarget', { url: 'about:blank' });
      pageTarget = { targetId: result.targetId };
    }

    // Attach to the page target
    const { sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });

    this.targetSessionIds.set(tabId, sessionId);

    // Enable necessary domains
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);

    // Set up console message listener
    if (!this.consoleMessages) {
      this.consoleMessages = new Map();
    }
    this.consoleMessages.set(tabId, []);

    cdp.on('Runtime.consoleAPICalled', (params) => {
      const messages = this.consoleMessages.get(tabId) || [];
      const text = params.args?.map(arg => arg.value || arg.description || '').join(' ') || '';
      messages.push({
        type: params.type,
        text,
        timestamp: params.timestamp,
      });
      if (messages.length > 1000) {
        messages.shift();
      }
      this.consoleMessages.set(tabId, messages);
    });

    // Set up network request listener
    if (!this.networkRequests) {
      this.networkRequests = new Map();
    }
    this.networkRequests.set(tabId, []);

    cdp.on('Network.requestWillBeSent', (params) => {
      const requests = this.networkRequests.get(tabId) || [];
      requests.push({
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        timestamp: params.timestamp,
        status: 'pending',
      });
      if (requests.length > 500) {
        requests.shift();
      }
      this.networkRequests.set(tabId, requests);
    });

    cdp.on('Network.responseReceived', (params) => {
      const requests = this.networkRequests.get(tabId) || [];
      const request = requests.find(r => r.requestId === params.requestId);
      if (request) {
        request.status = params.response.status;
        request.statusText = params.response.statusText;
      }
    });

    return this.sessions.get(tabId);
  }

  async navigate(tabId, url) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }

    // Navigate and wait for load
    await cdp.send('Page.navigate', { url }, sessionId);

    // Wait for page to load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Update stored URL
    const session = this.sessions.get(tabId);
    if (session) {
      session.current_url = url;
    }

    return `Navigated to ${url}`;
  }

  async screenshot(tabId, format = 'jpeg', quality = 80) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    // Get layout metrics for dimensions
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId);
    const width = Math.ceil(metrics.cssVisualViewport?.clientWidth || 1280);
    const height = Math.ceil(metrics.cssVisualViewport?.clientHeight || 720);

    // Capture screenshot
    const result = await cdp.send('Page.captureScreenshot', {
      format,
      quality,
    }, sessionId);

    return [result.data, width, height];
  }

  async getAccessibilityTree(tabId, depth = 15) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    // Enable accessibility domain
    await cdp.send('Accessibility.enable', {}, sessionId);

    // Get the full accessibility tree
    const result = await cdp.send('Accessibility.getFullAXTree', {
      depth,
    }, sessionId);

    return { nodes: result.nodes };
  }

  async getPageUrl(tabId) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      return ['', ''];
    }

    // Get URL and title via JavaScript evaluation
    const urlResult = await cdp.send('Runtime.evaluate', {
      expression: 'window.location.href',
    }, sessionId);

    const titleResult = await cdp.send('Runtime.evaluate', {
      expression: 'document.title',
    }, sessionId);

    const url = urlResult.result?.value || '';
    const title = titleResult.result?.value || '';

    return [url, title];
  }

  async getPageText(tabId) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    const result = await cdp.send('Runtime.evaluate', {
      expression: 'document.body.innerText',
    }, sessionId);

    return result.result?.value || '';
  }

  async sendCdpCommand(tabId, method, params = {}) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    return await cdp.send(method, params, sessionId);
  }

  // Mouse actions
  async click(tabId, x, y, button = 'left', clickCount = 1) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    // Enable Input domain if not already
    await cdp.send('Input.enable', {}, sessionId).catch(() => {});

    // Mouse down
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
    }, sessionId);

    // Mouse up
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
    }, sessionId);

    return `Clicked at (${x}, ${y})`;
  }

  async doubleClick(tabId, x, y) {
    return await this.click(tabId, x, y, 'left', 2);
  }

  async tripleClick(tabId, x, y) {
    return await this.click(tabId, x, y, 'left', 3);
  }

  async rightClick(tabId, x, y) {
    return await this.click(tabId, x, y, 'right', 1);
  }

  async hover(tabId, x, y) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    }, sessionId);

    return `Hovered at (${x}, ${y})`;
  }

  async drag(tabId, startX, startY, endX, endY) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    // Move to start position
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX,
      y: startY,
    }, sessionId);

    // Mouse down
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: startX,
      y: startY,
      button: 'left',
      clickCount: 1,
    }, sessionId);

    // Move to end position
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: endX,
      y: endY,
    }, sessionId);

    // Mouse up
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: endX,
      y: endY,
      button: 'left',
      clickCount: 1,
    }, sessionId);

    return `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})`;
  }

  // Keyboard actions
  async type(tabId, text) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    // Type each character
    for (const char of text) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char,
      }, sessionId);

      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char,
      }, sessionId);
    }

    return `Typed: "${text}"`;
  }

  async pressKey(tabId, key, modifiers = []) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    // Key code mapping
    const keyMap = {
      'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
      'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
      'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
      'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
      'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
      'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
      'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
      'Home': { key: 'Home', code: 'Home', keyCode: 36 },
      'End': { key: 'End', code: 'End', keyCode: 35 },
      'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
      'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    };

    const keyInfo = keyMap[key] || { key, code: key, keyCode: key.charCodeAt(0) };

    // Calculate modifier flags
    let modifierFlags = 0;
    if (modifiers.includes('alt')) modifierFlags |= 1;
    if (modifiers.includes('ctrl')) modifierFlags |= 2;
    if (modifiers.includes('meta') || modifiers.includes('cmd')) modifierFlags |= 4;
    if (modifiers.includes('shift')) modifierFlags |= 8;

    // Press modifier keys
    for (const mod of modifiers) {
      const modKey = mod === 'cmd' || mod === 'meta' ? 'Meta' :
                     mod.charAt(0).toUpperCase() + mod.slice(1);
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: modKey,
        modifiers: modifierFlags,
      }, sessionId);
    }

    // Key down
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      modifiers: modifierFlags,
    }, sessionId);

    // Key up
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyInfo.key,
      code: keyInfo.code,
      windowsVirtualKeyCode: keyInfo.keyCode,
      modifiers: modifierFlags,
    }, sessionId);

    // Release modifier keys
    for (const mod of modifiers) {
      const modKey = mod === 'cmd' || mod === 'meta' ? 'Meta' :
                     mod.charAt(0).toUpperCase() + mod.slice(1);
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: modKey,
      }, sessionId);
    }

    return `Pressed key: ${modifiers.length ? modifiers.join('+') + '+' : ''}${key}`;
  }

  // Scroll actions
  async scroll(tabId, x, y, direction, amount = 3) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    // Calculate delta based on direction
    let deltaX = 0;
    let deltaY = 0;
    const scrollAmount = amount * 100; // pixels per tick

    switch (direction) {
      case 'up':
        deltaY = -scrollAmount;
        break;
      case 'down':
        deltaY = scrollAmount;
        break;
      case 'left':
        deltaX = -scrollAmount;
        break;
      case 'right':
        deltaX = scrollAmount;
        break;
    }

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX,
      deltaY,
    }, sessionId);

    return `Scrolled ${direction} at (${x}, ${y})`;
  }

  // Execute JavaScript
  async executeScript(tabId, script) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    const result = await cdp.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId);

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Script execution error');
    }

    return result.result?.value;
  }

  // Set form input value
  async setFormValue(tabId, selector, value) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    // Use JavaScript to set the value
    const script = `
      (function() {
        const element = document.querySelector('${selector.replace(/'/g, "\\'")}');
        if (!element) return { success: false, error: 'Element not found' };

        if (element.tagName === 'SELECT') {
          element.value = '${String(value).replace(/'/g, "\\'")}';
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (element.type === 'checkbox' || element.type === 'radio') {
          element.checked = ${Boolean(value)};
          element.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          element.value = '${String(value).replace(/'/g, "\\'")}';
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { success: true };
      })()
    `;

    const result = await cdp.send('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    }, sessionId);

    return result.result?.value;
  }

  // Resize viewport
  async setViewportSize(tabId, width, height) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    }, sessionId);

    return `Viewport resized to ${width}x${height}`;
  }

  // Take a zoomed/cropped screenshot
  async screenshotRegion(tabId, x0, y0, x1, y1, format = 'jpeg', quality = 80) {
    const cdp = this.cdpConnections.get(tabId);
    const sessionId = this.targetSessionIds.get(tabId);

    if (!cdp || !sessionId) {
      throw new Error(`No CDP connection found for tab ${tabId}`);
    }

    const result = await cdp.send('Page.captureScreenshot', {
      format,
      quality,
      clip: {
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
        scale: 1,
      },
    }, sessionId);

    return [result.data, x1 - x0, y1 - y0];
  }

  async closeSession(tabId) {
    const sessionInfo = this.sessions.get(tabId);
    this.sessions.delete(tabId);

    if (!sessionInfo) {
      return;
    }

    // Close CDP connection
    const cdp = this.cdpConnections.get(tabId);
    this.cdpConnections.delete(tabId);
    this.targetSessionIds.delete(tabId);

    if (cdp) {
      try {
        await cdp.close();
      } catch {
        // Connection might already be closed
      }
    }

    // Release session via API (https://docs.browserbase.com/reference/api/update-a-session)
    if (sessionInfo.session_id) {
      try {
        await this._apiRequest('POST', `/v1/sessions/${sessionInfo.session_id}`, {
          status: 'REQUEST_RELEASE',
          projectId: this.projectId,
        });
      } catch {
        // Session might already be released
      }
    }
  }

  getAvailableTabs() {
    const tabs = [];
    for (const [tabId, info] of this.sessions) {
      tabs.push({
        tabId,
        title: 'Browserbase Session',
        url: info.current_url || 'about:blank',
      });
    }
    return tabs;
  }

  async cleanup() {
    for (const tabId of this.sessions.keys()) {
      await this.closeSession(tabId);
    }
  }
}

// Singleton instance
let _client = null;

export function getClient() {
  if (!_client) {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    if (!apiKey || !projectId) {
      throw new Error('BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID environment variables required');
    }
    _client = new BrowserbaseClient(apiKey, projectId);
  }
  return _client;
}

export { BrowserbaseClient };
