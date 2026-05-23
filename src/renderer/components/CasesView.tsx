import { ClipboardList, FilePlus2, PencilLine } from "lucide-react";
import { MIN_RELIABLE_NAME_OCR_CONFIDENCE, type PatientCase } from "../../shared/domain";
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
          <h2>Encoding List</h2>
          <p>{cases.length} record{cases.length === 1 ? "" : "s"} waiting for official entry</p>
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
            <span>Reviewed person name</span>
            <span>Form</span>
            <span>Capture profile</span>
            <span>Status</span>
            <span />
          </div>
          {cases.map((patientCase) => {
            const acceptedValue = (fieldId: string) => {
              const value = patientCase.values[fieldId];
              return Boolean(
                value?.confirmed
                && !(fieldId === "observed_name" && value.confidence !== undefined && value.confidence < MIN_RELIABLE_NAME_OCR_CONFIDENCE)
              );
            };
            const reviewed = patientCase.selectedFieldIds.filter(acceptedValue).length;
            const officialName = patientCase.values.confirmed_official_name?.confirmed
              ? patientCase.values.confirmed_official_name.value
              : "";
            const observedName = acceptedValue("observed_name")
              ? patientCase.values.observed_name.value
              : "";
            const displayedName = officialName || observedName;
            const nameWasSelected = patientCase.selectedFieldIds.includes("observed_name") || patientCase.selectedFieldIds.includes("confirmed_official_name");
            return (
              <div className="case-row" role="row" key={patientCase.id}>
                <div className="case-person">
                  <strong>{displayedName || (nameWasSelected ? "Awaiting reviewed name" : "Name not selected")}</strong>
                  {displayedName && <small>{officialName ? "Confirmed official name" : "Reviewed document name"}</small>}
                </div>
                <strong>{documentLabel(patientCase.documentType)}</strong>
                <span>{patientCase.profileName}</span>
                <span className={reviewed === patientCase.selectedFieldIds.length ? "status ok" : "status pending"}>
                  {reviewed}/{patientCase.selectedFieldIds.length} reviewed
                </span>
                <button className="secondary command row-edit" title="Open and edit saved fields" onClick={() => onOpen(patientCase)}>
                  <PencilLine size={16} />
                  Review / Edit
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
