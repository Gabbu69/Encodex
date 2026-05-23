import { createRequire } from "node:module";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import type { Alignment, DocumentType, FieldDefinition } from "../shared/domain.js";

const require = createRequire(import.meta.url);
const englishData = require("@tesseract.js-data/eng") as { langPath: string; gzip: boolean };
const MULTILINE_FIELD_IDS = new Set(["findings", "impression"]);
const ENLARGED_SINGLE_LINE_FIELD_IDS = new Set(["observed_name", "pregnancy_test_result"]);

export interface OcrSuggestion {
  fieldId: string;
  text: string;
  confidence: number;
  qualityWarning?: string;
}

export function normalizeRecognizedText(fieldId: string, text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (fieldId === "observed_name") {
    return normalized.replace(/^NAME\s*[:.-]?\s*/i, "").trim();
  }
  return normalized;
}

interface NameCandidate {
  text: string;
  confidence: number;
}

export function usableNameText(text: string) {
  const words = text.match(/[A-Za-z]{2,}/g) ?? [];
  return words.length >= 2 && words.join("").length >= 6;
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
  return scored[0]?.score >= 0 ? { text: scored[0].text, confidence: scored[0].confidence } : { text: "", confidence: 0 };
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
    alignment: Alignment
  ): Promise<OcrSuggestion[]> {
    const aligned = await alignDocument(bytes, alignment);
    const metadata = await sharp(aligned).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error("Unable to read captured image dimensions.");
    }
    const worker = await this.getWorker();
    const suggestions: OcrSuggestion[] = [];
    for (const field of fields) {
      const region = field.region?.[documentType];
      if (!region) {
        continue;
      }
      const left = Math.round(region.left * metadata.width);
      const top = Math.round(region.top * metadata.height);
      const width = Math.max(1, Math.round(region.width * metadata.width));
      const height = Math.max(1, Math.round(region.height * metadata.height));
      if (field.id === "observed_name") {
        const nameSuggestion = await this.recognizeName(worker, aligned, { left, top, width, height });
        suggestions.push({
          fieldId: field.id,
          ...nameSuggestion,
          qualityWarning: height < 14 || nameSuggestion.confidence < 65
            ? "Image quality is low for reliable name reading. Retake a close-up photo of the physical paper, not a screen, or type and review the name manually."
            : undefined
        });
        continue;
      }
      const enlarge = MULTILINE_FIELD_IDS.has(field.id) || ENLARGED_SINGLE_LINE_FIELD_IDS.has(field.id);
      let cropPipeline = sharp(aligned)
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
    region: { left: number; top: number; width: number; height: number }
  ): Promise<NameCandidate> {
    await worker.setParameters({
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz,.' -",
      preserve_interword_spaces: "1"
    });
    const candidates: NameCandidate[] = [];
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
      const result = await worker.recognize(await pipeline.png().toBuffer());
      candidates.push({
        text: normalizeRecognizedText("observed_name", result.data.text),
        confidence: Math.round(result.data.confidence)
      });
    }
    return bestNameCandidate(candidates);
  }
}
