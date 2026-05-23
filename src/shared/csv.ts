import { FIELDS } from "./fields.js";
import { MIN_RELIABLE_NAME_OCR_CONFIDENCE, type PatientCase } from "./domain.js";

function escapeCsv(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

export function exportCasesCsv(cases: PatientCase[]): string {
  const columns = ["case_id", "document_type", "capture_profile", "selected_fields", "created_at", ...FIELDS.map((field) => field.id)];
  const rows = cases.map((patientCase) => {
    const base = [
      patientCase.id,
      patientCase.documentType,
      patientCase.profileName,
      patientCase.selectedFieldIds.join("|"),
      patientCase.createdAt
    ];
    const fieldValues = FIELDS.map((field) => {
      const value = patientCase.values[field.id];
      const rejectedOcrName = field.id === "observed_name" && value?.confidence !== undefined && value.confidence < MIN_RELIABLE_NAME_OCR_CONFIDENCE;
      return value?.confirmed && !rejectedOcrName ? value.value : "";
    });
    return [...base, ...fieldValues].map(escapeCsv).join(",");
  });
  return [columns.join(","), ...rows].join("\r\n");
}
