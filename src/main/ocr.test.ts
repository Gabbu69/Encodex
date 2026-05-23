import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { alignDocument } from "./ocr.js";

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
