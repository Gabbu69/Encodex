import type { MasterPatient, MatchCandidate } from "./domain.js";

export function normalizeName(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function normalizeDate(value: string): string {
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length !== 8) {
    return value.trim();
  }
  const firstFour = Number(digits.slice(0, 4));
  if (firstFour > 1900) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  }
  return `${digits.slice(4, 8)}-${digits.slice(0, 2)}-${digits.slice(2, 4)}`;
}

function editDistance(first: string, second: string): number {
  const row = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let i = 1; i <= first.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= second.length; j += 1) {
      const saved = row[j];
      const replace = previous + (first[i - 1] === second[j - 1] ? 0 : 1);
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, replace);
      previous = saved;
    }
  }
  return row[second.length];
}

export function similarity(first: string, second: string): number {
  const a = normalizeName(first);
  const b = normalizeName(second);
  if (!a || !b) {
    return 0;
  }
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

export function findCandidates(patients: MasterPatient[], observedName: string, birthdate: string): MatchCandidate[] {
  const normalizedBirthdate = normalizeDate(birthdate);
  return patients
    .filter((patient) => normalizeDate(patient.birthdate) === normalizedBirthdate)
    .map((patient) => ({
      patientId: patient.id,
      officialName: patient.officialName,
      philhealthId: patient.philhealthId,
      birthdate: patient.birthdate,
      score: similarity(observedName, patient.officialName)
    }))
    .filter((candidate) => candidate.score >= 0.45)
    .sort((a, b) => b.score - a.score);
}
