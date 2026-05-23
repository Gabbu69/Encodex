import type { CapturePreset, DocumentType, FieldCategory, FieldDefinition, Region } from "./domain.js";

const U = "urinalysis" as const;
const P = "pregnancy_test" as const;
const X = "xray" as const;
const M = "medical_certificate" as const;

export const DOCUMENT_TYPES: DocumentType[] = [U, P, X, M];

export const DOCUMENT_LABELS: Record<DocumentType, string> = {
  urinalysis: "Urinalysis",
  pregnancy_test: "Pregnancy Test",
  xray: "X-Ray / Radiology",
  medical_certificate: "Medical Certificate"
};

const docs = (...documentTypes: DocumentType[]) => documentTypes;
const region = (left: number, top: number, width: number, height: number): Region => ({ left, top, width, height });

function typed(
  id: string,
  label: string,
  category: FieldCategory,
  documents: DocumentType[],
  regions: Partial<Record<DocumentType, Region>>
): FieldDefinition {
  return { id, label, category, documents, source: "ocr", region: regions };
}

export const FIELDS: FieldDefinition[] = [
  {
    id: "observed_name",
    label: "Name on document",
    category: "Patient identity",
    documents: docs(U, P, X, M),
    source: { urinalysis: "ocr", pregnancy_test: "ocr", xray: "ocr", medical_certificate: "manual" },
    region: {
      urinalysis: region(0.14, 0.26, 0.38, 0.045),
      pregnancy_test: region(0.14, 0.322, 0.36, 0.045),
      xray: region(0.16, 0.34, 0.32, 0.024)
    }
  },
  {
    id: "confirmed_official_name",
    label: "Corrected official name",
    category: "Patient identity",
    documents: docs(U, P, X, M),
    source: "master"
  },
  {
    id: "philhealth_id",
    label: "PhilHealth ID",
    category: "Patient identity",
    documents: docs(U, P, X, M),
    source: "master"
  },
  {
    id: "birthdate",
    label: "Birthdate (manual verification)",
    category: "Patient identity",
    documents: docs(U, P, X, M),
    source: "manual"
  },
  {
    id: "age",
    label: "Age",
    category: "Patient identity",
    documents: docs(U, P, X, M),
    source: { urinalysis: "ocr", pregnancy_test: "ocr", xray: "ocr", medical_certificate: "manual" },
    region: {
      urinalysis: region(0.69, 0.215, 0.07, 0.04),
      pregnancy_test: region(0.58, 0.322, 0.08, 0.045),
      xray: region(0.65, 0.421, 0.09, 0.04)
    }
  },
  typed("sex", "Sex", "Patient identity", docs(U, P, X), {
    urinalysis: region(0.69, 0.255, 0.07, 0.04),
    pregnancy_test: region(0.58, 0.367, 0.08, 0.04),
    xray: region(0.84, 0.421, 0.11, 0.04)
  }),
  typed("report_date", "Date", "Header", docs(U, P, X), {
    urinalysis: region(0.84, 0.215, 0.12, 0.04),
    pregnancy_test: region(0.82, 0.322, 0.14, 0.045),
    xray: region(0.38, 0.385, 0.16, 0.04)
  }),
  typed("ward", "Ward", "Header", docs(U, P), {
    urinalysis: region(0.84, 0.255, 0.12, 0.04),
    pregnancy_test: region(0.82, 0.367, 0.14, 0.04)
  }),
  typed("case_number", "Case number", "Header", docs(U, P), {
    urinalysis: region(0.14, 0.294, 0.38, 0.038),
    pregnancy_test: region(0.14, 0.412, 0.36, 0.04)
  }),
  typed("requesting_physician", "Requesting physician", "Header", docs(U, P, X), {
    urinalysis: region(0.14, 0.255, 0.38, 0.04),
    pregnancy_test: region(0.14, 0.367, 0.36, 0.04),
    xray: region(0.28, 0.541, 0.62, 0.04)
  }),

  typed("color", "Color", "Macroscopic", docs(U), { urinalysis: region(0.17, 0.382, 0.15, 0.032) }),
  typed("clarity", "Transparency / clarity", "Macroscopic", docs(U), { urinalysis: region(0.17, 0.418, 0.15, 0.032) }),
  typed("reaction", "pH", "Chemical", docs(U), { urinalysis: region(0.46, 0.382, 0.12, 0.032) }),
  typed("specific_gravity", "Specific gravity", "Chemical", docs(U), { urinalysis: region(0.46, 0.418, 0.12, 0.032) }),
  typed("sugar", "Sugar", "Chemical", docs(U), { urinalysis: region(0.74, 0.382, 0.15, 0.032) }),
  typed("albumin", "Albumin", "Chemical", docs(U), { urinalysis: region(0.74, 0.418, 0.15, 0.032) }),
  typed("pus_cells", "Pus cells", "Microscopic", docs(U), { urinalysis: region(0.17, 0.492, 0.15, 0.032) }),
  typed("red_blood_cells", "Red blood cells", "Microscopic", docs(U), { urinalysis: region(0.17, 0.529, 0.15, 0.032) }),
  typed("renal_tubular_cells", "Renal cells", "Microscopic", docs(U), { urinalysis: region(0.17, 0.566, 0.15, 0.032) }),
  typed("squamous_epithelial_cells", "Epithelial cells", "Microscopic", docs(U), { urinalysis: region(0.17, 0.603, 0.15, 0.032) }),
  typed("mucous_threads", "Mucous threads", "Microscopic", docs(U), { urinalysis: region(0.17, 0.64, 0.15, 0.032) }),
  typed("yeast_cells", "Yeast cells", "Others", docs(U), { urinalysis: region(0.17, 0.677, 0.15, 0.032) }),
  typed("bacteria", "Bacteria", "Others", docs(U), { urinalysis: region(0.17, 0.714, 0.15, 0.032) }),
  typed("amorphous_urates", "Amorphous urates", "Crystals", docs(U), { urinalysis: region(0.45, 0.492, 0.14, 0.032) }),
  typed("uric_acid", "Uric acid", "Crystals", docs(U), { urinalysis: region(0.45, 0.529, 0.14, 0.032) }),
  typed("calcium_oxalate", "Calcium oxalate", "Crystals", docs(U), { urinalysis: region(0.45, 0.566, 0.14, 0.032) }),
  typed("triple_phosphate", "Triple phosphate", "Crystals", docs(U), { urinalysis: region(0.45, 0.603, 0.14, 0.032) }),
  typed("ammonium_biurate", "Ammonium biurate", "Crystals", docs(U), { urinalysis: region(0.45, 0.64, 0.14, 0.032) }),
  typed("calcium_carbonate", "Calcium carbonate", "Crystals", docs(U), { urinalysis: region(0.45, 0.677, 0.14, 0.032) }),
  typed("amorphous_phosphates", "Amorphous phosphates", "Crystals", docs(U), { urinalysis: region(0.45, 0.714, 0.14, 0.032) }),
  typed("hyaline_cast", "Hyaline cast", "Casts", docs(U), { urinalysis: region(0.73, 0.492, 0.15, 0.032) }),
  typed("fine_granular_cast", "Fine granular cast", "Casts", docs(U), { urinalysis: region(0.73, 0.529, 0.15, 0.032) }),
  typed("coarse_granular_cast", "Coarse granular cast", "Casts", docs(U), { urinalysis: region(0.73, 0.566, 0.15, 0.032) }),
  typed("waxy_cast", "Waxy cast", "Casts", docs(U), { urinalysis: region(0.73, 0.603, 0.15, 0.032) }),
  typed("pus_in_clumps", "Pus in clumps", "Casts", docs(U), { urinalysis: region(0.73, 0.64, 0.15, 0.032) }),
  typed("urinalysis_others", "Other urine findings", "Others", docs(U), { urinalysis: region(0.73, 0.677, 0.15, 0.032) }),
  typed("pregnancy_test_result", "Pregnancy test result", "Pregnancy test", docs(U, P), {
    urinalysis: region(0.73, 0.714, 0.15, 0.032),
    pregnancy_test: region(0.36, 0.548, 0.33, 0.055)
  }),
  { id: "remarks", label: "Remarks", category: "Others", documents: docs(U), source: "manual" },

  typed("file_number", "File number", "Radiology", docs(X), { xray: region(0.12, 0.385, 0.13, 0.04) }),
  typed("section", "Section", "Radiology", docs(X), { xray: region(0.70, 0.385, 0.14, 0.04) }),
  typed("or_number", "OR number", "Radiology", docs(X), { xray: region(0.88, 0.385, 0.1, 0.04) }),
  typed("procedure_type", "Type of procedure", "Radiology", docs(X), { xray: region(0.29, 0.46, 0.62, 0.04) }),
  typed("diagnosis", "Diagnosis", "Radiology", docs(X), { xray: region(0.2, 0.5, 0.72, 0.04) }),
  typed("findings", "Findings", "Radiology", docs(X), { xray: region(0.12, 0.57, 0.8, 0.1) }),
  typed("impression", "Impression", "Radiology", docs(X), { xray: region(0.15, 0.67, 0.76, 0.06) }),

  { id: "residence", label: "Residence / address", category: "Certificate", documents: docs(M), source: "manual" },
  { id: "examined_dates", label: "Examined / treated dates", category: "Certificate", documents: docs(M), source: "manual" },
  { id: "medical_certificate_diagnosis", label: "Diagnosis", category: "Certificate", documents: docs(M), source: "manual" },
  { id: "procedure", label: "Procedure", category: "Certificate", documents: docs(M), source: "manual" },
  { id: "medical_certificate_remarks", label: "Remarks", category: "Certificate", documents: docs(M), source: "manual" },
  { id: "issuance_date", label: "Issuance date", category: "Certificate", documents: docs(M), source: "manual" },
  { id: "attending_physician", label: "Attending physician", category: "Certificate", documents: docs(M), source: "manual" }
];

