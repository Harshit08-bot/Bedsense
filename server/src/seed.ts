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
