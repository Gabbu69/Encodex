import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import multer from "multer";
import QRCode from "qrcode";
import type { CapturePreset, DocumentType, PatientCase, StoredValue } from "../shared/domain.js";
import { DEFAULT_ALIGNMENT } from "../shared/domain.js";
import { exportCasesCsv } from "../shared/csv.js";
import { BUILT_IN_PRESETS, FIELDS, isDocumentType, requiresMasterMatch, sourceForDocument, supportsTypedName, validSelectedFields } from "../shared/fields.js";
import { findCandidates } from "../shared/matching.js";
import { VaultStore, safeCase } from "./crypto-store.js";
import { parsePatientRows, rowsToPatients, suggestMapping, type ImportMapping } from "./master-import.js";
import { LocalOcr, type OcrSuggestion } from "./ocr.js";

interface ClipboardPort {
  writeText(value: string): void;
  clear(): void;
}

interface OcrPort {
  recognizeSelected(
    bytes: Buffer,
    documentType: DocumentType,
    fields: typeof FIELDS,
    alignment: PatientCase["alignment"]
  ): Promise<OcrSuggestion[]>;
}

export interface ServerDependencies {
  store: VaultStore;
  ocr: OcrPort | LocalOcr;
  clipboard: ClipboardPort;
  rendererDirectory?: string;
  captureOrigin: () => string;
  now?: () => Date;
}

interface Session {
  expiresAt: number;
}

interface ContinuousCapturePermission {
  documentType: DocumentType;
  profileName: string;
  selectedFieldIds: string[];
  expiresAt: number;
  used: boolean;
}

const SESSION_COOKIE = "medical_encoder_session";
const SESSION_TTL = 8 * 60 * 60 * 1000;
const UPLOAD_TTL = 10 * 60 * 1000;
const IMAGE_RETENTION = 7 * 24 * 60 * 60 * 1000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });

function initialAlignment(documentType: DocumentType): PatientCase["alignment"] {
  if (documentType === "xray") {
    return { ...DEFAULT_ALIGNMENT, top: 0.16, bottom: 0.1 };
  }
  return { ...DEFAULT_ALIGNMENT };
}

function iso(now: Date) {
  return now.toISOString();
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function parameter(request: Request, name: string) {
  return String(request.params[name]);
}

function localRequest(request: Request) {
  const remote = request.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character] ?? character));
}

