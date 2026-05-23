import { createRequire } from "node:module";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import type { Alignment, DocumentType, FieldDefinition } from "../shared/domain.js";

const require = createRequire(import.meta.url);
const englishData = require("@tesseract.js-data/eng") as { langPath: string; gzip: boolean };
const MULTILINE_FIELD_IDS = new Set(["findings", "impression"]);
const ENLARGED_SINGLE_LINE_FIELD_IDS = new Set(["pregnancy_test_result"]);

export interface OcrSuggestion {
  fieldId: string;
  text: string;
  confidence: number;
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
      const enlarge = MULTILINE_FIELD_IDS.has(field.id) || ENLARGED_SINGLE_LINE_FIELD_IDS.has(field.id);
      let cropPipeline = sharp(aligned)
        .extract({ left, top, width, height })
        .grayscale()
        .normalize();
      if (enlarge) {
        cropPipeline = cropPipeline.resize({ width: width * 2 });
      }
      const crop = await cropPipeline.png().toBuffer();
      const pageSegmentationMode = ENLARGED_SINGLE_LINE_FIELD_IDS.has(field.id)
        ? Tesseract.PSM.SINGLE_LINE
        : MULTILINE_FIELD_IDS.has(field.id)
          ? Tesseract.PSM.AUTO
          : Tesseract.PSM.SINGLE_BLOCK;
      await worker.setParameters({
        tessedit_pageseg_mode: pageSegmentationMode
      });
      const result = await worker.recognize(crop);
      suggestions.push({
        fieldId: field.id,
        text: result.data.text.replace(/\s+/g, " ").trim(),
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
}
