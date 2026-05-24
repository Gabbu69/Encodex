export type DocumentType = "urinalysis" | "pregnancy_test" | "xray" | "medical_certificate";
export type FieldSource = "ocr" | "manual" | "master";
export type OcrEngine = "tesseract" | "windows";
export type FieldCategory =
  | "Patient identity"
  | "Header"
  | "Macroscopic"
  | "Chemical"
  | "Microscopic"
  | "Crystals"
  | "Casts"
  | "Others"
  | "Certificate"
  | "Pregnancy test"
  | "Radiology";

export interface Region {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FieldDefinition {
  id: string;
  label: string;
  category: FieldCategory;
  documents: DocumentType[];
  source: FieldSource | Partial<Record<DocumentType, FieldSource>>;
  region?: Partial<Record<DocumentType, Region>>;
}

export interface CapturePreset {
  id: string;
  name: string;
  builtIn: boolean;
  documentType?: DocumentType;
  fieldIds: string[];
}

export interface StoredValue {
  value: string;
  confirmed: boolean;
  confidence?: number;
  ocrEngine?: OcrEngine;
  confirmedAt?: string;
}

export interface Alignment {
  rotation: 0 | 90 | 180 | 270;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CaseImage {
  id: string;
  uploadedAt: string;
  expiresAt: string;
  mimeType: string;
}

export interface PatientCase {
  id: string;
  patientGroupId?: string;
  documentType: DocumentType;
  profileName: string;
  selectedFieldIds: string[];
  continuousCapture?: boolean;
  values: Record<string, StoredValue>;
  alignment: Alignment;
  image?: CaseImage;
  uploadTokenHash?: string;
  uploadExpiresAt?: string;
  uploadUsed?: boolean;
  matchedPatientId?: string;
  observedNameForMatch?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MasterPatient {
  id: string;
  officialName: string;
  philhealthId: string;
  birthdate: string;
}

export interface AuditEvent {
  type: string;
  createdAt: string;
  detail: string;
}

export interface VaultData {
  cases: PatientCase[];
  customPresets: CapturePreset[];
  masterPatients: MasterPatient[];
  audit: AuditEvent[];
}

export interface MatchCandidate {
  patientId: string;
  officialName: string;
  philhealthId?: string;
  birthdate: string;
  score: number;
}

export const DEFAULT_ALIGNMENT: Alignment = {
  rotation: 0,
  top: 0,
  right: 0,
  bottom: 0,
  left: 0
};

export const MIN_RELIABLE_NAME_OCR_CONFIDENCE = 55;
