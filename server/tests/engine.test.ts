import { describe, expect, it } from 'vitest';
import { solveIlp } from '../src/engine/ilp';
import { greedyAllocate } from '../src/engine/greedy';
import { checkProposals } from '../src/engine/checker';
import type { BedInfo, Candidate, PatientNeed } from '../src/domain/types';

let n = 0;
const bed = (o: Partial<BedInfo> = {}): BedInfo => ({
  id: `b${n++}`, label: 'x', wardId: 'w', department: 'Medicine', room: `r${n}`, type: 'ward',
  category: 'general', sexPolicy: 'any', isolation: false, oxygen: false, ...o,
});
const cand = (b: BedInfo, o: Partial<Candidate> = {}): Candidate =>
  ({ bed: b, status: 'ready', availableInMin: 0, trust: 'confirmed', holdMin: 0, roomOccupants: [], ...o });
const pat = (id: string, o: Partial<PatientNeed> = {}): PatientNeed => ({
  id, urgency: 2, sex: 'F', ageGroup: 'adult', department: 'Medicine', bedType: 'ward',
  needsOxygen: false, needsIsolation: false, category: 'general', acceptsOtherCategory: false, ...o,
});

describe('engine', () => {
  it('plans patients together: the one with fewer options gets the scarce bed', async () => {
    const oxy = bed({ oxygen: true });
    const plain = bed();
    const cands = [cand(oxy), cand(plain)];
    const needs = [pat('anyone'), pat('needsO2', { needsOxygen: true })];
    const out = await solveIlp(needs, cands);
    expect(out.find((p) => p.requestId === 'needsO2')?.bedId).toBe(oxy.id);
    expect(out.find((p) => p.requestId === 'anyone')?.bedId).toBe(plain.id);
  });

  it('keeps the last ready ICU bed for the critical patient', async () => {
    const icu1 = bed({ type: 'icu', department: 'Critical Care' });
    const out = await solveIlp([pat('routine', { bedType: 'icu', urgency: 1 }), pat('critical', { bedType: 'icu', urgency: 3 })], [cand(icu1)]);
    expect(out).toHaveLength(1);
    expect(out[0].requestId).toBe('critical');
  });

  it('prefers own department; age-mix cost is once per room (regression)', async () => {
    const room = 'crowded';
    const medBed = bed({ room });
    const eyeBed = bed({ department: 'Eye' });
    const younger = Array.from({ length: 8 }, () => ({ sex: 'F' as const, ageGroup: 'adult' as const }));
    const out = await solveIlp([pat('elder', { ageGroup: 'elderly' })], [cand(medBed, { roomOccupants: younger }), cand(eyeBed)]);
    expect(out[0].bedId).toBe(medBed.id); // 60 once, not 8 x 60 > 300
  });

  it('never mixes two new patients of different sexes in one empty room', async () => {
    const room = 'double';
    const b1 = bed({ room }); const b2 = bed({ room });
    const cands = [cand(b1), cand(b2)];
    const needs = [pat('f', { sex: 'F' }), pat('m', { sex: 'M' })];
    const out = await solveIlp(needs, cands);
    expect(out).toHaveLength(1);
    const g = greedyAllocate(needs, cands);
    expect(g).toHaveLength(1);
  });

  it('a ward pause delays beds except for critical patients', async () => {
    const b = bed({ type: 'icu', department: 'Critical Care' });
    const out = await solveIlp([pat('crit', { bedType: 'icu', urgency: 3 }), pat('urgent', { bedType: 'icu', urgency: 2 })], [cand(b, { holdMin: 30 })]);
    expect(out[0].requestId).toBe('crit');
    expect(out[0].availableInMin).toBe(0);
  });

  it('honours forbidden pairs (rejected suggestions)', async () => {
    const a = bed(); const b = bed();
    const out = await solveIlp([pat('p')], [cand(a), cand(b)], new Set([`p:${a.id}`]));
    expect(out[0].bedId).toBe(b.id);
  });

  it('solves 60 patients against 200 beds in about a second (includes WASM load)', async () => {
    const cands = Array.from({ length: 200 }, (_, i) => cand(bed({ room: `rm${Math.floor(i / 4)}`, oxygen: i % 2 === 0, sexPolicy: i % 8 < 4 ? 'male' : 'female' })));
    const needs = Array.from({ length: 60 }, (_, i) => pat(`p${i}`, { sex: i % 2 ? 'M' : 'F', urgency: ((i % 3) + 1) as 1 | 2 | 3 }));
    const t = Date.now();
    const out = await solveIlp(needs, cands);
    expect(Date.now() - t).toBeLessThan(2500);
    expect(out).toHaveLength(60);
  });
});

describe('independent checker', () => {
  const beds = new Map([['b', { id: 'b', room: 'r', type: 'ward', category: 'general', sexPolicy: 'male', isolation: false, oxygen: false, occupantSexes: [] }]]);
  const pats = new Map([['p', { id: 'p', sex: 'F', bedType: 'ward', category: 'general', acceptsOtherCategory: false, needsOxygen: false, needsIsolation: false }]]);
  it('catches a broken rule', () => {
    expect(checkProposals([{ requestId: 'p', bedId: 'b' }], pats, beds)[0].rule).toBe('male-only room');
  });
  it('catches a bed used twice', () => {
    const p2 = new Map(pats).set('q', { ...pats.get('p')!, id: 'q', sex: 'M' });
    const rules = checkProposals([{ requestId: 'q', bedId: 'b' }, { requestId: 'q', bedId: 'b' }], p2, beds).map((v) => v.rule);
    expect(rules).toContain('bed used twice');
  });
});
