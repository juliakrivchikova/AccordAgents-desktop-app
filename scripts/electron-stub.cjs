// Lets main-process services that call Electron's `app`/`safeStorage` run under
// plain `node --test`. Preload with --require; userData comes from
// ACCORD_TEST_USER_DATA so each test can point at its own temp directory.
const Module = require("node:module");

const stub = {
  app: {
    getPath: (name) => {
      if (name === "userData") {
        return process.env.ACCORD_TEST_USER_DATA ?? require("node:os").tmpdir();
      }
      return require("node:os").tmpdir();
    },
    getVersion: () => "0.0.0-test",
    isPackaged: false,
    on: () => {},
    whenReady: async () => {}
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => Buffer.from(value).toString("utf8")
  },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  shell: { openExternal: async () => {} },
  protocol: { handle: () => {} }
};

const load = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === "electron") {
    return stub;
  }
  return load.call(this, request, parent, isMain);
};
