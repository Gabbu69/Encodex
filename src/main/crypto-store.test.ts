import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "./crypto-store.js";

const folders: string[] = [];

afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { force: true, recursive: true })));
});
describe("encrypted local storage", () => {
  it("encrypts structured values and source image bytes at rest", async () => {
    const folder = await mkdtemp(path.join(tmpdir(), "medical-vault-"));
    folders.push(folder);
    const store = new VaultStore(folder);
    await store.setup("correct horse battery staple");
    await store.updateData((data) => {
      data.masterPatients = [{ id: "p1", officialName: "PRIVATE PERSON", philhealthId: "012345678901", birthdate: "2000-01-01" }];
    });
    await store.storeImage("scan", Buffer.from("not-a-real-patient-image"));

    expect((await readFile(path.join(folder, "records.enc"))).toString("utf8")).not.toContain("PRIVATE PERSON");
    expect((await readFile(path.join(folder, "images", "scan.enc"))).toString("utf8")).not.toContain("not-a-real-patient-image");

    store.lock();
    await expect(store.readData()).rejects.toThrow("locked");
    expect(await store.unlock("correct horse battery staple")).toBe(true);
    expect((await store.readData()).masterPatients[0].officialName).toBe("PRIVATE PERSON");
  });
});
