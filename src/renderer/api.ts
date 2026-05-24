import type { Alignment, CapturePreset, FieldDefinition, MatchCandidate, PatientCase, Region } from "../shared/domain";

export interface AppConfig {
  fields: FieldDefinition[];
  presets: CapturePreset[];
  masterPatientCount: number;
}

export interface CaptureLink {
  url: string;
  qrDataUrl: string;
}

interface ApiError {
  error?: string;
}

async function responseError(response: Response) {
  try {
    const body = (await response.json()) as ApiError;
    return body.error ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

async function json<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: options?.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...options?.headers },
    ...options
  });
  if (!response.ok) {
    throw new Error(await responseError(response));
  }
  return response.json() as Promise<T>;
}

export const api = {
  status: () => json<{ initialized: boolean; unlocked: boolean }>("/api/status"),
  setup: (password: string) => json<{ ok: true }>("/api/setup", { method: "POST", body: JSON.stringify({ password }) }),
  login: (password: string) => json<{ ok: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => json<{ ok: true }>("/api/logout", { method: "POST" }),
  config: () => json<AppConfig>("/api/config"),
  cases: () => json<PatientCase[]>("/api/cases"),
  patientCase: (id: string) => json<PatientCase>(`/api/cases/${id}`),
  createCase: (documentType: string, profileName: string, fieldIds: string[], linkToCaseId?: string, continuousCapture = false) =>
    json<{ patientCase: PatientCase; capture: CaptureLink }>("/api/cases", {
      method: "POST",
      body: JSON.stringify({ documentType, profileName, fieldIds, linkToCaseId, continuousCapture })
    }),
  createCaptureLink: (id: string) => json<CaptureLink>(`/api/cases/${id}/capture-link`, { method: "POST" }),
  savePreset: (name: string, documentType: string, fieldIds: string[]) =>
    json<CapturePreset>("/api/presets", { method: "POST", body: JSON.stringify({ name, documentType, fieldIds }) }),
  changeDocumentType: (id: string, documentType: string) =>
    json<PatientCase>(`/api/cases/${id}/document-type`, { method: "PUT", body: JSON.stringify({ documentType }) }),
  narrowSelection: (id: string, profileName: string, fieldIds: string[]) =>
    json<PatientCase>(`/api/cases/${id}/selection`, { method: "PUT", body: JSON.stringify({ profileName, fieldIds }) }),
  autoFit: (id: string) =>
    json<{ patientCase: PatientCase; adjusted: boolean }>(`/api/cases/${id}/auto-fit`, { method: "POST" }),
  align: (id: string, alignment: Alignment) =>
    json<PatientCase>(`/api/cases/${id}/alignment`, { method: "PUT", body: JSON.stringify(alignment) }),
  ocr: (id: string, fieldIds: string[], nameRegion?: Region) =>
    json<{ suggestions: Array<{ fieldId: string; text: string; confidence: number; qualityWarning?: string; detectedRegion?: Region }> }>(`/api/cases/${id}/ocr`, {
      method: "POST",
      body: JSON.stringify({ fieldIds, nameRegion })
    }),
  review: (id: string, values: PatientCase["values"]) =>
    json<PatientCase>(`/api/cases/${id}/review`, { method: "PUT", body: JSON.stringify({ values }) }),
  match: (id: string, observedName: string, birthdate: string) =>
    json<{ candidates: MatchCandidate[] }>(`/api/cases/${id}/match`, {
      method: "POST",
      body: JSON.stringify({ observedName, birthdate })
    }),
  confirmMatch: (id: string, patientId: string, observedName: string, birthdate: string) =>
    json<PatientCase>(`/api/cases/${id}/match/confirm`, {
      method: "POST",
      body: JSON.stringify({ patientId, observedName, birthdate })
    }),
  copy: (id: string, fieldId: string) =>
    json<{ ok: true; clearsAfterSeconds: number }>(`/api/cases/${id}/copy/${fieldId}`, { method: "POST" }),
  clearClipboard: () => json<{ ok: true }>("/api/clipboard/clear", { method: "POST" }),
  complete: (id: string) => json<{ ok: true; deleted: true }>(`/api/cases/${id}/complete`, { method: "POST" }),
  previewMaster: async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return json<{ headers: string[]; rowCount: number; suggestedMapping: Record<string, string> }>("/api/master/preview", { method: "POST", body: form });
  },
  importMaster: async (file: File, mapping: Record<string, string>) => {
    const form = new FormData();
    form.append("file", file);
    form.append("mapping", JSON.stringify(mapping));
    return json<{ imported: number }>("/api/master/import", { method: "POST", body: form });
  },
  exportCsv: async (caseIds: string[]) => {
    const response = await fetch("/api/export", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseIds })
    });
    if (!response.ok) {
      throw new Error(await responseError(response));
    }
    return response.blob();
  }
};
