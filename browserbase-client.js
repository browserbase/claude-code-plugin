/**
 * Browserbase client using Stagehand as CDP layer and Browserbase SDK for API calls.
 * Uses Stagehand's page object directly without Playwright dependency.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Stagehand } from '@browserbasehq/stagehand';
import Browserbase from '@browserbasehq/sdk';

const STATE_DIR = path.join(os.homedir(), '.browserbase', 'state');

class BrowserbaseClient {
  constructor(apiKey, projectId) {
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.sessions = new Map(); // tab_id -> session info
    this.stagehandInstances = new Map(); // tab_id -> Stagehand instance
    this.pages = new Map(); // tab_id -> Page instance (stored directly for reliable access)
    this.nextTabId = 1000000000;
    this.consoleMessages = new Map();
    this.networkRequests = new Map();

    // Initialize Browserbase SDK
    this.bb = new Browserbase({ apiKey });
  }

  async _initializeSession(tabId) {
    // Create Stagehand instance with Browserbase
    const stagehand = new Stagehand({
      env: 'BROWSERBASE',
      apiKey: this.apiKey,
      projectId: this.projectId,
      browserbaseSessionCreateParams: {
        keepAlive: true,
        timeout: 21600, // 6 hours in seconds
      },
    });

    await stagehand.init();

    const sessionId = stagehand.browserbaseSessionID;

    // Get debug URL from Browserbase SDK
    let debugUrl = stagehand.browserbaseDebugURL || '';
    if (!debugUrl) {
      try {
        const debugInfo = await this.bb.sessions.debug(sessionId);
        debugUrl = debugInfo.debuggerFullscreenUrl;
      } catch (err) {
        console.error('Failed to get debug URL:', err.message);
      }
    }

    this.sessions.set(tabId, {
      session_id: sessionId,
      debug_url: debugUrl,
      current_url: 'about:blank',
    });

    this.stagehandInstances.set(tabId, stagehand);

    // Write session info to state files for hooks to read
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(path.join(STATE_DIR, 'debug_url'), debugUrl);
      fs.writeFileSync(path.join(STATE_DIR, 'session_id'), sessionId);
    } catch (err) {
      console.error('Failed to write state files:', err.message);
    }

    // Set up console message listener using Stagehand's page event
    // In Stagehand v3, page is accessed via context.activePage()
    // IMPORTANT: Store the page reference directly to avoid issues with activePage() returning wrong page
    this.consoleMessages.set(tabId, []);
    const page = stagehand.context.activePage();
    this.pages.set(tabId, page);

    page.on('console', (message) => {
      const messages = this.consoleMessages.get(tabId) || [];
      messages.push({
        type: message.type(),
        text: message.text(),
        timestamp: Date.now(),
      });
      // Keep last 1000 messages
      if (messages.length > 1000) {
        messages.shift();
      }
      this.consoleMessages.set(tabId, messages);
    });

    // Also inject page-level console interception for more reliable capture
    await page.evaluate(() => {
      if (!window.__consoleMessages) {
        window.__consoleMessages = [];
        const methods = ['log', 'error', 'warn', 'info', 'debug'];
        methods.forEach(method => {
          const original = console[method];
          console[method] = function(...args) {
            window.__consoleMessages.push({
              type: method,
              text: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
              timestamp: Date.now(),
            });
            if (window.__consoleMessages.length > 1000) window.__consoleMessages.shift();
            return original.apply(console, args);
          };
        });
      }
    });

    // Set up network request tracking via page.evaluate injection
    this.networkRequests.set(tabId, []);

    // Inject network tracking script
    await page.evaluate(() => {
      if (!window.__networkRequests) {
        window.__networkRequests = [];
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          const method = args[1]?.method || 'GET';
          const requestId = Math.random().toString(36).substring(7);
          const entry = { requestId, url, method, timestamp: Date.now(), status: 'pending' };
          window.__networkRequests.push(entry);
          if (window.__networkRequests.length > 500) window.__networkRequests.shift();
          try {
            const response = await originalFetch.apply(this, args);
            entry.status = response.status;
            entry.statusText = response.statusText;
            return response;
          } catch (err) {
            entry.status = 'error';
            entry.statusText = err.message;
            throw err;
          }
        };

        const originalXHR = window.XMLHttpRequest.prototype.open;
        window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__requestInfo = { method, url, requestId: Math.random().toString(36).substring(7) };
          return originalXHR.call(this, method, url, ...rest);
        };

        const originalSend = window.XMLHttpRequest.prototype.send;
        window.XMLHttpRequest.prototype.send = function(...args) {
          if (this.__requestInfo) {
            const entry = { ...this.__requestInfo, timestamp: Date.now(), status: 'pending' };
            window.__networkRequests.push(entry);
            if (window.__networkRequests.length > 500) window.__networkRequests.shift();
            this.addEventListener('load', () => {
              entry.status = this.status;
              entry.statusText = this.statusText;
            });
            this.addEventListener('error', () => {
              entry.status = 'error';
            });
          }
          return originalSend.apply(this, args);
        };
      }
    });

    return this.sessions.get(tabId);
  }

  async createSession() {
    const tabId = this.nextTabId;
    this.nextTabId += 1;

    const sessionInfo = await this._initializeSession(tabId);
    return [tabId, sessionInfo];
  }

  /**
   * Initialize a new session with an externally provided tabId.
   */
  async initSession(externalTabId) {
    return await this._initializeSession(externalTabId);
  }

  _getStagehand(tabId) {
    const stagehand = this.stagehandInstances.get(tabId);
    if (!stagehand) {
      throw new Error(`No Stagehand instance found for tab ${tabId}`);
    }
    return stagehand;
  }

  _getPage(tabId) {
    // Return the stored page reference for this specific tab
    // This avoids issues with activePage() potentially returning the wrong page
    const page = this.pages.get(tabId);
    if (!page) {
      throw new Error(`No page found for tab ${tabId}`);
    }
    return page;
  }

  async navigate(tabId, url) {
    const page = this._getPage(tabId);

    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `https://${url}`;
    }

    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Re-inject console interception after navigation
    await page.evaluate(() => {
      if (!window.__consoleMessages) {
        window.__consoleMessages = [];
        const methods = ['log', 'error', 'warn', 'info', 'debug'];
        methods.forEach(method => {
          const original = console[method];
          console[method] = function(...args) {
            window.__consoleMessages.push({
              type: method,
              text: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
              timestamp: Date.now(),
            });
            if (window.__consoleMessages.length > 1000) window.__consoleMessages.shift();
            return original.apply(console, args);
          };
        });
      }
    });

    // Re-inject full network tracking script after navigation
    await page.evaluate(() => {
      if (!window.__networkRequests) {
        window.__networkRequests = [];
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          const method = args[1]?.method || 'GET';
          const requestId = Math.random().toString(36).substring(7);
          const entry = { requestId, url, method, timestamp: Date.now(), status: 'pending' };
          window.__networkRequests.push(entry);
          if (window.__networkRequests.length > 500) window.__networkRequests.shift();
          try {
            const response = await originalFetch.apply(this, args);
            entry.status = response.status;
            entry.statusText = response.statusText;
            return response;
          } catch (err) {
            entry.status = 'error';
            entry.statusText = err.message;
            throw err;
          }
        };

        const originalXHR = window.XMLHttpRequest.prototype.open;
        window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__requestInfo = { method, url, requestId: Math.random().toString(36).substring(7) };
          return originalXHR.call(this, method, url, ...rest);
        };

        const originalSend = window.XMLHttpRequest.prototype.send;
        window.XMLHttpRequest.prototype.send = function(...args) {
          if (this.__requestInfo) {
            const entry = { ...this.__requestInfo, timestamp: Date.now(), status: 'pending' };
            window.__networkRequests.push(entry);
            if (window.__networkRequests.length > 500) window.__networkRequests.shift();
            this.addEventListener('load', () => {
              entry.status = this.status;
              entry.statusText = this.statusText;
            });
            this.addEventListener('error', () => {
              entry.status = 'error';
            });
          }
          return originalSend.apply(this, args);
        };
      }
    });

    // Update stored URL
    const session = this.sessions.get(tabId);
    if (session) {
      session.current_url = url;
    }

    return `Navigated to ${url}`;
  }

  async screenshot(tabId, format = 'jpeg', quality = 80) {
    const page = this._getPage(tabId);

    // Get viewport dimensions via evaluate
    const viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));

    // Capture screenshot using Stagehand's page.screenshot()
    const buffer = await page.screenshot({
      type: format,
      quality: format === 'jpeg' ? quality : undefined,
    });

    // Convert to base64
    const data = buffer.toString('base64');

    return [data, viewport.width, viewport.height];
  }

  async getAccessibilityTree(tabId, depth = 15) {
    const page = this._getPage(tabId);

    // Use JavaScript to build an accessibility tree representation
    const tree = await page.evaluate((maxDepth) => {
      function getAccessibleName(el) {
        return el.getAttribute('aria-label') ||
               el.getAttribute('alt') ||
               el.getAttribute('title') ||
               el.getAttribute('placeholder') ||
               (el.labels && el.labels[0]?.textContent) ||
               el.textContent?.trim().substring(0, 100) ||
               '';
      }

      function getRole(el) {
        const explicitRole = el.getAttribute('role');
        if (explicitRole) return explicitRole;

        const tagRoles = {
          'A': 'link', 'BUTTON': 'button', 'INPUT': el.type || 'textbox',
          'SELECT': 'combobox', 'TEXTAREA': 'textbox', 'IMG': 'img',
          'H1': 'heading', 'H2': 'heading', 'H3': 'heading', 'H4': 'heading',
          'H5': 'heading', 'H6': 'heading', 'NAV': 'navigation', 'MAIN': 'main',
          'HEADER': 'banner', 'FOOTER': 'contentinfo', 'ASIDE': 'complementary',
          'FORM': 'form', 'TABLE': 'table', 'UL': 'list', 'OL': 'list', 'LI': 'listitem',
        };
        return tagRoles[el.tagName] || 'generic';
      }

      function buildTree(el, currentDepth) {
        if (currentDepth > maxDepth) return null;
        if (!el || el.nodeType !== 1) return null;
        if (el.getAttribute('aria-hidden') === 'true') return null;
        if (window.getComputedStyle(el).display === 'none') return null;

        const role = getRole(el);
        const name = getAccessibleName(el);
        const value = el.value || '';

        const node = { role, name, value: value.substring(0, 100) };

        if (currentDepth < maxDepth) {
          const children = [];
          for (const child of el.children) {
            const childNode = buildTree(child, currentDepth + 1);
            if (childNode) children.push(childNode);
          }
          if (children.length > 0) node.children = children;
        }

        return node;
      }

      function flattenTree(node, nodes = [], nodeId = 1) {
        if (!node) return nodes;
        nodes.push({
          nodeId,
          role: { value: node.role },
          name: { value: node.name },
          value: node.value ? { value: node.value } : undefined,
        });
        if (node.children) {
          for (const child of node.children) {
            flattenTree(child, nodes, nodes.length + 1);
          }
        }
        return nodes;
      }

      const tree = buildTree(document.body, 0);
      return flattenTree(tree);
    }, depth);

    return { nodes: tree || [] };
  }

  async getPageUrl(tabId) {
    const page = this._getPage(tabId);
    const url = page.url();
    const title = await page.title();
    return [url, title];
  }

  async getPageText(tabId) {
    const page = this._getPage(tabId);
    const text = await page.evaluate(() => document.body.innerText);
    return text || '';
  }

  async sendCdpCommand(tabId, method, params = {}) {
    // CDP commands need to go through evaluate for most operations
    // This is a limited fallback - most CDP operations should use other methods
    throw new Error(`Direct CDP command '${method}' not supported. Use other methods instead.`);
  }

  // Mouse actions
  async click(tabId, x, y, button = 'left', clickCount = 1) {
    const page = this._getPage(tabId);

    await page.click(x, y, {
      button,
      clickCount,
    });

    // Focus the element at click coordinates for input fields
    await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || el.getAttribute('role') === 'textbox' || el.getAttribute('role') === 'combobox')) {
        el.focus();
      }
    }, { x, y });

    return `Clicked at (${x}, ${y})`;
  }

  async doubleClick(tabId, x, y) {
    const page = this._getPage(tabId);
    await page.click(x, y, { clickCount: 2 });
    return `Double clicked at (${x}, ${y})`;
  }

  async tripleClick(tabId, x, y) {
    const page = this._getPage(tabId);
    await page.click(x, y, { clickCount: 3 });
    return `Triple clicked at (${x}, ${y})`;
  }

  async rightClick(tabId, x, y) {
    const page = this._getPage(tabId);
    await page.click(x, y, { button: 'right' });
    return `Right clicked at (${x}, ${y})`;
  }

  async hover(tabId, x, y) {
    const page = this._getPage(tabId);

    // Use JavaScript to dispatch mouseover/mouseenter events
    await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (el) {
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: x, clientY: y }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
      }
    }, { x, y });

    return `Hovered at (${x}, ${y})`;
  }

  async drag(tabId, startX, startY, endX, endY) {
    const page = this._getPage(tabId);

    // Simulate drag using JavaScript events
    await page.evaluate(({ startX, startY, endX, endY }) => {
      const startEl = document.elementFromPoint(startX, startY);
      const endEl = document.elementFromPoint(endX, endY);

      if (startEl) {
        startEl.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, clientX: startX, clientY: startY, button: 0
        }));
        startEl.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true, clientX: endX, clientY: endY, button: 0
        }));
      }

      if (endEl) {
        endEl.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, clientX: endX, clientY: endY, button: 0
        }));
      }
    }, { startX, startY, endX, endY });

    return `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})`;
  }

  // Keyboard actions
  async type(tabId, text) {
    const page = this._getPage(tabId);
    await page.type(text);
    return `Typed: "${text}"`;
  }

  async pressKey(tabId, key, modifiers = []) {
    const page = this._getPage(tabId);

    // Build key combination string for Stagehand v3
    // Format: "Modifier+Key" e.g., "Ctrl+A", "Cmd+Shift+S"
    const keyParts = [];
    for (const mod of modifiers) {
      // Normalize modifier names
      const modKey = mod === 'meta' ? 'Cmd' :
                     mod.charAt(0).toUpperCase() + mod.slice(1);
      keyParts.push(modKey);
    }
    keyParts.push(key);
    const keyCombo = keyParts.join('+');

    // Stagehand v3 uses keyPress method on the page
    if (page.keyPress && typeof page.keyPress === 'function') {
      await page.keyPress(keyCombo);
    } else {
      // Fallback: dispatch keyboard events via JavaScript
      await page.evaluate(({ key, modifiers }) => {
        const activeEl = document.activeElement || document.body;
        const eventInit = {
          key,
          code: key,
          bubbles: true,
          cancelable: true,
          ctrlKey: modifiers.includes('ctrl'),
          altKey: modifiers.includes('alt'),
          shiftKey: modifiers.includes('shift'),
          metaKey: modifiers.includes('meta') || modifiers.includes('cmd'),
        };
        activeEl.dispatchEvent(new KeyboardEvent('keydown', eventInit));
        activeEl.dispatchEvent(new KeyboardEvent('keyup', eventInit));
      }, { key, modifiers });
    }

    return `Pressed key: ${keyCombo}`;
  }

  // Scroll actions
  async scroll(tabId, x, y, direction, amount = 3) {
    const page = this._getPage(tabId);

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

    // Use JavaScript to scroll
    await page.evaluate(({ x, y, deltaX, deltaY }) => {
      const el = document.elementFromPoint(x, y);
      if (el) {
        // Try to scroll the element if it's scrollable
        const scrollableEl = el.closest('[style*="overflow"]') ||
                            (el.scrollHeight > el.clientHeight ? el : null) ||
                            document.scrollingElement ||
                            document.documentElement;
        scrollableEl.scrollBy(deltaX, deltaY);
      } else {
        window.scrollBy(deltaX, deltaY);
      }
    }, { x, y, deltaX, deltaY });

    return `Scrolled ${direction} at (${x}, ${y})`;
  }

  // Execute JavaScript
  async executeScript(tabId, script) {
    const page = this._getPage(tabId);

    try {
      const result = await page.evaluate(script);
      return result;
    } catch (err) {
      throw new Error(err.message || 'Script execution error');
    }
  }

  // Set form input value
  async setFormValue(tabId, selector, value) {
    const page = this._getPage(tabId);

    const result = await page.evaluate(({ selector, value }) => {
      const element = document.querySelector(selector);
      if (!element) return { success: false, error: 'Element not found' };

      if (element.tagName === 'SELECT') {
        element.value = String(value);
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (element.type === 'checkbox' || element.type === 'radio') {
        element.checked = Boolean(value);
        element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        element.value = String(value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { success: true };
    }, { selector, value });

    return result;
  }

  // Resize viewport
  async setViewportSize(tabId, width, height) {
    const page = this._getPage(tabId);
    await page.setViewportSize(width, height);
    return `Viewport resized to ${width}x${height}`;
  }

  // Take a zoomed/cropped screenshot
  async screenshotRegion(tabId, x0, y0, x1, y1, format = 'jpeg', quality = 80) {
    const page = this._getPage(tabId);

    const buffer = await page.screenshot({
      type: format,
      quality: format === 'jpeg' ? quality : undefined,
      clip: {
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
      },
    });

    const data = buffer.toString('base64');
    return [data, x1 - x0, y1 - y0];
  }

  // Sync console messages from page to client storage
  async syncConsoleMessages(tabId) {
    try {
      const page = this._getPage(tabId);
      const pageMessages = await page.evaluate(() => {
        const messages = window.__consoleMessages || [];
        return messages;
      });

      if (pageMessages && pageMessages.length > 0) {
        const existingMessages = this.consoleMessages.get(tabId) || [];
        // Add messages that aren't already in the list (by timestamp)
        const existingTimestamps = new Set(existingMessages.map(m => m.timestamp));
        for (const msg of pageMessages) {
          if (!existingTimestamps.has(msg.timestamp)) {
            existingMessages.push(msg);
          }
        }
        // Keep last 1000 and sort by timestamp
        existingMessages.sort((a, b) => a.timestamp - b.timestamp);
        if (existingMessages.length > 1000) {
          existingMessages.splice(0, existingMessages.length - 1000);
        }
        this.consoleMessages.set(tabId, existingMessages);
      }
    } catch (err) {
      // Ignore errors - page might not be available
    }
  }

  async closeSession(tabId) {
    const sessionInfo = this.sessions.get(tabId);
    this.sessions.delete(tabId);
    this.pages.delete(tabId);
    this.consoleMessages.delete(tabId);
    this.networkRequests.delete(tabId);

    if (!sessionInfo) {
      return;
    }

    // Close Stagehand instance
    const stagehand = this.stagehandInstances.get(tabId);
    this.stagehandInstances.delete(tabId);
    if (stagehand) {
      try {
        await stagehand.close();
      } catch {
        // Instance might already be closed
      }
    }

    // Release session via Browserbase SDK
    if (sessionInfo.session_id) {
      try {
        await this.bb.sessions.update(sessionInfo.session_id, {
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
