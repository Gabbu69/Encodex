import { describe, expect, it } from "vitest";
import { BUILT_IN_PRESETS, DOCUMENT_TYPES, fieldsForDocument, presetFields, validSelectedFields } from "./fields.js";

describe("capture profiles", () => {
  it("keeps Name Only restricted to a single document name field", () => {
    const preset = BUILT_IN_PRESETS.find((entry) => entry.id === "name-only")!;
    for (const documentType of DOCUMENT_TYPES) {
      expect(presetFields(preset, documentType)).toEqual(["observed_name"]);
    }
  });

  it("rejects values unavailable on the selected document template", () => {
    expect(validSelectedFields("medical_certificate", ["observed_name", "color"])).toBe(false);
    expect(validSelectedFields("urinalysis", ["observed_name", "color"])).toBe(true);
    expect(validSelectedFields("pregnancy_test", ["observed_name", "pregnancy_test_result"])).toBe(true);
    expect(validSelectedFields("xray", ["observed_name", "findings", "impression"])).toBe(true);
  });

  it("has a typed name crop for each typed supplied form", () => {
    for (const documentType of ["urinalysis", "pregnancy_test", "xray"] as const) {
      const nameField = fieldsForDocument(documentType).find((field) => field.id === "observed_name");
      expect(nameField?.region?.[documentType]).toBeDefined();
    }
  });
});