function phoneShell(title: string, content: string, script = "") {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${escapeHtml(title)} | Encodex</title><link rel="stylesheet" href="/capture.css"></head><body><main class="phone-shell"><header class="phone-brand"><span>EX</span><strong>Encodex</strong></header>${content}</main>${script}</body></html>`;
}

function capturePage(token: string, continuousCapture = false, nextPaper = false) {
  const action = nextPaper ? `/capture/${escapeHtml(token)}/next` : `/capture/${escapeHtml(token)}`;
  return phoneShell("Capture document", `
    <section class="mobile-capture">
      <p class="eyebrow">${nextPaper ? "Continuous capture" : "Phone capture"}</p>
      <h1>${nextPaper ? "Scan next paper" : "Scan document"}</h1>
      <p class="lead">${nextPaper ? "The same selected fields will be collected again." : "Fill the frame with one clear page."}</p>
      <form id="capture-form" method="post" enctype="multipart/form-data" action="${action}">
        <label class="pick">
          <span class="pick-title">Take or choose photo</span>
          <span class="pick-meta">JPEG, PNG, or WebP / up to 12 MB</span>
          <input required name="document" id="document-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment">
        </label>
        <img id="photo-preview" class="photo-preview" alt="Selected document preview" hidden>
        <p id="file-state" class="file-state" aria-live="polite">No photo selected</p>
        <button id="send-photo" type="submit">Send to Laptop</button>
      </form>
      ${continuousCapture && !nextPaper ? `<p class="mode-note">Continuous mode is on. After this upload, continue with the next paper without rescanning the QR code.</p>` : ""}
      <p class="privacy-note">Uploads to this laptop over the local network.</p>
    </section>
  `, `<script defer src="/capture.js"></script>`);
}

function phoneResultPage(success: boolean, title: string, message: string, nextToken?: string) {
  return phoneShell(title, `
    <section class="mobile-result ${success ? "success" : "error"}">
      <span class="result-mark" aria-hidden="true">${success ? "&#10003;" : "!"}</span>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      ${nextToken ? `
        <a class="next-action" href="/capture/${escapeHtml(nextToken)}/next">Capture Next Paper</a>
        <p class="queue-note">Same profile and selected fields only.</p>
      ` : ""}
    </section>
  `);
}

function requireCase(data: { cases: PatientCase[] }, caseId: string) {
  const patientCase = data.cases.find((entry) => entry.id === caseId);
  if (!patientCase) {
    throw new Error("Case not found.");
  }
  return patientCase;
}

function selectedValuesOnly(patientCase: PatientCase, values: Record<string, StoredValue>) {
  const selected = new Set(patientCase.selectedFieldIds);
  return Object.fromEntries(Object.entries(values).filter(([fieldId]) => selected.has(fieldId)));
}

export function createServer(dependencies: ServerDependencies) {
  const app = express();
  const sessions = new Map<string, Session>();
  const continuousCaptures = new Map<string, ContinuousCapturePermission>();
  let clipboardRevision = 0;
  const now = () => dependencies.now?.() ?? new Date();

  app.disable("x-powered-by");
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        "upgrade-insecure-requests": null
      }
    }
  }));

  app.get("/capture.css", (_request, response) => {
    response.type("text/css").send(`
      :root { --surface: #fff; --page: #f1f5f5; --text: #15282e; --muted: #566a70; --line: #d2dcdf; --primary: #08776d; --primary-dark: #075b54; --error: #a23930; }
      * { box-sizing: border-box; letter-spacing: 0; }
      body { margin: 0; min-height: 100svh; background: var(--page); color: var(--text); font-family: "Segoe UI", Arial, sans-serif; }
      .phone-shell { width: min(100%, 480px); min-height: 100svh; margin: 0 auto; padding: max(20px, env(safe-area-inset-top)) 18px calc(24px + env(safe-area-inset-bottom)); background: var(--surface); }
      .phone-brand { height: 46px; display: flex; align-items: center; gap: 10px; margin-bottom: 34px; }
      .phone-brand span { width: 38px; height: 38px; border-radius: 7px; display: grid; place-items: center; background: #e6f2ef; color: var(--primary-dark); font-size: 13px; font-weight: 700; }
      .phone-brand strong { font-size: 17px; }
      .eyebrow { margin: 0 0 9px; color: var(--primary); font-size: 12px; font-weight: 700; text-transform: uppercase; }
      h1 { margin: 0; font-size: 29px; line-height: 1.18; font-weight: 650; }
      .lead { margin: 9px 0 30px; color: var(--muted); font-size: 16px; line-height: 1.45; }
      form { display: grid; gap: 14px; }
      .pick { position: relative; min-height: 116px; border: 1px dashed #8da7ad; border-radius: 7px; padding: 24px 18px; background: #f7faf9; display: grid; place-content: center; text-align: center; gap: 8px; color: var(--primary-dark); }
      .pick:focus-within { outline: 2px solid #83bbb5; border-color: var(--primary); }
      .pick-title { font-size: 16px; font-weight: 650; }
      .pick-meta { color: var(--muted); font-size: 12px; }
      .pick input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
      .photo-preview { width: 100%; max-height: 240px; object-fit: contain; border: 1px solid var(--line); border-radius: 7px; background: #f4f7f7; }
      .file-state { min-height: 20px; margin: 0; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
      .file-state.invalid { color: var(--error); }
      button { height: 52px; margin-top: 8px; border: 0; border-radius: 7px; background: var(--primary); color: #fff; font: inherit; font-size: 16px; font-weight: 650; }
      button:disabled { opacity: .62; }
      button:active:not(:disabled) { background: var(--primary-dark); }
      .mode-note { margin: 3px 0 0; padding: 12px 13px; border-radius: 7px; background: #edf7f5; color: var(--primary-dark); font-size: 13px; line-height: 1.45; }
      .privacy-note { margin: 25px 0 0; padding: 14px 0 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; line-height: 1.45; }
      .mobile-result { min-height: calc(100svh - 112px); display: grid; align-content: center; justify-items: center; text-align: center; padding: 20px; }
      .result-mark { width: 54px; height: 54px; margin-bottom: 20px; display: grid; place-items: center; border-radius: 50%; background: #e6f4ef; color: var(--primary); font-size: 28px; font-weight: 650; }
      .mobile-result.error .result-mark { background: #fbebea; color: var(--error); }
      .mobile-result p { max-width: 310px; margin: 11px 0 0; color: var(--muted); font-size: 15px; line-height: 1.45; }
      .next-action { width: 100%; height: 52px; margin-top: 30px; border-radius: 7px; background: var(--primary); color: #fff; display: inline-flex; align-items: center; justify-content: center; text-decoration: none; font-size: 16px; font-weight: 650; }
      .next-action:active { background: var(--primary-dark); }
      .mobile-result .queue-note { margin-top: 12px; font-size: 12px; }
    `);
  });

  app.get("/capture.js", (_request, response) => {
    response.type("application/javascript").send(`
      (() => {
        const input = document.getElementById("document-photo");
        const preview = document.getElementById("photo-preview");
        const status = document.getElementById("file-state");
        const form = document.getElementById("capture-form");
        const button = document.getElementById("send-photo");
        const maximumBytes = 12 * 1024 * 1024;
        let previewUrl = "";
        input.addEventListener("change", () => {
          const file = input.files && input.files[0];
          status.classList.remove("invalid");
          button.disabled = false;
          if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
            previewUrl = "";
          }
          if (!file) {
            status.textContent = "No photo selected";
            preview.hidden = true;
            return;
          }
          if (file.size > maximumBytes) {
            status.textContent = "This photo is over 12 MB. Choose a smaller image or retake it.";
            status.classList.add("invalid");
            preview.hidden = true;
            button.disabled = true;
            return;
          }
          status.textContent = file.name;
          previewUrl = URL.createObjectURL(file);
          preview.src = previewUrl;
          preview.hidden = false;
        });
        form.addEventListener("submit", () => {
          button.disabled = true;
          button.textContent = "Sending photo...";
        });
      })();
    `);
  });

  app.get("/capture/:token", async (request, response) => {
    try {
      if (!dependencies.store.isUnlocked()) {
        response.status(423).type("html").send(phoneResultPage(false, "Laptop is locked", "Unlock Encodex on the laptop, then create a new QR link."));
        return;
      }
      const data = await dependencies.store.readData();
      const token = parameter(request, "token");
      const patientCase = data.cases.find((entry) => entry.uploadTokenHash === hashToken(token));
      if (!patientCase || patientCase.uploadUsed || !patientCase.uploadExpiresAt || new Date(patientCase.uploadExpiresAt) <= now()) {
        response.status(410).type("html").send(phoneResultPage(false, "Link unavailable", "Create a new phone capture link on the laptop and try again."));
        return;
      }
      response.type("html").send(capturePage(token, Boolean(patientCase.continuousCapture)));
    } catch (error) {
      response.status(400).type("html").send(phoneResultPage(false, "Unable to open capture", (error as Error).message));
    }
  });

  app.post("/capture/:token", (request, response) => {
    upload.single("document")(request, response, (uploadError) => {
      if (uploadError) {
        const message = uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE"
          ? "This photo is over 12 MB. Choose a smaller image or retake it."
          : "Choose one JPEG, PNG, or WebP document photo and try again.";
        response.status(400).type("html").send(phoneResultPage(false, "Photo not sent", message));
        return;
      }
      void (async () => {
        try {
          if (!dependencies.store.isUnlocked()) {
            response.status(423).type("html").send(phoneResultPage(false, "Laptop is locked", "Unlock Encodex on the laptop, then create a new QR link."));
            return;
          }
          if (!request.file || !["image/jpeg", "image/png", "image/webp"].includes(request.file.mimetype)) {
            response.status(400).type("html").send(phoneResultPage(false, "Photo not sent", "Choose one JPEG, PNG, or WebP document photo and try again."));
            return;
          }
          const tokenHash = hashToken(parameter(request, "token"));
          const data = await dependencies.store.readData();
          const patientCase = data.cases.find((entry) => entry.uploadTokenHash === tokenHash);
          if (!patientCase || patientCase.uploadUsed || !patientCase.uploadExpiresAt || new Date(patientCase.uploadExpiresAt) <= now()) {
            response.status(410).type("html").send(phoneResultPage(false, "Link unavailable", "Create a new phone capture link on the laptop and try again."));
            return;
          }
          await storeUploadedPhoto(patientCase, request.file);
          await dependencies.store.updateData((stored) => {
            const destination = requireCase(stored, patientCase.id);
            Object.assign(destination, patientCase);
          });
          if (patientCase.continuousCapture) {
            grantContinuation(parameter(request, "token"), patientCase);
          }
          response.type("html").send(phoneResultPage(
            true,
            "Photo sent",
            patientCase.continuousCapture ? "This paper is queued on the laptop. Continue scanning or review it there." : "Continue on the laptop to review the selected fields.",
            patientCase.continuousCapture ? parameter(request, "token") : undefined
          ));
        } catch (error) {
          response.status(400).type("html").send(phoneResultPage(false, "Photo not sent", (error as Error).message));
        }
      })();
    });
  });

  app.get("/capture/:token/next", async (request, response) => {
    try {
      if (!dependencies.store.isUnlocked()) {
        response.status(423).type("html").send(phoneResultPage(false, "Laptop is locked", "Unlock Encodex on the laptop before continuing."));
        return;
      }
      if (!continuationPermission(parameter(request, "token"))) {
        response.status(410).type("html").send(phoneResultPage(false, "Capture finished", "Create a new continuous capture on the laptop to continue."));
        return;
      }
      response.type("html").send(capturePage(parameter(request, "token"), true, true));
    } catch (error) {
      response.status(400).type("html").send(phoneResultPage(false, "Unable to continue", (error as Error).message));
    }
  });

  app.post("/capture/:token/next", (request, response) => {
    upload.single("document")(request, response, (uploadError) => {
      if (uploadError) {
        const message = uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE"
          ? "This photo is over 12 MB. Choose a smaller image or retake it."
          : "Choose one JPEG, PNG, or WebP document photo and try again.";
        response.status(400).type("html").send(phoneResultPage(false, "Photo not sent", message));
        return;
      }
      void (async () => {
        try {
          if (!dependencies.store.isUnlocked()) {
            response.status(423).type("html").send(phoneResultPage(false, "Laptop is locked", "Unlock Encodex on the laptop before continuing."));
            return;
          }
          if (!request.file || !["image/jpeg", "image/png", "image/webp"].includes(request.file.mimetype)) {
            response.status(400).type("html").send(phoneResultPage(false, "Photo not sent", "Choose one JPEG, PNG, or WebP document photo and try again."));
            return;
          }
          const continuation = continuationPermission(parameter(request, "token"));
          if (!continuation) {
            response.status(410).type("html").send(phoneResultPage(false, "Capture finished", "Create a new continuous capture on the laptop to continue."));
            return;
          }
          continuation.used = true;
          try {
            const nextCase = newPatientCase(continuation.documentType, continuation.profileName, continuation.selectedFieldIds, true);
            const nextCapability = issueUploadCapability(nextCase);
            await storeUploadedPhoto(nextCase, request.file);
            await dependencies.store.updateData((stored) => {
              stored.cases.unshift(nextCase);
            });
            grantContinuation(nextCapability.token, nextCase);
            response.type("html").send(phoneResultPage(true, "Photo sent", "This paper is queued on the laptop. Continue scanning or review it there.", nextCapability.token));
          } catch (error) {
            continuation.used = false;
            throw error;
          }
        } catch (error) {
          response.status(400).type("html").send(phoneResultPage(false, "Photo not sent", (error as Error).message));
        }
      })();
    });
  });

  app.use("/api", (request, response, next) => {
    if (!localRequest(request)) {
      response.status(403).json({ error: "The desktop application may only be used on this laptop." });
      return;
    }
    next();
  });
  app.use("/api", cookieParser(), express.json({ limit: "1mb" }));

  app.get("/api/status", async (request, response) => {
    const token = request.cookies?.[SESSION_COOKIE] as string | undefined;
    const session = token ? sessions.get(token) : undefined;
    const sessionUnlocked = dependencies.store.isUnlocked() && Boolean(session && session.expiresAt > now().getTime());
    response.json({ initialized: await dependencies.store.initialized(), unlocked: sessionUnlocked });
  });

  function createSession(response: Response) {
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { expiresAt: now().getTime() + SESSION_TTL });
    response.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      maxAge: SESSION_TTL
    });
  }

  app.post("/api/setup", async (request, response, next) => {
    try {
      await dependencies.store.setup(String(request.body.password ?? ""));
      createSession(response);
      response.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/login", async (request, response, next) => {
    try {
      if (!(await dependencies.store.unlock(String(request.body.password ?? "")))) {
        response.status(401).json({ error: "Incorrect app password." });
        return;
      }
      await dependencies.store.purgeExpiredImages(now());
      createSession(response);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  function authenticated(request: Request, response: Response, next: NextFunction) {
    const token = request.cookies?.[SESSION_COOKIE] as string | undefined;
    const session = token ? sessions.get(token) : undefined;
    if (!dependencies.store.isUnlocked() || !session || session.expiresAt <= now().getTime()) {
      response.status(401).json({ error: "Unlock the application to continue." });
      return;
    }
    session.expiresAt = now().getTime() + SESSION_TTL;
    next();
  }

  app.use("/api", (request, response, next) => {
    if (["/status", "/setup", "/login"].includes(request.path)) {
      next();
      return;
    }
    authenticated(request, response, next);
  });

  app.post("/api/logout", (_request, response) => {
    dependencies.store.lock();
    sessions.clear();
    response.clearCookie(SESSION_COOKIE);
    response.json({ ok: true });
  });

  app.get("/api/config", async (_request, response) => {
    const data = await dependencies.store.readData();
    response.json({
      fields: FIELDS,
      presets: [...BUILT_IN_PRESETS, ...data.customPresets],
      masterPatientCount: data.masterPatients.length
    });
  });

  app.post("/api/presets", async (request, response, next) => {
    try {
      const documentType = request.body.documentType as DocumentType;
      const fieldIds = request.body.fieldIds as string[];
      const name = String(request.body.name ?? "").trim();
      if (!name || !isDocumentType(documentType) || !validSelectedFields(documentType, fieldIds)) {
        response.status(400).json({ error: "Choose a name, document type, and at least one supported field." });
        return;
      }
      const preset: CapturePreset = {
        id: dependencies.store.newId(),
        name,
        builtIn: false,
        documentType,
        fieldIds
      };
      await dependencies.store.updateData((data) => {
        data.customPresets.push(preset);
      });
      response.status(201).json(preset);
    } catch (error) {
      next(error);
    }
  });

  function issueUploadCapability(patientCase: PatientCase) {
    const token = randomBytes(28).toString("hex");
    patientCase.uploadTokenHash = hashToken(token);
    patientCase.uploadExpiresAt = new Date(now().getTime() + UPLOAD_TTL).toISOString();
    patientCase.uploadUsed = false;
    patientCase.updatedAt = iso(now());
    const url = `${dependencies.captureOrigin()}/capture/${token}`;
    return { token, url };
  }

  async function issueUploadLink(patientCase: PatientCase) {
    const { url } = issueUploadCapability(patientCase);
    return { url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 280 }) };
  }

  function newPatientCase(documentType: DocumentType, profileName: string, fieldIds: string[], continuousCapture: boolean): PatientCase {
    const timestamp = iso(now());
    return {
      id: dependencies.store.newId(),
      documentType,
      profileName,
      selectedFieldIds: [...new Set(fieldIds)],
      continuousCapture,
      values: {},
      alignment: initialAlignment(documentType),
      createdAt: timestamp,
      updatedAt: timestamp
    };
  }

  async function storeUploadedPhoto(patientCase: PatientCase, file: Express.Multer.File) {
    const imageId = dependencies.store.newId();
    await dependencies.store.storeImage(imageId, file.buffer);
    if (patientCase.image) {
      await dependencies.store.deleteImage(patientCase.image.id);
    }
    patientCase.image = {
      id: imageId,
      uploadedAt: iso(now()),
      expiresAt: new Date(now().getTime() + IMAGE_RETENTION).toISOString(),
      mimeType: file.mimetype
    };
    patientCase.uploadUsed = true;
    if (patientCase.continuousCapture) {
      patientCase.uploadExpiresAt = new Date(now().getTime() + UPLOAD_TTL).toISOString();
    }
    patientCase.updatedAt = iso(now());
  }

  function grantContinuation(token: string, patientCase: PatientCase) {
    continuousCaptures.set(hashToken(token), {
      documentType: patientCase.documentType,
      profileName: patientCase.profileName,
      selectedFieldIds: [...patientCase.selectedFieldIds],
      expiresAt: now().getTime() + UPLOAD_TTL,
      used: false
    });
  }

  function continuationPermission(token: string) {
    const tokenHash = hashToken(token);
    const permission = continuousCaptures.get(tokenHash);
    if (!permission || permission.used || permission.expiresAt <= now().getTime()) {
      continuousCaptures.delete(tokenHash);
      return undefined;
    }
    return permission;
  }

  app.post("/api/cases", async (request, response, next) => {
    try {
      const documentType = request.body.documentType as DocumentType;
      const fieldIds = request.body.fieldIds as string[];
      const profileName = String(request.body.profileName ?? "").trim();
      const linkToCaseId = request.body.linkToCaseId ? String(request.body.linkToCaseId) : undefined;
      const continuousCapture = request.body.continuousCapture === true && !linkToCaseId;
      if (!isDocumentType(documentType) || !validSelectedFields(documentType, fieldIds) || !profileName) {
        response.status(400).json({ error: "Choose a supported form and one or more fields before capture." });
        return;
      }
      const timestamp = iso(now());
      const patientCase = newPatientCase(documentType, profileName, fieldIds, continuousCapture);
      const capture = await issueUploadLink(patientCase);
      await dependencies.store.updateData((data) => {
        if (linkToCaseId) {
          const relatedCase = requireCase(data, linkToCaseId);
          const groupId = relatedCase.patientGroupId ?? relatedCase.id;
          relatedCase.patientGroupId = groupId;
          relatedCase.updatedAt = timestamp;
          patientCase.patientGroupId = groupId;
        }
        data.cases.unshift(patientCase);
      });
      response.status(201).json({ patientCase: safeCase(patientCase), capture });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cases", async (_request, response) => {
    const data = await dependencies.store.readData();
    response.json(data.cases.map(safeCase));
  });

  app.get("/api/cases/:caseId", async (request, response) => {
    const data = await dependencies.store.readData();
    response.json(safeCase(requireCase(data, parameter(request, "caseId"))));
  });

  app.post("/api/cases/:caseId/capture-link", async (request, response, next) => {
    try {
      const data = await dependencies.store.readData();
      const patientCase = requireCase(data, parameter(request, "caseId"));
      const capture = await issueUploadLink(patientCase);
      await dependencies.store.updateData((stored) => Object.assign(requireCase(stored, patientCase.id), patientCase));
      response.json(capture);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cases/:caseId/image", async (request, response, next) => {
    try {
      const patientCase = requireCase(await dependencies.store.readData(), parameter(request, "caseId"));
      if (!patientCase.image) {
        response.status(404).json({ error: "This case has no active source image." });
        return;
      }
      response.type(patientCase.image.mimeType).send(await dependencies.store.readImage(patientCase.image.id));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/cases/:caseId/alignment", async (request, response, next) => {
    try {
      const rotation = Number(request.body.rotation);
      const top = Number(request.body.top);
      const right = Number(request.body.right);
      const bottom = Number(request.body.bottom);
      const left = Number(request.body.left);
      if (![0, 90, 180, 270].includes(rotation) || [top, right, bottom, left].some((value) => !Number.isFinite(value) || value < 0 || value > 0.35) || top + bottom > 0.6 || left + right > 0.6) {
        response.status(400).json({ error: "Alignment values are outside the supported document frame." });
        return;
      }
      let updated: PatientCase | undefined;
      await dependencies.store.updateData((data) => {
        const patientCase = requireCase(data, parameter(request, "caseId"));
        patientCase.alignment = { rotation: rotation as 0 | 90 | 180 | 270, top, right, bottom, left };
        patientCase.updatedAt = iso(now());
        updated = patientCase;
      });
      response.json(safeCase(updated!));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cases/:caseId/ocr", async (request, response, next) => {
    try {
      const patientCase = requireCase(await dependencies.store.readData(), parameter(request, "caseId"));
      if (!patientCase.image) {
        response.status(400).json({ error: "Capture a document photo before reading typed fields." });
        return;
      }
      const permitted = new Set(patientCase.selectedFieldIds);
      if (requiresMasterMatch(patientCase.selectedFieldIds) && supportsTypedName(patientCase.documentType)) {
        permitted.add("observed_name");
      }
      const requested = Array.isArray(request.body.fieldIds) ? (request.body.fieldIds as string[]) : [...permitted];
      if (requested.some((fieldId) => !permitted.has(fieldId))) {
        response.status(400).json({ error: "OCR is restricted to the selected capture profile." });
        return;
      }
      const ocrFields = requested.flatMap((fieldId) => {
        const field = FIELDS.find((entry) => entry.id === fieldId);
        return field && sourceForDocument(field, patientCase.documentType) === "ocr" ? [field] : [];
      });
      const suggestions = await dependencies.ocr.recognizeSelected(
        await dependencies.store.readImage(patientCase.image.id),
        patientCase.documentType,
        ocrFields,
        patientCase.alignment
      );
      response.json({ suggestions });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/cases/:caseId/review", async (request, response, next) => {
    try {
      const supplied = (request.body.values ?? {}) as Record<string, StoredValue>;
      let updated: PatientCase | undefined;
      await dependencies.store.updateData((data) => {
        const patientCase = requireCase(data, parameter(request, "caseId"));
        if (!patientCase.image) {
          throw new Error("Capture a document photo before reviewing selected fields.");
        }
        const selected = new Set(patientCase.selectedFieldIds);
        if (Object.keys(supplied).some((fieldId) => !selected.has(fieldId))) {
          throw new Error("Only fields chosen before capture may be retained.");
        }
        const reviewable = Object.entries(supplied).filter(([fieldId, entry]) => {
          const field = FIELDS.find((candidate) => candidate.id === fieldId)!;
          if (sourceForDocument(field, patientCase.documentType) !== "master") {
            return true;
          }
          const submittedValue = String(entry.value ?? "").trim();
          const existingValue = patientCase.values[fieldId]?.value ?? "";
          if (submittedValue && submittedValue !== existingValue) {
            throw new Error("Official identity values may only be set through a confirmed patient match.");
          }
          return false;
        });
        const cleaned = Object.fromEntries(
          reviewable.map(([fieldId, entry]) => [
            fieldId,
            {
              value: String(entry.value ?? "").trim(),
              confirmed: Boolean(entry.confirmed),
              confidence: typeof entry.confidence === "number" ? entry.confidence : undefined,
              confirmedAt: entry.confirmed ? iso(now()) : undefined
            }
          ])
        );
        const identityChanged = ["observed_name", "birthdate"].some((fieldId) => {
          const nextValue = cleaned[fieldId]?.value;
          return nextValue !== undefined && nextValue !== patientCase.values[fieldId]?.value;
        });
        if (identityChanged && patientCase.matchedPatientId) {
          delete patientCase.values.confirmed_official_name;
          delete patientCase.values.philhealth_id;
          patientCase.matchedPatientId = undefined;
          patientCase.observedNameForMatch = undefined;
        }
        patientCase.values = selectedValuesOnly(patientCase, { ...patientCase.values, ...cleaned });
        patientCase.updatedAt = iso(now());
        updated = patientCase;
      });
      response.json(safeCase(updated!));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cases/:caseId/match", async (request, response, next) => {
    try {
      const data = await dependencies.store.readData();
      const patientCase = requireCase(data, parameter(request, "caseId"));
      if (!patientCase.image) {
        response.status(400).json({ error: "Capture a document photo before matching a patient." });
        return;
      }
      if (!requiresMasterMatch(patientCase.selectedFieldIds)) {
        response.status(400).json({ error: "This capture profile does not request corrected identity data." });
        return;
      }
      const candidates = findCandidates(data.masterPatients, String(request.body.observedName ?? ""), String(request.body.birthdate ?? ""))
        .map((candidate) => patientCase.selectedFieldIds.includes("philhealth_id") ? candidate : { ...candidate, philhealthId: undefined });
      response.json({ candidates });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cases/:caseId/match/confirm", async (request, response, next) => {
    try {
      const observedName = String(request.body.observedName ?? "").trim();
      const birthdate = String(request.body.birthdate ?? "").trim();
      const patientId = String(request.body.patientId ?? "");
      let updated: PatientCase | undefined;
      await dependencies.store.updateData((data) => {
        const patientCase = requireCase(data, parameter(request, "caseId"));
        if (!patientCase.image) {
          throw new Error("Capture a document photo before confirming a patient match.");
        }
        if (!requiresMasterMatch(patientCase.selectedFieldIds)) {
          throw new Error("This capture profile does not request corrected identity data.");
        }
        const selectedCandidate = findCandidates(data.masterPatients, observedName, birthdate).find((candidate) => candidate.patientId === patientId);
        if (!selectedCandidate) {
          throw new Error("The selected patient match is no longer valid.");
        }
        const confirmed: StoredValue = { value: selectedCandidate.officialName, confirmed: true, confirmedAt: iso(now()) };
        if (patientCase.selectedFieldIds.includes("confirmed_official_name")) {
          patientCase.values.confirmed_official_name = confirmed;
          patientCase.observedNameForMatch = observedName;
        }
        if (patientCase.selectedFieldIds.includes("philhealth_id")) {
          patientCase.values.philhealth_id = { value: selectedCandidate.philhealthId ?? "", confirmed: true, confirmedAt: iso(now()) };
        }
        if (patientCase.selectedFieldIds.includes("birthdate")) {
          patientCase.values.birthdate = { value: selectedCandidate.birthdate, confirmed: true, confirmedAt: iso(now()) };
        }
        patientCase.matchedPatientId = selectedCandidate.patientId;
        patientCase.updatedAt = iso(now());
        updated = patientCase;
      });
      response.json(safeCase(updated!));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cases/:caseId/copy/:fieldId", async (request, response, next) => {
    try {
      const patientCase = requireCase(await dependencies.store.readData(), parameter(request, "caseId"));
      const fieldId = parameter(request, "fieldId");
      if (!patientCase.selectedFieldIds.includes(fieldId) || !patientCase.values[fieldId]?.confirmed) {
        response.status(400).json({ error: "Review and confirm this selected field before copying." });
        return;
      }
      dependencies.clipboard.writeText(patientCase.values[fieldId].value);
      const thisCopy = ++clipboardRevision;
      setTimeout(() => {
        if (clipboardRevision === thisCopy) {
          dependencies.clipboard.clear();
        }
      }, 60_000);
      response.json({ ok: true, clearsAfterSeconds: 60 });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/clipboard/clear", (_request, response) => {
    clipboardRevision += 1;
    dependencies.clipboard.clear();
    response.json({ ok: true });
  });

  app.post("/api/master/preview", upload.single("file"), async (request, response, next) => {
    try {
      if (!request.file) {
        response.status(400).json({ error: "Select a patient master CSV or Excel file." });
        return;
      }
      const rows = await parsePatientRows(request.file.buffer, request.file.originalname);
      const headers = rows[0] ?? [];
      response.json({ headers, rowCount: Math.max(0, rows.length - 1), suggestedMapping: suggestMapping(headers) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/master/import", upload.single("file"), async (request, response, next) => {
    try {
      if (!request.file) {
        response.status(400).json({ error: "Select a patient master CSV or Excel file." });
        return;
      }
      const mapping = JSON.parse(String(request.body.mapping ?? "{}")) as ImportMapping;
      const rows = await parsePatientRows(request.file.buffer, request.file.originalname);
      const patients = rowsToPatients(rows, mapping);
      await dependencies.store.updateData((data) => {
        data.masterPatients = patients;
        data.audit.push({
          type: "master_list_replaced",
          createdAt: iso(now()),
          detail: `Approved patient master replaced with ${patients.length} entries.`
        });
      });
      response.status(201).json({ imported: patients.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/export", async (request, response, next) => {
    try {
      const data = await dependencies.store.readData();
      const caseIds = Array.isArray(request.body.caseIds) ? new Set(request.body.caseIds as string[]) : undefined;
      const cases = caseIds ? data.cases.filter((patientCase) => caseIds.has(patientCase.id)) : data.cases;
      await dependencies.store.updateData((stored) => {
        stored.audit.push({ type: "csv_export", createdAt: iso(now()), detail: `${cases.length} selected case(s) exported.` });
      });
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="encodex-export-${now().toISOString().slice(0, 10)}.csv"`);
      response.send(exportCasesCsv(cases));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cases/:caseId/complete", async (request, response, next) => {
    try {
      const patientCase = requireCase(await dependencies.store.readData(), parameter(request, "caseId"));
      if (!patientCase.selectedFieldIds.every((fieldId) => patientCase.values[fieldId]?.confirmed)) {
        response.status(400).json({ error: "Every selected field must be reviewed before marking official entry complete." });
        return;
      }
      await dependencies.store.removeCompletedCase(patientCase.id);
      response.json({ ok: true, deleted: true });
    } catch (error) {
      next(error);
    }
  });

  if (dependencies.rendererDirectory && existsSync(dependencies.rendererDirectory)) {
    app.use((request, response, next) => {
      if (!localRequest(request)) {
        response.status(403).send("Open the capture link provided by the laptop application.");
        return;
      }
      next();
    });
    app.use(express.static(dependencies.rendererDirectory));
    app.get("/{*path}", (_request, response) => {
      response.sendFile(path.join(dependencies.rendererDirectory!, "index.html"));
    });
  }

  app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
    response.status(400).json({ error: error.message || "The request could not be completed." });
  });

  return app;
}
