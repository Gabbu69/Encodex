import { useMemo, useState } from "react";
import { BookmarkPlus, Camera, Check, FlaskConical, NotebookPen, ScanLine, TestTubeDiagonal } from "lucide-react";
import type { CapturePreset, DocumentType, FieldDefinition, PatientCase } from "../../shared/domain";
import { DOCUMENT_TYPES, documentLabel, presetFields } from "../../shared/fields";

interface NewCaptureProps {
  fields: FieldDefinition[];
  presets: CapturePreset[];
  linkedFrom?: PatientCase;
  onCreate: (documentType: DocumentType, profileName: string, fields: string[]) => Promise<void>;
  onSavePreset: (name: string, documentType: DocumentType, fields: string[]) => Promise<void>;
}

export function NewCapture({ fields, presets, linkedFrom, onCreate, onSavePreset }: NewCaptureProps) {
  const initialDocument: DocumentType = linkedFrom && linkedFrom.documentType !== "medical_certificate" ? "medical_certificate" : "urinalysis";
  const [documentType, setDocumentType] = useState<DocumentType>(initialDocument);
  const [activePreset, setActivePreset] = useState("name-only");
  const [selected, setSelected] = useState<string[]>(["observed_name"]);
  const [customName, setCustomName] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  const availableFields = fields.filter((field) => field.documents.includes(documentType));
  const availablePresets = presets.filter((preset) => !preset.documentType || preset.documentType === documentType);
  const grouped = useMemo(
    () =>
      Object.entries(
        availableFields.reduce<Record<string, FieldDefinition[]>>((groups, field) => {
          (groups[field.category] ??= []).push(field);
          return groups;
        }, {})
      ),
    [availableFields]
  );

  function chooseDocument(next: DocumentType) {
    setDocumentType(next);
    setActivePreset("name-only");
    setSelected(["observed_name"]);
  }

  const documentIcons: Record<DocumentType, typeof FlaskConical> = {
    urinalysis: FlaskConical,
    pregnancy_test: TestTubeDiagonal,
    xray: ScanLine,
    medical_certificate: NotebookPen
  };

  function choosePreset(id: string) {
    const preset = presets.find((entry) => entry.id === id);
    if (!preset) {
      return;
    }
    setActivePreset(id);
    setSelected(presetFields(preset, documentType));
  }

  function toggleField(fieldId: string) {
    setActivePreset("");
    setSelected((current) => (current.includes(fieldId) ? current.filter((entry) => entry !== fieldId) : [...current, fieldId]));
  }

  async function savePreset() {
    setMessage("");
    if (!customName.trim() || selected.length === 0) {
      setMessage("Enter a preset name and select at least one field.");
      return;
    }
    try {
      await onSavePreset(customName.trim(), documentType, selected);
      setCustomName("");
      setMessage("Custom preset saved.");
    } catch (caught) {
      setMessage((caught as Error).message);
    }
  }

  async function createCapture() {
    if (selected.length === 0) {
      setMessage("Select at least one field before capturing.");
      return;
    }
    const profileName = availablePresets.find((preset) => preset.id === activePreset)?.name ?? (customName.trim() || "Custom selection");
    setPending(true);
    setMessage("");
    try {
      await onCreate(documentType, profileName, selected);
    } catch (caught) {
      setMessage((caught as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="content-view capture-config">
      <header className="view-header">
        <div>
          <h2>New Capture</h2>
          <p>{linkedFrom ? "Linked patient case / select data before capture" : "Select data before photographing the form"}</p>
        </div>
      </header>
      <div className="setup-band">
        <h3>Form</h3>
        <div className="document-options" role="radiogroup" aria-label="Document type">
          {DOCUMENT_TYPES.map((option) => {
            const Icon = documentIcons[option];
            return (
              <button key={option} className={documentType === option ? "active" : ""} onClick={() => chooseDocument(option)}>
                <Icon size={17} /> {documentLabel(option)}
              </button>
            );
          })}
        </div>
      </div>
      <div className="setup-band">
        <h3>Capture Profile</h3>
        <div className="preset-grid">
          {availablePresets.map((preset) => (
            <button className={`preset ${activePreset === preset.id ? "selected" : ""}`} key={preset.id} onClick={() => choosePreset(preset.id)}>
              {activePreset === preset.id && <Check size={15} />}
              {preset.name}
            </button>
          ))}
        </div>
      </div>
      <div className="setup-band field-selection">
        <div className="band-header">
          <h3>Fields To Capture</h3>
          <strong>{selected.length} selected</strong>
        </div>
        {grouped.map(([category, categoryFields]) => (
          <fieldset key={category}>
            <legend>{category}</legend>
            <div className="checks">
              {categoryFields.map((field) => (
                <label key={field.id}>
                  <input type="checkbox" checked={selected.includes(field.id)} onChange={() => toggleField(field.id)} />
                  {field.label}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="setup-band custom-save">
        <label className="form-field">
          Custom preset name
          <input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="Name + Result" />
        </label>
        <button className="secondary command" onClick={savePreset}>
          <BookmarkPlus size={17} />
          Save Preset
        </button>
      </div>
      {message && <p className="notice">{message}</p>}
      <footer className="sticky-actions">
        <button className="primary command" onClick={createCapture} disabled={pending || selected.length === 0}>
          <Camera size={17} />
          {pending ? "Creating..." : "Create Phone Capture"}
        </button>
      </footer>
    </section>
  );
}
