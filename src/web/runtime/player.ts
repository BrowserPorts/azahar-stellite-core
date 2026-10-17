// SPDX-License-Identifier: GPL-2.0-or-later

import { AzaharClient } from "./client";
import type { BrowserAudioOutput, CoreOption, InstalledTitle } from "./client";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing player element: ${id}`);
  return value as T;
}

const openButton = element<HTMLButtonElement>("open");
const gameFile = element<HTMLInputElement>("game-file");
const installButton = element<HTMLButtonElement>("install");
const ciaFile = element<HTMLInputElement>("cia-file");
const installProgress = element<HTMLProgressElement>("install-progress");
const importDspButton = element<HTMLButtonElement>("import-dsp");
const dspFiles = element<HTMLInputElement>("dsp-files");
const importProgress = element<HTMLProgressElement>("import-progress");
const playButton = element<HTMLButtonElement>("play");
const resetButton = element<HTMLButtonElement>("reset");
const libraryButton = element<HTMLButtonElement>("library");
const fullscreenButton = element<HTMLButtonElement>("fullscreen");
const saveButton = element<HTMLButtonElement>("save");
const restoreButton = element<HTMLButtonElement>("restore");
const retryButton = element<HTMLButtonElement>("retry");
const slot = element<HTMLSelectElement>("slot");
const volume = element<HTMLInputElement>("volume");
const status = element("status");
const title = element("game-title");
const welcome = element("welcome");
const installed = element("installed");
const emptyLibrary = element("empty-library");
const fps = element<HTMLOutputElement>("fps");
const log = element("log");
const jit = element("jit");
const settings = element("settings");
const optionKeys = ["citra_audio_emulation", "citra_layout_option", "citra_swap_screen"] as const;
const preferences = new Map<string, string>();
const settingSelects = new Map<string, HTMLSelectElement>();
const preferencesKey = "azahar.player.options.v1";
let canvas = element<HTMLCanvasElement>("canvas");
let client: AzaharClient | undefined;
let audio: BrowserAudioOutput | undefined;
let gain: GainNode | undefined;
let ready = false;
let loaded = false;
let running = false;
let busy = false;
let fatal = false;
let generation = 0;
let sampling = false;
let logsDirty = false;
let installing = false;
const lines: string[] = [];

function message(text: string, error = false): undefined {
  status.textContent = text;
  status.classList.toggle("error", error);
  status.setAttribute("role", error ? "alert" : "status");
  return undefined;
}

function controls(): undefined {
  const unavailable = busy || fatal || !ready;
  openButton.disabled = unavailable || running;
  installButton.disabled = unavailable || loaded;
  importDspButton.disabled = unavailable || loaded;
  playButton.disabled = unavailable || !loaded;
  resetButton.disabled = unavailable || !loaded;
  libraryButton.disabled = busy || !loaded;
  fullscreenButton.disabled = unavailable || !loaded;
  saveButton.disabled = unavailable || !loaded;
  restoreButton.disabled = unavailable || !loaded;
  slot.disabled = unavailable || !loaded;
  playButton.textContent = running ? "Pause" : "Play";
  welcome.hidden = loaded;
  retryButton.hidden = !fatal;
  retryButton.disabled = busy;
  installed.querySelectorAll("button").forEach(button => {
    button.disabled = unavailable || loaded;
    return undefined;
  });
  for (const select of settingSelects.values()) select.disabled = unavailable || loaded;
  if (!running) fps.value = "Paused";
  return undefined;
}

function appendLog(line: string): undefined {
  lines.push(line.trimEnd());
  if (lines.length > 200) lines.splice(0, lines.length - 200);
  logsDirty = true;
  return undefined;
}

function readPreferences(): undefined {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(preferencesKey) ?? "{}");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const key of optionKeys) {
        const value = (stored as Record<string, unknown>)[key];
        if (typeof value === "string") preferences.set(key, value);
      }
    }
  } catch (error) { appendLog(`Could not read player settings: ${String(error)}`); }
  return undefined;
}

function writePreferences(): undefined {
  try { localStorage.setItem(preferencesKey, JSON.stringify(Object.fromEntries(preferences))); }
  catch (error) { appendLog(`Could not save player settings: ${String(error)}`); }
  return undefined;
}

async function showSettings(current: AzaharClient, definitions: CoreOption[]): Promise<undefined> {
  settings.replaceChildren();
  settingSelects.clear();
  for (const key of optionKeys) {
    const definition = definitions.find(option => option.key === key);
    if (!definition) continue;
    const preferred = preferences.get(key);
    if (preferred !== undefined && definition.values.some(value => value.value === preferred)) {
      await current.setOption(key, preferred);
      definition.value = preferred;
    } else preferences.delete(key);
    const label = document.createElement("label");
    label.className = "setting";
    label.textContent = definition.label;
    const select = document.createElement("select");
    select.id = `setting-${key}`;
    select.disabled = true;
    select.setAttribute("aria-describedby", `${select.id}-description`);
    for (const value of definition.values) select.add(new Option(value.label, value.value));
    select.value = definition.value;
    select.addEventListener("change", () => {
      const value = select.value;
      action(`Applying ${definition.label}…`, async () => {
        try {
          if (client !== current || loaded) throw new Error("Change settings in the library before opening a game");
          await current.setOption(key, value);
        } catch (error) { select.value = definition.value; throw error; }
        definition.value = value;
        preferences.set(key, value);
        writePreferences();
        message("Setting applied.");
      });
      return undefined;
    });
    label.append(select);
    const description = document.createElement("p");
    description.id = `${select.id}-description`;
    description.className = "hint";
    description.textContent = definition.description;
    settings.append(label, description);
    settingSelects.set(key, select);
  }
  return undefined;
}

function slotLabel(): string { return slot.value === "0" ? "quick slot" : `slot ${slot.value}`; }

async function action(text: string, work: () => Promise<unknown>): Promise<undefined> {
  if (busy) return undefined;
  busy = true;
  controls();
  message(text);
  try { await work(); }
  catch (error) { message(error instanceof Error ? error.message : String(error), true); }
  finally {
    if (document.hidden && running && client) {
      try { await client.pause(); running = false; }
      catch (error) { appendLog(String(error)); }
    }
    busy = false;
    controls();
  }
  return undefined;
}

function showTitles(titles: InstalledTitle[]): undefined {
  installed.replaceChildren();
  const games = titles.filter(item => item.executable);
  emptyLibrary.hidden = games.length !== 0;
  emptyLibrary.textContent = "No installed titles yet. Open a game file to begin.";
  for (const item of games) {
    const button = document.createElement("button");
    button.textContent = item.title || "Untitled game";
    const media = document.createElement("small");
    media.textContent = item.media === "sdmc" ? "SD card" : "System storage";
    button.append(media);
    button.addEventListener("click", () => {
      action("Opening installed title…", () => loadGame(item.title || "Untitled game",
        current => current.loadInstalled(item.id)));
      return undefined;
    });
    const row = document.createElement("li");
    row.append(button);
    installed.append(row);
  }
  controls();
  return undefined;
}

async function newSession(): Promise<undefined> {
  const own = ++generation;
  ready = false; loaded = false; running = false; fatal = false;
  audio = undefined; gain = undefined;
  jit.textContent = "";
  const previous = client;
  client = undefined;
  if (previous) await previous.close().catch(error => appendLog(String(error)));
  const replacement = document.createElement("canvas");
  replacement.id = "canvas";
  replacement.width = 400; replacement.height = 480; replacement.tabIndex = 0;
  replacement.setAttribute("aria-label", "Nintendo 3DS screens");
  canvas.replaceWith(replacement);
  canvas = replacement;
  title.textContent = "Library";
  const current = new AzaharClient({
    video: () => undefined, audio: () => undefined,
    installProgress: (written, total) => {
      if (own !== generation || !installing) return undefined;
      if (total > 0) { installProgress.max = total; installProgress.value = written; }
      else installProgress.removeAttribute("value");
      return undefined;
    },
    log: line => { if (own === generation) appendLog(line); return undefined; },
    error: text => {
      if (own !== generation) return undefined;
      fatal = true; running = false;
      message(text, true); controls();
      return undefined;
    },
  });
  client = current;
  try {
    await current.ready;
    await showSettings(current, await current.options());
    await current.connectSurface(canvas.transferControlToOffscreen());
    current.connectInput(canvas);
    showTitles(await current.installedTitles());
    ready = true;
    message("Ready. Open a game or choose an installed title.");
  } catch (error) {
    fatal = true;
    await current.close().catch(closeError => appendLog(String(closeError)));
    throw error;
  }
  controls();
  return undefined;
}

async function loadGame(name: string, load: (current: AzaharClient) => Promise<string>): Promise<undefined> {
  if (loaded || !ready || fatal) await newSession();
  if (!client) throw new Error("The emulator is unavailable");
  message(`Opening ${name}…`);
  try {
    await load(client);
    loaded = true;
    title.textContent = name;
    message("Ready to play.");
  } catch (error) {
    await newSession().catch(startError => appendLog(String(startError)));
    throw error;
  }
  return undefined;
}

openButton.addEventListener("click", () => { gameFile.click(); return undefined; });
gameFile.addEventListener("change", () => {
  const file = gameFile.files?.[0];
  gameFile.value = "";
  if (file) action("Opening game…", () => loadGame(file.name, current => current.load(file)));
  return undefined;
});

installButton.addEventListener("click", () => { ciaFile.click(); return undefined; });
ciaFile.addEventListener("change", () => {
  const file = ciaFile.files?.[0];
  ciaFile.value = "";
  if (file) action(`Installing ${file.name}…`, async () => {
    if (!client || loaded) throw new Error("Return to the library before installing a CIA");
    installing = true;
    installProgress.removeAttribute("value");
    installProgress.hidden = false;
    try {
      await client.install(file);
      showTitles(await client.installedTitles());
      message(`Installed ${file.name}.`);
    } finally {
      installing = false;
      installProgress.hidden = true;
    }
  });
  return undefined;
});

async function importFirmware(files: File[]): Promise<undefined> {
  if (!client || loaded) throw new Error("Return to the library before importing files");
  const imports = files.map(file => {
    const name = file.name.toLowerCase();
    if (name !== "dspfirm.cdc" && name !== "dspaudio.cdc") {
      throw new Error("Select dspfirm.cdc or dspaudio.cdc");
    }
    return { file, path: `sdmc/3ds/${name}` };
  });
  importProgress.max = Math.max(1, files.reduce((sum, file) => sum + file.size, 0));
  importProgress.value = 0;
  importProgress.hidden = false;
  let count = 0;
  try {
    for (const { file, path } of imports) {
      message(`Importing ${count + 1} of ${files.length}: ${file.name}`);
      await client.importUserFile(file, path);
      count++;
      importProgress.value += file.size;
    }
    message(`Imported ${files.length} DSP firmware ${files.length === 1 ? "file" : "files"}.`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Import stopped after ${count} of ${files.length} files. ${reason}`);
  } finally { importProgress.hidden = true; }
  return undefined;
}

