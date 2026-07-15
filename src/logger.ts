import { Writable } from 'node:stream';
import pino, { multistream } from 'pino';
import { logBuffer, type LogEntry } from './observability/buffers.js';

const bufferStream = new Writable({
  write(chunk, _encoding, callback) {
    try {
      const line = String(chunk).trim();
      if (line.length > 0) {
        const parsed = JSON.parse(line) as {
          time?: string;
          level?: number | string;
          msg?: string;
          [key: string]: unknown;
        };
        const levelMap: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
        const level = typeof parsed.level === 'number' ? levelMap[parsed.level] ?? String(parsed.level) : String(parsed.level ?? 'info');
        const { time: _t, level: _l, msg: _m, pid: _p, hostname: _h, ...extra } = parsed;
        const entry: Omit<LogEntry, 'seq'> = {
          time: parsed.time ?? new Date().toISOString(),
          level,
          msg: parsed.msg ?? '',
        };
        if (Object.keys(extra).length > 0) entry.extra = extra;
        logBuffer.push(entry);
      }
    } catch {
      /* ignore non-json */
    }
    callback();
  },
});

export const createLogger = (level = 'info') => pino({
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.x-api-key', 'apiKey'],
    censor: '[REDACTED]',
  },
}, multistream([
  { level, stream: process.stdout },
  { level, stream: bufferStream },
]));

export const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
export type Logger = ReturnType<typeof createLogger>;
