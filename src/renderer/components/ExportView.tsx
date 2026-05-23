import { useState } from "react";
import { Download, FileSpreadsheet } from "lucide-react";
import type { PatientCase } from "../../shared/domain";
import { documentLabel } from "../../shared/fields";
import { api } from "../api";

interface ExportViewProps {
  cases: PatientCase[];
}

export function ExportView({ cases }: ExportViewProps) {
  const [selected, setSelected] = useState<string[]>(cases.map((patientCase) => patientCase.id));
  const [notice, setNotice] = useState("");

  function toggle(caseId: string) {
    setSelected((current) => current.includes(caseId) ? current.filter((id) => id !== caseId) : [...current, caseId]);
  }

  async function downloadCsv() {
    try {
      const blob = await api.exportCsv(selected);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `encodex-export-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("CSV created. Delete the plaintext CSV after successful import into the official database.");
    } catch (caught) {
      setNotice((caught as Error).message);
    }
  }

  return (
    <section className="content-view export-view">
      <header className="view-header">
        <div>
          <h2>CSV Export</h2>
          <p>Reviewed selected fields only</p>
        </div>
        <button className="primary command" disabled={selected.length === 0} onClick={downloadCsv}>
          <Download size={17} />
          Export Selected
        </button>
      </header>
      <div className="export-list">
        {cases.length === 0 ? (
          <div className="empty-state"><FileSpreadsheet size={30} /><h3>No open cases to export</h3></div>
        ) : cases.map((patientCase) => (
          <label key={patientCase.id} className="export-row">
            <input type="checkbox" checked={selected.includes(patientCase.id)} onChange={() => toggle(patientCase.id)} />
            <strong>{documentLabel(patientCase.documentType)}</strong>
            <span>{patientCase.profileName}</span>
            <span>{patientCase.selectedFieldIds.length} values selected</span>
          </label>
        ))}
      </div>
      {notice && <p className="notice">{notice}</p>}
    </section>
  );
}
