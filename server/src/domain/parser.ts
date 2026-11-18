import type { BedType, Sex, Urgency } from './types';

export interface Field<T> { value: T; evidence: string } // evidence is always a substring of the note

export interface IntakeResult {
  age?: Field<number>;
  sex?: Field<Sex>;
  bedType?: Field<BedType>;
  department?: Field<string>;
  oxygen?: Field<boolean>;
  isolation?: Field<boolean>;
  urgency?: Field<Urgency>;
  missing: string[]; // required details we could not find
  questions: string[]; // one short question per missing detail
  assumed: string[]; // optional details defaulted - the UI asks the person to confirm
}

const DEPARTMENTS: Record<string, RegExp> = {
  Medicine: /\b(medicine|medical|general medicine)\b/i,
  Surgery: /\b(surgery|surgical|general surgery)\b/i,
  Paediatrics: /\b(paediatrics?|pediatrics?|peds|paeds)\b/i,
  'Obstetrics and Gynaecology': /\b(obg|obs\s*&?\s*gynae?|gynaecology|gynecology|obstetrics?)\b/i,
  Orthopaedics: /\b(orthopaedics?|orthopedics?|ortho)\b/i,
  ENT: /\bENT\b/i,
  Eye: /\b(eye|ophthalmology)\b/i,
  Psychiatry: /\bpsychiatry\b/i,
  Dermatology: /\b(dermatology|skin)\b/i,
};

/** Looks just before and after a keyword for "no", "not", "without", "nahi"... */
function negated(text: string, idx: number, len: number): boolean {
  const before = text.slice(Math.max(0, idx - 14), idx).toLowerCase();
  const after = text.slice(idx + len, idx + len + 14).toLowerCase();
  return /\b(no|not|without|non|nil)\s*$/.test(before) || /^\s*[:\-]?\s*(nahi|nahin|nhi|no|nil)\b/.test(after);
}

const around = (text: string, idx: number, len: number) => text.slice(Math.max(0, idx - 14), idx + len + 14).trim();

function detectFlag(text: string, re: RegExp): Field<boolean> | undefined {
  let negative: Field<boolean> | undefined;
  for (const m of text.matchAll(new RegExp(re.source, 'gi'))) {
    const idx = m.index ?? 0;
    const ev = around(text, idx, m[0].length);
    if (!negated(text, idx, m[0].length)) return { value: true, evidence: ev };
    negative ??= { value: false, evidence: ev };
  }
  return negative;
}

export function parseIntake(note: string): IntakeResult {
  const r: IntakeResult = { missing: [], questions: [], assumed: [] };

  const ageM = note.match(/\b(\d{1,3})\s*(?:yrs?|y\/o|yo|years?|yr old|y)\b/i) ?? note.match(/\bage\s*[:\-]?\s*(\d{1,3})\b/i);
  const sexAgeM = note.match(/\b(\d{1,3})\s*(?:y|yrs?|yo)?\s*[\/,-]?\s*([MF])\b/);
  if (ageM) r.age = { value: Number(ageM[1]), evidence: ageM[0] };
  else if (sexAgeM) r.age = { value: Number(sexAgeM[1]), evidence: sexAgeM[0] };

  const fem = note.match(/\b(female|woman|lady|girl|mahila|ladki)\b/i);
  const mal = note.match(/\b(male|man|boy|gentleman|purush|ladka)\b/i);
  if (fem) r.sex = { value: 'F', evidence: fem[0] };
  else if (mal) r.sex = { value: 'M', evidence: mal[0] };
  else if (sexAgeM) r.sex = { value: sexAgeM[2] as Sex, evidence: sexAgeM[0] };

  const icu = note.match(/\bICU\b/i);
  const hdu = note.match(/\bHDU\b/i);
  for (const [name, re] of Object.entries(DEPARTMENTS)) {
    const m = note.match(re);
    if (m) { r.department = { value: name, evidence: m[0] }; break; }
  }
  if (icu) r.bedType = { value: 'icu', evidence: icu[0] };
  else if (hdu) r.bedType = { value: 'hdu', evidence: hdu[0] };
  else if (r.department) r.bedType = { value: 'ward', evidence: r.department.evidence };

  r.oxygen = detectFlag(note, /\b(?:\d+(?:\.\d+)?\s*(?:L|lpm|l\/min)\s*(?:of\s*)?(?:O2|oxygen)|oxygen|O2)\b/);
  r.isolation = detectFlag(note, /\b(?:isolation|isolate|isolated|contact precautions|airborne precautions|droplet precautions|infectious)\b/);

  const urg = note.match(/\b(critical|unstable|emergency|code red)\b/i) ? 3
    : note.match(/\burgent\b/i) ? 2
    : note.match(/\b(routine|stable|elective)\b/i) ? 1 : null;
  if (urg) r.urgency = { value: urg as Urgency, evidence: (note.match(/\b(critical|unstable|emergency|code red|urgent|routine|stable|elective)\b/i) as RegExpMatchArray)[0] };

  const need = (key: string, q: string, present: unknown) => { if (!present) { r.missing.push(key); r.questions.push(q); } };
  need('age', "What is the patient's age?", r.age);
  need('sex', "Is the patient male or female?", r.sex);
  need('bedType', 'Which ward or unit should the patient go to (or ICU/HDU)?', r.bedType);
  if (!r.urgency) r.assumed.push('urgency: routine');
  if (!r.oxygen) r.assumed.push('oxygen: not needed');
  if (!r.isolation) r.assumed.push('isolation: not needed');
  return r;
}

// ---- nurse replies (English / Hindi / Hinglish) ----
export type Reply = 'ready' | 'not_yet' | 'occupied' | 'unknown';

export function parseReply(raw: string): Reply {
  const t = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return 'unknown';
  if (/\b(kharab|broken|damaged|leak|leaking|repair|out of order|not working|problem)\b/.test(t)) return 'unknown';
  if (/\b(occupied|bhara|full)\b|khali nahi|patient (abhi )?(hai|here|still)|not (free|empty|vacant)/.test(t)) return 'occupied';
  if (/not yet|not (cleaned|clean|ready)|abhi nahi|saaf ho raha|being cleaned|cleaning|dirty|gandi|ganda|pending|thodi der|wait/.test(t)) return 'not_yet';
  if (/\b(ready|khali|empty|vacant|free|clean|cleaned)\b|saaf hai|^(yes|haan|ha|han|ji|ji haan|ok|okay)$/.test(t)) return 'ready';
  return 'unknown';
}