const fieldIds = (documentType: DocumentType, categories?: FieldCategory[]) =>
  FIELDS.filter((field) => field.documents.includes(documentType) && (!categories || categories.includes(field.category))).map((field) => field.id);

export const BUILT_IN_PRESETS: CapturePreset[] = [
  { id: "name-only", name: "Name Only", builtIn: true, fieldIds: ["observed_name"] },
  { id: "corrected-name", name: "Corrected Name", builtIn: true, fieldIds: ["confirmed_official_name"] },
  { id: "philhealth-id", name: "PhilHealth ID", builtIn: true, fieldIds: ["philhealth_id"] },
  { id: "patient-identity", name: "Patient Identity", builtIn: true, fieldIds: ["observed_name", "confirmed_official_name", "philhealth_id", "birthdate", "age", "sex"] },
  { id: "urinalysis-results", name: "Urinalysis Results", builtIn: true, documentType: U, fieldIds: fieldIds(U, ["Macroscopic", "Chemical", "Microscopic", "Crystals", "Casts", "Others", "Pregnancy test"]) },
  { id: "pregnancy-result", name: "Pregnancy Test Result", builtIn: true, documentType: P, fieldIds: ["pregnancy_test_result"] },
  { id: "xray-result", name: "Radiology Result", builtIn: true, documentType: X, fieldIds: fieldIds(X, ["Radiology"]) },
  { id: "medical-certificate", name: "Medical Certificate", builtIn: true, documentType: M, fieldIds: ["observed_name", "confirmed_official_name", ...fieldIds(M, ["Certificate"])] },
  ...DOCUMENT_TYPES.map((documentType) => ({
    id: `full-${documentType}`,
    name: "Full Supported Form",
    builtIn: true,
    documentType,
    fieldIds: fieldIds(documentType)
  }))
];

