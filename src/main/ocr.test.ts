import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { alignDocument, bestNameCandidate, normalizeRecognizedText, usableNameText } from "./ocr.js";

describe("document rotation and alignment", () => {
  it("crops against rotated dimensions for a sideways photographed page", async () => {
    const sideways = await sharp({
      create: { width: 200, height: 400, channels: 3, background: "#ffffff" }
    }).png().toBuffer();

    const result = await alignDocument(sideways, { rotation: 270, top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 });
    const metadata = await sharp(result).metadata();

    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(160);
  });
});

describe("selected name OCR cleanup", () => {
  it("removes a printed field label without correcting the recognized name", () => {
    expect(normalizeRecognizedText("observed_name", "NAME: SAMPLE, RUBY JEAN\n")).toBe("SAMPLE, RUBY JEAN");
    expect(normalizeRecognizedText("observed_name", "SAMPLO, RUBY JEAN")).toBe("SAMPLO, RUBY JEAN");
  });

  it("does not offer meaningless short fragments as a recognized name", () => {
    expect(usableNameText("Ey")).toBe(false);
    expect(bestNameCandidate([{ text: "Ey", confidence: 70 }])).toEqual({ text: "", confidence: 0 });
  });

  it("chooses a name-like multiword result across image processing passes", () => {
    expect(bestNameCandidate([
      { text: "SE", confidence: 81 },
      { text: "SAMPLE, RUBY JEAN", confidence: 74 },
      { text: "SAMPLE, RUBY IEAN", confidence: 66 }
    ])).toEqual({ text: "SAMPLE, RUBY JEAN", confidence: 74 });
  });
});
