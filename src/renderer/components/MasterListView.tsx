import { useState } from "react";
import { Database, FileUp, ShieldCheck } from "lucide-react";
import { api } from "../api";

interface MasterListViewProps {
  count: number;
  onImported: () => Promise<void>;
}
export function MasterListView({ count, onImported }: MasterListViewProps) {
  const [file, setFile] = useState<File>();
  const [headers, setHeaders] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState({ officialName: "", philhealthId: "", birthdate: "" });
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);

  async function inspect(selectedFile: File | undefined) {
    setFile(selectedFile);
    setNotice("");
    if (!selectedFile) {
      setHeaders([]);
      return;
    }
    setPending(true);
    try {
      const preview = await api.previewMaster(selectedFile);
      setHeaders(preview.headers);
      setRowCount(preview.rowCount);
      setMapping({
        officialName: preview.suggestedMapping.officialName ?? "",
        philhealthId: preview.suggestedMapping.philhealthId ?? "",
        birthdate: preview.suggestedMapping.birthdate ?? ""
      });
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function importFile() {
    if (!file) {
      return;
    }
    setPending(true);
    setNotice("");
    try {
      const result = await api.importMaster(file, mapping);
      await onImported();
      setNotice(`${result.imported} approved patient records imported.`);
      setFile(undefined);
      setHeaders([]);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="content-view master-view">
      <header className="view-header">
        <div>
          <h2>Patient Master</h2>
          <p>{count} active approved records</p>
        </div>
      </header>
      <div className="master-import">
        <h3><Database size={18} /> Replace Approved File</h3>
        <label className="file-input">
          <FileUp size={20} />
          <span>{file?.name ?? "Select CSV or XLSX file"}</span>
          <input type="file" accept=".csv,.xlsx" onChange={(event) => void inspect(event.target.files?.[0])} />
        </label>
        {headers.length > 0 && (
          <>
            <p className="muted">{rowCount} row{rowCount === 1 ? "" : "s"} found</p>
            <div className="mapping-grid">
              {([
                ["officialName", "Official name"],
                ["philhealthId", "PhilHealth ID"],
                ["birthdate", "Birthdate"]
              ] as const).map(([key, label]) => (
                <label className="form-field" key={key}>
                  {label}
                  <select value={mapping[key]} onChange={(event) => setMapping((current) => ({ ...current, [key]: event.target.value }))}>
                    <option value="">Choose column</option>
                    {headers.map((header) => <option key={header} value={header}>{header}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <button className="primary command" onClick={importFile} disabled={pending}>
              <ShieldCheck size={17} />
              Replace Active Master List
            </button>
          </>
        )}
        {notice && <p className="notice">{notice}</p>}
      </div>
    </section>
  );
}
