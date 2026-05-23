import { useEffect, useState } from "react";
import { ClipboardList, FilePlus2, FileSpreadsheet, LogOut, UsersRound } from "lucide-react";
import type { CaptureLink, AppConfig } from "./api";
import { api } from "./api";
import type { DocumentType, PatientCase } from "../shared/domain";
import { AuthScreen } from "./components/AuthScreen";
import { CasesView } from "./components/CasesView";
import { NewCapture } from "./components/NewCapture";
import { CaseReview } from "./components/CaseReview";
import { MasterListView } from "./components/MasterListView";
import { ExportView } from "./components/ExportView";

type Page = "cases" | "new" | "master" | "export" | "review";

export function App() {
  const [authentication, setAuthentication] = useState<{ initialized: boolean; unlocked: boolean }>();
  const [config, setConfig] = useState<AppConfig>();
  const [cases, setCases] = useState<PatientCase[]>([]);
  const [page, setPage] = useState<Page>("cases");
  const [activeCase, setActiveCase] = useState<PatientCase>();
  const [linkFromCase, setLinkFromCase] = useState<PatientCase>();
  const [capture, setCapture] = useState<CaptureLink>();
  const [error, setError] = useState("");

  useEffect(() => {
    void api.status().then(setAuthentication).catch((caught) => setError((caught as Error).message));
  }, []);

  useEffect(() => {
    if (!authentication?.unlocked || page !== "cases") {
      return;
    }
    const polling = window.setInterval(() => {
      void api.cases().then(setCases).catch(() => {
        // The next foreground action will show session or connection errors.
      });
    }, 2500);
    return () => window.clearInterval(polling);
  }, [authentication?.unlocked, page]);

  async function loadWorkspace() {
    const [nextConfig, nextCases] = await Promise.all([api.config(), api.cases()]);
    setConfig(nextConfig);
    setCases(nextCases);
  }

  async function authenticate(password: string, setup: boolean) {
    if (setup) {
      await api.setup(password);
    } else {
      await api.login(password);
    }
    setAuthentication({ initialized: true, unlocked: true });
    await loadWorkspace();
  }

  async function logout() {
    await api.logout();
    setConfig(undefined);
    setCases([]);
    setActiveCase(undefined);
    setAuthentication({ initialized: true, unlocked: false });
  }

  async function createCase(documentType: DocumentType, profileName: string, fieldIds: string[], continuousCapture: boolean) {
    const created = await api.createCase(documentType, profileName, fieldIds, linkFromCase?.id, continuousCapture);
    setCases((current) => [created.patientCase, ...current]);
    setActiveCase(created.patientCase);
    setCapture(created.capture);
    setLinkFromCase(undefined);
    setPage("review");
  }

  async function savePreset(name: string, documentType: DocumentType, fieldIds: string[]) {
    await api.savePreset(name, documentType, fieldIds);
    setConfig(await api.config());
  }

  function updateCase(updated: PatientCase) {
    setActiveCase(updated);
    setCases((current) => current.map((patientCase) => patientCase.id === updated.id ? updated : patientCase));
  }

  function openCase(patientCase: PatientCase) {
    setActiveCase(patientCase);
    setCapture(undefined);
    setLinkFromCase(undefined);
    setPage("review");
  }

  async function completedCase() {
    const remaining = await api.cases();
    setCases(remaining);
    const queued = [...remaining].reverse().find((patientCase) => patientCase.image);
    if (queued) {
      setActiveCase(queued);
      setCapture(undefined);
      setPage("review");
      return;
    }
    setActiveCase(undefined);
    setPage("cases");
  }

  function attachRelated(patientCase: PatientCase) {
    setLinkFromCase(patientCase);
    setPage("new");
  }

  if (!authentication) {
    return <div className="loading">Opening secure workspace...</div>;
  }

  if (!authentication.unlocked) {
    return <AuthScreen initialized={authentication.initialized} onAuthenticate={authenticate} />;
  }

  if (!config) {
    void loadWorkspace().catch((caught) => setError((caught as Error).message));
    return <div className="loading">Loading workspace...</div>;
  }

  return (
    <div className="application">
      <aside className="sidebar">
        <div className="brand">
          <span>ME</span>
          <div>
            <strong>Encodex</strong>
            <small>Local workspace</small>
          </div>
        </div>
        <nav>
          <button className={page === "cases" || page === "review" ? "current" : ""} onClick={() => setPage("cases")}>
            <ClipboardList size={19} /> Cases
          </button>
          <button className={page === "new" ? "current" : ""} onClick={() => setPage("new")}>
            <FilePlus2 size={19} /> New Capture
          </button>
          <button className={page === "master" ? "current" : ""} onClick={() => setPage("master")}>
            <UsersRound size={19} /> Patient Master
          </button>
          <button className={page === "export" ? "current" : ""} onClick={() => setPage("export")}>
            <FileSpreadsheet size={19} /> CSV Export
          </button>
        </nav>
        <div className="privacy-state">
          <strong>Local-only session</strong>
          <span>Images expire after 7 days</span>
        </div>
        <button className="logout command" onClick={logout}>
          <LogOut size={17} /> Lock
        </button>
      </aside>
      <main className="workspace">
        {error && <p className="notice error global">{error}</p>}
        {page === "cases" && <CasesView cases={cases} onNew={() => setPage("new")} onOpen={openCase} />}
        {page === "new" && (
          <NewCapture fields={config.fields} presets={config.presets} linkedFrom={linkFromCase} onCreate={createCase} onSavePreset={savePreset} />
        )}
        {page === "review" && activeCase && (
          <CaseReview
            patientCase={activeCase}
            fields={config.fields}
            capture={capture}
            masterPatientCount={config.masterPatientCount}
            onCaseUpdate={updateCase}
            onAttachRelated={attachRelated}
            onComplete={completedCase}
          />
        )}
        {page === "master" && <MasterListView count={config.masterPatientCount} onImported={loadWorkspace} />}
        {page === "export" && <ExportView cases={cases} />}
      </main>
    </div>
  );
}
