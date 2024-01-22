import * as dotenv from 'dotenv';
import { pino } from 'pino';
import { isMainThread, workerData } from 'worker_threads';
import { config } from './config.js';
dotenv.config();

const transport = pino.transport({
  target: 'pino-pretty',
  options: { destination: 1 },
});

const baseLogger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
  },
  transport,
);

export const logger = isMainThread ? baseLogger.child({ name: config.get('bot_name') }) : baseLogger.child({ name: `worker-${workerData.workerId}` })