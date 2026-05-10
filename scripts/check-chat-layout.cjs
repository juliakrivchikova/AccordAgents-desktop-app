const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CHILD_FLAG = "--electron-child";
const SCREENSHOT_PATH = path.join(process.cwd(), "dist", "chat-layout-check.png");

async function main() {
  if (process.argv.includes(CHILD_FLAG)) {
    await runElectronChild();
    return;
  }
  await runParent();
}

async function runParent() {
  const port = await findFreePort();
  const conversationId = valueAfter("--conversation-id");
  const fixturePath = conversationId ? await writeRealConversationFixture(conversationId) : undefined;
  const url = fixturePath ? `http://127.0.0.1:${port}/` : `http://127.0.0.1:${port}/?mock=chat-layout`;
  const vitePath = path.join(process.cwd(), "node_modules", ".bin", "vite");
  const electronPath = require("electron");
  const vite = spawn(vitePath, ["--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let viteOutput = "";
  vite.stdout.on("data", (chunk) => {
    viteOutput += chunk.toString();
  });
  vite.stderr.on("data", (chunk) => {
    viteOutput += chunk.toString();
  });

  try {
    await waitForUrl(url, 15_000);
    const childArgs = [__filename, CHILD_FLAG, "--url", url];
    if (fixturePath) {
      childArgs.push("--fixture-path", fixturePath);
    }
    const result = await runProcess(electronPath, childArgs, 30_000);
    process.stdout.write(result.stdout);
    if (result.stderr.trim()) {
      process.stderr.write(result.stderr);
    }
  } finally {
    vite.kill("SIGTERM");
    await waitForExit(vite, 3_000).catch(() => vite.kill("SIGKILL"));
  }

  if (vite.exitCode && vite.exitCode !== 0) {
    throw new Error(`Vite exited with code ${vite.exitCode}\n${viteOutput}`);
  }
}

async function runElectronChild() {
  const { app, BrowserWindow } = require("electron");
  const url = valueAfter("--url");
  if (!url) {
    throw new Error("Missing --url for Electron child.");
  }

  await app.whenReady();
  const fixturePath = valueAfter("--fixture-path");
  const preload = fixturePath ? await writeFixturePreload(fixturePath) : undefined;
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  try {
    await window.loadURL(url);
    await waitForReady(window);
    await openFixture(window);
    const result = await inspectLayout(window);
    assertLayout(result);
    await fs.mkdir(path.dirname(SCREENSHOT_PATH), { recursive: true });
    const screenshot = await window.webContents.capturePage();
    await fs.writeFile(SCREENSHOT_PATH, screenshot.toPNG());
    process.stdout.write(`${JSON.stringify({ ...result, screenshotPath: SCREENSHOT_PATH }, null, 2)}\n`);
  } finally {
    window.close();
    app.quit();
  }
}

async function openFixture(window) {
  await waitForCondition(window, () => {
    const fixture = document.querySelector(".history-item");
    if (!fixture) {
      return false;
    }
    fixture.click();
    return true;
  }, 10_000);
  await waitForCondition(window, () => Boolean(document.querySelector(".chat-view")), 10_000);
}

async function writeRealConversationFixture(conversationId) {
  const dbPath = path.join(os.homedir(), "Library", "Application Support", "ai-consensus", "ai-consensus.sqlite3");
  const sql = `select payload_json as payloadJson from conversations where id = '${conversationId.replace(/'/g, "''")}' limit 1;`;
  const result = await runProcess("sqlite3", ["-json", dbPath, sql], 10_000);
  const rows = JSON.parse(result.stdout || "[]");
  if (!rows[0]?.payloadJson) {
    throw new Error(`Conversation ${conversationId} was not found in ${dbPath}`);
  }
  const conversation = JSON.parse(rows[0].payloadJson);
  const now = new Date().toISOString();
  const fixture = {
    settings: {
      roundLimitDefault: 2,
      providers: [
        { kind: "codex-cli", label: "Codex CLI", enabled: true },
        { kind: "claude-code", label: "Claude Code", enabled: true }
      ],
      chatRoleConfigs: [
        { id: "synthesizer", label: "Synthesizer", instructions: "", version: 1, builtIn: true, updatedAt: now },
        { id: "arbiter", label: "Arbiter", instructions: "", version: 1, builtIn: true, updatedAt: now },
        { id: "software-engineer", label: "Software Engineer", instructions: "", version: 4, builtIn: true, updatedAt: now }
      ],
      chatParticipantConfigs: []
    },
    conversation
  };
  const fixturePath = path.join(process.cwd(), "dist", "chat-layout-real-fixture.json");
  await fs.mkdir(path.dirname(fixturePath), { recursive: true });
  await fs.writeFile(fixturePath, JSON.stringify(fixture), "utf8");
  return fixturePath;
}

async function writeFixturePreload(fixturePath) {
  const preloadPath = path.join(process.cwd(), "dist", "chat-layout-preload.cjs");
  const preloadSource = `
    const { contextBridge } = require("electron");
    const fs = require("node:fs");
    const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
    const conversationListeners = new Set();
    const bridge = {
      getSettings: async () => fixture.settings,
      updateProviderSettings: async () => fixture.settings,
      saveChatRoleConfig: async () => fixture.settings,
      saveChatParticipantConfig: async () => fixture.settings,
      deleteChatParticipantConfig: async () => fixture.settings,
      updateLastRepoPath: async (repoPath) => ({ ...fixture.settings, lastRepoPath: repoPath }),
      listProviderModels: async () => [],
      detectAgents: async () => [
        { kind: "codex-cli", label: "Codex CLI", installed: true, version: "fixture" },
        { kind: "claude-code", label: "Claude Code", installed: true, version: "fixture" }
      ],
      selectRepoDirectory: async () => undefined,
      inspectRepo: async (repoPath) => ({ repoPath, isRepo: true, currentBranch: "fixture", branches: ["fixture"], statusLines: [] }),
      getDiff: async () => ({ mode: "working", title: "Fixture diff", diff: "", metadata: {} }),
      listConversations: async () => [fixture.conversation],
      getConversation: async (id) => id === fixture.conversation.id ? fixture.conversation : undefined,
      saveDecisionSelections: async () => fixture.conversation,
      saveDecisionResolutions: async () => fixture.conversation,
      savePlanItemReview: async () => fixture.conversation,
      createChatConversation: async () => ({ conversation: fixture.conversation, warnings: [] }),
      addChatParticipant: async () => fixture.conversation,
      sendChatMessage: async () => ({ conversation: fixture.conversation, warnings: [] }),
      respondToChatMentions: async () => ({ conversation: fixture.conversation, warnings: [] }),
      startReview: async () => ({ conversation: fixture.conversation, warnings: [] }),
      continueReview: async () => ({ conversation: fixture.conversation, warnings: [] }),
      askPlanDecisionClarification: async () => ({ conversation: fixture.conversation, warnings: [] }),
      composeImplementationPlan: async () => ({ conversation: fixture.conversation, warnings: [] }),
      retryImplementationPlanSynthesis: async () => ({ conversation: fixture.conversation, warnings: [] }),
      recoverImplementationPlan: async () => ({ conversation: fixture.conversation, warnings: [] }),
      reviseImplementationPlan: async () => ({ conversation: fixture.conversation, warnings: [] }),
      cancelReview: async () => undefined,
      onReviewProgress: () => () => undefined,
      onConversationUpdated: (callback) => {
        conversationListeners.add(callback);
        return () => conversationListeners.delete(callback);
      }
    };
    contextBridge.exposeInMainWorld("consensus", bridge);
  `;
  await fs.mkdir(path.dirname(preloadPath), { recursive: true });
  await fs.writeFile(preloadPath, preloadSource, "utf8");
  return preloadPath;
}

async function inspectLayout(window) {
  return window.webContents.executeJavaScript(`
    (() => {
      const timeline = document.querySelector(".chat-timeline");
      const composer = document.querySelector(".chat-composer");
      const textarea = document.querySelector(".chat-composer textarea");
      const panel = document.querySelector(".chat-conversation-panel");
      const messages = [...document.querySelectorAll(".chat-timeline > article")];
      const lastMessage = messages[messages.length - 1];
      if (!timeline || !composer || !textarea || !panel || !lastMessage) {
        throw new Error("Missing chat layout nodes.");
      }

      timeline.scrollTo({ top: 0 });
      const composerAtTopScroll = isFullyVisible(composer);
      const textareaAtTopScroll = isFullyVisible(textarea);
      const canScrollUp = timeline.scrollTop === 0 && timeline.scrollHeight > timeline.clientHeight;
      timeline.scrollTo({ top: timeline.scrollHeight });
      const timelineAtBottom = Math.abs(timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight) <= 2;
      const lastRect = lastMessage.getBoundingClientRect();
      const composerRect = composer.getBoundingClientRect();
      const textareaRect = textarea.getBoundingClientRect();
      const panelStyle = getComputedStyle(panel);
      const timelineStyle = getComputedStyle(timeline);
      const finalTextReachable = lastMessage.textContent?.includes("final paragraph remains fully reachable") ?? false;
      const lastMessageAboveComposer = lastRect.bottom <= composerRect.top + 1 && lastRect.bottom > 0;
      const composerAtBottom = Math.abs(composerRect.bottom - window.innerHeight) <= 2;
      const textareaVisible = isFullyVisible(textarea);
      const textareaUsable = textareaRect.width >= 300 && textareaRect.height >= 54;
      const htmlScrollHeight = document.documentElement.scrollHeight;
      const htmlClientHeight = document.documentElement.clientHeight;
      const originalWindowScrollY = window.scrollY;
      window.scrollTo(0, 999_999);
      const windowScrollYAfter = window.scrollY;
      window.scrollTo(0, originalWindowScrollY);
      const bodyDoesNotScroll = windowScrollYAfter === 0;

      function isFullyVisible(element) {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
      }

      return {
        bodyClientHeight: document.body.clientHeight,
        bodyDoesNotScroll,
        bodyScrollHeight: document.body.scrollHeight,
        canScrollUp,
        composerAtBottom,
        composerAtTopScroll,
        finalTextReachable,
        lastMessageAboveComposer,
        messageCount: messages.length,
        htmlClientHeight,
        htmlScrollHeight,
        panelOverflowY: panelStyle.overflowY,
        textareaAtTopScroll,
        textareaHeight: textareaRect.height,
        textareaUsable,
        textareaVisible,
        textareaWidth: textareaRect.width,
        timelineAtBottom,
        timelineOverflowY: timelineStyle.overflowY,
        timelineScrollHeight: timeline.scrollHeight,
        timelineClientHeight: timeline.clientHeight,
        windowScrollYAfter
      };
    })();
  `);
}

function assertLayout(result) {
  const failures = [];
  if (!result.bodyDoesNotScroll) {
    failures.push(
      `document scrolls instead of chat timeline (window scrollY ${result.windowScrollYAfter}px, html ${result.htmlScrollHeight}px/${result.htmlClientHeight}px, body ${result.bodyScrollHeight}px/${result.bodyClientHeight}px)`
    );
  }
  if (!result.canScrollUp) {
    failures.push("chat timeline cannot scroll to prior history");
  }
  if (!result.timelineAtBottom) {
    failures.push("chat timeline cannot scroll to its bottom");
  }
  if (result.panelOverflowY !== "hidden") {
    failures.push(`chat conversation panel overflow-y is ${result.panelOverflowY}, expected hidden`);
  }
  if (result.timelineOverflowY !== "auto") {
    failures.push(`chat timeline overflow-y is ${result.timelineOverflowY}, expected auto`);
  }
  if (!result.composerAtTopScroll || !result.composerAtBottom) {
    failures.push("composer does not remain visible at the bottom of the Electron window");
  }
  if (!result.textareaAtTopScroll || !result.textareaVisible || !result.textareaUsable) {
    failures.push(`message textarea is not visible/usable (${result.textareaWidth}x${result.textareaHeight})`);
  }
  if (!result.lastMessageAboveComposer) {
    failures.push("last message is hidden under or below the composer");
  }
  if (failures.length > 0) {
    throw new Error(`Chat layout check failed:\n- ${failures.join("\n- ")}\n${JSON.stringify(result, null, 2)}`);
  }
}

async function waitForReady(window) {
  await waitForCondition(window, () => document.readyState === "complete" || document.readyState === "interactive", 10_000);
}

async function waitForCondition(window, predicate, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await window.webContents.executeJavaScript(`(${predicate.toString()})()`);
    if (ok) {
      return;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Electron layout condition.");
}

async function waitForUrl(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canConnect(url)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function canConnect(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(true);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a local port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited with code ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("Timed out waiting for process exit.")), timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
