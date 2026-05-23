import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PatientCase, VaultData } from "../shared/domain.js";

interface VaultMetadata {
  version: number;
  salt: string;
  verifier: string;
}

const EMPTY_VAULT: VaultData = {
  cases: [],
  customPresets: [],
  masterPatients: [],
  audit: []
};

function dateNow() {
  return new Date().toISOString();
}

export class VaultStore {
  private readonly metadataPath: string;
  private readonly recordsPath: string;
  private readonly imagesPath: string;
  private key?: Buffer;

  constructor(private readonly rootPath: string) {
    this.metadataPath = path.join(rootPath, "vault-meta.json");
    this.recordsPath = path.join(rootPath, "records.enc");
    this.imagesPath = path.join(rootPath, "images");
  }

  async initialized(): Promise<boolean> {
    try {
      await readFile(this.metadataPath);
      return true;
    } catch {
      return false;
    }
  }

  isUnlocked() {
    return Boolean(this.key);
  }

  async setup(password: string): Promise<void> {
    if (await this.initialized()) {
      throw new Error("The secure store has already been configured.");
    }
    if (password.length < 10) {
      throw new Error("Use an app password with at least 10 characters.");
    }
    await mkdir(this.imagesPath, { recursive: true });
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, 32);
    const metadata: VaultMetadata = {
      version: 1,
      salt: salt.toString("base64"),
      verifier: this.verifier(key)
    };
    await writeFile(this.metadataPath, JSON.stringify(metadata, null, 2), "utf8");
    this.key = key;
    await this.writeData({ ...EMPTY_VAULT });
  }

  async unlock(password: string): Promise<boolean> {
    const metadata = JSON.parse(await readFile(this.metadataPath, "utf8")) as VaultMetadata;
    const key = scryptSync(password, Buffer.from(metadata.salt, "base64"), 32);
    const supplied = Buffer.from(this.verifier(key));
    const expected = Buffer.from(metadata.verifier);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return false;
    }
    this.key = key;
    return true;
  }

  lock() {
    this.key = undefined;
  }

  async readData(): Promise<VaultData> {
    this.requireKey();
    try {
      const encrypted = await readFile(this.recordsPath);
      return JSON.parse(this.decrypt(encrypted).toString("utf8")) as VaultData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...EMPTY_VAULT };
      }
      throw error;
    }
  }

  async updateData(mutator: (data: VaultData) => void): Promise<VaultData> {
    const data = await this.readData();
    mutator(data);
    await this.writeData(data);
    return data;
  }

  async storeImage(imageId: string, bytes: Buffer): Promise<void> {
    this.requireKey();
    await mkdir(this.imagesPath, { recursive: true });
    await writeFile(path.join(this.imagesPath, `${imageId}.enc`), this.encrypt(bytes));
  }

  async readImage(imageId: string): Promise<Buffer> {
    this.requireKey();
    return this.decrypt(await readFile(path.join(this.imagesPath, `${imageId}.enc`)));
  }

  async deleteImage(imageId: string): Promise<void> {
    await rm(path.join(this.imagesPath, `${imageId}.enc`), { force: true });
  }

  async purgeExpiredImages(now = new Date()): Promise<number> {
    if (!this.isUnlocked()) {
      return 0;
    }
    let deleted = 0;
    const data = await this.readData();
    for (const patientCase of data.cases) {
      if (patientCase.image && new Date(patientCase.image.expiresAt) <= now) {
        await this.deleteImage(patientCase.image.id);
        patientCase.image = undefined;
        patientCase.updatedAt = dateNow();
        deleted += 1;
      }
    }
    if (deleted) {
      data.audit.push({ type: "image_retention_purge", createdAt: dateNow(), detail: `${deleted} expired source image(s) deleted.` });
      await this.writeData(data);
    }
    return deleted;
  }

  async removeCompletedCase(caseId: string): Promise<void> {
    const data = await this.readData();
    const patientCase = data.cases.find((entry) => entry.id === caseId);
    if (!patientCase) {
      throw new Error("Case not found.");
    }
    if (patientCase.image) {
      await this.deleteImage(patientCase.image.id);
    }
    data.cases = data.cases.filter((entry) => entry.id !== caseId);
    data.audit.push({
      type: "official_entry_confirmed",
      createdAt: dateNow(),
      detail: `Case ${caseId} content and temporary image deleted after confirmation.`
    });
    await this.writeData(data);
  }

  newId() {
    return randomUUID();
  }

  private async writeData(data: VaultData): Promise<void> {
    this.requireKey();
    await mkdir(this.rootPath, { recursive: true });
    await writeFile(this.recordsPath, this.encrypt(Buffer.from(JSON.stringify(data), "utf8")));
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error("Secure store is locked.");
    }
    return this.key;
  }

  private verifier(key: Buffer) {
    return createHmac("sha256", key).update("medical-scan-copy-assistant:v1").digest("base64");
  }

  private encrypt(plain: Buffer) {
    const key = this.requireKey();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  }

  private decrypt(envelope: Buffer) {
    const key = this.requireKey();
    const nonce = envelope.subarray(0, 12);
    const tag = envelope.subarray(12, 28);
    const encrypted = envelope.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
}

export function safeCase(patientCase: PatientCase): PatientCase {
  const sanitized = structuredClone(patientCase);
  delete sanitized.uploadTokenHash;
  return sanitized;
}
