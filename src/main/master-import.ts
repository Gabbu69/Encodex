import { readSheet } from "read-excel-file/node";
import type { MasterPatient } from "../shared/domain.js";

export interface ImportMapping {
  officialName: string;
  philhealthId: string;
  birthdate: string;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (quoted && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

export async function parsePatientRows(bytes: Buffer, fileName: string): Promise<string[][]> {
  if (fileName.toLowerCase().endsWith(".csv")) {
    return bytes
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map(parseCsvLine);
  }
  if (fileName.toLowerCase().endsWith(".xlsx")) {
    const rows = await readSheet(bytes);
    return rows.map((row) => row.map((cell) => String(cell ?? "").trim()));
  }
  throw new Error("Upload an approved .csv or .xlsx patient master file.");
}

function inferredHeader(headers: string[], possibilities: RegExp[]) {
  return headers.find((header) => possibilities.some((pattern) => pattern.test(header.toLowerCase()))) ?? "";
}

export function suggestMapping(headers: string[]): ImportMapping {
  return {
    officialName: inferredHeader(headers, [/official.*name/, /patient.*name/, /^name$/]),
    philhealthId: inferredHeader(headers, [/phil.*health/, /pin/, /philhealth.*id/]),
    birthdate: inferredHeader(headers, [/birth/, /bdate/, /dob/])
  };
}

export function rowsToPatients(rows: string[][], mapping: ImportMapping): MasterPatient[] {
  const headers = rows[0] ?? [];
  const officialNameIndex = headers.indexOf(mapping.officialName);
  const philhealthIndex = headers.indexOf(mapping.philhealthId);
  const birthdateIndex = headers.indexOf(mapping.birthdate);
  if ([officialNameIndex, philhealthIndex, birthdateIndex].some((index) => index < 0)) {
    throw new Error("Map all required columns before importing: official name, PhilHealth ID, and birthdate.");
  }
  const patients = rows.slice(1).flatMap((row, index) => {
    const officialName = row[officialNameIndex]?.trim();
    const philhealthId = row[philhealthIndex]?.trim();
    const birthdate = row[birthdateIndex]?.trim();
    if (!officialName && !philhealthId && !birthdate) {
      return [];
    }
    if (!officialName || !philhealthId || !birthdate) {
      throw new Error(`Patient master row ${index + 2} is missing a required value.`);
    }
    return [{ id: `patient-${index + 1}`, officialName, philhealthId, birthdate }];
  });
  if (!patients.length) {
    throw new Error("The patient master file contains no usable patient rows.");
  }
  return patients;
}
