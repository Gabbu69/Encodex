import { useEffect, useMemo, useRef, useState } from "react";
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
import type { DocumentType, FieldDefinition, MatchCandidate, PatientCase, StoredValue } from "../../shared/domain";
import { DOCUMENT_TYPES, documentLabel, requiresMasterMatch, sourceForDocument, supportsTypedName } from "../../shared/fields";

interface CaseReviewProps {
  patientCase: PatientCase;
  fields: FieldDefinition[];
  capture?: CaptureLink;
  masterPatientCount: number;
  onCaseUpdate: (patientCase: PatientCase) => void;
  onAttachRelated: (patientCase: PatientCase) => void;
  onComplete: () => void | Promise<void>;
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
  const [clipboardReady, setClipboardReady] = useState(false);
  const automaticReadImage = useRef("");

  useEffect(() => {
    setClipboardReady(false);
  }, [patientCase.id]);

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
    setClipboardReady(false);
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

  async function changeDocumentType(documentType: DocumentType) {
    if (documentType === patientCase.documentType) {
      return;
    }
    setPending("template");
    setNotice("");
    setClipboardReady(false);
    setCandidates([]);
    try {
      const updated = await api.changeDocumentType(patientCase.id, documentType);
      onCaseUpdate(updated);
      setNotice(
        Object.keys(patientCase.values).length === 0
          ? `Form changed to ${documentLabel(documentType)}. Reading only the selected typed fields from the new location.`
          : `Form changed to ${documentLabel(documentType)}. Reread or edit the selected fields before copying.`
      );
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending("");
    }
  }

  async function narrowToNameOnly() {
    if (!window.confirm("Keep only Name on document for this photo and following continuous scans? Other selected fields for this capture will be removed.")) {
      return;
    }
    setPending("selection");
    setNotice("");
    setClipboardReady(false);
    setCandidates([]);
    try {
      const updated = await api.narrowSelection(patientCase.id, "Name Only", ["observed_name"]);
      onCaseUpdate(updated);
      setNotice("Name Only is active. Verify the scanned name, then select Review & Copy Name.");
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending("");
    }
  }

  async function readTypedFields(effectiveAlignment = alignment) {
    setPending("ocr");
    setNotice("");
    setClipboardReady(false);
    try {
      const changedAlignment = (["rotation", "top", "right", "bottom", "left"] as const)
        .some((edge) => effectiveAlignment[edge] !== patientCase.alignment[edge]);
      if (changedAlignment) {
        onCaseUpdate(await api.align(patientCase.id, effectiveAlignment));
      }
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
      if (readsOnlyName && nameOnly) {
        const recognizedName = result.suggestions.find((suggestion) => suggestion.fieldId === "observed_name")?.text;
        setNotice(
          recognizedName
            ? "Name detected. Verify its spelling, then select Review & Copy Name."
            : "The name was not clear. Type it above, then select Review & Copy Name."
        );
      } else if (readsOnlyName) {
        const recognizedName = result.suggestions.find((suggestion) => suggestion.fieldId === "observed_name")?.text;
        setNotice(
          recognizedName
            ? "Name detected. Check the spelling, mark Name on document as Reviewed, then save selected values."
            : "The name was not clear. Type it, mark Name on document as Reviewed, then save selected values."
        );
      } else {
        setNotice("Typed field suggestions are ready for confirmation.");
      }
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
      setNotice("Selected fields saved. Reviewed names appear in the Encoding List and can be opened again for editing.");
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
      setClipboardReady(true);
      setNotice("Copied. Paste this value into PhilHealth YAKAP now. Clipboard clears automatically in 60 seconds.");
    } catch (caught) {
      setNotice((caught as Error).message);
    }
  }

  async function reviewAndCopyName() {
    const name = draft.observed_name?.value.trim() ?? "";
    if (!name) {
      setNotice("Read or type the name before copying.");
      return;
    }
    setPending("name-copy");
    setNotice("");
    setClipboardReady(false);
    try {
      const updated = await api.review(patientCase.id, {
        observed_name: {
          ...draft.observed_name,
          value: name,
          confirmed: true
        }
      });
      onCaseUpdate(updated);
      await api.copy(patientCase.id, "observed_name");
      setClipboardReady(true);
      setNotice("Name copied. Paste it into the PhilHealth YAKAP name field now. Clipboard clears in 60 seconds.");
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending("");
    }
  }

  async function clearClipboard() {
    await api.clearClipboard();
    setClipboardReady(false);
    setNotice("Clipboard cleared.");
  }

