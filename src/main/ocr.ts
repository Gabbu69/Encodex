import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { MIN_RELIABLE_NAME_OCR_CONFIDENCE, type Alignment, type DocumentType, type FieldDefinition, type OcrEngine, type Region } from "../shared/domain.js";

const require = createRequire(import.meta.url);
const englishData = require("@tesseract.js-data/eng") as { langPath: string; gzip: boolean };
const MULTILINE_FIELD_IDS = new Set(["findings", "impression"]);
const ENLARGED_SINGLE_LINE_FIELD_IDS = new Set(["observed_name", "pregnancy_test_result"]);

export interface OcrSuggestion {
  fieldId: string;
  text: string;
  confidence: number;
  ocrEngine?: OcrEngine;
  qualityWarning?: string;
  detectedRegion?: Region;
}

export function normalizeRecognizedText(fieldId: string, text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (fieldId === "observed_name") {
    return normalized
      .replace(/^NAME\s*[:.-]?\s*/i, "")
      .replace(/^(?:N[AI]ME|VIE|ME)\s*[:.-]\s*/i, "")
      .trim();
  }
  return normalized;
}

interface NameCandidate {
  text: string;
  confidence: number;
  ocrEngine?: OcrEngine;
}

const FORM_HEADING_WORDS = new Set([
  "RADIOLOGY",
  "DEPARTMENT",
  "HOSPITAL",
  "UNIVERSITY",
  "FINDINGS",
  "IMPRESSION",
  "PROCEDURE",
  "ROCEDURE",
  "PHYSICIAN",
  "DIAGNOSIS",
  "CHEST",
  "SECTION"
]);
const XRAY_SOURCE_NAME_REGIONS: Region[] = [0.36, 0.37, 0.38, 0.39, 0.4, 0.405, 0.41].map((top) => ({
  left: 0.16,
  top,
  width: 0.29,
  height: 0.018
}));
const WINDOWS_NAME_REVIEW_SCORE = 86;
const WINDOWS_OCR_SCRIPT = String.raw`Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.DataWriter,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$method=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1})[0]
function Await($operation,[Type]$resultType){$task=$method.MakeGenericMethod($resultType).Invoke($null,@($operation));[void]$task.Wait(15000);$task.Result}
$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd())
$stream=[Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
$writer=[Windows.Storage.Streams.DataWriter]::new($stream.GetOutputStreamAt(0))
$writer.WriteBytes($bytes)
[void](Await ($writer.StoreAsync()) ([UInt32]))
[void](Await ($writer.FlushAsync()) ([Boolean]))
[void]$writer.DetachStream()
$stream.Seek(0)
$decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if($null -ne $engine){$result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]);[Console]::Out.Write($result.Text)}`;

async function recognizeWithWindowsOcr(crop: Buffer) {
  if (process.platform !== "win32") {
    return "";
  }
  const encodedScript = Buffer.from(WINDOWS_OCR_SCRIPT, "utf16le").toString("base64");
  return new Promise<string>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }
    );
    let output = "";
    let complete = false;
    const finish = (text: string) => {
      if (!complete) {
        complete = true;
        resolve(text);
      }
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish("");
    }, 18000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.on("error", () => {
      clearTimeout(timeout);
      finish("");
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      finish(code === 0 ? output.trim() : "");
    });
    child.stdin.on("error", () => {
      clearTimeout(timeout);
      finish("");
    });
    child.stdin.end(crop.toString("base64"));
  });
}

const FOLLOWING_NAME_LABEL = /(?:AGE|SEX|DATE|BDATE|BIRTHDATE|TYPE\s+OF\s+PROCEDURE|EXAMINATION\s+DESIRED|PHYSICIAN|REQUESTING\s+PHYSICIAN|SECTION|WARD|CASE\s*#|DIAGNOSIS|OR\s*#|FILE\s+NO)\s*[:.-]?/i;

export function extractNameFromDocumentText(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  const labeled = normalized.match(/\b(?:NAME|N[AI]ME)\s*[:.-]?\s*(.*)$/i);
  if (!labeled) {
    return "";
  }
  const value = labeled[1].split(FOLLOWING_NAME_LABEL, 1)[0] ?? "";
  return normalizeRecognizedText("observed_name", value).replace(/^[_|]+\s*|\s*[_|]+$/g, "").trim();
}

export function usableNameText(text: string) {
  const words = (text.match(/[A-Za-z]{2,}/g) ?? []).map((word) => word.toUpperCase());
  return words.length >= 2 && words.join("").length >= 6 && !words.some((word) => FORM_HEADING_WORDS.has(word));
}

export function bestNameCandidate(candidates: NameCandidate[]) {
  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: usableNameText(candidate.text)
        ? candidate.confidence + (candidate.text.includes(",") ? 8 : 0) + ((candidate.text.match(/[A-Za-z]{2,}/g) ?? []).length >= 3 ? 4 : 0)
        : -1
    }))
    .sort((first, second) => second.score - first.score);
  if (!scored[0] || scored[0].score < 0) {
    return { text: "", confidence: 0 };
  }
  if (scored[0].confidence < MIN_RELIABLE_NAME_OCR_CONFIDENCE) {
    return { text: "", confidence: scored[0].confidence };
  }
  return scored[0].ocrEngine
    ? { text: scored[0].text, confidence: scored[0].confidence, ocrEngine: scored[0].ocrEngine }
    : { text: scored[0].text, confidence: scored[0].confidence };
}

