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
