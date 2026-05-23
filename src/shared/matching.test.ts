import { describe, expect, it } from "vitest";
import { exportCasesCsv } from "./csv.js";
import { findCandidates } from "./matching.js";
import type { MasterPatient, PatientCase } from "./domain.js";

describe("identity matching", () => {
  const patients: MasterPatient[] = [
    { id: "one", officialName: "MARA DELA CRUZ", philhealthId: "001122334455", birthdate: "2000-06-05" },
    { id: "two", officialName: "MARIO DELA CRUZ", philhealthId: "111122223333", birthdate: "1999-01-01" }
  ];

  it("suggests a corrected official name only within the confirmed birthdate", () => {
    const candidates = findCandidates(patients, "MRA DELA CRUZ", "06/05/2000");
    expect(candidates.map((candidate) => candidate.patientId)).toEqual(["one"]);
  });
});

describe("CSV export", () => {
  it("does not expose values that were not selected and retained", () => {
    const patientCase: PatientCase = {
      id: "case-1",
      documentType: "urinalysis",
      profileName: "Name Only",
      selectedFieldIds: ["observed_name"],
      values: { observed_name: { value: "REVIEWED NAME", confirmed: true } },
      alignment: { rotation: 0, top: 0, right: 0, bottom: 0, left: 0 },
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z"
    };
    const csv = exportCasesCsv([patientCase]);
    expect(csv).toContain("REVIEWED NAME");
    expect(csv).not.toContain("SECRET RESULT");
  });

  it("does not export an unconfirmed draft value", () => {
    const patientCase: PatientCase = {
      id: "case-2",
      documentType: "medical_certificate",
      profileName: "Name Only",
      selectedFieldIds: ["observed_name"],
      values: { observed_name: { value: "UNCONFIRMED NAME", confirmed: false } },
      alignment: { rotation: 0, top: 0, right: 0, bottom: 0, left: 0 },
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z"
    };
    expect(exportCasesCsv([patientCase])).not.toContain("UNCONFIRMED NAME");
  });
});
