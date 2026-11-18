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