importDspButton.addEventListener("click", () => { dspFiles.click(); return undefined; });
dspFiles.addEventListener("change", () => {
  const files = Array.from(dspFiles.files ?? []);
  dspFiles.value = "";
  if (files.length) action("Importing firmware…", () => importFirmware(files));
  return undefined;
});

playButton.addEventListener("click", () => {
  action(running ? "Pausing…" : "Starting game…", async () => {
    if (!client) throw new Error("The emulator is unavailable");
    if (running) { await client.pause(); running = false; message("Paused."); }
    else {
      // Create Web Audio directly from this user gesture, before awaiting work.
      if (!audio) {
        audio = await client.connectAudio();
        gain = audio.context.createGain();
        gain.gain.value = volume.valueAsNumber / 100;
        audio.node.disconnect(); audio.node.connect(gain); gain.connect(audio.context.destination);
      }
      await client.performance();
      await client.start(); running = true;
      canvas.focus({ preventScroll: true });
      message("Playing.");
    }
  });
  return undefined;
});

libraryButton.addEventListener("click", () => { action("Returning to library…", newSession); return undefined; });
retryButton.addEventListener("click", () => { action("Restarting emulator…", newSession); return undefined; });
resetButton.addEventListener("click", () => {
  action("Resetting game…", async () => { await client!.reset(); message("Game reset."); });
  return undefined;
});
saveButton.addEventListener("click", () => {
  action("Saving state…", async () => { await client!.save(Number(slot.value)); message(`Saved ${slotLabel()}.`); });
  return undefined;
});
restoreButton.addEventListener("click", () => {
  action("Loading state…", async () => {
    await client!.restore(Number(slot.value));
    message(`Loaded ${slotLabel()}.${running ? "" : " Press Play to continue."}`);
  });
  return undefined;
});
volume.addEventListener("input", () => {
  if (gain) gain.gain.setValueAtTime(volume.valueAsNumber / 100, gain.context.currentTime);
  return undefined;
});
fullscreenButton.addEventListener("click", () => {
  const request = document.fullscreenElement ? document.exitFullscreen() : element("screen").requestFullscreen();
  request.catch(error => message(String(error), true));
  return undefined;
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && running && !busy) action("Pausing…", async () => {
    await client!.pause(); running = false; message("Paused while the tab is hidden.");
  });
  return undefined;
});
window.addEventListener("pagehide", () => { client?.close().catch(() => undefined); return undefined; });
setInterval(() => {
  if (logsDirty) { log.textContent = lines.join("\n"); logsDirty = false; }
  if (!client || !running || busy || sampling) return undefined;
  const current = client;
  sampling = true;
  current.performance().then(stats => {
    if (client === current && running) {
      fps.value = `${stats.systemFps.toFixed(1)} FPS`;
      jit.textContent = `DSP Wasm JIT: ${stats.dspJit.installedEntries} installed, ${stats.dspJit.optimizedEntries} optimized.`;
    }
  }).catch(error => appendLog(String(error))).finally(() => { sampling = false; });
  return undefined;
}, 1000);

readPreferences();
action("Starting Azahar…", newSession);
