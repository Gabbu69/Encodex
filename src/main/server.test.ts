import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "./crypto-store.js";
import { createServer } from "./server.js";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function harness() {
  const folder = await mkdtemp(path.join(tmpdir(), "medical-api-"));
  folders.push(folder);
  const clipboard = { value: "", writeText(value: string) { this.value = value; }, clear() { this.value = ""; } };
  const app = createServer({
    store: new VaultStore(folder),
    clipboard,
    captureOrigin: () => "http://192.168.1.2:4179",
    ocr: { async recognizeSelected() { return []; } }
  });
  const agent = request.agent(app);
  await agent.post("/api/setup").send({ password: "correct horse battery staple" }).expect(201);
  return { agent, clipboard, app };
}

async function capturePhoto(agent: request.SuperAgentTest, captureUrl: string) {
  const token = captureUrl.split("/").pop()!;
  await agent
    .post(`/capture/${token}`)
    .attach("document", Buffer.from("fabricated image"), { filename: "form.jpg", contentType: "image/jpeg" })
    .expect(200);
}

describe("selected-field privacy boundary", () => {
  it("requires a login session even while the encrypted vault is unlocked elsewhere", async () => {
    const { app } = await harness();
    const separateSession = request.agent(app);

    const status = await separateSession.get("/api/status").expect(200);

    expect(status.body).toEqual({ initialized: true, unlocked: false });
    await separateSession.get("/api/config").expect(401);
  });

  it.each(["urinalysis", "pregnancy_test", "xray", "medical_certificate"] as const)(
    "supports Name Only capture for the %s template",
    async (documentType) => {
      const { agent } = await harness();
      const created = await agent
        .post("/api/cases")
        .send({ documentType, profileName: "Name Only", fieldIds: ["observed_name"] })
        .expect(201);
      expect(created.body.patientCase.documentType).toBe(documentType);
      expect(created.body.patientCase.selectedFieldIds).toEqual(["observed_name"]);
    }
  );

  it("retains and copies only the field selected before a Name Only capture", async () => {
    const { agent, clipboard } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "urinalysis", profileName: "Name Only", fieldIds: ["observed_name"] })
      .expect(201);
    await capturePhoto(agent, created.body.capture.url);
    const caseId = created.body.patientCase.id as string;

    await agent
      .put(`/api/cases/${caseId}/review`)
      .send({
        values: {
          observed_name: { value: "CONFIRMED NAME", confirmed: true },
          diagnosis: { value: "MUST NOT STORE", confirmed: true }
        }
      })
      .expect(400);

    await agent
      .put(`/api/cases/${caseId}/review`)
      .send({ values: { observed_name: { value: "CONFIRMED NAME", confirmed: true } } })
      .expect(200);
    await agent.post(`/api/cases/${caseId}/copy/observed_name`).expect(200);
    expect(clipboard.value).toBe("CONFIRMED NAME");

    const exported = await agent.post("/api/export").send({ caseIds: [caseId] }).expect(200);
    expect(exported.text).toContain("CONFIRMED NAME");
    expect(exported.text).not.toContain("MUST NOT STORE");
    await agent.post(`/api/cases/${caseId}/complete`).expect(200);
    expect((await agent.get("/api/cases").expect(200)).body).toEqual([]);
  });

  it("uses a confirmed birthdate match to provide only requested master-list output", async () => {
    const { agent } = await harness();
    const master = [
      "Official Name,PhilHealth ID,Birthdate",
      "MARIA SAMPLE,000011112222,2001-04-03"
    ].join("\n");
    await agent
      .post("/api/master/import")
      .field("mapping", JSON.stringify({ officialName: "Official Name", philhealthId: "PhilHealth ID", birthdate: "Birthdate" }))
      .attach("file", Buffer.from(master), "master.csv")
      .expect(201);
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "medical_certificate", profileName: "PhilHealth ID", fieldIds: ["philhealth_id"] })
      .expect(201);
    await capturePhoto(agent, created.body.capture.url);
    const caseId = created.body.patientCase.id as string;
    const matches = await agent
      .post(`/api/cases/${caseId}/match`)
      .send({ observedName: "MARIA SAMPL", birthdate: "04/03/2001" })
      .expect(200);
    expect(matches.body.candidates).toHaveLength(1);

    const confirmed = await agent
      .post(`/api/cases/${caseId}/match/confirm`)
      .send({ patientId: matches.body.candidates[0].patientId, observedName: "MARIA SAMPL", birthdate: "04/03/2001" })
      .expect(200);
    expect(confirmed.body.values).toEqual({
      philhealth_id: expect.objectContaining({ value: "000011112222", confirmed: true })
    });
    expect(confirmed.body.observedNameForMatch).toBeUndefined();
  });

  it("cannot set a master-list identity field by direct review input", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "urinalysis", profileName: "PhilHealth ID", fieldIds: ["philhealth_id"] })
      .expect(201);
    await capturePhoto(agent, created.body.capture.url);
    await agent
      .put(`/api/cases/${created.body.patientCase.id}/review`)
      .send({ values: { philhealth_id: { value: "FORGED-ID", confirmed: true } } })
      .expect(400);
  });

  it("invalidates a confirmed match when a selected identity value changes", async () => {
    const { agent } = await harness();
    const master = ["Official Name,PhilHealth ID,Birthdate", "ANA SAMPLE,999900001111,2002-02-01"].join("\n");
    await agent
      .post("/api/master/import")
      .field("mapping", JSON.stringify({ officialName: "Official Name", philhealthId: "PhilHealth ID", birthdate: "Birthdate" }))
      .attach("file", Buffer.from(master), "master.csv")
      .expect(201);
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "urinalysis", profileName: "Patient Identity", fieldIds: ["observed_name", "philhealth_id"] })
      .expect(201);
    await capturePhoto(agent, created.body.capture.url);
    const caseId = created.body.patientCase.id as string;
    await agent
      .put(`/api/cases/${caseId}/review`)
      .send({ values: { observed_name: { value: "ANA SAMPLE", confirmed: true } } })
      .expect(200);
    const matches = await agent.post(`/api/cases/${caseId}/match`).send({ observedName: "ANA SAMPLE", birthdate: "02/01/2002" }).expect(200);
    await agent
      .post(`/api/cases/${caseId}/match/confirm`)
      .send({ patientId: matches.body.candidates[0].patientId, observedName: "ANA SAMPLE", birthdate: "02/01/2002" })
      .expect(200);
    const changed = await agent
      .put(`/api/cases/${caseId}/review`)
      .send({ values: { observed_name: { value: "ANA CHANGED", confirmed: true } } })
      .expect(200);
    expect(changed.body.values.philhealth_id).toBeUndefined();
    expect(changed.body.matchedPatientId).toBeUndefined();
  });
});
