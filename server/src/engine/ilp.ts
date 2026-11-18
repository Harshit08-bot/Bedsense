import highsLoader from 'highs';
import type { Candidate, PatientNeed, Proposal } from '../domain/types';
import { W, scoreMatch, totalCost, type Scored } from '../domain/scoring';

let highsP: ReturnType<typeof highsLoader> | null = null;
const getHighs = () => (highsP ??= highsLoader());

const TOP_K = 40; // keep only each patient's K cheapest allowed beds, so the model stays small
const term = (coef: number, v: string) => ` ${coef < 0 ? '-' : '+'} ${Math.abs(Math.round(coef))} ${v}`;

interface Pair { pi: number; bi: number; s: Scored; v: string }

/**
 * One binary variable per (patient, bed). Minimise total cost, where assigning a patient
 * earns back their "unassigned" penalty, so everybody gets a bed when one is allowed.
 * Extra variables: m<room> (room holds men) enforces "no new sex mixing in an empty shared room";
 * z<room> charges the age-mix cost once per room.
 */
export async function solveIlp(
  needs: PatientNeed[], cands: Candidate[], forbidden = new Set<string>(), timeLimitSec = 1,
): Promise<Proposal[]> {
  const pairs: Pair[] = [];
  needs.forEach((p, pi) => {
    cands
      .map((c, bi) => ({ bi, s: forbidden.has(`${p.id}:${c.bed.id}`) ? null : scoreMatch(p, c) }))
      .filter((x): x is { bi: number; s: Scored } => x.s !== null)
      .sort((a, b) => totalCost(a.s) - totalCost(b.s))
      .slice(0, TOP_K)
      .forEach(({ bi, s }) => pairs.push({ pi, bi, s, v: `x${pi}_${bi}` }));
  });
  if (pairs.length === 0) return [];

  const roomIds = new Map<string, number>();
  const rid = (room: string) => roomIds.get(room) ?? (roomIds.set(room, roomIds.size), roomIds.size - 1);
  const objective: string[] = [];
  const constraints: string[] = [];
  const binaries = new Set<string>();
  const zRooms = new Set<number>();
  const mRooms = new Set<number>();
  const candsPerRoom = new Map<string, number>();
  for (const c of cands) candsPerRoom.set(c.bed.room, (candsPerRoom.get(c.bed.room) ?? 0) + 1);

  for (const { pi, bi, s, v } of pairs) {
    binaries.add(v);
    objective.push(term(s.base - W.unassigned * needs[pi].urgency, v));
    const c = cands[bi];
    const r = rid(c.bed.room);
    if (s.ageMix) {
      zRooms.add(r);
      constraints.push(` za${pi}_${bi}: ${v} - z${r} <= 0`);
    }
    if (c.bed.sexPolicy === 'any' && c.roomOccupants.length === 0 && (candsPerRoom.get(c.bed.room) ?? 0) > 1) {
      mRooms.add(r);
      constraints.push(needs[pi].sex === 'M' ? ` sx${pi}_${bi}: ${v} - m${r} <= 0` : ` sx${pi}_${bi}: ${v} + m${r} <= 1`);
    }
  }
  for (const r of zRooms) { binaries.add(`z${r}`); objective.push(term(W.ageMix, `z${r}`)); }
  for (const r of mRooms) binaries.add(`m${r}`);

  needs.forEach((_, pi) => {
    const vs = pairs.filter((x) => x.pi === pi).map((x) => x.v);
    if (vs.length) constraints.push(` pc${pi}: ${vs.join(' + ')} <= 1`);
  });
  cands.forEach((_, bi) => {
    const vs = pairs.filter((x) => x.bi === bi).map((x) => x.v);
    if (vs.length > 1) constraints.push(` bc${bi}: ${vs.join(' + ')} <= 1`);
  });

  const lp = `Minimize\n obj:${objective.join('')}\nSubject To\n${constraints.join('\n')}\nBinary\n ${[...binaries].join(' ')}\nEnd\n`;
  const highs = await getHighs();
  const sol = highs.solve(lp, { time_limit: timeLimitSec });
  if (sol.Status !== 'Optimal' && sol.Status !== 'Time limit reached') throw new Error(`ILP status: ${sol.Status}`);

  return pairs
    .filter((x) => (sol.Columns[x.v]?.Primal ?? 0) > 0.5)
    .map((x) => ({
      requestId: needs[x.pi].id,
      bedId: cands[x.bi].bed.id,
      cost: totalCost(x.s),
      availableInMin: x.s.availableInMin,
      reasons: x.s.reasons,
    }));
}
