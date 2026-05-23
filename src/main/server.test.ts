import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "./crypto-store.js";
import { createServer } from "./server.js";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function harness(ocr = { async recognizeSelected() { return []; } }) {
  const folder = await mkdtemp(path.join(tmpdir(), "medical-api-"));
  folders.push(folder);
  const clipboard = { value: "", writeText(value: string) { this.value = value; }, clear() { this.value = ""; } };
  const store = new VaultStore(folder);
  const app = createServer({
    store,
    clipboard,
    captureOrigin: () => "http://192.168.1.2:4179",
    ocr
  });
  const agent = request.agent(app);
  await agent.post("/api/setup").send({ password: "correct horse battery staple" }).expect(201);
  return { agent, clipboard, app, store };
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
      if (documentType === "xray") {
        expect(created.body.patientCase.alignment).toMatchObject({ top: 0.16, bottom: 0.1 });
      }
    }
  );

  it("serves an HTTP-compatible phone upload page and stores the submitted photo", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "urinalysis", profileName: "Name Only", fieldIds: ["observed_name"] })
      .expect(201);
    const token = String(created.body.capture.url).split("/").pop()!;

    const page = await agent.get(`/capture/${token}`).expect(200);
    expect(page.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
    expect(page.text).toContain("Take or choose photo");
    expect(page.text).toContain("/capture.js");

    const uploaded = await agent
      .post(`/capture/${token}`)
      .attach("document", Buffer.from("fabricated image"), { filename: "form.jpg", contentType: "image/jpeg" })
      .expect(200);
    expect(uploaded.text).toContain("Photo sent");

    const updated = await agent.get(`/api/cases/${created.body.patientCase.id}`).expect(200);
    expect(updated.body.image).toEqual(expect.objectContaining({ mimeType: "image/jpeg" }));
  });

  it("queues repeated phone uploads with the same selected fields in continuous mode", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "xray", profileName: "Name Only", fieldIds: ["observed_name"], continuousCapture: true })
      .expect(201);
    const token = String(created.body.capture.url).split("/").pop()!;

    const firstUpload = await agent
      .post(`/capture/${token}`)
      .attach("document", Buffer.from("first fabricated image"), { filename: "first.jpg", contentType: "image/jpeg" })
      .expect(200);
    expect(firstUpload.text).toContain("Capture Next Paper");
    expect(firstUpload.text).toContain("Same profile and selected fields only.");

    const nextPage = await agent.get(`/capture/${token}/next`).expect(200);
    expect(nextPage.text).toContain("Scan next paper");
    expect(nextPage.text).toContain("same selected fields");

    const nextUpload = await agent
      .post(`/capture/${token}/next`)
      .attach("document", Buffer.from("second fabricated image"), { filename: "second.jpg", contentType: "image/jpeg" })
      .expect(200);
    expect(nextUpload.text).toContain("Capture Next Paper");

    await agent
      .post(`/capture/${token}/next`)
      .attach("document", Buffer.from("duplicate attempt"), { filename: "third.jpg", contentType: "image/jpeg" })
      .expect(410);

    const cases = (await agent.get("/api/cases").expect(200)).body;
    expect(cases).toHaveLength(2);
    expect(cases.every((patientCase: { continuousCapture?: boolean }) => patientCase.continuousCapture)).toBe(true);
    expect(cases.map((patientCase: { selectedFieldIds: string[] }) => patientCase.selectedFieldIds)).toEqual([
      ["observed_name"],
      ["observed_name"]
    ]);
    expect(cases.every((patientCase: { image?: unknown }) => Boolean(patientCase.image))).toBe(true);
  });

  it("does not offer another phone upload when continuous scanning is off", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "urinalysis", profileName: "Name Only", fieldIds: ["observed_name"], continuousCapture: false })
      .expect(201);
    const token = String(created.body.capture.url).split("/").pop()!;

    const uploaded = await agent
      .post(`/capture/${token}`)
      .attach("document", Buffer.from("fabricated image"), { filename: "form.jpg", contentType: "image/jpeg" })
      .expect(200);
    expect(uploaded.text).not.toContain("Capture Next Paper");
    await agent.get(`/capture/${token}/next`).expect(410);
  });

  it("changes a captured name-only form template and carries it to the next continuous paper", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "urinalysis", profileName: "Name Only", fieldIds: ["observed_name"], continuousCapture: true })
      .expect(201);
    const caseId = created.body.patientCase.id as string;
    const token = String(created.body.capture.url).split("/").pop()!;

    await agent
      .post(`/capture/${token}`)
      .attach("document", Buffer.from("fabricated radiology page"), { filename: "radiology.jpg", contentType: "image/jpeg" })
      .expect(200);
    const changed = await agent
      .put(`/api/cases/${caseId}/document-type`)
      .send({ documentType: "xray" })
      .expect(200);
    expect(changed.body.documentType).toBe("xray");
    expect(changed.body.selectedFieldIds).toEqual(["observed_name"]);
    expect(changed.body.alignment).toMatchObject({ top: 0.16, bottom: 0.1 });
    expect(changed.body.image).toBeDefined();

    await agent
      .post(`/capture/${token}/next`)
      .attach("document", Buffer.from("next fabricated radiology page"), { filename: "next.jpg", contentType: "image/jpeg" })
      .expect(200);
    const cases = (await agent.get("/api/cases").expect(200)).body;
    expect(cases).toHaveLength(2);
    expect(cases.every((patientCase: { documentType: string }) => patientCase.documentType === "xray")).toBe(true);
  });

  it("does not switch a case to a form that cannot contain its selected fields", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "urinalysis", profileName: "Urinalysis Results", fieldIds: ["color"] })
      .expect(201);

    await agent
      .put(`/api/cases/${created.body.patientCase.id}/document-type`)
      .send({ documentType: "xray" })
      .expect(400);
  });

  it("can reduce a captured record to Name Only without adding data and repeats that reduced setup", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "xray", profileName: "Patient Identity", fieldIds: ["observed_name", "age"], continuousCapture: true })
      .expect(201);
    const caseId = created.body.patientCase.id as string;
    const token = String(created.body.capture.url).split("/").pop()!;

    await capturePhoto(agent, created.body.capture.url);
    await agent
      .put(`/api/cases/${caseId}/review`)
      .send({
        values: {
          observed_name: { value: "TEST PERSON", confirmed: true },
          age: { value: "24", confirmed: true }
        }
      })
      .expect(200);
    const reduced = await agent
      .put(`/api/cases/${caseId}/selection`)
      .send({ profileName: "Name Only", fieldIds: ["observed_name"] })
      .expect(200);
    expect(reduced.body.profileName).toBe("Name Only");
    expect(reduced.body.selectedFieldIds).toEqual(["observed_name"]);
    expect(reduced.body.values).toEqual({ observed_name: expect.objectContaining({ value: "TEST PERSON", confirmed: true }) });

    await agent
      .post(`/capture/${token}/next`)
      .attach("document", Buffer.from("next fabricated name page"), { filename: "next.jpg", contentType: "image/jpeg" })
      .expect(200);
    const cases = (await agent.get("/api/cases").expect(200)).body;
    expect(cases[0].profileName).toBe("Name Only");
    expect(cases[0].selectedFieldIds).toEqual(["observed_name"]);
  });

  it("cannot add a new field to an already captured selection", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "xray", profileName: "Name Only", fieldIds: ["observed_name"] })
      .expect(201);

    await agent
      .put(`/api/cases/${created.body.patientCase.id}/selection`)
      .send({ profileName: "Identity", fieldIds: ["observed_name", "age"] })
      .expect(400);
  });

  it("reads only a manually marked name rectangle for a Name Only capture", async () => {
    const recognizeSelected = vi.fn(async () => [{ fieldId: "observed_name", text: "SAMPLE, TEST NAME", confidence: 93 }]);
    const { agent } = await harness({ recognizeSelected });
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "xray", profileName: "Name Only", fieldIds: ["observed_name"] })
      .expect(201);
    await capturePhoto(agent, created.body.capture.url);
    const nameRegion = { left: 0.24, top: 0.43, width: 0.32, height: 0.05 };

    await agent
      .post(`/api/cases/${created.body.patientCase.id}/ocr`)
      .send({ fieldIds: ["observed_name"], nameRegion })
      .expect(200);

    expect(recognizeSelected).toHaveBeenCalledWith(
      expect.any(Buffer),
      "xray",
      [expect.objectContaining({ id: "observed_name" })],
      expect.any(Object),
      { observed_name: nameRegion }
    );
  });

  it("rejects a marked name rectangle when the name was not selected", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "urinalysis", profileName: "Urinalysis Results", fieldIds: ["color"] })
      .expect(201);
    await capturePhoto(agent, created.body.capture.url);

    await agent
      .post(`/api/cases/${created.body.patientCase.id}/ocr`)
      .send({ fieldIds: ["color"], nameRegion: { left: 0.2, top: 0.2, width: 0.2, height: 0.04 } })
      .expect(400);
  });

  it("allows continuous capture after the previous reviewed case is deleted", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "xray", profileName: "Name Only", fieldIds: ["observed_name"], continuousCapture: true })
      .expect(201);
    const caseId = created.body.patientCase.id as string;
    const token = String(created.body.capture.url).split("/").pop()!;

    await agent
      .post(`/capture/${token}`)
      .attach("document", Buffer.from("first fabricated image"), { filename: "first.jpg", contentType: "image/jpeg" })
      .expect(200);
    await agent
      .put(`/api/cases/${caseId}/review`)
      .send({ values: { observed_name: { value: "REVIEWED NAME", confirmed: true } } })
      .expect(200);
    await agent.post(`/api/cases/${caseId}/complete`).expect(200);

    await agent.get(`/capture/${token}/next`).expect(200);
    await agent
      .post(`/capture/${token}/next`)
      .attach("document", Buffer.from("next fabricated image"), { filename: "next.jpg", contentType: "image/jpeg" })
      .expect(200);
    const remaining = (await agent.get("/api/cases").expect(200)).body;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].selectedFieldIds).toEqual(["observed_name"]);
  });

  it("returns a mobile-readable failure when a phone photo exceeds the upload limit", async () => {
    const { agent } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "urinalysis", profileName: "Name Only", fieldIds: ["observed_name"] })
      .expect(201);
    const token = String(created.body.capture.url).split("/").pop()!;

    const uploaded = await agent
      .post(`/capture/${token}`)
      .attach("document", Buffer.alloc(12 * 1024 * 1024 + 1), { filename: "too-large.jpg", contentType: "image/jpeg" })
      .expect(400);
    expect(uploaded.text).toContain("Photo not sent");
    expect(uploaded.text).toContain("over 12 MB");
  });

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

  it("does not copy a low-confidence OCR name until an encoder corrects it", async () => {
    const { agent, clipboard, store } = await harness();
    const created = await agent
      .post("/api/cases")
      .send({ documentType: "xray", profileName: "Name Only", fieldIds: ["observed_name"] })
      .expect(201);
    await capturePhoto(agent, created.body.capture.url);
    const caseId = created.body.patientCase.id as string;

    await agent
      .put(`/api/cases/${caseId}/review`)
      .send({ values: { observed_name: { value: "Eki Nn HERE", confirmed: true, confidence: 9 } } })
      .expect(400);
    await store.updateData((data) => {
      const patientCase = data.cases.find((entry) => entry.id === caseId)!;
      patientCase.values.observed_name = { value: "Eki Nn HERE", confirmed: true, confidence: 9 };
    });
    await agent.post(`/api/cases/${caseId}/copy/observed_name`).expect(400);
    expect(clipboard.value).toBe("");

    await agent
      .put(`/api/cases/${caseId}/review`)
      .send({ values: { observed_name: { value: "SAMPLE, TEST NAME", confirmed: true } } })
      .expect(200);
    await agent.post(`/api/cases/${caseId}/copy/observed_name`).expect(200);
    expect(clipboard.value).toBe("SAMPLE, TEST NAME");
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
