# BedSense (Version 2)

Hospital bed management system built according to [BedSense-MVP-Builder-Guide.md](./BedSense-MVP-Builder-Guide.md).

## Quick Start

### 1. MongoDB
MongoDB is running locally on port 27017 (`mongodb://localhost:27017/bedsense-ver-2`).

### 2. Start the Backend Server
```bash
cd server
npm run dev
# Running on http://localhost:4000
```

To re-seed demo data at any time:
```bash
cd server
npm run seed
```

To run unit tests:
```bash
cd server
npm run test
# 31 passed
```

### 3. Start the Web Frontend
```bash
cd web
npm run dev
# Running on http://localhost:5173
```

## Demo Logins
All accounts use the password: `bedsense123`

| Role | Email | Screen |
|---|---|---|
| **Bed Manager** | `manager@bedsense.test` | Bed Manager Dashboard |
| **Requester (Doctor)** | `doctor@bedsense.test` | Admission Requests Page |
| **ICU Ward Phone** | `icu@bedsense.test` | Ward Mobile Interface |
| **Medicine Ward Phone** | `med@bedsense.test` | Ward Mobile Interface |
| **Surgery Ward Phone** | `sur@bedsense.test` | Ward Mobile Interface |
| **Paediatrics Ward Phone** | `ped@bedsense.test` | Ward Mobile Interface |
