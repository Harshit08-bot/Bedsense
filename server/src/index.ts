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