  async function completeCase() {
    if (!window.confirm("Confirm that selected values were entered into the official database. Local case data and its photo will be deleted.")) {
      return;
    }
    setPending("complete");
    try {
      await api.complete(patientCase.id);
      await onComplete();
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
  const visibleScanFields = selectedFields.filter(
    (field) => sourceForDocument(field, patientCase.documentType) === "ocr" && field.region?.[patientCase.documentType]
  );
  const readsOnlyName = visibleScanFields.length === 1 && visibleScanFields[0].id === "observed_name";
  const nameOnly = selectedFields.length === 1 && selectedFields[0].id === "observed_name";
  const canNarrowToNameOnly = patientCase.selectedFieldIds.includes("observed_name") && !nameOnly;
  const allReviewed = patientCase.selectedFieldIds.every((fieldId) => patientCase.values[fieldId]?.confirmed);

  useEffect(() => {
    const automaticReadKey = patientCase.image ? `${patientCase.image.id}:${patientCase.documentType}` : "";
    if (!patientCase.image || !hasOcr || automaticReadImage.current === automaticReadKey) {
      return;
    }
    automaticReadImage.current = automaticReadKey;
    if (Object.keys(patientCase.values).length === 0) {
      void readTypedFields(patientCase.alignment);
    }
  }, [patientCase.id, patientCase.documentType, patientCase.image?.id, hasOcr]);

  return (
    <section className="content-view review-view">
      <header className="view-header">
        <div>
          <h2>{documentLabel(patientCase.documentType)}</h2>
          <p>
            {patientCase.profileName} / {patientCase.selectedFieldIds.length} selected value{patientCase.selectedFieldIds.length === 1 ? "" : "s"}
            {patientCase.continuousCapture ? " / Continuous queue" : ""}
          </p>
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
                <>
                  <div className="qr-layout">
                    <img className="qr" alt="Phone capture QR code" src={activeCapture.qrDataUrl} />
                    <div className="capture-link">
                      <Link2 size={17} />
                      <span>{activeCapture.url}</span>
                    </div>
                  </div>
                  {patientCase.continuousCapture && (
                    <p className="capture-tip">Continuous scanning is on. After sending each paper, tap Capture Next Paper on the phone.</p>
                  )}
                </>
              )}
            </div>
          )}
          {patientCase.image && (
            <div className="template-panel">
              <div className="band-header">
                <h3>Form Shown In Photo</h3>
                <span className="muted">Sets the correct scan area</span>
              </div>
              <div className="template-switch" role="radiogroup" aria-label="Form shown in uploaded photo">
                {DOCUMENT_TYPES.map((option) => (
                  <button
                    key={option}
                    className={patientCase.documentType === option ? "active" : ""}
                    disabled={pending === "template"}
                    onClick={() => void changeDocumentType(option)}
                  >
                    {documentLabel(option)}
                  </button>
                ))}
              </div>
              <p>Choose the paper type in the image before reading. This changes where selected fields are scanned; it does not collect additional fields.</p>
            </div>
          )}
          {patientCase.image && canNarrowToNameOnly && (
            <div className="selection-panel">
              <div>
                <h3>Need Only The Written Name?</h3>
                <p>Reduce this captured record to the name field only. Removed fields cannot be added back from this photo.</p>
              </div>
              <button className="secondary command" disabled={pending === "selection"} onClick={narrowToNameOnly}>
                Use Name Only
              </button>
            </div>
          )}
          {patientCase.image && hasOcr && (
            <button className="primary command scan-action" disabled={pending === "ocr"} onClick={() => void readTypedFields()}>
              {pending === "ocr" ? <LoaderCircle className="spin" size={17} /> : <ScanText size={17} />}
              {readsOnlyName ? "Read Selected Name Only" : "Read Selected Typed Fields"}
            </button>
          )}
          {needsMatch && (
            <div className="match-panel">
              <div className="band-header">
                <h3>Approved Patient Match</h3>
                <span className="muted">{masterPatientCount} master records</span>
              </div>
              {masterPatientCount === 0 && (
                <p className="match-tip">To correct an official name, import the approved patient master first. To copy only the written name, use the Name Only profile.</p>
              )}
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
                    {!fromMaster && !nameOnly && (
                      <label className="confirm-check">
                        <input type="checkbox" checked={value.confirmed} onChange={(event) => confirmValue(field.id, event.target.checked)} />
                        Reviewed
                      </label>
                    )}
                    {!nameOnly && (
                      <button
                        className="icon-command"
                        title={`Copy ${field.label}`}
                        disabled={!patientCase.values[field.id]?.confirmed}
                        onClick={() => copyField(field.id)}
                      >
                        <Clipboard size={17} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {nameOnly ? (
            <div className="name-copy-workflow">
              <button
                className="primary command name-copy-action"
                onClick={reviewAndCopyName}
                disabled={!patientCase.image || !draft.observed_name?.value.trim() || pending === "name-copy" || pending === "ocr"}
              >
                {pending === "name-copy" ? <LoaderCircle className="spin" size={17} /> : <Clipboard size={17} />}
                {draft.observed_name?.confirmed ? "Copy Name Again" : "Review & Copy Name"}
              </button>
              <p>Check the spelling in the name box first. The green outline only marks the scan area; it does not copy by itself.</p>
            </div>
          ) : (
            <button className="primary command save-review" onClick={saveReview} disabled={pending === "save"}>
              <CheckCircle2 size={17} />
              Save Reviewed Values
            </button>
          )}
          {notice && <p className={`notice ${clipboardReady ? "copied" : ""}`}>{notice}</p>}
        </div>
        <aside className="image-panel">
          <div className="band-header">
            <h3>Source Image</h3>
            {patientCase.image && <span className="muted">Expires {new Date(patientCase.image.expiresAt).toLocaleDateString()}</span>}
          </div>
          {patientCase.image ? (
            <>
              <div className="document-preview">
                <div className="document-canvas" style={{ transform: `rotate(${alignment.rotation}deg)` }}>
                  <img
                    alt="Captured document"
                    src={`/api/cases/${patientCase.id}/image?v=${encodeURIComponent(patientCase.updatedAt)}`}
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
                  {visibleScanFields.map((field) => {
                    const region = field.region![patientCase.documentType]!;
                    const availableWidth = 1 - alignment.left - alignment.right;
                    const availableHeight = 1 - alignment.top - alignment.bottom;
                    return (
                      <div
                        className="selected-scan-guide"
                        key={field.id}
                        title={`${field.label} scan area`}
                        aria-label={`${field.label} scan area`}
                        style={{
                          top: `${(alignment.top + region.top * availableHeight) * 100}%`,
                          left: `${(alignment.left + region.left * availableWidth) * 100}%`,
                          width: `${region.width * availableWidth * 100}%`,
                          height: `${region.height * availableHeight * 100}%`
                        }}
                      />
                    );
                  })}
                </div>
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
