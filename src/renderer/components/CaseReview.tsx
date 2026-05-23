import { useEffect, useMemo, useState } from "react";
import {
  AlignCenter,
  CheckCircle2,
  Clipboard,
  ClipboardX,
  Link2,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  ScanText,
  Trash2
} from "lucide-react";
import type { CaptureLink } from "../api";
import { api } from "../api";
import type { FieldDefinition, MatchCandidate, PatientCase, StoredValue } from "../../shared/domain";
import { documentLabel, requiresMasterMatch, sourceForDocument, supportsTypedName } from "../../shared/fields";

interface CaseReviewProps {
  patientCase: PatientCase;
  fields: FieldDefinition[];
  capture?: CaptureLink;
  masterPatientCount: number;
  onCaseUpdate: (patientCase: PatientCase) => void;
  onAttachRelated: (patientCase: PatientCase) => void;
  onComplete: () => void;
}

export function CaseReview({ patientCase, fields, capture, masterPatientCount, onCaseUpdate, onAttachRelated, onComplete }: CaseReviewProps) {
  const selectedFields = useMemo(
    () => fields.filter((field) => patientCase.selectedFieldIds.includes(field.id)),
    [fields, patientCase.selectedFieldIds]
  );
  const [draft, setDraft] = useState<Record<string, StoredValue>>({});
  const [activeCapture, setActiveCapture] = useState<CaptureLink | undefined>(capture);
  const [transientName, setTransientName] = useState("");
  const [transientBirthdate, setTransientBirthdate] = useState("");
  const [candidates, setCandidates] = useState<MatchCandidate[]>([]);
  const [alignment, setAlignment] = useState(patientCase.alignment);
  const [pending, setPending] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setDraft(
      Object.fromEntries(
        patientCase.selectedFieldIds.map((fieldId) => [fieldId, patientCase.values[fieldId] ?? { value: "", confirmed: false }])
      )
    );
    setAlignment(patientCase.alignment);
    if (patientCase.values.observed_name?.value) {
      setTransientName(patientCase.values.observed_name.value);
    }
    if (patientCase.values.birthdate?.value) {
      setTransientBirthdate(patientCase.values.birthdate.value);
    }
  }, [patientCase]);

  useEffect(() => {
    if (patientCase.image) {
      return;
    }
    const polling = window.setInterval(async () => {
      try {
        const refreshed = await api.patientCase(patientCase.id);
        if (refreshed.image) {
          onCaseUpdate(refreshed);
          setNotice("Photo received.");
        }
      } catch {
        // A brief network interruption should not disrupt the review workspace.
      }
    }, 2500);
    return () => window.clearInterval(polling);
  }, [patientCase.id, patientCase.image, onCaseUpdate]);

  function setValue(fieldId: string, value: string) {
    setDraft((current) => ({
      ...current,
      [fieldId]: { ...current[fieldId], value, confirmed: false }
    }));
    if (fieldId === "observed_name") {
      setTransientName(value);
    }
    if (fieldId === "birthdate") {
      setTransientBirthdate(value);
    }
  }

  function confirmValue(fieldId: string, confirmed: boolean) {
    setDraft((current) => ({
      ...current,
      [fieldId]: { ...current[fieldId], confirmed }
    }));
  }

  async function issueLink() {
    setPending("link");
    setNotice("");
    try {
      setActiveCapture(await api.createCaptureLink(patientCase.id));
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending("");
    }
  }

  async function applyAlignment() {
    setPending("alignment");
    setNotice("");
    try {
      onCaseUpdate(await api.align(patientCase.id, alignment));
      setNotice("Document alignment saved.");
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending("");
    }
  }

  async function readTypedFields() {
    setPending("ocr");
    setNotice("");
    try {
      const requested = selectedFields
        .filter((field) => sourceForDocument(field, patientCase.documentType) === "ocr" && field.region?.[patientCase.documentType])
        .map((field) => field.id);
      if (requiresMasterMatch(patientCase.selectedFieldIds) && supportsTypedName(patientCase.documentType)) {
        requested.push("observed_name");
      }
      const result = await api.ocr(patientCase.id, [...new Set(requested)]);
      result.suggestions.forEach((suggestion) => {
        if (patientCase.selectedFieldIds.includes(suggestion.fieldId)) {
          setDraft((current) => ({
            ...current,
            [suggestion.fieldId]: {
              value: suggestion.text,
              confirmed: false,
              confidence: suggestion.confidence
            }
          }));
        }
        if (suggestion.fieldId === "observed_name") {
          setTransientName(suggestion.text);
        }
        if (suggestion.fieldId === "birthdate") {
          setTransientBirthdate(suggestion.text);
        }
      });
      setNotice("Typed field suggestions are ready for confirmation.");
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending("");
    }
  }

  async function saveReview() {
    setPending("save");
    setNotice("");
    try {
      const updated = await api.review(patientCase.id, draft);
      onCaseUpdate(updated);
      setNotice("Selected fields saved.");
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending("");
    }
  }

  async function searchPatient() {
    setPending("match");
    setNotice("");
    try {
      const result = await api.match(patientCase.id, transientName, transientBirthdate);
      setCandidates(result.candidates);
      if (!result.candidates.length) {
        setNotice("No approved patient match found for the entered name and birthdate.");
      }
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending("");
    }
  }

  async function chooseCandidate(patientId: string) {
    setPending("match");
    try {
      const updated = await api.confirmMatch(patientCase.id, patientId, transientName, transientBirthdate);
      onCaseUpdate(updated);
      setCandidates([]);
      setNotice("Official patient match confirmed.");
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending("");
    }
  }

  async function copyField(fieldId: string) {
    setNotice("");
    try {
      await api.copy(patientCase.id, fieldId);
      setNotice("Copied. Clipboard clears automatically in 60 seconds.");
    } catch (caught) {
      setNotice((caught as Error).message);
    }
  }

  async function clearClipboard() {
    await api.clearClipboard();
    setNotice("Clipboard cleared.");
  }

  async function completeCase() {
    if (!window.confirm("Confirm that selected values were entered into the official database. Local case data and its photo will be deleted.")) {
      return;
    }
    setPending("complete");
    try {
      await api.complete(patientCase.id);
      onComplete();
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending("");
    }
  }

  const needsMatch = requiresMasterMatch(patientCase.selectedFieldIds);
  const hasOcr = selectedFields.some(
    (field) => sourceForDocument(field, patientCase.documentType) === "ocr" && field.region?.[patientCase.documentType]
  ) || (needsMatch && supportsTypedName(patientCase.documentType));
  const allReviewed = patientCase.selectedFieldIds.every((fieldId) => patientCase.values[fieldId]?.confirmed);

  return (
    <section className="content-view review-view">
      <header className="view-header">
        <div>
          <h2>{documentLabel(patientCase.documentType)}</h2>
          <p>{patientCase.profileName} / {patientCase.selectedFieldIds.length} selected value{patientCase.selectedFieldIds.length === 1 ? "" : "s"}</p>
        </div>
        <div className="header-actions">
          <button className="secondary command" onClick={() => onAttachRelated(patientCase)}>
            <Link2 size={17} />
            Attach Related Form
          </button>
          <button className="secondary command" onClick={clearClipboard}>
            <ClipboardX size={17} />
            Clear Clipboard
          </button>
          <button className="danger command" disabled={!allReviewed || pending === "complete"} onClick={completeCase}>
            <Trash2 size={17} />
            Mark Entered And Delete
          </button>
        </div>
      </header>
      <div className="review-grid">
        <div className="review-fields">
          {!patientCase.image && (
            <div className="capture-panel">
              <div className="band-header">
                <h3>Phone Capture</h3>
                <button className="secondary command" disabled={pending === "link"} onClick={issueLink}>
                  <RefreshCw size={16} />
                  {activeCapture ? "New Link" : "Create Link"}
                </button>
              </div>
              {activeCapture && (
                <div className="qr-layout">
                  <img className="qr" alt="Phone capture QR code" src={activeCapture.qrDataUrl} />
                  <div className="capture-link">
                    <Link2 size={17} />
                    <span>{activeCapture.url}</span>
                  </div>
                </div>
              )}
            </div>
          )}
          {patientCase.image && hasOcr && (
            <button className="primary command scan-action" disabled={pending === "ocr"} onClick={readTypedFields}>
              {pending === "ocr" ? <LoaderCircle className="spin" size={17} /> : <ScanText size={17} />}
              Read Selected Typed Fields
            </button>
          )}
          {needsMatch && (
            <div className="match-panel">
              <div className="band-header">
                <h3>Approved Patient Match</h3>
                <span className="muted">{masterPatientCount} master records</span>
              </div>
              <div className="match-inputs">
                <label className="form-field">
                  Name for matching
                  <input value={transientName} onChange={(event) => setTransientName(event.target.value)} />
                </label>
                <label className="form-field">
                  Birthdate for matching
                  <input value={transientBirthdate} onChange={(event) => setTransientBirthdate(event.target.value)} placeholder="MM/DD/YYYY" />
                </label>
                <button className="secondary command" disabled={pending === "match" || !transientName || !transientBirthdate} onClick={searchPatient}>
                  <AlignCenter size={17} />
                  Find Match
                </button>
              </div>
              {candidates.map((candidate) => (
                <div className="candidate" key={candidate.patientId}>
                  <div>
                    <strong>{candidate.officialName}</strong>
                    <span>Birthdate: {candidate.birthdate} / Match {Math.round(candidate.score * 100)}%</span>
                  </div>
                  <button className="primary command" onClick={() => chooseCandidate(candidate.patientId)}>
                    <CheckCircle2 size={16} /> Confirm
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="field-list">
            {selectedFields.map((field) => {
              const value = draft[field.id] ?? { value: "", confirmed: false };
              const fromMaster = sourceForDocument(field, patientCase.documentType) === "master";
              return (
                <div className="review-field" key={field.id}>
                  <div className="field-top">
                    <label htmlFor={`field-${field.id}`}>{field.label}</label>
                    {value.confidence !== undefined && (
                      <span className={value.confidence >= 75 ? "confidence good" : "confidence uncertain"}>
                        OCR {value.confidence}%
                      </span>
                    )}
                  </div>
                  <div className="field-controls">
                    <input
                      id={`field-${field.id}`}
                      value={value.value}
                      readOnly={fromMaster}
                      placeholder={fromMaster ? "Confirm patient match first" : "Enter or review value"}
                      onChange={(event) => setValue(field.id, event.target.value)}
                    />
                    {!fromMaster && (
                      <label className="confirm-check">
                        <input type="checkbox" checked={value.confirmed} onChange={(event) => confirmValue(field.id, event.target.checked)} />
                        Reviewed
                      </label>
                    )}
                    <button
                      className="icon-command"
                      title={`Copy ${field.label}`}
                      disabled={!patientCase.values[field.id]?.confirmed}
                      onClick={() => copyField(field.id)}
                    >
                      <Clipboard size={17} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <button className="primary command save-review" onClick={saveReview} disabled={pending === "save"}>
            <CheckCircle2 size={17} />
            Save Reviewed Values
          </button>
          {notice && <p className="notice">{notice}</p>}
        </div>
        <aside className="image-panel">
          <div className="band-header">
            <h3>Source Image</h3>
            {patientCase.image && <span className="muted">Expires {new Date(patientCase.image.expiresAt).toLocaleDateString()}</span>}
          </div>
          {patientCase.image ? (
            <>
              <div className="document-preview">
                <img
                  alt="Captured document"
                  src={`/api/cases/${patientCase.id}/image?v=${encodeURIComponent(patientCase.updatedAt)}`}
                  style={{ transform: `rotate(${alignment.rotation}deg)` }}
                />
                <div
                  className="alignment-guide"
                  style={{
                    top: `${alignment.top * 100}%`,
                    right: `${alignment.right * 100}%`,
                    bottom: `${alignment.bottom * 100}%`,
                    left: `${alignment.left * 100}%`
                  }}
                />
              </div>
              <div className="alignment-controls">
                <button
                  className="icon-command"
                  title="Rotate clockwise"
                  onClick={() => setAlignment((current) => ({ ...current, rotation: ((current.rotation + 90) % 360) as 0 | 90 | 180 | 270 }))}
                >
                  <RotateCw size={18} />
                </button>
                {(["top", "right", "bottom", "left"] as const).map((edge) => (
                  <label key={edge}>
                    {edge}
                    <input
                      type="range"
                      min="0"
                      max="25"
                      value={Math.round(alignment[edge] * 100)}
                      onChange={(event) => setAlignment((current) => ({ ...current, [edge]: Number(event.target.value) / 100 }))}
                    />
                  </label>
                ))}
                <button className="secondary command" onClick={applyAlignment} disabled={pending === "alignment"}>
                  <AlignCenter size={16} />
                  Apply
                </button>
              </div>
            </>
          ) : (
            <div className="image-placeholder">Awaiting phone capture</div>
          )}
        </aside>
      </div>
    </section>
  );
}
