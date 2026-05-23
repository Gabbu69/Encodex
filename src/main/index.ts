import { networkInterfaces } from "node:os";
import path from "node:path";
import { app, BrowserWindow, clipboard } from "electron";
import type { Server } from "node:http";
import { VaultStore } from "./crypto-store.js";
import { LocalOcr } from "./ocr.js";
import { createServer } from "./server.js";

let window: BrowserWindow | undefined;
let httpServer: Server | undefined;
let ocr: LocalOcr | undefined;

function hotspotAddress() {
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }
  return "127.0.0.1";
}

async function listen(serverApp: ReturnType<typeof createServer>) {
  let port = 4179;
  while (port < 4190) {
    const result = await new Promise<Server | undefined>((resolve) => {
      const candidate = serverApp.listen(port, "0.0.0.0", () => resolve(candidate));
      candidate.once("error", () => resolve(undefined));
    });
    if (result) {
      return { server: result, port };
    }
    port += 1;
  }
  throw new Error("No free local port is available for secure capture.");
}

async function openApplication() {
  const dataDirectory = process.env.MEDICAL_APP_DATA_DIR ?? path.join(app.getPath("userData"), "secure-data");
  const store = new VaultStore(dataDirectory);
  ocr = new LocalOcr();
  let localPort = 4179;
  const serverApp = createServer({
    store,
    ocr,
    clipboard,
    rendererDirectory: process.env.VITE_DEV_SERVER_URL ? undefined : path.join(app.getAppPath(), "dist"),
    captureOrigin: () => `http://${hotspotAddress()}:${localPort}`
  });
  const listening = await listen(serverApp);
  httpServer = listening.server;
  localPort = listening.port;

  window = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#f4f6f7",
    title: "Encodex",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const applicationUrl = process.env.VITE_DEV_SERVER_URL ?? `http://127.0.0.1:${localPort}`;
  await window.loadURL(applicationUrl);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.on("closed", () => {
    window = undefined;
  });
}

app.whenReady().then(openApplication);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!window) {
    void openApplication();
  }
});

app.on("before-quit", () => {
  httpServer?.close();
  void ocr?.stop();
});