export async function alignDocument(bytes: Buffer, alignment: Alignment) {
  const rotated = await sharp(bytes).rotate(alignment.rotation).png().toBuffer();
  const metadata = await sharp(rotated).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Unable to align source image.");
  }
  const left = Math.round(metadata.width * alignment.left);
  const top = Math.round(metadata.height * alignment.top);
  const width = Math.round(metadata.width * (1 - alignment.left - alignment.right));
  const height = Math.round(metadata.height * (1 - alignment.top - alignment.bottom));
  if (width < 50 || height < 50) {
    throw new Error("Document alignment leaves too little image area.");
  }
  return sharp(rotated).extract({ left, top, width, height }).png().toBuffer();
}

function longestRun(flags: boolean[]) {
  let best = { start: 0, end: 0 };
  let start = -1;
  flags.forEach((matches, index) => {
    if (matches && start === -1) {
      start = index;
    }
    if ((!matches || index === flags.length - 1) && start !== -1) {
      const end = matches && index === flags.length - 1 ? index + 1 : index;
      if (end - start > best.end - best.start) {
        best = { start, end };
      }
      start = -1;
    }
  });
  return best;
}

function median(values: number[]) {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

export async function suggestXrayScreenAlignment(bytes: Buffer, rotation: Alignment["rotation"]) {
  const rotated = await sharp(bytes).rotate(rotation).png().toBuffer();
  const { data, info } = await sharp(rotated)
    .grayscale()
    .resize({ width: 360 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sampleSize = Math.max(4, Math.min(14, Math.floor(Math.min(info.width, info.height) * 0.04)));
  const frameSamples: number[] = [];
  for (let y = 0; y < sampleSize; y += 1) {
    for (let x = 0; x < sampleSize; x += 1) {
      frameSamples.push(data[y * info.width + x]);
      frameSamples.push(data[y * info.width + info.width - x - 1]);
      frameSamples.push(data[(info.height - y - 1) * info.width + x]);
      frameSamples.push(data[(info.height - y - 1) * info.width + info.width - x - 1]);
    }
  }
  const frameBrightness = median(frameSamples);
  if (frameBrightness > 88) {
    return undefined;
  }
  const contentThreshold = Math.min(145, Math.max(38, frameBrightness + 30));
  const isContent = (x: number, y: number) => data[y * info.width + x] >= contentThreshold;
  const columns = Array.from({ length: info.width }, (_, x) => {
    let content = 0;
    for (let y = 0; y < info.height; y += 1) {
      content += isContent(x, y) ? 1 : 0;
    }
    return content / info.height >= 0.2;
  });
  const rows = Array.from({ length: info.height }, (_, y) => {
    let content = 0;
    for (let x = 0; x < info.width; x += 1) {
      content += isContent(x, y) ? 1 : 0;
    }
    return content / info.width >= 0.2;
  });
  const columnRun = longestRun(columns);
  const rowRun = longestRun(rows);
  if (columnRun.end - columnRun.start < info.width * 0.35 || rowRun.end - rowRun.start < info.height * 0.35) {
    return undefined;
  }
  const outerLeft = columnRun.start / info.width;
  const outerRight = 1 - columnRun.end / info.width;
  const outerTop = rowRun.start / info.height;
  const outerBottom = 1 - rowRun.end / info.height;
  if (Math.max(outerLeft, outerRight, outerTop, outerBottom) < 0.045) {
    return undefined;
  }
  const contentHeight = 1 - outerTop - outerBottom;
  const suggestion: Alignment = {
    rotation,
    left: outerLeft,
    right: outerRight,
    top: outerTop + contentHeight * 0.16,
    bottom: outerBottom + contentHeight * 0.1
  };
  if (
    [suggestion.left, suggestion.right, suggestion.top, suggestion.bottom].some((edge) => edge > 0.35)
    || suggestion.left + suggestion.right > 0.6
    || suggestion.top + suggestion.bottom > 0.6
  ) {
    return undefined;
  }
  return suggestion;
}

export class LocalOcr {
  private worker?: Awaited<ReturnType<typeof Tesseract.createWorker>>;

  async recognizeSelected(
    bytes: Buffer,
    documentType: DocumentType,
    fields: FieldDefinition[],
    alignment: Alignment,
    regionOverrides: Partial<Record<string, Region>> = {}
  ): Promise<OcrSuggestion[]> {
    const aligned = await alignDocument(bytes, alignment);
    const metadata = await sharp(aligned).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Unable to read captured image dimensions.");
    }
    const worker = await this.getWorker();
    const suggestions: OcrSuggestion[] = [];
    let rotated: Buffer | undefined;
    for (const field of fields) {
      const override = regionOverrides[field.id];
      const region = override ?? field.region?.[documentType];
      if (!region) {
        continue;
      }
      let sourceImage = aligned;
      let sourceWidth = metadata.width;
      let sourceHeight = metadata.height;
      if (override) {
        rotated ??= await sharp(bytes).rotate(alignment.rotation).png().toBuffer();
        const rotatedMetadata = await sharp(rotated).metadata();
        if (!rotatedMetadata.width || !rotatedMetadata.height) {
          throw new Error("Unable to read captured image dimensions.");
        }
        sourceImage = rotated;
        sourceWidth = rotatedMetadata.width;
        sourceHeight = rotatedMetadata.height;
      }
      const left = Math.round(region.left * sourceWidth);
      const top = Math.round(region.top * sourceHeight);
      const width = Math.max(1, Math.round(region.width * sourceWidth));
      const height = Math.max(1, Math.round(region.height * sourceHeight));
      if (field.id === "observed_name") {
        let detectedRegion: Region | undefined;
        rotated ??= await sharp(bytes).rotate(alignment.rotation).png().toBuffer();
        let nameSuggestion = override
          ? await this.recognizeName(worker, sourceImage, { left, top, width, height }, true)
          : await this.recognizeNameFromPage(worker, rotated);
        let measuredHeight = height;
        if (!override && (!nameSuggestion.text || nameSuggestion.confidence < 85)) {
          const croppedName = await this.recognizeName(worker, sourceImage, { left, top, width, height }, true);
          if (croppedName.text && croppedName.confidence > nameSuggestion.confidence) {
            nameSuggestion = croppedName;
          }
        }
        if (documentType === "xray" && !override && (!nameSuggestion.text || nameSuggestion.confidence < 85)) {
          const sourceMetadata = await sharp(rotated).metadata();
          if (sourceMetadata.width && sourceMetadata.height) {
            for (const candidateRegion of XRAY_SOURCE_NAME_REGIONS) {
              const candidate = await this.recognizeName(worker, rotated, {
                left: Math.round(candidateRegion.left * sourceMetadata.width),
                top: Math.round(candidateRegion.top * sourceMetadata.height),
                width: Math.round(candidateRegion.width * sourceMetadata.width),
                height: Math.round(candidateRegion.height * sourceMetadata.height)
              }, false);
              if (candidate.text && candidate.confidence > nameSuggestion.confidence) {
                nameSuggestion = candidate;
                detectedRegion = candidateRegion;
                measuredHeight = Math.round(candidateRegion.height * sourceMetadata.height);
              }
              if (candidate.text && candidate.confidence >= 85) {
                break;
              }
            }
          }
        }
        suggestions.push({
          fieldId: field.id,
          ...nameSuggestion,
          detectedRegion,
          qualityWarning: measuredHeight < 14 || nameSuggestion.confidence < 65
            ? "Image quality is low for reliable name reading. Retake a close-up photo of the physical paper, not a screen, or type and review the name manually."
            : undefined
        });
        continue;
      }
      const enlarge = MULTILINE_FIELD_IDS.has(field.id) || ENLARGED_SINGLE_LINE_FIELD_IDS.has(field.id);
      let cropPipeline = sharp(sourceImage)
        .extract({ left, top, width, height })
        .grayscale()
        .normalize();
      if (enlarge) {
        cropPipeline = cropPipeline.resize({ width: width * 3 }).sharpen();
      }
      const crop = await cropPipeline.png().toBuffer();
      const pageSegmentationMode = ENLARGED_SINGLE_LINE_FIELD_IDS.has(field.id)
        ? Tesseract.PSM.SINGLE_LINE
        : MULTILINE_FIELD_IDS.has(field.id)
          ? Tesseract.PSM.AUTO
          : Tesseract.PSM.SINGLE_BLOCK;
      await worker.setParameters({
        tessedit_pageseg_mode: pageSegmentationMode,
        tessedit_char_whitelist: ""
      });
      const result = await worker.recognize(crop);
      suggestions.push({
        fieldId: field.id,
        text: normalizeRecognizedText(field.id, result.data.text),
        confidence: Math.round(result.data.confidence)
      });
    }
    return suggestions;
  }

  async stop() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = undefined;
    }
  }

  private async getWorker() {
    if (!this.worker) {
      this.worker = await Tesseract.createWorker("eng", 1, {
        langPath: englishData.langPath,
        gzip: englishData.gzip,
        cacheMethod: "none"
      });
    }
    return this.worker;
  }

  private async recognizeName(
    worker: Awaited<ReturnType<typeof Tesseract.createWorker>>,
    aligned: Buffer,
    region: { left: number; top: number; width: number; height: number },
    allowWindowsFallback: boolean
  ): Promise<NameCandidate> {
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz,.' -",
      preserve_interword_spaces: "1"
    });
    const candidates: NameCandidate[] = [];
    let windowsCrop: Buffer | undefined;
    for (const pass of [
      { height: 96, threshold: undefined },
      { height: 150, threshold: undefined },
      { height: 110, threshold: 185 }
    ]) {
      let pipeline = sharp(aligned)
        .extract(region)
        .grayscale()
        .resize({ height: Math.max(pass.height, region.height * 4), kernel: "lanczos3" })
        .normalize()
        .sharpen();
      if (pass.threshold !== undefined) {
        pipeline = pipeline.threshold(pass.threshold);
      }
      const crop = await pipeline.png().toBuffer();
      if (pass.height === 150 && pass.threshold === undefined) {
        windowsCrop = crop;
      }
      const result = await worker.recognize(crop);
      candidates.push({
        text: normalizeRecognizedText("observed_name", result.data.text),
        confidence: Math.round(result.data.confidence),
        ocrEngine: "tesseract"
      });
    }
    const tesseractReading = bestNameCandidate(candidates);
    if (allowWindowsFallback && (!tesseractReading.text || tesseractReading.confidence < 90) && windowsCrop) {
      const windowsText = normalizeRecognizedText("observed_name", await recognizeWithWindowsOcr(windowsCrop));
      if (usableNameText(windowsText)) {
        candidates.push({ text: windowsText, confidence: WINDOWS_NAME_REVIEW_SCORE, ocrEngine: "windows" });
      }
    }
    return bestNameCandidate(candidates);
  }

  private async recognizeNameFromPage(
    worker: Awaited<ReturnType<typeof Tesseract.createWorker>>,
    page: Buffer
  ): Promise<NameCandidate> {
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.AUTO,
      tessedit_char_whitelist: "",
      preserve_interword_spaces: "1"
    });
    const metadata = await sharp(page).metadata();
    const sourceWidth = metadata.width ?? 1800;
    const targetWidth = Math.min(3000, Math.max(1800, sourceWidth));
    const candidates: NameCandidate[] = [];
    let windowsPage: Buffer | undefined;
    for (const pass of [
      { normalize: true, threshold: undefined },
      { normalize: true, threshold: 182 }
    ]) {
      let pipeline = sharp(page)
        .resize({ width: targetWidth, withoutEnlargement: false, kernel: "lanczos3" })
        .grayscale()
        .sharpen();
      if (pass.normalize) {
        pipeline = pipeline.normalize();
      }
      if (pass.threshold !== undefined) {
        pipeline = pipeline.threshold(pass.threshold);
      }
      const prepared = await pipeline.png().toBuffer();
      windowsPage ??= prepared;
      const result = await worker.recognize(prepared);
      const text = extractNameFromDocumentText(result.data.text);
      if (usableNameText(text)) {
        candidates.push({
          text,
          confidence: Math.round(result.data.confidence),
          ocrEngine: "tesseract"
        });
      }
    }
    const tesseractReading = bestNameCandidate(candidates);
    if ((!tesseractReading.text || tesseractReading.confidence < 90) && windowsPage) {
      const windowsText = extractNameFromDocumentText(await recognizeWithWindowsOcr(windowsPage));
      if (usableNameText(windowsText)) {
        candidates.push({ text: windowsText, confidence: WINDOWS_NAME_REVIEW_SCORE, ocrEngine: "windows" });
      }
    }
    return bestNameCandidate(candidates);
  }
}
