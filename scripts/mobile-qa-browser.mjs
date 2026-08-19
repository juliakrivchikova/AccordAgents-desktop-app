import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launchMobileQaBrowser({
  repoRoot,
  url,
  port,
  profileDir,
  width = 390,
  height = 844
}) {
  const browser = process.env.QA_MOBILE_BROWSER || "electron";
  if (browser === "chrome") {
    const chromePath = process.env.CHROME_BIN || defaultChromePath;
    return spawn(chromePath, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      url
    ], {
      stdio: ["ignore", "pipe", "pipe"]
    });
  }

  if (browser !== "electron") {
    throw new Error(`Unsupported QA_MOBILE_BROWSER=${browser}. Use "electron" or "chrome".`);
  }

  const electronBin = process.env.QA_MOBILE_BROWSER_BIN ||
    path.join(repoRoot, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  if (!existsSync(electronBin)) {
    throw new Error(`Electron binary not found: ${electronBin}. Run npm install or npm rebuild electron.`);
  }

  const appDir = path.join(profileDir, "qa-electron-browser-app");
  await mkdir(appDir, { recursive: true });
  await writeFile(path.join(appDir, "package.json"), JSON.stringify({ main: "main.js" }), "utf8");
  await writeFile(path.join(appDir, "main.js"), `
const { app, BrowserWindow } = require("electron");

app.commandLine.appendSwitch("remote-debugging-port", String(process.env.QA_MOBILE_CDP_PORT));
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-gpu");
app.setPath("userData", process.env.QA_MOBILE_USER_DATA_DIR);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: Number(process.env.QA_MOBILE_WIDTH || 390),
    height: Number(process.env.QA_MOBILE_HEIGHT || 844),
    title: "AccordAgents Mobile QA",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadURL(process.env.QA_MOBILE_TARGET_URL);
});

app.on("window-all-closed", () => app.quit());
`, "utf8");

  return spawn(electronBin, [appDir], {
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      QA_MOBILE_CDP_PORT: String(port),
      QA_MOBILE_TARGET_URL: url,
      QA_MOBILE_USER_DATA_DIR: profileDir,
      QA_MOBILE_WIDTH: String(width),
      QA_MOBILE_HEIGHT: String(height)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
}
