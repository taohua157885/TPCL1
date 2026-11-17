import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';

export const REPORT_DIR = path.join(DATA_DIR, 'error-reports');
process.on('uncaughtExceptionMonitor', (error, origin) => writeErrorReport(error, { source: 'process', origin }));
export function redact(value) {
  return String(value)
    .replace(/((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|api[_-]?key|device[_-]?code|token)\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'&}]+/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[^\s,"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[REDACTED]');
}
export function writeErrorReport(error, context = {}) {
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
    const report = { time: new Date().toISOString(), runtime: process.version, platform: `${os.platform()} ${os.release()} ${os.arch()}`, error: { name: error?.name || 'Error', message: String(error?.message || error), stack: error?.stack || '' }, context };
    fs.writeFileSync(path.join(REPORT_DIR, id), JSON.stringify(sanitizeReport(report), null, 2), { encoding: 'utf8', flag: 'wx' });
    return id;
  } catch (e) { console.error('[TPCL] 无法保存错误报告:', e.message); return null; }
}

// Sanitize values before serialization so quotes, backslashes and multiline
// errors cannot leave invalid JSON or partially exposed structured credentials.
export function sanitizeReport(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redact(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const result = Array.isArray(value) ? value.map(v => sanitizeReport(v, seen))
    : Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
      /token|password|secret|authorization|cookie|api[_-]?key|device[_-]?code/i.test(key)
        ? '[REDACTED]' : sanitizeReport(v, seen)]));
  seen.delete(value);
  return result;
}
