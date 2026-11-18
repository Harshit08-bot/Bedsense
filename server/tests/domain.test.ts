import { describe, expect, it } from 'vitest';
import { applyEvent, computeTrust, initialState, minutesUntilReady, replay } from '../src/domain/ledger';
import { violatesHardRule } from '../src/domain/rules';
import { parseIntake, parseReply } from '../src/domain/parser';
import type { BedInfo, PatientNeed } from '../src/domain/types';

const t0 = new Date('2026-01-01T10:00:00Z');
const at = (min: number) => new Date(t0.getTime() + min * 60000);

const bed = (o: Partial<BedInfo> = {}): BedInfo => ({
  id: 'b1', label: 'M-1', wardId: 'w', department: 'Medicine', room: 'r1', type: 'ward',
  category: 'general', sexPolicy: 'any', isolation: false, oxygen: false, ...o,
});
const patient = (o: Partial<PatientNeed> = {}): PatientNeed => ({
  id: 'p1', urgency: 2, sex: 'F', ageGroup: 'adult', department: 'Medicine', bedType: 'ward',
  needsOxygen: false, needsIsolation: false, category: 'general', acceptsOtherCategory: false, ...o,
});

describe('ledger', () => {
  it('walks a bed through its cycle', () => {
    const s = replay([
      { type: 'ADMITTED', at: at(0), source: 'board', payload: { occupant: { sex: 'M', ageGroup: 'adult' } } },
      { type: 'DISCHARGE_ORDERED', at: at(60), source: 'board' },
      { type: 'PATIENT_LEFT', at: at(120), source: 'board' },
      { type: 'CLEANED', at: at(160), source: 'ward' },
    ], t0);
    expect(s.status).toBe('ready');
    expect(s.occupant).toBeUndefined();
    expect(s.lastConfirmedAt).toEqual(at(160));
  });
  it('a board event resets confirmation, a ward event sets it', () => {
    let s = applyEvent(initialState(t0), { type: 'STATUS_CONFIRMED', at: at(1), source: 'ward', payload: { status: 'ready' } });
    expect(computeTrust(s, at(10))).toBe('confirmed');
    s = applyEvent(s, { type: 'BLOCKED', at: at(20), source: 'board' });
    expect(s.lastConfirmedAt).toBeUndefined();
  });
  it('doubts a bed that stays dirty too long', () => {
    const s = applyEvent(initialState(t0), { type: 'PATIENT_LEFT', at: at(0), source: 'board' });
    expect(computeTrust(s, at(60))).toBe('inferred');
    expect(computeTrust(s, at(130))).toBe('stale');
    expect(minutesUntilReady(s, at(10))).toBe(35);
  });
});

describe('hard rules', () => {
  it('bed type, oxygen, isolation', () => {
    expect(violatesHardRule(patient({ bedType: 'icu' }), bed(), [])).toBeTruthy();
    expect(violatesHardRule(patient({ needsOxygen: true }), bed(), [])).toBeTruthy();
    expect(violatesHardRule(patient({ needsOxygen: true }), bed({ oxygen: true }), [])).toBeNull();
    expect(violatesHardRule(patient({ needsIsolation: true }), bed(), [])).toBeTruthy();
  });
  it('isolation overrides payment category', () => {
    expect(violatesHardRule(patient({ needsIsolation: true }), bed({ isolation: true, category: 'private' }), [])).toBeNull();
    expect(violatesHardRule(patient(), bed({ category: 'private' }), [])).toBeTruthy();
    expect(violatesHardRule(patient({ acceptsOtherCategory: true }), bed({ category: 'private' }), [])).toBeNull();
  });
  it('sex rules; children rooms may mix', () => {
    expect(violatesHardRule(patient({ sex: 'F' }), bed({ sexPolicy: 'male' }), [])).toBeTruthy();
    expect(violatesHardRule(patient({ sex: 'F' }), bed(), [{ sex: 'M', ageGroup: 'adult' }])).toBeTruthy();
    expect(violatesHardRule(patient({ sex: 'F' }), bed({ sexPolicy: 'children' }), [{ sex: 'M', ageGroup: 'child' }])).toBeNull();
  });
});

describe('intake parser', () => {
  it('reads the guide example', () => {
    const r = parseIntake('62 yr old female, COPD, on 4L O2. Admit under Medicine ward. No isolation');
    expect(r.age?.value).toBe(62);
    expect(r.sex?.value).toBe('F');
    expect(r.department?.value).toBe('Medicine');
    expect(r.bedType?.value).toBe('ward');
    expect(r.oxygen?.value).toBe(true);
    expect(r.isolation?.value).toBe(false);
    expect(r.missing).toEqual([]);
  });
  it('handles negations and Hinglish', () => {
    expect(parseIntake('45 M surgery, O2 nahi').oxygen?.value).toBe(false);
    expect(parseIntake('45 M surgery, isolation no').isolation?.value).toBe(false);
    expect(parseIntake('45 M surgery, contact precautions').isolation?.value).toBe(true);
    expect(parseIntake('70 year old man needs ICU, critical').urgency?.value).toBe(3);
  });
  it('asks instead of guessing', () => {
    const r = parseIntake('chest pain, admit medicine');
    expect(r.missing).toEqual(['age', 'sex']);
    expect(r.questions).toHaveLength(2);
  });
  it('evidence is always quoted from the note', () => {
    const note = '62 yr old female, on 4L O2. Admit under Medicine ward. No isolation';
    const r = parseIntake(note);
    for (const f of [r.age, r.sex, r.department, r.oxygen, r.isolation]) expect(note.includes(f!.evidence)).toBe(true);
  });
});

describe('reply parser', () => {
  it.each([
    ['haan khali hai', 'ready'], ['Ready', 'ready'], ['yes', 'ready'],
    ['abhi saaf ho raha hai', 'not_yet'], ['Not cleaned yet', 'not_yet'], ['not ready', 'not_yet'],
    ['patient abhi hai', 'occupied'], ['khali nahi hai', 'occupied'], ['not free', 'occupied'],
    ['bed kharab hai', 'unknown'], ['???', 'unknown'], ['', 'unknown'],
  ])('%s -> %s', (text, want) => expect(parseReply(text)).toBe(want));
});
