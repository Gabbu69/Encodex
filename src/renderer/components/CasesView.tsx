import { ClipboardList, FilePlus2, FolderOpen } from "lucide-react";
import type { PatientCase } from "../../shared/domain";
import { documentLabel } from "../../shared/fields";

interface CasesViewProps {
  cases: PatientCase[];
  onNew: () => void;
  onOpen: (patientCase: PatientCase) => void;
}

export function CasesView({ cases, onNew, onOpen }: CasesViewProps) {
  return (
    <section className="content-view">
      <header className="view-header">
        <div>
          <h2>Cases</h2>
          <p>{cases.length} open case{cases.length === 1 ? "" : "s"}</p>
        </div>
        <button className="primary command" onClick={onNew}>
          <FilePlus2 size={17} />
          New Capture
        </button>
      </header>
      {cases.length === 0 ? (
        <div className="empty-state">
          <ClipboardList size={32} />
          <h3>No open cases</h3>
          <button className="primary command" onClick={onNew}>
            <FilePlus2 size={17} />
            New Capture
          </button>
        </div>
      ) : (
        <div className="case-table" role="table">
          <div className="case-table-head" role="row">
            <span>Form</span>
            <span>Capture profile</span>
            <span>Selected values</span>
            <span>Status</span>
            <span />
          </div>
          {cases.map((patientCase) => {
            const reviewed = patientCase.selectedFieldIds.filter((fieldId) => patientCase.values[fieldId]?.confirmed).length;
            return (
              <div className="case-row" role="row" key={patientCase.id}>
                <strong>{documentLabel(patientCase.documentType)}</strong>
                <span>{patientCase.profileName}</span>
                <span>{patientCase.selectedFieldIds.length}</span>
                <span className={reviewed === patientCase.selectedFieldIds.length ? "status ok" : "status pending"}>
                  {reviewed}/{patientCase.selectedFieldIds.length} reviewed
                </span>
                <button className="icon-command" title="Open case" onClick={() => onOpen(patientCase)}>
                  <FolderOpen size={18} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
