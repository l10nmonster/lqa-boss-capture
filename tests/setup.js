/**
 * Jest setup file for Chrome extension tests
 * Mocks Chrome APIs and sets up global test environment
 */

// Mock Chrome APIs
global.chrome = {
  runtime: {
    sendMessage: jest.fn((message, callback) => {
      if (callback) callback({ success: true });
      return Promise.resolve({ success: true });
    }),
    connect: jest.fn(() => ({
      onMessage: {
        addListener: jest.fn()
      },
      onDisconnect: {
        addListener: jest.fn()
      },
      postMessage: jest.fn(),
      disconnect: jest.fn()
    })),
    onMessage: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    },
    onMessageExternal: {
      addListener: jest.fn(),
      removeListener: jest.fn()
    },
    getURL: jest.fn((path) => `chrome-extension://test-id/${path}`)
  },
  storage: {
    local: {
      get: jest.fn((keys, callback) => {
        const result = {};
        if (callback) callback(result);
        return Promise.resolve(result);
      }),
      set: jest.fn((items, callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
      remove: jest.fn((keys, callback) => {
        if (callback) callback();
        return Promise.resolve();
      })
    },
    sync: {
      get: jest.fn((keys, callback) => {
        const result = {};
        if (callback) callback(result);
        return Promise.resolve(result);
      }),
      set: jest.fn((items, callback) => {
        if (callback) callback();
        return Promise.resolve();
      }),
      remove: jest.fn((keys, callback) => {
        if (callback) callback();
        return Promise.resolve();
      })
    }
  },
  tabs: {
    query: jest.fn((queryInfo, callback) => {
      const tabs = [{ id: 1, url: 'https://example.com', title: 'Test Page' }];
      if (callback) callback(tabs);
      return Promise.resolve(tabs);
    }),
    sendMessage: jest.fn((tabId, message, callback) => {
      const response = { success: true };
      if (callback) callback(response);
      return Promise.resolve(response);
    }),
    create: jest.fn((createProperties, callback) => {
      const tab = { id: 2, ...createProperties };
      if (callback) callback(tab);
      return Promise.resolve(tab);
    })
  },
  debugger: {
    attach: jest.fn((target, version, callback) => {
      if (callback) callback();
      return Promise.resolve();
    }),
    detach: jest.fn((target, callback) => {
      if (callback) callback();
      return Promise.resolve();
    }),
    sendCommand: jest.fn((target, method, params, callback) => {
      const result = {};
      if (callback) callback(result);
      return Promise.resolve(result);
    })
  },
  scripting: {
    executeScript: jest.fn((injection, callback) => {
      const results = [{ result: null }];
      if (callback) callback(results);
      return Promise.resolve(results);
    })
  },
  sidePanel: {
    open: jest.fn((options, callback) => {
      if (callback) callback();
      return Promise.resolve();
    })
  },
  downloads: {
    download: jest.fn((options, callback) => {
      const downloadId = 1;
      if (callback) callback(downloadId);
      return Promise.resolve(downloadId);
    })
  }
};

// Mock console methods to reduce noise in tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};
