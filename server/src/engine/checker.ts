// INDEPENDENT rule checker. Deliberately imports nothing from ../domain:
// a bug in the engine or in rules.ts must not be able to hide here.

export interface CheckBed {
  id: string; room: string; type: string; category: string; sexPolicy: string;
  isolation: boolean; oxygen: boolean; occupantSexes: string[];
}
export interface CheckPatient {
  id: string; sex: string; bedType: string; category: string; acceptsOtherCategory: boolean;
  needsOxygen: boolean; needsIsolation: boolean;
}
export interface CheckPair { requestId: string; bedId: string }
export interface Violation { requestId: string; rule: string }

export function checkProposals(pairs: CheckPair[], patients: Map<string, CheckPatient>, beds: Map<string, CheckBed>): Violation[] {
  const bad: Violation[] = [];
  const seenBeds = new Set<string>();
  const seenPatients = new Set<string>();
  const newSexByRoom = new Map<string, Set<string>>();

  for (const { requestId, bedId } of pairs) {
    const p = patients.get(requestId);
    const b = beds.get(bedId);
    if (!p || !b) { bad.push({ requestId, rule: 'unknown patient or bed' }); continue; }
    const fail = (rule: string) => bad.push({ requestId, rule });

    if (seenBeds.has(bedId)) fail('bed used twice');
    if (seenPatients.has(requestId)) fail('patient placed twice');
    seenBeds.add(bedId); seenPatients.add(requestId);

    if (b.type !== p.bedType) fail('bed type');
    if (p.needsIsolation && !b.isolation) fail('isolation');
    if (p.needsOxygen && !b.oxygen) fail('oxygen');
    if (!p.needsIsolation && b.category !== p.category && !p.acceptsOtherCategory) fail('category');
    if (b.sexPolicy === 'male' && p.sex !== 'M') fail('male-only room');
    if (b.sexPolicy === 'female' && p.sex !== 'F') fail('female-only room');
    if (b.sexPolicy === 'any') {
      if (b.occupantSexes.some((s) => s !== p.sex)) fail('mixes with existing occupants');
      const set = newSexByRoom.get(b.room) ?? new Set<string>();
      set.add(p.sex);
      newSexByRoom.set(b.room, set);
      if (set.size > 1) fail('two new patients of different sexes in one room');
    }
  }
  return bad;
}