export function documentLabel(documentType: DocumentType) {
  return DOCUMENT_LABELS[documentType];
}

export function isDocumentType(value: unknown): value is DocumentType {
  return DOCUMENT_TYPES.includes(value as DocumentType);
}

export function fieldsForDocument(documentType: DocumentType): FieldDefinition[] {
  return FIELDS.filter((field) => field.documents.includes(documentType));
}

export function presetFields(preset: CapturePreset, documentType: DocumentType): string[] {
  const allowed = new Set(fieldsForDocument(documentType).map((field) => field.id));
  return preset.fieldIds.filter((fieldId) => allowed.has(fieldId));
}

export function validSelectedFields(documentType: DocumentType, fieldIds: string[]): boolean {
  const allowed = new Set(fieldsForDocument(documentType).map((field) => field.id));
  return fieldIds.length > 0 && fieldIds.every((fieldId) => allowed.has(fieldId));
}

export function requiresMasterMatch(fieldIds: string[]): boolean {
  return fieldIds.includes("confirmed_official_name") || fieldIds.includes("philhealth_id");
}

export function sourceForDocument(field: FieldDefinition, documentType: DocumentType) {
  return typeof field.source === "string" ? field.source : field.source[documentType] ?? "manual";
}

export function supportsTypedName(documentType: DocumentType) {
  return documentType !== M;
}
