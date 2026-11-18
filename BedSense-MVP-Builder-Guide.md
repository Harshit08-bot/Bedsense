# BedSense MVP: Builder Guide

**Stack:** React (Vite + TypeScript) · Node.js (Express + TypeScript) · MongoDB (Mongoose) · Socket.IO · HiGHS (optimiser)
**Goal:** a working, interactive, usable MVP of BedSense that fixes bed data first and then allocates beds.

---

## Contents

0. [Read this first](#0-read-this-first)
1. [What you are building](#1-what-you-are-building)
2. [Architecture and the decisions behind it](#2-architecture-and-the-decisions-behind-it)
3. [Setup](#3-setup)
4. [Data model](#4-data-model)
5. [Build the backend, step by step](#5-build-the-backend-step-by-step)
6. [Build the frontend, step by step](#6-build-the-frontend-step-by-step)
7. [Run it and demo it](#7-run-it-and-demo-it)
8. [API reference](#8-api-reference)
9. [Known limits of this MVP](#9-known-limits-of-this-mvp)
10. [Before a real pilot](#10-before-a-real-pilot)
11. [What to build next](#11-what-to-build-next)

---

## 0. Read this first

**What was verified.** Every file in this guide was written and run before being put in the guide:

- `npm test` in `server/`: **31 tests pass** (ledger, trust, hard rules, intake parser, reply parser, optimiser, greedy fallback, independent checker).
- `tsc --noEmit` passes for both `server/` and `web/`.
- `vite build` succeeds for `web/`.
- The Express routes load, reject requests with no token (401), and reject the wrong role (403).

**What was not verified.** I could not run MongoDB or a browser where I built this. So the code that talks to the database (models, services, routes, seed) and the React screens are type-checked but not exercised. If something fails on first run, it will most likely be there. Section 7 has checkpoints that tell you which layer to look at.

**Versions used** (Node 22 LTS, npm 10):

| Server | Web |
|---|---|
| express 5.3, mongoose 9.12, socket.io 4.8, zod 4.6, jsonwebtoken 9, bcryptjs 3, dotenv 18, highs 1.15, typescript 7, tsx 4, vitest 5 | react 19.3, react-router-dom 7, @tanstack/react-query 5, socket.io-client 4.8, vite 8, tailwindcss 4.3, typescript 7 |

Commit your `package-lock.json` files so later installs don't drift.

---

## 1. What you are building

**The problem in one line:** hospital bed boards only know what staff type in, and staff type late or forget. So BedSense keeps track of *how much it trusts each bed's status*, asks the ward about the beds it doubts, and then chooses the best bed for every waiting patient together. A person approves every move.

### Roles

Patients are never users; they are data. Three roles are enough.

| Role | Real person | Device | What they do |
|---|---|---|---|
| **Bed Manager** | Admission desk / bed control | Desktop | Sees the whole hospital, approves or rejects suggested beds, adds patients, runs demo tools |
| **Ward Staff** | Nursing Sister / floor nurse | Phone | Answers "is bed 12 ready?", marks beds cleaned / patient left / blocked, asks for a short pause in admissions |
| **Requester** | Doctor / ER desk | Desktop or phone | Pastes an admission note, confirms the parsed needs, tracks their requests |

### MVP scope

| In the MVP | Left out on purpose (see section 11) |
|---|---|
| Bed ledger with trust levels (event sourced) | WhatsApp Cloud API (the ward phone page replaces it) |
| Hard rules + cost-based allocation (optimiser) | LLM-based intake (rules-only parser instead) |
| Independent rule checker (the "referee") | Referral agent, discharge chaser |
| Bed truth agent (asks wards about doubted beds) | Nurse workload cost |
| Approve / reject flow with plain-English reasons | Connection to the hospital's existing software |
| Ward phone page, ward pause, per-bed hold | Full simulation experiments |
| Doctor-note intake (English + Hinglish negations) | |
| Live updates (Socket.IO) | |
| Demo tools: "make the board wrong", burst of patients, auto-nurse | |

---

## 2. Architecture and the decisions behind it

```
 React SPA (Vite)
 ├─ /manager   Bed Manager dashboard (desktop)
 ├─ /ward      Ward phone page (mobile first)
 └─ /requests  Doctor request page
        │  REST (JWT)            ▲  Socket.IO: "something changed: beds"
        ▼                        │  (clients then refetch through REST)
 ┌──────────────────── Node.js + Express API ──────────────────────┐
 │ routes/  (zod validation, role guards)                          │
 │ services/                                                       │
 │   ledger.service     append event → update read model           │
 │   planner.service    build candidates → solve → REFEREE → save  │
 │   assignments        approve / reject / answer a question       │
 │   truthAgent         asks wards about doubted beds              │
 │   simulator          demo drift, bursts, auto-nurse             │
 │ engine/  ilp (HiGHS) · greedy (fallback) · checker (referee)    │
 │ domain/  ledger · rules · scoring · parser   (pure, no I/O)     │
 └──────────────────────────────┬──────────────────────────────────┘
                                ▼
                  MongoDB: users, wards, beds, bedstates, bedevents,
                  admissionrequests, suggestions, questions, holds
 Background jobs (setInterval): planning loop · truth agent
```

### The decisions that matter

1. **Pure domain core.** Everything that decides things (`domain/` and `engine/`) takes plain objects and returns plain objects. No database, no HTTP. That is why 31 tests run in about a second, and it is where bugs are cheapest to find.
2. **Event sourcing for beds.** Never store "bed 12 is free" as typed truth. Append events (admitted, patient left, cleaned…) to `bedevents` and derive the status from them, like a bank passbook. `bedstates` is just a cache of the derived result; `rebuildState()` can recompute it from events at any time.
3. **Trust is computed, not stored.** A status is *confirmed* (a ward person said so within an hour), *inferred* (derived from events, nobody confirmed lately), or *stale/doubted* (it has lasted longer than it normally should). Computing it on read means it is always current.
4. **Optimiser instead of "first free bed".** A first-free-bed rule can give the next patient's only possible bed to someone who had other options. The optimiser considers every waiting patient together. Each (patient, bed) pair is a yes/no variable, hard rules remove impossible pairs, and cost weights pick the best combination.
5. **HiGHS instead of OR-Tools CP-SAT.** The original BedSense design uses Google OR-Tools in Python. OR-Tools has no official Node package, so this MVP uses **HiGHS** (a mixed-integer solver compiled to WebAssembly, npm package `highs`). The model is the same kind of 0/1 problem. The optimiser sits behind one function, `solveIlp(needs, candidates)`, so you can later swap it for a Python OR-Tools service without touching anything else.
6. **A separate referee.** `engine/checker.ts` re-checks every proposal against every hard rule and **imports nothing from `domain/`**. If the optimiser or `rules.ts` has a bug, the referee catches it instead of trusting it. Violating proposals are dropped and logged loudly.
7. **Fail safe.** If the solver errors, the planner falls back to the greedy allocator and the UI labels the plan "fallback plan".
8. **Rolling plan.** Every few minutes the planner plans for beds ready now **and** beds expected ready within 3 hours. Only "ready now" assignments get an **Approve** button. The rest are shown as "planned, free in ~N min" and re-planned next round.
9. **Sockets carry no data.** They say only "beds changed". Clients refetch through the authenticated REST API, so patient data never travels over an unauthenticated channel.
10. **A person approves every move.** The system suggests. Nothing is assigned without the Bed Manager pressing Approve. Nothing medical is ever decided by software.

### How one patient flows through the system

1. A doctor pastes a note. The parser extracts age, sex, ward, oxygen, isolation, each with a quote from the note. Missing details come back as questions, not guesses.
2. The request enters the queue as `waiting`.
3. The planner builds candidate beds (ready now, or ready within 3 hours), removes anything that breaks a hard rule, solves, runs the referee, and saves suggestions with reasons.
4. If the suggested bed is **doubted**, the truth agent asks that ward "is bed 12 ready?". The nurse taps Ready / Not yet / Occupied. That becomes a `STATUS_CONFIRMED` event, trust becomes *confirmed*, and the plan refreshes.
5. The Bed Manager presses **Approve**. The bed becomes `reserved`. If nobody confirmed it in the last 30 minutes, the ward gets a heads-up question. If they say "not yet", the assignment is revoked and the patient goes back to the queue.
6. When the patient arrives, the manager presses **Arrived** (`ADMITTED`). Later events (discharge ordered, patient left, cleaned) complete the cycle.

Bed status cycle: `ready → reserved → occupied → discharging → dirty → ready` (and `blocked`).

---

## 3. Setup

### Prerequisites

- Node.js 22 LTS (or 20+) and npm
- Docker (easiest way to run MongoDB), or a local MongoDB 7+ install
- A code editor and a terminal

### Project layout

```
bedsense/
├─ docker-compose.yml
├─ server/
│  ├─ src/
│  │  ├─ domain/       types, ledger, rules, scoring, parser   (pure)
│  │  ├─ engine/       ilp, greedy, checker                    (pure)
│  │  ├─ services/     board, ledger.service, planner.service,
│  │  │                assignments.service, truthAgent, simulator
│  │  ├─ routes/       index.ts
│  │  ├─ auth.ts  config.ts  models.ts  realtime.ts  seed.ts  index.ts
│  └─ tests/           domain.test.ts, engine.test.ts
└─ web/
   └─ src/             pages/, components/, api.ts, auth.tsx, live.ts, types.ts
```

### Create the project and start MongoDB

```bash
mkdir bedsense && cd bedsense
git init
```

`docker-compose.yml`:

```yaml
services:
  mongo:
    image: mongo:7
    ports: ["27017:27017"]
    volumes: ["bedsense-mongo:/data/db"]
volumes:
  bedsense-mongo:
```

`.gitignore`:

```
node_modules
dist
.env
```

```bash
docker compose up -d        # MongoDB on mongodb://127.0.0.1:27017
```

### Create the server project

```bash
mkdir server && cd server
npm init -y
npm pkg set type=module
npm i express mongoose socket.io jsonwebtoken bcryptjs zod cors dotenv highs
npm i -D typescript tsx vitest @types/express @types/jsonwebtoken @types/cors @types/node
npm pkg set scripts.dev="tsx watch src/index.ts" scripts.start="tsx src/index.ts" \
  scripts.seed="tsx src/seed.ts" scripts.test="vitest run" scripts.typecheck="tsc --noEmit"
mkdir -p src/domain src/engine src/services src/routes tests
cd ..
```

> **Why `tsx` in production too?** It keeps the MVP simple: no separate build step, and TypeScript imports work without `.js` extensions. For a real deployment, add a bundler such as `tsup` or `esbuild`.

`server/tsconfig.json`:

**`server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

`server/.env` (copy to `.env.example` too, without the secret):

```bash
PORT=4000
MONGO_URI=mongodb://127.0.0.1:27017/bedsense
JWT_SECRET=change-me-to-a-long-random-string
CLIENT_ORIGIN=http://localhost:5173
# Demo speed. Production defaults are 300 (5 min) and 900 (15 min).
PLAN_EVERY_SEC=30
AGENT_EVERY_SEC=20
# Set to off in production to remove the simulator endpoints
DEMO_TOOLS=on
```

---

## 4. Data model

| Collection | Purpose | Key fields |
|---|---|---|
| `users` | Logins | `email`, `passwordHash`, `role` (`manager` / `ward` / `requester`), `wardId` for ward staff |
| `wards` | Departments | `name`, `code`, `department` |
| `beds` | Physical beds. Room attributes are copied onto the bed to save a collection | `label`, `wardId`, `department`, `room`, `type` (`ward`/`icu`/`hdu`), `category` (`general`/`private`), `sexPolicy` (`male`/`female`/`any`/`children`), `isolation`, `oxygen` |
| `bedevents` | **Append-only history.** The source of truth | `bedId`, `type`, `at`, `source` (`board`/`ward`/`system`/`sim`), `payload` |
| `bedstates` | Read model derived from events | `bedId`, `status`, `statusSince`, `lastConfirmedAt`, `occupant {sex, ageGroup}`, `truthStatus` (demo only) |
| `admissionrequests` | Patients needing a bed | age, sex, ageGroup, department, bedType, urgency (1-3), needsOxygen, needsIsolation, category, `status` (`waiting`/`assigned`/`admitted`/`cancelled`) |
| `suggestions` | Planner output | `requestId`, `bedId`, `cost`, `availableInMin`, `reasons[]`, `fallback`, `status` (`proposed`/`approved`/`rejected`/`superseded`/`revoked`) |
| `questions` | What the truth agent asked wards | `bedId`, `wardId`, `kind` (`is_ready`/`pre_send`), `status`, `answer`, `rawReply` |
| `holds` | "Keep this free" | `scope` (`ward`/`bed`), `wardId`/`bedId`, `until` |

**Privacy by design:** no patient names, phone numbers or diagnoses are stored. A request holds only what is needed to choose a bed. Keep it that way.

---

## 5. Build the backend, step by step

Build bottom-up: the pure logic first (with tests), then the database layer, then HTTP. Each step ends with a checkpoint.

### Step 1: Shared types

The vocabulary used everywhere: bed types, statuses, `PatientNeed`, `Candidate`, `Proposal`.

**`server/src/domain/types.ts`**

```ts
export type BedType = 'ward' | 'icu' | 'hdu';
export type Category = 'general' | 'private';
export type Sex = 'M' | 'F';
export type AgeGroup = 'child' | 'adult' | 'elderly';
export type SexPolicy = 'male' | 'female' | 'any' | 'children';
export type BedStatus = 'ready' | 'reserved' | 'occupied' | 'discharging' | 'dirty' | 'blocked';
export type Trust = 'confirmed' | 'inferred' | 'stale';
export type Urgency = 1 | 2 | 3;

export const ageGroupOf = (age: number): AgeGroup => (age < 18 ? 'child' : age >= 65 ? 'elderly' : 'adult');

export interface BedInfo {
  id: string;
  label: string;
  wardId: string;
  department: string;
  room: string;
  type: BedType;
  category: Category;
  sexPolicy: SexPolicy;
  isolation: boolean;
  oxygen: boolean;
}

export interface PatientNeed {
  id: string;
  urgency: Urgency;
  sex: Sex;
  ageGroup: AgeGroup;
  department: string;
  bedType: BedType;
  needsOxygen: boolean;
  needsIsolation: boolean;
  category: Category;
  acceptsOtherCategory: boolean;
}

export interface Occupant {
  sex: Sex;
  ageGroup: AgeGroup;
}

/** A bed that is ready now, or expected to be ready soon, as seen by the planner. */
export interface Candidate {
  bed: BedInfo;
  status: BedStatus;
  availableInMin: number;
  trust: Trust;
  holdMin: number; // minutes until a ward pause ends (0 = no pause)
  roomOccupants: Occupant[];
}

export interface Proposal {
  requestId: string;
  bedId: string;
  cost: number;
  availableInMin: number;
  reasons: string[];
}
```

### Step 2: The bed ledger (event sourcing + trust)

`applyEvent` turns "state + event" into the next state. A **ward-sourced** event also counts as a staff confirmation. `computeTrust` marks a status as doubted once it has lasted longer than its normal limit (ready 8 h, reserved 90 min, discharging 6 h, dirty 2 h; these limits are assumptions you should tune with the ward). `minutesUntilReady` estimates when a dirty or discharging bed will be usable.

**`server/src/domain/ledger.ts`**

```ts
import type { BedStatus, Occupant, Trust } from './types';

export type EventType =
  | 'ADMITTED' | 'RESERVED' | 'RESERVATION_RELEASED' | 'DISCHARGE_ORDERED'
  | 'PATIENT_LEFT' | 'CLEANED' | 'BLOCKED' | 'UNBLOCKED' | 'STATUS_CONFIRMED';
export type EventSource = 'board' | 'ward' | 'system' | 'sim';

export interface LedgerEvent {
  type: EventType;
  at: Date;
  source: EventSource;
  payload?: { status?: BedStatus; occupant?: Occupant };
}

export interface BedStateData {
  status: BedStatus;
  statusSince: Date;
  lastConfirmedAt?: Date;
  occupant?: Occupant;
}

export const initialState = (at: Date): BedStateData => ({ status: 'ready', statusSince: at });

function step(s: BedStateData, e: LedgerEvent): BedStateData {
  const to = (status: BedStatus, occupant?: Occupant): BedStateData => ({ status, statusSince: e.at, occupant });
  switch (e.type) {
    case 'ADMITTED': return to('occupied', e.payload?.occupant ?? s.occupant);
    case 'RESERVED': return to('reserved', e.payload?.occupant);
    case 'RESERVATION_RELEASED': return to('ready');
    case 'DISCHARGE_ORDERED': return to('discharging', s.occupant);
    case 'PATIENT_LEFT': return to('dirty');
    case 'CLEANED': return to('ready');
    case 'BLOCKED': return to('blocked');
    case 'UNBLOCKED': return to('dirty');
    case 'STATUS_CONFIRMED': {
      const status = e.payload!.status!;
      if (status === s.status) return s;
      return to(status, status === 'occupied' ? s.occupant : undefined);
    }
  }
}

/** Pure event -> state. A ward-sourced event also counts as a staff confirmation. */
export function applyEvent(s: BedStateData, e: LedgerEvent): BedStateData {
  const next = step(s, e);
  const lastConfirmedAt = e.source === 'ward' ? e.at : next === s ? s.lastConfirmedAt : undefined;
  return { ...next, lastConfirmedAt };
}

export const replay = (events: LedgerEvent[], start: Date): BedStateData =>
  events.reduce(applyEvent, initialState(start));

// ---- trust ----
export const STALE_AFTER_MIN: Record<BedStatus, number> = {
  ready: 480, reserved: 90, discharging: 360, dirty: 120, occupied: Infinity, blocked: Infinity,
};
export const CONFIRM_FRESH_MIN = 60;
export const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60000;

export function computeTrust(s: BedStateData, now: Date): Trust {
  if (s.lastConfirmedAt && minutesBetween(s.lastConfirmedAt, now) <= CONFIRM_FRESH_MIN) return 'confirmed';
  if (minutesBetween(s.statusSince, now) > STALE_AFTER_MIN[s.status]) return 'stale';
  return 'inferred';
}

/** Rough ETA (minutes) until a bed can take a patient. null = not expected soon. */
export function minutesUntilReady(s: BedStateData, now: Date): number | null {
  const since = minutesBetween(s.statusSince, now);
  switch (s.status) {
    case 'ready': return 0;
    case 'dirty': return Math.max(10, 45 - since);
    case 'discharging': return Math.max(30, 165 - since); // leaves (~120) + cleaning (~45), both assumed
    default: return null;
  }
}
```

### Step 3: Hard rules

Rules that are **never** traded off against cost. A medical need (isolation) overrides the payment category. Children's rooms may mix sexes.

**`server/src/domain/rules.ts`**

```ts
import type { BedInfo, Occupant, PatientNeed } from './types';

/** Returns the broken rule, or null when the bed is allowed. Hard rules are never traded off. */
export function violatesHardRule(p: PatientNeed, bed: BedInfo, occupants: Occupant[]): string | null {
  if (bed.type !== p.bedType) return 'wrong bed type';
  if (p.needsIsolation && !bed.isolation) return 'needs isolation room';
  if (p.needsOxygen && !bed.oxygen) return 'needs oxygen point';
  // a medical need (isolation) overrides the payment category
  if (!p.needsIsolation && bed.category !== p.category && !p.acceptsOtherCategory) return 'wrong room category';
  if (bed.sexPolicy === 'male' && p.sex !== 'M') return 'male-only room';
  if (bed.sexPolicy === 'female' && p.sex !== 'F') return 'female-only room';
  if (bed.sexPolicy === 'any' && occupants.some((o) => o.sex !== p.sex)) return 'would mix sexes';
  return null; // 'children' rooms may mix
}
```

### Step 4: Cost and reasons

Every allowed (patient, bed) pair gets a cost and a list of plain-English reasons. The reasons are what the Bed Manager reads before approving, so write them for humans.

Two design notes:
- The **age-mix cost** is kept separate (`ageMix` flag) because the optimiser charges it **once per room**, not once per roommate. Charging per roommate once caused an elderly Medicine patient to be sent to the Eye ward (eight younger roommates added eight penalties). The test named "regression" in Step 7 guards this.
- A **ward pause** delays that ward's free beds, **except for critical patients**.

**`server/src/domain/scoring.ts`**

```ts
import type { Candidate, PatientNeed } from './types';
import { violatesHardRule } from './rules';

/** All weights are tunable assumptions - review them with doctors and nurses. */
export const W = {
  unassigned: 10000, // per urgency level
  waitPerMin: 2, // per minute, per urgency level
  doubted: 250,
  unconfirmed: 30,
  otherDept: 300,
  otherCategory: 200,
  isolationWaste: 150,
  oxygenWaste: 40,
  ageMix: 60, // once per room
};

export interface Scored {
  base: number; // everything except the age-mix cost
  ageMix: boolean;
  availableInMin: number;
  reasons: string[];
}
export const totalCost = (s: Scored) => s.base + (s.ageMix ? W.ageMix : 0);

export function scoreMatch(p: PatientNeed, c: Candidate): Scored | null {
  if (violatesHardRule(p, c.bed, c.roomOccupants)) return null;
  const reasons: string[] = [];
  // a ward pause delays its free beds, except for critical patients
  const avail = p.urgency === 3 ? c.availableInMin : Math.max(c.availableInMin, c.holdMin);
  let base = W.waitPerMin * p.urgency * avail;
  reasons.push(avail === 0 ? 'ready now' : `free in about ${Math.ceil(avail)} min`);
  if (avail > c.availableInMin) reasons.push('ward asked for a short pause');

  if (c.trust === 'confirmed') reasons.push('status confirmed by staff');
  else if (c.trust === 'inferred') { base += W.unconfirmed; reasons.push('status not confirmed recently'); }
  else { base += W.doubted; reasons.push('status doubted - ward will be asked to confirm'); }

  if (c.bed.type === 'ward') {
    if (c.bed.department !== p.department) { base += W.otherDept; reasons.push(`other department (${c.bed.department})`); }
    else reasons.push(`${c.bed.department} ward, own department`);
  } else reasons.push(`${c.bed.type.toUpperCase()} bed`);

  if (c.bed.category !== p.category && !p.needsIsolation) { base += W.otherCategory; reasons.push('different room category (family agreed)'); }
  if (c.bed.isolation && !p.needsIsolation) { base += W.isolationWaste; reasons.push('uses an isolation room that is not needed'); }
  if (c.bed.oxygen && !p.needsOxygen && c.bed.type === 'ward') { base += W.oxygenWaste; reasons.push('uses an oxygen bed that is not needed'); }
  const ageMix = c.roomOccupants.some((o) => o.ageGroup !== p.ageGroup);
  if (ageMix) reasons.push('room has a different age group');
  return { base, ageMix, availableInMin: avail, reasons };
}
```

### Step 5: The engine (optimiser, fallback, referee)

**Optimiser (`ilp.ts`).** One yes/no variable per (patient, bed). The objective subtracts a large "unassigned" penalty for each patient, so everyone gets a bed whenever one is allowed. Two extra kinds of variable model room-level rules: one stops two *new* patients of different sexes from sharing an empty room, and one charges the age-mix cost once per room. Only each patient's 40 cheapest allowed beds are kept, to keep the model small.

**`server/src/engine/ilp.ts`**

```ts
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
```

**Greedy fallback (`greedy.ts`).** Most urgent first, cheapest allowed bed. Used if the solver fails.

**`server/src/engine/greedy.ts`**

```ts
import type { Candidate, Occupant, PatientNeed, Proposal } from '../domain/types';
import { scoreMatch, totalCost } from '../domain/scoring';

/** Fallback allocator: most urgent first, cheapest allowed bed. Also usable as a baseline. */
export function greedyAllocate(needs: PatientNeed[], cands: Candidate[], forbidden = new Set<string>()): Proposal[] {
  const used = new Set<string>();
  const added = new Map<string, Occupant[]>(); // patients already placed in a room this round
  const out: Proposal[] = [];
  const order = [...needs].sort((a, b) => b.urgency - a.urgency);
  for (const p of order) {
    let best: { c: Candidate; cost: number; avail: number; reasons: string[] } | null = null;
    for (const c of cands) {
      if (used.has(c.bed.id) || forbidden.has(`${p.id}:${c.bed.id}`)) continue;
      const occ = [...c.roomOccupants, ...(added.get(c.bed.room) ?? [])];
      const s = scoreMatch(p, { ...c, roomOccupants: occ });
      if (!s) continue;
      const cost = totalCost(s);
      if (!best || cost < best.cost) best = { c, cost, avail: s.availableInMin, reasons: s.reasons };
    }
    if (!best) continue;
    used.add(best.c.bed.id);
    added.set(best.c.bed.room, [...(added.get(best.c.bed.room) ?? []), { sex: p.sex, ageGroup: p.ageGroup }]);
    out.push({ requestId: p.id, bedId: best.c.bed.id, cost: best.cost, availableInMin: best.avail, reasons: best.reasons });
  }
  return out;
}
```

**The referee (`checker.ts`).** Written separately on purpose: it must not import anything from `domain/`.

**`server/src/engine/checker.ts`**

```ts
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
```

> **Solver note.** HiGHS' `solve()` is synchronous, so it blocks the Node event loop while it runs. With a 1 second limit and hospital-sized problems this is fine for an MVP. At larger scale, move it into a `worker_threads` worker.

### Step 6: Intake parser and reply reader

Turns a doctor's note into bed needs, and a nurse's typed reply into `ready` / `not_yet` / `occupied` / `unknown`. Rules:

- Every extracted detail carries **evidence**: a fragment of the original note.
- Missing required details (age, sex, ward or ICU/HDU) become **questions**, never guesses.
- Optional details left unstated (oxygen, isolation, urgency) are listed under `assumed`, and the UI asks the person to confirm them.
- Negations work in English and Hinglish: "no isolation", "O2 nahi", "isolation no". "contact precautions" counts as isolation.
- A reply that mentions a problem, or that is unclear, is `unknown`. The system then asks again with buttons. **It never assumes a bed is free.** "Not cleaned yet" is read as *not yet*, even though it contains the word "cleaned".

**`server/src/domain/parser.ts`**

```ts
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
```

### Step 7: Tests (your first checkpoint)

**`server/tests/domain.test.ts`**

```ts
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
```

**`server/tests/engine.test.ts`**

```ts
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
```

```bash
cd server && npm test
```

**Checkpoint:** 31 tests pass. If any fail, stop and fix them now. Everything after this builds on this layer.

### Step 8: Config, Mongo models, realtime, auth

**`server/src/config.ts`**

```ts
import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  mongoUri: process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/bedsense',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  planEverySec: Number(process.env.PLAN_EVERY_SEC ?? 300), // production: 5 min. Demo: 30
  agentEverySec: Number(process.env.AGENT_EVERY_SEC ?? 900), // production: 15 min. Demo: 45
  demoTools: process.env.DEMO_TOOLS !== 'off', // simulator endpoints; turn off in production
};
```

**`server/src/models.ts`**

```ts
import mongoose, { Schema, model } from 'mongoose';

const oid = Schema.Types.ObjectId;
const occupant = new Schema({ sex: String, ageGroup: String }, { _id: false });

export const User = model('User', new Schema({
  name: String,
  email: { type: String, unique: true, lowercase: true },
  passwordHash: String,
  role: { type: String, enum: ['manager', 'ward', 'requester'], required: true },
  wardId: { type: oid, ref: 'Ward' },
}));

export const Ward = model('Ward', new Schema({
  name: String,
  code: { type: String, unique: true },
  department: String,
}));

// Room attributes are denormalised onto the bed: one collection fewer for the MVP.
export const Bed = model('Bed', new Schema({
  label: { type: String, required: true },
  wardId: { type: oid, ref: 'Ward', index: true },
  department: String,
  room: String,
  type: { type: String, enum: ['ward', 'icu', 'hdu'] },
  category: { type: String, enum: ['general', 'private'] },
  sexPolicy: { type: String, enum: ['male', 'female', 'any', 'children'] },
  isolation: Boolean,
  oxygen: Boolean,
}));

// Read model: always derivable by replaying BedEvent.
export const BedState = model('BedState', new Schema({
  bedId: { type: oid, ref: 'Bed', unique: true },
  status: String,
  statusSince: Date,
  lastConfirmedAt: Date,
  occupant,
  truthStatus: String, // demo only: what is really true, so the dashboard can show where the board is wrong
}));

// Append-only history. Never edited, never deleted.
export const BedEvent = model('BedEvent', new Schema({
  bedId: { type: oid, index: true },
  type: String,
  at: Date,
  source: String,
  actorId: oid,
  payload: Schema.Types.Mixed,
}));

export const AdmissionRequest = model('AdmissionRequest', new Schema({
  rawNote: String,
  age: Number,
  sex: String,
  ageGroup: String,
  department: String,
  bedType: String,
  urgency: Number,
  needsOxygen: Boolean,
  needsIsolation: Boolean,
  category: { type: String, default: 'general' },
  acceptsOtherCategory: { type: Boolean, default: false },
  status: { type: String, enum: ['waiting', 'assigned', 'admitted', 'cancelled'], default: 'waiting', index: true },
  assignedBedId: oid,
  createdBy: oid,
  evidence: Schema.Types.Mixed,
}, { timestamps: true }));

export const Suggestion = model('Suggestion', new Schema({
  requestId: { type: oid, index: true },
  bedId: oid,
  cost: Number,
  availableInMin: Number,
  reasons: [String],
  fallback: Boolean,
  status: { type: String, enum: ['proposed', 'approved', 'rejected', 'superseded', 'revoked'], default: 'proposed', index: true },
  planRunId: String,
  approvedBy: oid,
  approvedAt: Date,
  rejectReason: String,
}, { timestamps: true }));

export const Question = model('Question', new Schema({
  bedId: oid,
  wardId: { type: oid, index: true },
  kind: { type: String, enum: ['is_ready', 'pre_send'] },
  reason: String,
  status: { type: String, enum: ['open', 'answered', 'expired'], default: 'open', index: true },
  answer: String,
  rawReply: String,
  suggestionId: oid,
  askedAt: { type: Date, default: Date.now },
  answeredAt: Date,
}));

export const Hold = model('Hold', new Schema({
  scope: { type: String, enum: ['ward', 'bed'] },
  wardId: oid,
  bedId: oid,
  until: { type: Date, index: true },
  createdBy: oid,
}));

export const connectDb = (uri: string) => mongoose.connect(uri);
```

Realtime emits only topic names:

**`server/src/realtime.ts`**

```ts
import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

export type Topic = 'beds' | 'suggestions' | 'questions' | 'requests' | 'feed';
let io: Server | null = null;

export function initRealtime(http: HttpServer, origin: string) {
  io = new Server(http, { cors: { origin } });
}
// Sockets only say WHAT changed. Clients refetch through the authenticated REST API,
// so no patient data ever travels over the socket.
export const emit = (...topics: Topic[]) => topics.forEach((t) => io?.emit('changed', t));
```

JWT auth with a role guard:

**`server/src/auth.ts`**

```ts
import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config';

export type Role = 'manager' | 'ward' | 'requester';
export interface AuthUser { id: string; name: string; role: Role; wardId?: string }

declare global {
  namespace Express { interface Request { user?: AuthUser } }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const signToken = (u: AuthUser) => jwt.sign(u, config.jwtSecret, { expiresIn: '12h' });

export const requireAuth = (...roles: Role[]): RequestHandler => (req, _res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  if (!token) throw new HttpError(401, 'Not signed in');
  try { req.user = jwt.verify(token, config.jwtSecret) as AuthUser; }
  catch { throw new HttpError(401, 'Session expired'); }
  if (roles.length && !roles.includes(req.user.role)) throw new HttpError(403, 'Not allowed for your role');
  next();
};
```

### Step 9: Services (the glue between domain and database)

**`board.ts`** loads every bed with its derived state and computed trust.

**`server/src/services/board.ts`**

```ts
import type { BedInfo, PatientNeed } from '../domain/types';
import { computeTrust, initialState, type BedStateData } from '../domain/ledger';
import { Bed, BedState } from '../models';

export const toBedInfo = (b: any): BedInfo => ({
  id: String(b._id), label: b.label, wardId: String(b.wardId), department: b.department, room: b.room,
  type: b.type, category: b.category, sexPolicy: b.sexPolicy, isolation: !!b.isolation, oxygen: !!b.oxygen,
});

export const toNeed = (r: any): PatientNeed => ({
  id: String(r._id), urgency: r.urgency, sex: r.sex, ageGroup: r.ageGroup, department: r.department ?? '',
  bedType: r.bedType, needsOxygen: !!r.needsOxygen, needsIsolation: !!r.needsIsolation,
  category: r.category ?? 'general', acceptsOtherCategory: !!r.acceptsOtherCategory,
});

export const toStateData = (s: any): BedStateData => ({
  status: s.status, statusSince: s.statusSince, lastConfirmedAt: s.lastConfirmedAt ?? undefined,
  occupant: s.occupant?.sex ? { sex: s.occupant.sex, ageGroup: s.occupant.ageGroup } : undefined,
});

/** Every bed with its current ledger state and trust level. */
export async function loadBoard(now = new Date()) {
  const [beds, states] = await Promise.all([Bed.find().lean(), BedState.find().lean()]);
  const byBed = new Map(states.map((s) => [String(s.bedId), s]));
  return beds.map((b) => {
    const st = byBed.get(String(b._id));
    const state = st ? toStateData(st) : initialState(now);
    return { bed: b, info: toBedInfo(b), state, trust: computeTrust(state, now), truthStatus: (st?.truthStatus ?? undefined) as string | undefined };
  });
}
```

**`ledger.service.ts`** is the only place that writes bed state. It appends the event first, then updates the read model. If the two ever disagree, `rebuildState()` replays the events.

**`server/src/services/ledger.service.ts`**

```ts
import { applyEvent, initialState, replay, type EventSource, type EventType, type LedgerEvent } from '../domain/ledger';
import type { BedStatus, Occupant } from '../domain/types';
import { BedEvent, BedState } from '../models';
import { emit } from '../realtime';
import { toStateData } from './board';

interface Opts { actorId?: string; at?: Date; status?: BedStatus; occupant?: Occupant }

/** Append the event, then update the read model. If they ever disagree, rebuildState() fixes it. */
export async function recordEvent(bedId: string, type: EventType, source: EventSource, opts: Opts = {}) {
  const at = opts.at ?? new Date();
  const payload = { status: opts.status, occupant: opts.occupant };
  await BedEvent.create({ bedId, type, at, source, actorId: opts.actorId, payload });

  const cur = await BedState.findOne({ bedId }).lean();
  const next = applyEvent(cur ? toStateData(cur) : initialState(at), { type, at, source, payload });

  const set: Record<string, unknown> = { status: next.status, statusSince: next.statusSince };
  const unset: Record<string, 1> = {};
  if (next.lastConfirmedAt) set.lastConfirmedAt = next.lastConfirmedAt; else unset.lastConfirmedAt = 1;
  if (next.occupant) set.occupant = next.occupant; else unset.occupant = 1;
  // demo only: real staff actions and system actions are, by definition, the truth
  if (cur?.truthStatus && (source === 'ward' || source === 'system')) set.truthStatus = next.status;

  await BedState.updateOne({ bedId }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { upsert: true });
  emit('beds');
  return next;
}

export async function rebuildState(bedId: string) {
  const events = (await BedEvent.find({ bedId }).sort({ at: 1 }).lean()) as unknown as LedgerEvent[];
  const state = replay(events, events[0]?.at ?? new Date());
  await BedState.updateOne({ bedId }, { $set: { status: state.status, statusSince: state.statusSince, lastConfirmedAt: state.lastConfirmedAt, occupant: state.occupant } }, { upsert: true });
  return state;
}
```

**`planner.service.ts`** builds candidates, solves, runs the referee, supersedes old suggestions and saves new ones. `schedulePlan()` is debounced so a burst of events triggers one plan.

**`server/src/services/planner.service.ts`**

```ts
import { randomUUID } from 'crypto';
import { minutesUntilReady, minutesBetween } from '../domain/ledger';
import type { Candidate, Occupant, Proposal } from '../domain/types';
import { greedyAllocate } from '../engine/greedy';
import { solveIlp } from '../engine/ilp';
import { checkProposals, type CheckBed, type CheckPatient } from '../engine/checker';
import { AdmissionRequest, Hold, Suggestion } from '../models';
import { emit } from '../realtime';
import { loadBoard, toNeed } from './board';

const HORIZON_MIN = 180; // also plan for beds expected to be ready within 3 hours
const REJECT_MEMORY_MIN = 120;

export async function runPlan(now = new Date()) {
  const board = await loadBoard(now);
  const [requests, holds, rejected] = await Promise.all([
    AdmissionRequest.find({ status: 'waiting' }).sort({ createdAt: 1 }).lean(),
    Hold.find({ until: { $gt: now } }).lean(),
    Suggestion.find({ status: 'rejected', updatedAt: { $gt: new Date(now.getTime() - REJECT_MEMORY_MIN * 60000) } }).lean(),
  ]);
  const needs = requests.map(toNeed);
  const forbidden = new Set(rejected.map((s) => `${s.requestId}:${s.bedId}`));

  const occupantsByRoom = new Map<string, Occupant[]>();
  for (const r of board) {
    if (r.state.occupant && ['occupied', 'reserved', 'discharging'].includes(r.state.status)) {
      occupantsByRoom.set(r.info.room, [...(occupantsByRoom.get(r.info.room) ?? []), r.state.occupant]);
    }
  }
  const heldBeds = new Set(holds.filter((h) => h.scope === 'bed').map((h) => String(h.bedId)));
  const wardHoldMin = new Map<string, number>();
  for (const h of holds.filter((h) => h.scope === 'ward')) wardHoldMin.set(String(h.wardId), Math.max(0, minutesBetween(now, h.until!)));

  const cands: Candidate[] = [];
  for (const r of board) {
    if (heldBeds.has(r.info.id)) continue;
    const eta = minutesUntilReady(r.state, now);
    if (eta === null || eta > HORIZON_MIN) continue;
    cands.push({
      bed: r.info, status: r.state.status, availableInMin: eta, trust: r.trust,
      holdMin: wardHoldMin.get(r.info.wardId) ?? 0, roomOccupants: occupantsByRoom.get(r.info.room) ?? [],
    });
  }

  let proposals: Proposal[];
  let fallback = false;
  try { proposals = await solveIlp(needs, cands, forbidden); }
  catch (err) { console.error('ILP failed, using greedy fallback:', err); proposals = greedyAllocate(needs, cands, forbidden); fallback = true; }

  // Independent referee: nothing reaches a person without passing it.
  const bedMap = new Map<string, CheckBed>(cands.map((c) => [c.bed.id, {
    id: c.bed.id, room: c.bed.room, type: c.bed.type, category: c.bed.category, sexPolicy: c.bed.sexPolicy,
    isolation: c.bed.isolation, oxygen: c.bed.oxygen, occupantSexes: c.roomOccupants.map((o) => o.sex),
  }]));
  const patMap = new Map<string, CheckPatient>(needs.map((n) => [n.id, {
    id: n.id, sex: n.sex, bedType: n.bedType, category: n.category, acceptsOtherCategory: n.acceptsOtherCategory,
    needsOxygen: n.needsOxygen, needsIsolation: n.needsIsolation,
  }]));
  const violations = checkProposals(proposals.map((p) => ({ requestId: p.requestId, bedId: p.bedId })), patMap, bedMap);
  if (violations.length) {
    console.error('RULE CHECKER REJECTED PROPOSALS', violations);
    const bad = new Set(violations.map((v) => v.requestId));
    proposals = proposals.filter((p) => !bad.has(p.requestId));
  }

  await Suggestion.updateMany({ status: 'proposed' }, { status: 'superseded' });
  const planRunId = randomUUID();
  if (proposals.length) await Suggestion.insertMany(proposals.map((p) => ({ ...p, fallback, planRunId, status: 'proposed' })));
  emit('suggestions');
  return { planRunId, proposals: proposals.length, waiting: needs.length, fallback, violations: violations.length };
}

let timer: NodeJS.Timeout | null = null;
/** Debounced: many events in a burst trigger one plan. */
export function schedulePlan() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; runPlan().catch(console.error); }, 400);
}
```

**`assignments.service.ts`** holds approve / reject / answer. Approving reserves the bed. A bed nobody confirmed in 30 minutes also triggers a heads-up question to the ward. A "not yet" answer revokes the assignment and puts the patient back in the queue.

**`server/src/services/assignments.service.ts`**

```ts
import { HttpError } from '../auth';
import { AdmissionRequest, Bed, BedState, Question, Suggestion } from '../models';
import { emit } from '../realtime';
import { recordEvent } from './ledger.service';
import { schedulePlan } from './planner.service';
import { minutesBetween } from '../domain/ledger';
import type { Reply } from '../domain/parser';

const PRE_SEND_FRESH_MIN = 30;

export async function approveSuggestion(id: string, userId: string) {
  const claimed = await Suggestion.findOneAndUpdate(
    { _id: id, status: 'proposed' }, { status: 'approved', approvedBy: userId, approvedAt: new Date() },
  );
  if (!claimed) throw new HttpError(409, 'This suggestion is no longer current. The plan has been refreshed.');
  const revert = async (msg: string) => { await Suggestion.updateOne({ _id: id }, { status: 'superseded' }); schedulePlan(); throw new HttpError(409, msg); };

  if ((claimed.availableInMin ?? 0) > 0) return revert('That bed is not ready yet.');
  const [req, state, bed] = await Promise.all([
    AdmissionRequest.findById(claimed.requestId), BedState.findOne({ bedId: claimed.bedId }), Bed.findById(claimed.bedId),
  ]);
  if (!req || req.status !== 'waiting') return revert('The request changed.');
  if (!bed || !state || state.status !== 'ready') return revert('The bed changed since the suggestion. Re-planning.');

  await recordEvent(String(bed._id), 'RESERVED', 'system', {
    actorId: userId, occupant: { sex: req.sex as 'M' | 'F', ageGroup: req.ageGroup as 'child' | 'adult' | 'elderly' },
  });
  await AdmissionRequest.updateOne({ _id: req._id }, { status: 'assigned', assignedBedId: bed._id });

  // Heads-up to the ward if nobody confirmed this bed recently, so they can say "not ready" before the patient moves.
  const stale = !state.lastConfirmedAt || minutesBetween(state.lastConfirmedAt, new Date()) > PRE_SEND_FRESH_MIN;
  if (stale) {
    await Question.create({ bedId: bed._id, wardId: bed.wardId, kind: 'pre_send', reason: 'A patient is about to be sent to this bed', suggestionId: claimed._id });
    emit('questions');
  }
  emit('requests', 'feed');
  schedulePlan();
  return { bedLabel: bed.label, preSendCheck: stale };
}

export async function rejectSuggestion(id: string, reason?: string) {
  const s = await Suggestion.findOneAndUpdate({ _id: id, status: 'proposed' }, { status: 'rejected', rejectReason: reason });
  if (!s) throw new HttpError(409, 'This suggestion is no longer current.');
  schedulePlan();
}

const REPLY_TO_STATUS = { ready: 'ready', not_yet: 'dirty', occupied: 'occupied' } as const;

export async function answerQuestion(id: string, reply: Reply, raw: string | undefined, actorId: string) {
  const q = await Question.findById(id);
  if (!q || q.status !== 'open') throw new HttpError(409, 'Question already answered');
  if (reply === 'unknown') { // never assume a bed is free: keep it open, the UI asks again with buttons
    await Question.updateOne({ _id: id }, { rawReply: raw });
    emit('feed');
    return { reask: true };
  }
  await recordEvent(String(q.bedId), 'STATUS_CONFIRMED', 'ward', { actorId, status: REPLY_TO_STATUS[reply] });
  await Question.updateOne({ _id: id }, { status: 'answered', answer: reply, rawReply: raw, answeredAt: new Date() });

  if (q.kind === 'pre_send' && reply !== 'ready' && q.suggestionId) {
    const s = await Suggestion.findByIdAndUpdate(q.suggestionId, { status: 'revoked' });
    if (s) await AdmissionRequest.updateOne({ _id: s.requestId }, { status: 'waiting', $unset: { assignedBedId: 1 } });
    emit('requests');
  }
  emit('questions', 'feed');
  schedulePlan();
  return { reask: false };
}
```

**`truthAgent.ts`** is the "air traffic controller" that double-checks the radar. It asks about a doubted bed only if a waiting patient could actually use it, or if the ward has almost no trustworthy free beds. It sends at most 3 questions per ward per hour and never asks twice about the same bed.

**`server/src/services/truthAgent.ts`**

```ts
import { violatesHardRule } from '../domain/rules';
import { AdmissionRequest, Question } from '../models';
import { emit } from '../realtime';
import { loadBoard, toNeed } from './board';

const MAX_PER_WARD_PER_HOUR = 3;
const LOW_TRUST_SHARE = 0.1;

/**
 * Asks wards about doubted beds - but only where the answer matters:
 * a waiting patient could use the bed, or the ward has almost no trustworthy free beds.
 */
export async function runTruthAgent(now = new Date()) {
  const board = await loadBoard(now);
  const needs = (await AdmissionRequest.find({ status: 'waiting' }).lean()).map(toNeed);
  const hourAgo = new Date(now.getTime() - 3600_000);
  const [recent, open] = await Promise.all([
    Question.find({ askedAt: { $gte: hourAgo } }).lean(),
    Question.find({ status: 'open' }).lean(),
  ]);
  const sentByWard = new Map<string, number>();
  for (const q of recent) sentByWard.set(String(q.wardId), (sentByWard.get(String(q.wardId)) ?? 0) + 1);
  const openBeds = new Set(open.map((q) => String(q.bedId)));

  const wards = new Map<string, typeof board>();
  for (const r of board) wards.set(r.info.wardId, [...(wards.get(r.info.wardId) ?? []), r]);

  let asked = 0;
  for (const [wardId, beds] of wards) {
    const trustedFree = beds.filter((b) => b.state.status === 'ready' && b.trust !== 'stale').length;
    const lowTrust = trustedFree / beds.length < LOW_TRUST_SHARE;
    const doubted = beds
      .filter((b) => b.trust === 'stale' && b.state.status !== 'blocked' && !openBeds.has(b.info.id))
      .sort((a, b) => a.state.statusSince.getTime() - b.state.statusSince.getTime());

    let budget = MAX_PER_WARD_PER_HOUR - (sentByWard.get(wardId) ?? 0);
    for (const b of doubted) {
      if (budget <= 0) break;
      const wanted = needs.some((p) => !violatesHardRule(p, b.info, []));
      if (!wanted && !lowTrust) continue;
      await Question.create({
        bedId: b.info.id, wardId, kind: 'is_ready',
        reason: wanted ? 'A waiting patient could use this bed' : 'Few trusted free beds in this ward',
      });
      budget--; asked++;
    }
  }
  if (asked) emit('questions', 'feed');
  return { asked };
}
```

### Step 10: Simulator and seed data

You cannot test on real patients, so the MVP includes demo tools:

- `injectDrift(hidden, phantom)`: makes the board wrong. A *hidden* bed is really free but the board still says "dirty" for hours. A *phantom* bed shows "ready" but is not.
- `addBurst(n)`: adds waiting patients (for example, a bus accident).
- `autoNurse()`: answers open questions truthfully, so the demo runs without a phone.

**`server/src/services/simulator.ts`**

```ts
import { ageGroupOf, type Sex } from '../domain/types';
import { AdmissionRequest, BedState } from '../models';
import { emit } from '../realtime';
import { loadBoard } from './board';
import { recordEvent } from './ledger.service';
import { answerQuestion } from './assignments.service';
import { Question } from '../models';
import { schedulePlan } from './planner.service';

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const shuffle = <T,>(a: T[]) => [...a].sort(() => Math.random() - 0.5);
const minsAgo = (m: number) => new Date(Date.now() - m * 60000);

/**
 * Make the board wrong, the way a real hospital's board goes wrong.
 *  hidden : really free, but the board still says dirty/discharging for hours ("hidden bed")
 *  phantom: board says ready, but the bed is really not ("phantom bed")
 */
export async function injectDrift(hidden: number, phantom: number) {
  const board = shuffle(await loadBoard());
  let h = 0, p = 0;
  for (const r of board) {
    const id = r.info.id;
    if (h < hidden && ['occupied', 'dirty', 'discharging'].includes(r.state.status)) {
      await recordEvent(id, 'PATIENT_LEFT', 'sim', { at: minsAgo(150 + Math.random() * 200) }); // board: dirty for hours
      await BedState.updateOne({ bedId: id }, { truthStatus: 'ready' });
      h++;
    } else if (p < phantom && r.state.status === 'ready') {
      await recordEvent(id, 'CLEANED', 'sim', { at: minsAgo(20 + Math.random() * 60) }); // board: ready, unconfirmed
      await BedState.updateOne({ bedId: id }, { truthStatus: pick(['occupied', 'dirty']) });
      p++;
    }
  }
  schedulePlan();
  return { hidden: h, phantom: p };
}

/** A burst of waiting patients, e.g. a bus accident. */
export async function addBurst(count: number) {
  const depts = ['Medicine', 'Surgery', 'Paediatrics'];
  for (let i = 0; i < count; i++) {
    const critical = Math.random() < 0.25;
    const dept = pick(depts);
    const age = dept === 'Paediatrics' ? 2 + Math.floor(Math.random() * 12) : 20 + Math.floor(Math.random() * 65);
    await AdmissionRequest.create({
      rawNote: '(simulated)', age, ageGroup: ageGroupOf(age), sex: pick<Sex>(['M', 'F']),
      department: critical ? '' : dept, bedType: critical ? pick(['icu', 'hdu']) : 'ward',
      urgency: critical ? 3 : pick([1, 2]), needsOxygen: Math.random() < 0.3, needsIsolation: Math.random() < 0.08,
      category: 'general', acceptsOtherCategory: false, status: 'waiting',
    });
  }
  emit('requests');
  schedulePlan();
}

/** A fake nurse who answers every open question truthfully, so the demo runs without a phone. */
export async function autoNurse() {
  const open = await Question.find({ status: 'open' }).lean();
  let answered = 0;
  for (const q of open) {
    const st = await BedState.findOne({ bedId: q.bedId }).lean();
    const truth = st?.truthStatus ?? st?.status;
    const reply = truth === 'ready' ? 'ready' : truth === 'occupied' || truth === 'discharging' ? 'occupied' : 'not_yet';
    await answerQuestion(String(q._id), reply, undefined, String(q.wardId));
    answered++;
  }
  return { answered };
}
```

The seed creates 4 wards and 78 beds (Medicine, Surgery, Paediatrics, Critical Care with ICU and HDU beds), with male and female bays, shared private doubles and isolation singles. It also fills them with a realistic mix of occupied, dirty, discharging and ready beds, and creates demo logins. All use the password `bedsense123`.

**`server/src/seed.ts`**

```ts
import bcrypt from 'bcryptjs';
import { config } from './config';
import { ageGroupOf, type AgeGroup, type BedType, type Category, type Sex, type SexPolicy } from './domain/types';
import { Bed, BedEvent, BedState, connectDb, User, Ward, AdmissionRequest, Suggestion, Question, Hold } from './models';
import { recordEvent } from './services/ledger.service';
import mongoose from 'mongoose';

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const minsAgo = (m: number) => new Date(Date.now() - m * 60000);

interface Room { name: string; beds: number; category: Category; sexPolicy: SexPolicy; isolation?: boolean; oxygenBeds?: number; type?: BedType }

const adultWard: Room[] = [
  { name: 'Male bay 1', beds: 4, category: 'general', sexPolicy: 'male', oxygenBeds: 2 },
  { name: 'Male bay 2', beds: 4, category: 'general', sexPolicy: 'male', oxygenBeds: 2 },
  { name: 'Female bay 1', beds: 4, category: 'general', sexPolicy: 'female', oxygenBeds: 2 },
  { name: 'Female bay 2', beds: 4, category: 'general', sexPolicy: 'female', oxygenBeds: 2 },
  { name: 'Private double 1', beds: 2, category: 'private', sexPolicy: 'any', oxygenBeds: 2 },
  { name: 'Private double 2', beds: 2, category: 'private', sexPolicy: 'any', oxygenBeds: 0 },
  { name: 'Isolation 1', beds: 1, category: 'private', sexPolicy: 'any', isolation: true, oxygenBeds: 1 },
  { name: 'Isolation 2', beds: 1, category: 'private', sexPolicy: 'any', isolation: true, oxygenBeds: 1 },
];
const WARDS = [
  { code: 'MED', name: 'Medicine', department: 'Medicine', rooms: adultWard },
  { code: 'SUR', name: 'Surgery', department: 'Surgery', rooms: adultWard },
  { code: 'PED', name: 'Paediatrics', department: 'Paediatrics', rooms: [
    ...[1, 2, 3, 4].map((i): Room => ({ name: `Children bay ${i}`, beds: 4, category: 'general', sexPolicy: 'children', oxygenBeds: 1 })),
    ...[1, 2].map((i): Room => ({ name: `Isolation ${i}`, beds: 1, category: 'private', sexPolicy: 'children', isolation: true, oxygenBeds: 1 })),
  ] },
  { code: 'ICU', name: 'Critical Care', department: 'Critical Care', rooms: [
    ...Array.from({ length: 12 }, (_, i): Room => ({ name: `ICU ${i + 1}`, beds: 1, category: 'general', sexPolicy: 'any', isolation: i < 2, oxygenBeds: 1, type: 'icu' })),
    ...Array.from({ length: 4 }, (_, i): Room => ({ name: `HDU ${i + 1}`, beds: 1, category: 'general', sexPolicy: 'any', oxygenBeds: 1, type: 'hdu' })),
  ] },
];

export async function seed() {
  await Promise.all([Ward, Bed, BedState, BedEvent, User, AdmissionRequest, Suggestion, Question, Hold].map((m) => (m as any).deleteMany({})));

  const hash = await bcrypt.hash('bedsense123', 10);
  const wardDocs: Record<string, any> = {};
  for (const w of WARDS) {
    wardDocs[w.code] = await Ward.create({ name: w.name, code: w.code, department: w.department });
    let n = 1;
    for (const room of w.rooms) {
      const roomSex: Sex = pick(['M', 'F']); // occupants of an 'any' room share one sex
      for (let i = 0; i < room.beds; i++) {
        const bed = await Bed.create({
          label: `${w.code}-${String(n++).padStart(2, '0')}`, wardId: wardDocs[w.code]._id, department: w.department,
          room: `${w.code}:${room.name}`, type: room.type ?? 'ward', category: room.category, sexPolicy: room.sexPolicy,
          isolation: !!room.isolation, oxygen: i < (room.oxygenBeds ?? 0),
        });
        const roll = Math.random();
        const sex: Sex = room.sexPolicy === 'male' ? 'M' : room.sexPolicy === 'female' ? 'F' : room.sexPolicy === 'children' ? pick(['M', 'F']) : roomSex;
        const age = room.sexPolicy === 'children' ? 3 + Math.floor(Math.random() * 12) : 25 + Math.floor(Math.random() * 55);
        const occupant = { sex, ageGroup: ageGroupOf(age) as AgeGroup };
        const id = String(bed._id);
        if (roll < 0.62) await recordEvent(id, 'ADMITTED', 'board', { at: minsAgo(120 + Math.random() * 4000), occupant });
        else if (roll < 0.72) await recordEvent(id, 'PATIENT_LEFT', 'board', { at: minsAgo(5 + Math.random() * 80) });
        else if (roll < 0.80) {
          await recordEvent(id, 'ADMITTED', 'board', { at: minsAgo(3000), occupant });
          await recordEvent(id, 'DISCHARGE_ORDERED', 'board', { at: minsAgo(20 + Math.random() * 100) });
        } else await recordEvent(id, 'CLEANED', 'board', { at: minsAgo(30 + Math.random() * 250) });
      }
    }
  }
  await BedState.updateMany({}, [{ $set: { truthStatus: '$status' } }]); // demo: board starts correct

  const users = [
    { name: 'Asha (Bed Manager)', email: 'manager@bedsense.test', role: 'manager' },
    { name: 'Dr. Rao (Requester)', email: 'doctor@bedsense.test', role: 'requester' },
    ...WARDS.map((w) => ({ name: `Sister, ${w.name}`, email: `${w.code.toLowerCase()}@bedsense.test`, role: 'ward', wardId: wardDocs[w.code]._id })),
  ];
  await User.insertMany(users.map((u) => ({ ...u, passwordHash: hash })));
  const beds = await Bed.countDocuments();
  console.log(`Seeded ${WARDS.length} wards, ${beds} beds, ${users.length} users. Password for all: bedsense123`);
}

if (process.argv[1]?.endsWith('seed.ts')) {
  await connectDb(config.mongoUri);
  await seed();
  await mongoose.disconnect();
}
```

### Step 11: Routes

Every route is validated with zod and guarded by role. A ward user only ever sees and touches their own ward.

**`server/src/routes/index.ts`**

```ts
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { HttpError, requireAuth, signToken } from '../auth';
import { config } from '../config';
import { ageGroupOf } from '../domain/types';
import { parseIntake, parseReply } from '../domain/parser';
import { AdmissionRequest, Bed, BedState, Hold, Question, Suggestion, User, Ward } from '../models';
import { loadBoard } from '../services/board';
import { recordEvent } from '../services/ledger.service';
import { runPlan, schedulePlan } from '../services/planner.service';
import { answerQuestion, approveSuggestion, rejectSuggestion } from '../services/assignments.service';
import { addBurst, autoNurse, injectDrift } from '../services/simulator';
import { emit } from '../realtime';
import { seed } from '../seed';

export const routes = Router();
const mins = (m: number) => new Date(Date.now() + m * 60000);

// ---------- auth ----------
routes.post('/auth/login', async (req, res) => {
  const { email, password } = z.object({ email: z.string(), password: z.string() }).parse(req.body);
  const u = await User.findOne({ email: email.toLowerCase() });
  if (!u || !(await bcrypt.compare(password, u.passwordHash ?? ''))) throw new HttpError(401, 'Wrong email or password');
  const user = { id: String(u._id), name: u.name ?? '', role: u.role as 'manager' | 'ward' | 'requester', wardId: u.wardId ? String(u.wardId) : undefined };
  res.json({ token: signToken(user), user });
});

// ---------- wards & beds ----------
routes.get('/wards', requireAuth(), async (_req, res) => res.json(await Ward.find().lean()));

routes.get('/beds', requireAuth('manager', 'ward'), async (req, res) => {
  const [board, open, wards] = await Promise.all([loadBoard(), Question.find({ status: 'open' }).lean(), Ward.find().lean()]);
  const openBeds = new Set(open.map((q) => String(q.bedId)));
  const wardName = new Map(wards.map((w) => [String(w._id), w.name]));
  const mine = req.user!.role === 'ward' ? board.filter((r) => r.info.wardId === req.user!.wardId) : board;
  res.json(mine.map((r) => ({
    id: r.info.id, label: r.info.label, wardId: r.info.wardId, ward: wardName.get(r.info.wardId), room: r.info.room,
    type: r.info.type, category: r.info.category, isolation: r.info.isolation, oxygen: r.info.oxygen,
    status: r.state.status, statusSince: r.state.statusSince, trust: r.trust, asking: openBeds.has(r.info.id),
    mismatch: !!r.truthStatus && r.truthStatus !== r.state.status && req.user!.role === 'manager', // demo overlay
  })));
});

const manualEvents = ['DISCHARGE_ORDERED', 'PATIENT_LEFT', 'CLEANED', 'BLOCKED', 'UNBLOCKED'] as const;
routes.post('/beds/:id/events', requireAuth('manager', 'ward'), async (req, res) => {
  const { type } = z.object({ type: z.enum(manualEvents) }).parse(req.body);
  const bed = await Bed.findById(req.params.id);
  if (!bed) throw new HttpError(404, 'No such bed');
  if (req.user!.role === 'ward' && String(bed.wardId) !== req.user!.wardId) throw new HttpError(403, 'Not your ward');
  await recordEvent(String(bed._id), type, req.user!.role === 'ward' ? 'ward' : 'board', { actorId: req.user!.id });
  schedulePlan();
  res.json({ ok: true });
});

routes.post('/beds/:id/hold', requireAuth('manager'), async (req, res) => {
  const { minutes } = z.object({ minutes: z.number().min(5).max(480) }).parse(req.body);
  await Hold.create({ scope: 'bed', bedId: String(req.params.id), until: mins(minutes), createdBy: req.user!.id });
  schedulePlan();
  res.json({ ok: true });
});

// ---------- admission requests ----------
routes.post('/requests/parse', requireAuth('manager', 'requester'), (req, res) => {
  res.json(parseIntake(z.object({ note: z.string().min(3).max(2000) }).parse(req.body).note));
});

const requestBody = z.object({
  rawNote: z.string().optional(),
  age: z.number().int().min(0).max(120),
  sex: z.enum(['M', 'F']),
  bedType: z.enum(['ward', 'icu', 'hdu']),
  department: z.string().optional(),
  urgency: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  needsOxygen: z.boolean(),
  needsIsolation: z.boolean(),
  category: z.enum(['general', 'private']).default('general'),
  acceptsOtherCategory: z.boolean().default(false),
  evidence: z.any().optional(),
});
routes.post('/requests', requireAuth('manager', 'requester'), async (req, res) => {
  const b = requestBody.parse(req.body);
  if (b.bedType === 'ward' && !b.department) throw new HttpError(400, 'Choose a department for a ward bed');
  const doc = await AdmissionRequest.create({ ...b, ageGroup: ageGroupOf(b.age), department: b.department ?? '', createdBy: req.user!.id, status: 'waiting' });
  emit('requests');
  schedulePlan();
  res.status(201).json(doc);
});

routes.get('/requests', requireAuth('manager', 'requester'), async (req, res) => {
  const filter: Record<string, unknown> = { status: { $ne: 'cancelled' } };
  if (req.user!.role === 'requester') filter.createdBy = req.user!.id;
  const docs = await AdmissionRequest.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  const beds = new Map((await Bed.find({ _id: { $in: docs.map((d) => d.assignedBedId).filter(Boolean) } }).lean()).map((b) => [String(b._id), b.label]));
  res.json(docs.map((d) => ({ ...d, assignedBedLabel: d.assignedBedId ? beds.get(String(d.assignedBedId)) : undefined })));
});

routes.post('/requests/:id/cancel', requireAuth('manager', 'requester'), async (req, res) => {
  await AdmissionRequest.updateOne({ _id: String(req.params.id), status: { $in: ['waiting', 'assigned'] } }, { status: 'cancelled' });
  const r = await AdmissionRequest.findById(req.params.id);
  if (r?.assignedBedId) await recordEvent(String(r.assignedBedId), 'RESERVATION_RELEASED', 'system');
  emit('requests'); schedulePlan();
  res.json({ ok: true });
});

routes.post('/requests/:id/arrived', requireAuth('manager'), async (req, res) => {
  const r = await AdmissionRequest.findById(req.params.id);
  if (!r || r.status !== 'assigned' || !r.assignedBedId) throw new HttpError(409, 'No assigned bed');
  await recordEvent(String(r.assignedBedId), 'ADMITTED', 'board', { actorId: req.user!.id, occupant: { sex: r.sex as 'M' | 'F', ageGroup: r.ageGroup as 'child' | 'adult' | 'elderly' } });
  await AdmissionRequest.updateOne({ _id: r._id }, { status: 'admitted' });
  emit('requests');
  res.json({ ok: true });
});

// ---------- plan & suggestions ----------
routes.post('/plan/run', requireAuth('manager'), async (_req, res) => res.json(await runPlan()));

routes.get('/suggestions', requireAuth('manager'), async (_req, res) => {
  const [sugs, waiting] = await Promise.all([Suggestion.find({ status: 'proposed' }).lean(), AdmissionRequest.find({ status: 'waiting' }).sort({ urgency: -1, createdAt: 1 }).lean()]);
  const beds = new Map((await Bed.find({ _id: { $in: sugs.map((s) => s.bedId) } }).lean()).map((b) => [String(b._id), b]));
  const byReq = new Map(sugs.map((s) => [String(s.requestId), s]));
  res.json(waiting.map((r) => {
    const s = byReq.get(String(r._id));
    const b = s ? beds.get(String(s.bedId)) : undefined;
    return {
      request: r,
      suggestion: s && b ? { id: String(s._id), bedLabel: b.label, ward: b.department, cost: s.cost, availableInMin: s.availableInMin, reasons: s.reasons, fallback: s.fallback } : null,
    };
  }));
});
routes.post('/suggestions/:id/approve', requireAuth('manager'), async (req, res) => res.json(await approveSuggestion(String(req.params.id), req.user!.id)));
routes.post('/suggestions/:id/reject', requireAuth('manager'), async (req, res) => {
  await rejectSuggestion(String(req.params.id), z.object({ reason: z.string().optional() }).parse(req.body).reason);
  res.json({ ok: true });
});

// ---------- ward questions, replies and pause ----------
routes.get('/ward/questions', requireAuth('ward'), async (req, res) => {
  const qs = await Question.find({ wardId: req.user!.wardId, status: 'open' }).sort({ askedAt: 1 }).lean();
  const beds = new Map((await Bed.find({ _id: { $in: qs.map((q) => q.bedId) } }).lean()).map((b) => [String(b._id), b.label]));
  res.json(qs.map((q) => ({ id: String(q._id), bedLabel: beds.get(String(q.bedId)), kind: q.kind, reason: q.reason, askedAt: q.askedAt, needsButtons: !!q.rawReply })));
});

routes.post('/questions/:id/answer', requireAuth('ward'), async (req, res) => {
  const body = z.object({ reply: z.enum(['ready', 'not_yet', 'occupied']).optional(), text: z.string().max(200).optional() }).parse(req.body);
  const q = await Question.findById(req.params.id);
  if (!q || String(q.wardId) !== req.user!.wardId) throw new HttpError(404, 'No such question');
  const reply = body.reply ?? parseReply(body.text ?? '');
  res.json(await answerQuestion(String(q._id), reply, body.text, req.user!.id));
});

routes.get('/ward/hold', requireAuth('ward'), async (req, res) => {
  res.json(await Hold.findOne({ scope: 'ward', wardId: req.user!.wardId, until: { $gt: new Date() } }).lean());
});
routes.post('/ward/hold', requireAuth('ward'), async (req, res) => {
  const { minutes } = z.object({ minutes: z.number().min(5).max(120) }).parse(req.body);
  await Hold.deleteMany({ scope: 'ward', wardId: req.user!.wardId });
  await Hold.create({ scope: 'ward', wardId: req.user!.wardId, until: mins(minutes), createdBy: req.user!.id });
  schedulePlan(); emit('beds');
  res.json({ ok: true });
});
routes.delete('/ward/hold', requireAuth('ward'), async (req, res) => {
  await Hold.deleteMany({ scope: 'ward', wardId: req.user!.wardId });
  schedulePlan();
  res.json({ ok: true });
});

routes.get('/feed', requireAuth('manager'), async (_req, res) => {
  const qs = await Question.find().sort({ askedAt: -1 }).limit(30).lean();
  const [beds, wards] = await Promise.all([Bed.find({ _id: { $in: qs.map((q) => q.bedId) } }).lean(), Ward.find().lean()]);
  const bl = new Map(beds.map((b) => [String(b._id), b.label]));
  const wn = new Map(wards.map((w) => [String(w._id), w.name]));
  res.json(qs.map((q) => ({ id: String(q._id), bed: bl.get(String(q.bedId)), ward: wn.get(String(q.wardId)), kind: q.kind, reason: q.reason, status: q.status, answer: q.answer, rawReply: q.rawReply, askedAt: q.askedAt, answeredAt: q.answeredAt })));
});

// ---------- demo tools ----------
if (config.demoTools) {
  const demo = Router();
  demo.post('/drift', async (req, res) => {
    const b = z.object({ hidden: z.number().min(0).max(30).default(5), phantom: z.number().min(0).max(30).default(3) }).parse(req.body);
    res.json(await injectDrift(b.hidden, b.phantom));
  });
  demo.post('/burst', async (req, res) => { await addBurst(z.object({ count: z.number().min(1).max(60).default(5) }).parse(req.body).count); res.json({ ok: true }); });
  demo.post('/auto-nurse', async (_req, res) => res.json(await autoNurse()));
  demo.post('/reset', async (_req, res) => { await seed(); emit('beds', 'suggestions', 'questions', 'requests', 'feed'); res.json({ ok: true }); });
  routes.use('/demo', requireAuth('manager'), demo);
}
```

### Step 12: Entry point

Starts Express, Socket.IO, MongoDB, and the two background jobs.

**`server/src/index.ts`**

```ts
import http from 'http';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './auth';
import { config } from './config';
import { connectDb } from './models';
import { initRealtime } from './realtime';
import { routes } from './routes';
import { runPlan } from './services/planner.service';
import { runTruthAgent } from './services/truthAgent';

const app = express();
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json());
app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/api', routes);

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
};
app.use(onError);

const server = http.createServer(app);
initRealtime(server, config.clientOrigin);
await connectDb(config.mongoUri);

// the two background jobs: rolling plan, and the bed truth agent
setInterval(() => runPlan().catch(console.error), config.planEverySec * 1000);
setInterval(() => runTruthAgent().catch(console.error), config.agentEverySec * 1000);

server.listen(config.port, () => console.log(`BedSense API on http://localhost:${config.port}`));
```

### Run the backend and check it

```bash
cd server
npm run typecheck
npm run seed          # "Seeded 4 wards, 78 beds, 6 users..."
npm run dev           # "BedSense API on http://localhost:4000"
```

In another terminal:

```bash
# log in as the manager and keep the token
TOKEN=$(curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"manager@bedsense.test","password":"bedsense123"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# the bed board
curl -s localhost:4000/api/beds -H "authorization: Bearer $TOKEN" | head -c 400

# parse a doctor's note
curl -s localhost:4000/api/requests/parse -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"note":"62 yr old female, COPD, on 4L O2. Admit under Medicine ward. No isolation"}'
```

**Checkpoint:** you get 78 beds, each with `status` and `trust`, and a parsed note with age 62, sex F, Medicine, oxygen true, isolation false.

**If it fails:**
- `ECONNREFUSED 27017`: MongoDB is not running (`docker compose up -d`).
- `Not signed in` / `401`: the token is missing or expired. Log in again.
- A validation error from zod: the message names the field.

---

## 6. Build the frontend, step by step

### Create the web project

```bash
cd bedsense
mkdir web && cd web
npm init -y
npm pkg set type=module
npm i react react-dom react-router-dom @tanstack/react-query socket.io-client
npm i -D vite @vitejs/plugin-react typescript @types/react @types/react-dom tailwindcss @tailwindcss/vite
npm pkg set scripts.dev="vite" scripts.build="tsc --noEmit && vite build" scripts.preview="vite preview"
mkdir -p src/pages src/components
```

### Config files

`web/index.html`:

**`web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>BedSense</title>
  </head>
  <body class="bg-slate-50 text-slate-900">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/vite.config.ts` proxies `/api` and `/socket.io` to the backend, and exposes the dev server on your network so a phone can open the ward page:

**`web/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // so a phone on the same Wi-Fi can open the ward page
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
});
```

`web/tsconfig.json`:

**`web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`web/src/index.css`:

**`web/src/index.css`**

```css
@import "tailwindcss";
```

### Shared plumbing

Types that mirror the API responses:

**`web/src/types.ts`**

```ts
export type Role = 'manager' | 'ward' | 'requester';
export interface User { id: string; name: string; role: Role; wardId?: string }
export type BedStatus = 'ready' | 'reserved' | 'occupied' | 'discharging' | 'dirty' | 'blocked';

export interface Bed {
  id: string; label: string; wardId: string; ward?: string; room: string; type: 'ward' | 'icu' | 'hdu';
  category: string; isolation: boolean; oxygen: boolean; status: BedStatus; statusSince: string;
  trust: 'confirmed' | 'inferred' | 'stale'; asking: boolean; mismatch: boolean;
}
export interface RequestDoc {
  _id: string; age: number; sex: 'M' | 'F'; department?: string; bedType: string; urgency: 1 | 2 | 3;
  needsOxygen: boolean; needsIsolation: boolean; status: string; assignedBedLabel?: string; createdAt: string;
}
export interface QueueItem {
  request: RequestDoc;
  suggestion: null | { id: string; bedLabel: string; ward: string; cost: number; availableInMin: number; reasons: string[]; fallback: boolean };
}
export interface WardQuestion { id: string; bedLabel: string; kind: 'is_ready' | 'pre_send'; reason: string; needsButtons: boolean }
export interface FeedItem { id: string; bed: string; ward: string; kind: string; reason: string; status: string; answer?: string; rawReply?: string; askedAt: string }

export interface Field<T> { value: T; evidence: string }
export interface Intake {
  age?: Field<number>; sex?: Field<'M' | 'F'>; bedType?: Field<'ward' | 'icu' | 'hdu'>; department?: Field<string>;
  oxygen?: Field<boolean>; isolation?: Field<boolean>; urgency?: Field<1 | 2 | 3>;
  missing: string[]; questions: string[]; assumed: string[];
}
```

A fetch wrapper that attaches the token and turns errors into messages:

**`web/src/api.ts`**

```ts
export const getToken = () => localStorage.getItem('token');

export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { localStorage.removeItem('token'); localStorage.removeItem('user'); }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}
```

Auth context (login, logout, current user):

**`web/src/auth.tsx`**

```tsx
import { createContext, useContext, useState, type ReactNode } from 'react';
import { api } from './api';
import type { User } from './types';

interface Ctx { user: User | null; login: (email: string, password: string) => Promise<User>; logout: () => void }
const AuthCtx = createContext<Ctx>(null!);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => JSON.parse(localStorage.getItem('user') ?? 'null'));
  const login = async (email: string, password: string) => {
    const r = await api<{ token: string; user: User }>('/auth/login', 'POST', { email, password });
    localStorage.setItem('token', r.token);
    localStorage.setItem('user', JSON.stringify(r.user));
    setUser(r.user);
    return r.user;
  };
  const logout = () => { localStorage.removeItem('token'); localStorage.removeItem('user'); setUser(null); };
  return <AuthCtx.Provider value={{ user, login, logout }}>{children}</AuthCtx.Provider>;
}
```

The live hook. The server says *what* changed, and the client invalidates that query so React Query refetches it. React Query also polls every 15 seconds as a safety net.

**`web/src/live.ts`**

```ts
import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';

/** The server says WHAT changed; we refetch that data through the normal authenticated API. */
export function useLive() {
  const qc = useQueryClient();
  useEffect(() => {
    const socket = io({ path: '/socket.io' });
    socket.on('changed', (topic: string) => qc.invalidateQueries({ queryKey: [topic] }));
    return () => { socket.disconnect(); };
  }, [qc]);
}
```

**`web/src/main.tsx`**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth';
import App from './App';
import './index.css';

const qc = new QueryClient({ defaultOptions: { queries: { refetchInterval: 15000, retry: 1 } } }); // polling is the safety net behind sockets

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

Routing with a role guard, so each role lands on its own screen:

**`web/src/App.tsx`**

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import type { ReactNode } from 'react';
import type { Role } from './types';
import Login from './pages/Login';
import Manager from './pages/Manager';
import Ward from './pages/Ward';
import Requester from './pages/Requester';

const home: Record<Role, string> = { manager: '/manager', ward: '/ward', requester: '/requests' };

function Guard({ role, children }: { role: Role; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={home[user.role]} replace />;
  return <>{children}</>;
}

export default function App() {
  const { user } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/manager" element={<Guard role="manager"><Manager /></Guard>} />
      <Route path="/ward" element={<Guard role="ward"><Ward /></Guard>} />
      <Route path="/requests" element={<Guard role="requester"><Requester /></Guard>} />
      <Route path="*" element={<Navigate to={user ? home[user.role] : '/login'} replace />} />
    </Routes>
  );
}
```

### Screens

**Login** has quick-fill buttons for the demo accounts.

**`web/src/pages/Login.tsx`**

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

const demo = [
  ['Bed Manager', 'manager@bedsense.test'],
  ['ICU ward phone', 'icu@bedsense.test'],
  ['Medicine ward phone', 'med@bedsense.test'],
  ['Doctor (requester)', 'doctor@bedsense.test'],
];

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('manager@bedsense.test');
  const [password, setPassword] = useState('bedsense123');
  const [error, setError] = useState('');

  const submit = async () => {
    try {
      const u = await login(email, password);
      nav(u.role === 'manager' ? '/manager' : u.role === 'ward' ? '/ward' : '/requests');
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-3 rounded-xl bg-white p-6 shadow">
      <h1 className="text-2xl font-bold">BedSense</h1>
      <p className="text-sm text-slate-500">Sign in. Demo accounts use password <code>bedsense123</code>.</p>
      <input className="w-full rounded border p-2" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <input className="w-full rounded border p-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" onKeyDown={(e) => e.key === 'Enter' && submit()} />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="w-full rounded bg-slate-900 p-2 text-white" onClick={submit}>Sign in</button>
      <div className="flex flex-wrap gap-2 pt-2">
        {demo.map(([label, mail]) => (
          <button key={mail} className="rounded-full border px-3 py-1 text-xs" onClick={() => setEmail(mail)}>{label}</button>
        ))}
      </div>
    </div>
  );
}
```

**Bed board.** Colour shows status. Hatching means doubted. A `?` badge means the ward is being asked. In demo mode a red outline means the board is wrong.

**`web/src/components/BedBoard.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { Bed, BedStatus } from '../types';

export const STATUS_STYLE: Record<BedStatus, string> = {
  ready: 'bg-emerald-200 border-emerald-500',
  reserved: 'bg-sky-200 border-sky-500',
  occupied: 'bg-rose-200 border-rose-400',
  discharging: 'bg-amber-200 border-amber-500',
  dirty: 'bg-orange-200 border-orange-500',
  blocked: 'bg-slate-300 border-slate-500',
};
const HATCH = { backgroundImage: 'repeating-linear-gradient(45deg, rgba(0,0,0,.18) 0 3px, transparent 3px 8px)' };

export function BedTile({ bed, showTruth, onClick }: { bed: Bed; showTruth?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      title={`${bed.label} - ${bed.status} (${bed.trust})`}
      style={bed.trust === 'stale' ? HATCH : undefined}
      className={`relative h-14 w-16 rounded border-2 text-xs font-medium ${STATUS_STYLE[bed.status]} ${showTruth && bed.mismatch ? 'ring-4 ring-red-600' : ''}`}
    >
      {bed.label}
      <div className="text-[10px] font-normal">{bed.status}</div>
      {bed.asking && <span className="absolute -right-2 -top-2 rounded-full bg-indigo-600 px-1.5 text-white">?</span>}
      {bed.oxygen && <span className="absolute bottom-0 right-0.5 text-[9px]">O₂</span>}
      {bed.isolation && <span className="absolute bottom-0 left-0.5 text-[9px]">ISO</span>}
    </button>
  );
}

export const Legend = () => (
  <div className="flex flex-wrap gap-2 text-xs">
    {(Object.keys(STATUS_STYLE) as BedStatus[]).map((s) => (
      <span key={s} className={`rounded border px-2 py-0.5 ${STATUS_STYLE[s]}`}>{s}</span>
    ))}
    <span className="rounded border px-2 py-0.5" style={HATCH}>hatched = doubted</span>
    <span className="rounded border px-2 py-0.5">? = ward is being asked</span>
  </div>
);

export default function BedBoard({ showTruth, onBed }: { showTruth: boolean; onBed: (b: Bed) => void }) {
  const { data: beds = [] } = useQuery({ queryKey: ['beds'], queryFn: () => api<Bed[]>('/beds') });
  const wards = [...new Set(beds.map((b) => b.ward))];
  return (
    <div className="space-y-4">
      <Legend />
      {wards.map((w) => {
        const list = beds.filter((b) => b.ward === w);
        const free = list.filter((b) => b.status === 'ready').length;
        return (
          <section key={w}>
            <h3 className="mb-1 font-semibold">{w} <span className="text-sm font-normal text-slate-500">{free} ready / {list.length}</span></h3>
            <div className="flex flex-wrap gap-2">
              {list.map((b) => <BedTile key={b.id} bed={b} showTruth={showTruth} onClick={() => onBed(b)} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}
```

**Queue.** Waiting patients sorted by urgency, with the suggested bed, plain reasons, and Approve / Reject. A bed that is not ready yet shows "planned, free in ~N min" instead of an Approve button. Assigned patients wait for the **Arrived** button.

**`web/src/components/Queue.tsx`**

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { QueueItem, RequestDoc } from '../types';

const URG = { 3: 'Critical', 2: 'Urgent', 1: 'Routine' } as const;
const URG_STYLE = { 3: 'bg-red-600', 2: 'bg-amber-500', 1: 'bg-slate-500' } as const;
const describe = (r: RequestDoc) => `${r.age}${r.sex} - ${r.bedType === 'ward' ? r.department : r.bedType.toUpperCase()}${r.needsOxygen ? ' - O₂' : ''}${r.needsIsolation ? ' - isolation' : ''}`;

export default function Queue() {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({ queryKey: ['suggestions'], queryFn: () => api<QueueItem[]>('/suggestions') });
  const done = () => { qc.invalidateQueries({ queryKey: ['suggestions'] }); qc.invalidateQueries({ queryKey: ['beds'] }); qc.invalidateQueries({ queryKey: ['requests'] }); };
  const approve = useMutation({ mutationFn: (id: string) => api(`/suggestions/${id}/approve`, 'POST'), onSuccess: done, onError: (e) => { alert((e as Error).message); done(); } });
  const reject = useMutation({ mutationFn: (id: string) => api(`/suggestions/${id}/reject`, 'POST', {}), onSuccess: done });
  const assigned = useQuery({ queryKey: ['requests'], queryFn: () => api<RequestDoc[]>('/requests') });
  const arrived = useMutation({ mutationFn: (id: string) => api(`/requests/${id}/arrived`, 'POST'), onSuccess: done });

  return (
    <div className="space-y-3">
      <h2 className="text-lg font-semibold">Waiting patients ({items.length})</h2>
      {items.length === 0 && <p className="text-sm text-slate-500">Nobody is waiting.</p>}
      {items.map(({ request: r, suggestion: s }) => (
        <div key={r._id} className="rounded-lg border bg-white p-3 shadow-sm">
          <div className="flex items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs text-white ${URG_STYLE[r.urgency]}`}>{URG[r.urgency]}</span>
            <span className="font-medium">{describe(r)}</span>
          </div>
          {s ? (
            <div className="mt-2 text-sm">
              <div>Suggested: <b>{s.bedLabel}</b> <span className="text-slate-500">({s.ward}{s.fallback ? ', fallback plan' : ''})</span></div>
              <ul className="mt-1 list-disc pl-5 text-slate-600">{s.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
              <div className="mt-2 flex gap-2">
                {s.availableInMin === 0
                  ? <button className="rounded bg-emerald-600 px-3 py-1 text-white" onClick={() => approve.mutate(s.id)}>Approve</button>
                  : <span className="rounded bg-slate-100 px-2 py-1 text-xs">Planned - bed free in ~{Math.ceil(s.availableInMin)} min</span>}
                <button className="rounded border px-3 py-1" onClick={() => reject.mutate(s.id)}>Reject</button>
              </div>
            </div>
          ) : <p className="mt-2 text-sm text-red-600">No suitable bed expected soon - consider referral.</p>}
        </div>
      ))}
      <h3 className="pt-2 font-semibold">Assigned - waiting to arrive</h3>
      {(assigned.data ?? []).filter((r) => r.status === 'assigned').map((r) => (
        <div key={r._id} className="flex items-center justify-between rounded border bg-white p-2 text-sm">
          <span>{describe(r)} → <b>{r.assignedBedLabel}</b></span>
          <button className="rounded bg-slate-900 px-2 py-1 text-white" onClick={() => arrived.mutate(r._id)}>Arrived</button>
        </div>
      ))}
    </div>
  );
}
```

**Add patient.** Paste a note, click **Read note**, review and correct what was understood, then add. Quotes from the note and anything assumed are shown so the person can check.

**`web/src/components/AddPatient.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import type { Intake } from '../types';

const DEPTS = ['Medicine', 'Surgery', 'Paediatrics', 'Obstetrics and Gynaecology', 'Orthopaedics', 'ENT', 'Eye', 'Psychiatry', 'Dermatology'];

interface Form { age: string; sex: 'M' | 'F' | ''; bedType: 'ward' | 'icu' | 'hdu'; department: string; urgency: 1 | 2 | 3; oxygen: boolean; isolation: boolean; private: boolean }
const empty: Form = { age: '', sex: '', bedType: 'ward', department: 'Medicine', urgency: 1, oxygen: false, isolation: false, private: false };

export default function AddPatient({ onSaved }: { onSaved?: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [form, setForm] = useState<Form>(empty);
  const [intake, setIntake] = useState<Intake | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const parse = useMutation({
    mutationFn: () => api<Intake>('/requests/parse', 'POST', { note }),
    onSuccess: (r) => {
      setIntake(r);
      setForm((f) => ({
        ...f,
        age: r.age ? String(r.age.value) : f.age, sex: r.sex?.value ?? f.sex, bedType: r.bedType?.value ?? f.bedType,
        department: r.department?.value ?? f.department, urgency: r.urgency?.value ?? 1,
        oxygen: r.oxygen?.value ?? false, isolation: r.isolation?.value ?? false,
      }));
    },
  });
  const save = useMutation({
    mutationFn: () => api('/requests', 'POST', {
      rawNote: note, age: Number(form.age), sex: form.sex, bedType: form.bedType, urgency: form.urgency,
      department: form.bedType === 'ward' ? form.department : undefined, needsOxygen: form.oxygen,
      needsIsolation: form.isolation, category: form.private ? 'private' : 'general', evidence: intake,
    }),
    onSuccess: () => { setNote(''); setForm(empty); setIntake(null); qc.invalidateQueries(); onSaved?.(); },
  });
  const ready = Number(form.age) > 0 && form.sex !== '';

  return (
    <div className="space-y-2 rounded-lg border bg-white p-3">
      <h2 className="font-semibold">Add patient from a doctor&apos;s note</h2>
      <textarea className="w-full rounded border p-2 text-sm" rows={3} value={note} onChange={(e) => setNote(e.target.value)}
        placeholder="62 yr old female, COPD, on 4L O2. Admit under Medicine ward. No isolation" />
      <button className="rounded border px-3 py-1 text-sm" disabled={note.length < 3} onClick={() => parse.mutate()}>Read note</button>

      {intake && (
        <div className="rounded bg-slate-50 p-2 text-xs">
          {intake.questions.map((q) => <p key={q} className="font-medium text-red-700">? {q}</p>)}
          {intake.assumed.length > 0 && <p className="text-amber-700">Assumed, please confirm: {intake.assumed.join('; ')}</p>}
          {[intake.age, intake.sex, intake.department, intake.oxygen, intake.isolation].filter(Boolean).map((f) => (
            <p key={f!.evidence} className="text-slate-500">from note: “{f!.evidence}”</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 text-sm">
        <input className="rounded border p-1" type="number" placeholder="Age" value={form.age} onChange={(e) => set('age', e.target.value)} />
        <select className="rounded border p-1" value={form.sex} onChange={(e) => set('sex', e.target.value as Form['sex'])}>
          <option value="">Sex…</option><option value="M">Male</option><option value="F">Female</option>
        </select>
        <select className="rounded border p-1" value={form.bedType} onChange={(e) => set('bedType', e.target.value as Form['bedType'])}>
          <option value="ward">Ward</option><option value="hdu">HDU</option><option value="icu">ICU</option>
        </select>
        <select className="rounded border p-1" disabled={form.bedType !== 'ward'} value={form.department} onChange={(e) => set('department', e.target.value)}>
          {DEPTS.map((d) => <option key={d}>{d}</option>)}
        </select>
        <select className="rounded border p-1" value={form.urgency} onChange={(e) => set('urgency', Number(e.target.value) as Form['urgency'])}>
          <option value={1}>Routine</option><option value={2}>Urgent</option><option value={3}>Critical</option>
        </select>
        <label><input type="checkbox" checked={form.oxygen} onChange={(e) => set('oxygen', e.target.checked)} /> Oxygen</label>
        <label><input type="checkbox" checked={form.isolation} onChange={(e) => set('isolation', e.target.checked)} /> Isolation</label>
        <label><input type="checkbox" checked={form.private} onChange={(e) => set('private', e.target.checked)} /> Private room</label>
      </div>
      {save.error && <p className="text-sm text-red-600">{(save.error as Error).message}</p>}
      <button className="w-full rounded bg-slate-900 p-2 text-white disabled:opacity-40" disabled={!ready} onClick={() => save.mutate()}>Add to queue</button>
    </div>
  );
}
```

**Message feed and demo panel:**

**`web/src/components/Feed.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { FeedItem } from '../types';

export default function Feed() {
  const { data = [] } = useQuery({ queryKey: ['feed'], queryFn: () => api<FeedItem[]>('/feed') });
  return (
    <div className="space-y-1">
      <h2 className="font-semibold">Messages to wards</h2>
      {data.length === 0 && <p className="text-sm text-slate-500">No questions sent yet.</p>}
      {data.map((q) => (
        <div key={q.id} className="rounded border bg-white p-2 text-xs">
          <b>{q.ward}</b> · bed {q.bed} · {q.kind === 'pre_send' ? 'heads-up before sending' : 'is it ready?'}
          <div className="text-slate-500">{q.reason}</div>
          <div>{q.status === 'open' ? <span className="text-indigo-600">waiting for reply{q.rawReply ? ` (unclear: “${q.rawReply}”)` : ''}</span> : <span className="text-emerald-700">answered: {q.answer}</span>}</div>
        </div>
      ))}
    </div>
  );
}
```

**`web/src/components/DemoPanel.tsx`**

```tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';

export default function DemoPanel({ showTruth, setShowTruth }: { showTruth: boolean; setShowTruth: (v: boolean) => void }) {
  const qc = useQueryClient();
  const run = (path: string, body?: unknown) => ({ mutationFn: () => api(`/demo/${path}`, 'POST', body ?? {}), onSuccess: () => qc.invalidateQueries() });
  const drift = useMutation(run('drift', { hidden: 5, phantom: 3 }));
  const burst = useMutation(run('burst', { count: 5 }));
  const crunch = useMutation(run('burst', { count: 40 }));
  const nurse = useMutation(run('auto-nurse'));
  const reset = useMutation(run('reset'));
  const btn = 'rounded border bg-white px-2 py-1 text-xs hover:bg-slate-100';
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-indigo-300 bg-indigo-50 p-2">
      <span className="text-xs font-semibold text-indigo-700">DEMO</span>
      <label className="text-xs"><input type="checkbox" checked={showTruth} onChange={(e) => setShowTruth(e.target.checked)} /> Show where the board is wrong</label>
      <button className={btn} onClick={() => drift.mutate()}>Make the board wrong (5 hidden, 3 phantom)</button>
      <button className={btn} onClick={() => burst.mutate()}>Add 5 patients</button>
      <button className={btn} onClick={() => crunch.mutate()}>Crunch: 40 patients</button>
      <button className={btn} onClick={() => nurse.mutate()}>Auto-answer as nurse</button>
      <button className={btn} onClick={() => confirm('Reset all demo data?') && reset.mutate()}>Reset</button>
    </div>
  );
}
```

**The three pages.** Manager dashboard:

**`web/src/pages/Manager.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useLive } from '../live';
import BedBoard from '../components/BedBoard';
import Queue from '../components/Queue';
import AddPatient from '../components/AddPatient';
import Feed from '../components/Feed';
import DemoPanel from '../components/DemoPanel';
import type { Bed } from '../types';

export default function Manager() {
  useLive();
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const [showTruth, setShowTruth] = useState(false);
  const [selected, setSelected] = useState<Bed | null>(null);
  const { data: beds = [] } = useQuery({ queryKey: ['beds'], queryFn: () => api<Bed[]>('/beds') });

  const bedAction = useMutation({
    mutationFn: (v: { id: string; path: string; body: unknown }) => api(`/beds/${v.id}/${v.path}`, 'POST', v.body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['beds'] }); setSelected(null); },
  });
  const replan = useMutation({ mutationFn: () => api('/plan/run', 'POST'), onSuccess: () => qc.invalidateQueries({ queryKey: ['suggestions'] }) });

  const total = beds.length;
  const ready = beds.filter((b) => b.status === 'ready').length;
  const doubted = beds.filter((b) => b.trust === 'stale').length;
  const mismatches = beds.filter((b) => b.mismatch).length;

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">BedSense · Bed Manager</h1>
        <div className="flex items-center gap-3 text-sm">
          <span>{ready}/{total} ready</span><span>{doubted} doubted</span>
          {showTruth && <span className="text-red-700">{mismatches} wrong on board</span>}
          <button className="rounded border px-2 py-1" onClick={() => replan.mutate()}>Re-plan now</button>
          <span className="text-slate-500">{user?.name}</span>
          <button className="underline" onClick={logout}>Sign out</button>
        </div>
      </header>
      <DemoPanel showTruth={showTruth} setShowTruth={setShowTruth} />
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <BedBoard showTruth={showTruth} onBed={setSelected} />
          {selected && (
            <div className="rounded-lg border bg-white p-3 text-sm">
              <b>{selected.label}</b> · {selected.status} · {selected.trust} · {selected.room}
              <div className="mt-2 flex flex-wrap gap-2">
                {([['Keep free 2h', 'hold', { minutes: 120 }], ['Block', 'events', { type: 'BLOCKED' }], ['Unblock', 'events', { type: 'UNBLOCKED' }],
                  ['Discharge ordered', 'events', { type: 'DISCHARGE_ORDERED' }], ['Patient left', 'events', { type: 'PATIENT_LEFT' }], ['Cleaned', 'events', { type: 'CLEANED' }]] as const).map(([label, path, body]) => (
                  <button key={label} className="rounded border px-2 py-1" onClick={() => bedAction.mutate({ id: selected.id, path, body })}>{label}</button>
                ))}
                <button className="px-2 text-slate-500" onClick={() => setSelected(null)}>Close</button>
              </div>
            </div>
          )}
          <Feed />
        </div>
        <div className="space-y-4">
          <AddPatient />
          <Queue />
        </div>
      </div>
    </div>
  );
}
```

Ward phone page. This is the nurse's view: big buttons, one question at a time, a text box that understands "haan khali hai", and a pause button:

**`web/src/pages/Ward.tsx`**

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useLive } from '../live';
import { BedTile } from '../components/BedBoard';
import type { Bed, WardQuestion } from '../types';

const ACTION: Record<string, [string, string][]> = {
  occupied: [['Patient left', 'PATIENT_LEFT']], discharging: [['Patient left', 'PATIENT_LEFT']],
  dirty: [['Cleaned ✓', 'CLEANED']], ready: [['Block', 'BLOCKED']], blocked: [['Unblock', 'UNBLOCKED']], reserved: [],
};

function Question({ q }: { q: WardQuestion }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const answer = useMutation({
    mutationFn: (body: { reply?: string; text?: string }) => api(`/questions/${q.id}/answer`, 'POST', body),
    onSuccess: () => { setText(''); qc.invalidateQueries({ queryKey: ['questions'] }); qc.invalidateQueries({ queryKey: ['beds'] }); },
  });
  const btn = 'flex-1 rounded-lg py-3 text-base font-semibold text-white';
  return (
    <div className="rounded-xl border-2 border-indigo-300 bg-white p-3">
      <div className="text-lg font-bold">Bed {q.bedLabel}: is it ready?</div>
      <div className="text-xs text-slate-500">{q.kind === 'pre_send' ? 'A patient is about to be sent here.' : q.reason}</div>
      {q.needsButtons && <div className="mt-1 text-xs text-amber-700">We couldn&apos;t understand the last reply. Please tap a button.</div>}
      <div className="mt-2 flex gap-2">
        <button className={`${btn} bg-emerald-600`} onClick={() => answer.mutate({ reply: 'ready' })}>Ready</button>
        <button className={`${btn} bg-amber-500`} onClick={() => answer.mutate({ reply: 'not_yet' })}>Not yet</button>
        <button className={`${btn} bg-rose-600`} onClick={() => answer.mutate({ reply: 'occupied' })}>Occupied</button>
      </div>
      <div className="mt-2 flex gap-2">
        <input className="flex-1 rounded border p-2 text-sm" placeholder='or type: "haan khali hai"' value={text} onChange={(e) => setText(e.target.value)} />
        <button className="rounded border px-3 text-sm" disabled={!text} onClick={() => answer.mutate({ text })}>Send</button>
      </div>
    </div>
  );
}

export default function Ward() {
  useLive();
  const { user, logout } = useAuth();
  const qc = useQueryClient();
  const { data: beds = [] } = useQuery({ queryKey: ['beds'], queryFn: () => api<Bed[]>('/beds') });
  const { data: questions = [] } = useQuery({ queryKey: ['questions'], queryFn: () => api<WardQuestion[]>('/ward/questions') });
  const { data: hold } = useQuery({ queryKey: ['hold'], queryFn: () => api<{ until: string } | null>('/ward/hold') });
  const event = useMutation({
    mutationFn: (v: { id: string; type: string }) => api(`/beds/${v.id}/events`, 'POST', { type: v.type }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['beds'] }),
  });
  const setHold = useMutation({
    mutationFn: (minutes: number | null) => (minutes ? api('/ward/hold', 'POST', { minutes }) : api('/ward/hold', 'DELETE')),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hold'] }),
  });

  return (
    <div className="mx-auto max-w-md space-y-4 p-3">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold">{user?.name}</h1>
        <button className="text-sm underline" onClick={logout}>Sign out</button>
      </header>

      <section className="space-y-2">
        <h2 className="font-semibold">Questions ({questions.length})</h2>
        {questions.length === 0 && <p className="text-sm text-slate-500">Nothing to answer right now.</p>}
        {questions.map((q) => <Question key={q.id} q={q} />)}
      </section>

      <section className="rounded-xl border bg-white p-3">
        <h2 className="font-semibold">Busy? Pause new admissions</h2>
        {hold ? (
          <div className="mt-1 text-sm">Paused until {new Date(hold.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (critical patients still allowed)
            <button className="ml-2 underline" onClick={() => setHold.mutate(null)}>Clear</button></div>
        ) : (
          <div className="mt-2 flex gap-2">
            {[30, 60].map((m) => <button key={m} className="rounded border px-3 py-2 text-sm" onClick={() => setHold.mutate(m)}>{m} min</button>)}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Beds</h2>
        <div className="space-y-2">
          {beds.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-lg border bg-white p-2">
              <BedTile bed={b} />
              <div className="flex gap-2">
                {(ACTION[b.status] ?? []).map(([label, type]) => (
                  <button key={type} className="rounded border px-3 py-2 text-sm" onClick={() => event.mutate({ id: b.id, type })}>{label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
```

Requester page:

**`web/src/pages/Requester.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAuth } from '../auth';
import { useLive } from '../live';
import AddPatient from '../components/AddPatient';
import type { RequestDoc } from '../types';

const LABEL: Record<string, string> = { waiting: 'Waiting for a bed', assigned: 'Bed assigned', admitted: 'Admitted' };

export default function Requester() {
  useLive();
  const { user, logout } = useAuth();
  const { data = [] } = useQuery({ queryKey: ['requests'], queryFn: () => api<RequestDoc[]>('/requests') });
  return (
    <div className="mx-auto max-w-lg space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold">Admission requests · {user?.name}</h1>
        <button className="text-sm underline" onClick={logout}>Sign out</button>
      </header>
      <AddPatient />
      <h2 className="font-semibold">My requests</h2>
      {data.map((r) => (
        <div key={r._id} className="rounded border bg-white p-2 text-sm">
          {r.age}{r.sex} · {r.bedType === 'ward' ? r.department : r.bedType.toUpperCase()} — <b>{LABEL[r.status] ?? r.status}</b>
          {r.assignedBedLabel && <> · bed {r.assignedBedLabel}</>}
        </div>
      ))}
    </div>
  );
}
```

### Run the frontend

```bash
cd web
npm run build      # typechecks and builds
npm run dev        # http://localhost:5173
```

**Checkpoint:** you can sign in as `manager@bedsense.test` / `bedsense123` and see four wards of coloured beds.

---

## 7. Run it and demo it

Start MongoDB, the server (`npm run dev` in `server/`) and the web app (`npm run dev` in `web/`).

| Login | Password | Lands on |
|---|---|---|
| `manager@bedsense.test` | `bedsense123` | Bed Manager dashboard |
| `doctor@bedsense.test` | `bedsense123` | Request page |
| `icu@bedsense.test`, `med@bedsense.test`, `sur@bedsense.test`, `ped@bedsense.test` | `bedsense123` | Ward phone page for that ward |

For the phone: put the phone on the same Wi-Fi, open `http://<your-laptop-ip>:5173/login`, and sign in as a ward account. (Vite is already exposed on the network.)

### A 4-minute demo that shows the whole idea

1. **Today's problem.** On the manager dashboard, click **Make the board wrong (5 hidden, 3 phantom)**. Tick **Show where the board is wrong**. Eight beds get red outlines: the board and reality disagree. Hatched beds are the ones BedSense already doubts.
2. **Patients arrive.** Click **Add 5 patients**. Suggestions appear in the right column with reasons. Beds that are ready now have an **Approve** button. Doubted beds say "planned, free in ~10 min".
3. **It asks, only where it matters.** Within about 20 seconds the truth agent asks the relevant ward about a doubted bed. A `?` appears on the bed, and a message shows in the feed. On the phone (ICU or Medicine account) the question appears. Tap **Ready**. The red outline disappears, the bed turns confirmed, and an **Approve** button appears on the dashboard. If you have no phone, click **Auto-answer as nurse**.
4. **Approve.** Press Approve. The bed becomes reserved. If nobody had confirmed it recently, the ward gets a heads-up question. Answer **Not yet** and watch the assignment get revoked and the patient re-planned.
5. **Ward pause.** On the phone, tap **30 min** under "Busy? Pause new admissions". Routine patients are no longer given that ward's free beds. Critical patients still are.
6. **Stress.** Click **Crunch: 40 patients**. Everyone gets the best bed that obeys the rules, in about a second, and nothing breaks a rule.
7. **Type a note.** Paste `62 yr old female, COPD, on 4L O2. Admit under Medicine ward. No isolation`, click **Read note**, and show the quotes it extracted. Then paste `chest pain, admit medicine` and show that it **asks** for age and sex instead of guessing.

**The line to remember:** the best hospital scheduling algorithms assume the data is true. BedSense makes the data true, then allocates.

### If something doesn't work

| Symptom | Look at |
|---|---|
| Login returns 401 | Did you run `npm run seed`? |
| Board is empty | Seed not run, or the proxy in `vite.config.ts` points at the wrong port |
| No suggestions appear | Click **Re-plan now**. Check the server log for `ILP failed` or `RULE CHECKER REJECTED` |
| Suggestions say "no suitable bed" for everyone | Few beds are ready. Use **Reset**, or **Make the board wrong** to create hidden beds |
| No `?` badges / no questions | The truth agent only asks when a waiting patient could use a doubted bed. Add patients first. Lower `AGENT_EVERY_SEC` |
| Phone can't connect | Same Wi-Fi? Use the laptop's LAN address, not `localhost`. Check the firewall |
| Live updates not arriving | Check the browser console for socket errors. Polling still refreshes every 15 s |

---

## 8. API reference

All routes are under `/api` and need `Authorization: Bearer <token>` except login.

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/auth/login` | any | `{email, password}` → `{token, user}` |
| GET | `/wards` | any | List wards |
| GET | `/beds` | manager, ward | Beds with status, trust, `asking`, `mismatch` (a ward user sees only their ward) |
| POST | `/beds/:id/events` | manager, ward | `{type}`: `DISCHARGE_ORDERED`, `PATIENT_LEFT`, `CLEANED`, `BLOCKED`, `UNBLOCKED` |
| POST | `/beds/:id/hold` | manager | `{minutes}`: keep a bed free (what-if) |
| POST | `/requests/parse` | manager, requester | `{note}` → parsed needs with evidence, questions, assumptions |
| POST | `/requests` | manager, requester | Create a waiting request |
| GET | `/requests` | manager, requester | List (requesters see only their own) |
| POST | `/requests/:id/cancel` | manager, requester | Cancel; releases any reserved bed |
| POST | `/requests/:id/arrived` | manager | Patient arrived → bed becomes occupied |
| POST | `/plan/run` | manager | Run the planner now |
| GET | `/suggestions` | manager | Waiting patients with their suggested bed and reasons |
| POST | `/suggestions/:id/approve` | manager | Reserve the bed |
| POST | `/suggestions/:id/reject` | manager | `{reason?}`; the pair is not re-suggested for 2 hours |
| GET | `/ward/questions` | ward | Open questions for my ward |
| POST | `/questions/:id/answer` | ward | `{reply}` (`ready`/`not_yet`/`occupied`) or `{text}` |
| GET/POST/DELETE | `/ward/hold` | ward | Read / set `{minutes}` / clear the ward pause |
| GET | `/feed` | manager | Recent questions and answers |
| POST | `/demo/drift`, `/demo/burst`, `/demo/auto-nurse`, `/demo/reset` | manager | Demo tools (only when `DEMO_TOOLS` is not `off`) |

### Cost weights (all tunable assumptions)

| Cost | Value |
|---|---|
| No bed for a patient | 10,000 × urgency (dominates everything) |
| Waiting for a bed that is not ready yet | 2 per minute × urgency |
| Doubted bed that needs a check first | 250 |
| Bed not confirmed by a person recently | 30 |
| Another department's ward | 300 |
| Another room category | 200 |
| Isolation room used without need | 150 |
| Oxygen bed used without need | 40 |
| Different age group already in the room | 60, once per room |

They live in one object, `W` in `domain/scoring.ts`. Tune them with doctors and nurses; do not change them casually.

---

## 9. Known limits of this MVP

Be honest about these, and say them yourself before anyone asks.

- **Not tested in a real hospital.** The staleness limits (8 h, 90 min, 6 h, 2 h) and the ETAs (dirty about 45 min, discharging about 165 min) are assumptions, and they strongly affect behaviour.
- **Occupied beds never become "doubted".** A bed shown as occupied that is really empty will only be found through a ward action or a demo drift. A real build needs per-ward length-of-stay limits.
- **Age mixing between two *new* patients in the same empty room is not charged** (only against existing occupants). Sex mixing between them is fully enforced.
- **Nurse workload cost is not modelled.**
- **Event append and state update are two writes, not one transaction.** `rebuildState()` repairs any mismatch. Real transactions need MongoDB to run as a replica set.
- **Several approvals at once.** Approve uses an atomic claim on the suggestion and re-checks the bed, but there is no distributed lock.
- **One server process only.** The two `setInterval` jobs would run twice if you scaled to two instances. Add a lock first.
- **The socket is unauthenticated** by design (it carries topic names only), but anyone can see that *something* changed.
- **The solver blocks the event loop** while it runs (about a second at most).
- **The intake parser is rules-only.** It handles common English and Hinglish notes. Anything it cannot read becomes a question.
- **Passwords:** login is basic. No password reset, lockout or MFA.

---

## 10. Before a real pilot

- Replace `JWT_SECRET`; use HTTPS; set `DEMO_TOOLS=off`; never commit `.env`.
- Add rate limiting on `/auth/login`, a password policy, and lockout. Consider hospital SSO.
- Keep patient data minimal: bed labels and an internal request number only. No names or diagnoses in messages.
- Back up MongoDB. `bedevents` is your audit trail: never edit or delete from it.
- Add an audit view: who approved what, when, and the reasons shown at the time (already stored on `suggestions`).
- Get agreement on message volume with ward staff. The design target is a few questions per ward per shift (the staff interviews said 10 to 12 is acceptable).
- Start with **one ward for two weeks**: compare the board's status with what nurses confirm, and collect the missing numbers (discharge times, cleaning times).

---

## 11. What to build next

In rough priority order:

1. **WhatsApp adapter.** Put messaging behind an `IMessenger` interface (the ward page is adapter #1). Use the WhatsApp Business Cloud API with three buttons (Ready / Not yet / Occupied), each carrying the question id, and a webhook that calls the same `answerQuestion()`. Note the 24-hour customer-service window rules.
2. **Staleness for occupied beds**, with per-ward typical length of stay.
3. **Discharge chaser.** Remind the billing or scheme desk when a discharge step runs past its usual time.
4. **Referral agent.** If no suitable bed is expected within 2 hours, ask nearby hospitals and refer only when one confirms a bed.
5. **LLM-assisted intake** for messy notes. Keep the rule that every detail must quote the note; discard any answer whose quote is not in the note; if rules and LLM disagree, ask the doctor.
6. **Nurse workload cost** and **age mixing between new patients** in the optimiser.
7. **Stochastic simulator** with late and forgotten board updates (about 30 % forgotten at peak, and "shift change amnesia" around 14:00 and 21:00), so you can measure waits against today's method.
8. **Move the solver** to a worker thread, or swap it for Python OR-Tools CP-SAT behind the same `solveIlp` signature.
9. **Integration** with the hospital's existing software, so board events arrive automatically.
10. **MongoDB transactions** (replica set) for the event append and state update.
