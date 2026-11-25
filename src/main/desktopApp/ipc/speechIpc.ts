import { SPEECH_PROMPT_MAX_CHARS, isSpeechLanguage } from "../../../shared/speechToText";
import { app, ipcMain, systemPreferences } from "electron";
import type { DesktopApp } from "../desktopApp";

export function registerSpeechIpc(desktopApp: DesktopApp): void {
  ipcMain.handle("speech:state", () => desktopApp.speechToTextService.getState());
  ipcMain.handle("speech:enable", () => desktopApp.speechToTextService.enable());
  ipcMain.handle("speech:cancel-download", () => desktopApp.speechToTextService.cancelDownload());

  ipcMain.handle("speech:disable", (_event, request: { deleteModel?: unknown } | undefined) =>
    desktopApp.speechToTextService.disable({ deleteModel: request?.deleteModel === true }));

  ipcMain.handle("speech:prepare", () => desktopApp.speechToTextService.prepare());
  ipcMain.handle("speech:set-hold-key", (_event, holdKey: unknown) => desktopApp.speechToTextService.setHoldKey(holdKey));

  ipcMain.handle("speech:transcribe", async (_event, request: { audio?: unknown; prompt?: unknown; language?: unknown } | undefined) => {
    const audio = request?.audio;
    if (!(audio instanceof Uint8Array)) {
      throw new Error("The recording did not arrive.");
    }
    const prompt = typeof request?.prompt === "string" ? request.prompt.slice(-SPEECH_PROMPT_MAX_CHARS) : undefined;
    const language = isSpeechLanguage(request?.language) ? request.language : undefined;
    const result = await desktopApp.speechToTextService.transcribe(audio, { prompt, language });
    if (typeof result?.text === "string" && result.text.trim()) desktopApp.usageMilestones?.reach("dictation_used");
    return result;
  });

  ipcMain.handle("speech:request-microphone", async () => {
    // Chromium's stand-in microphone (a test run fed from an audio file)
    // never opens the real one, so there is nothing to ask macOS for.
    if (!(await desktopApp.speechToTextService.getState().then((state) => state.status === "ready", () => false))) return false;
    if (process.platform !== "darwin" || app.commandLine.hasSwitch("use-fake-device-for-media-stream")) return true;
    const status = systemPreferences.getMediaAccessStatus("microphone");
    if (status === "granted") return true;
    if (status === "not-determined") return systemPreferences.askForMediaAccess("microphone");
    return false;
  });
}
