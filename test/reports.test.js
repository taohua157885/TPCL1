import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('reports retain exception stack and redact credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tpcl-report-test-'));
  process.env.TPCL_DATA_DIR = dir;
  try {
    const { writeErrorReport, REPORT_DIR, sanitizeReport } = await import('../src/core/reports.js');
    const complex = { accessToken: 'secret with spaces and "quotes"', nested: { cookie: 'a=b; c=d' } };
    complex.self = complex;
    const safe = JSON.parse(JSON.stringify(sanitizeReport(complex)));
    assert.equal(safe.accessToken, '[REDACTED]');
    assert.equal(safe.nested.cookie, '[REDACTED]');
    assert.equal(safe.self, '[Circular]');
    const id = writeErrorReport(new Error('access_token=topsecret Authorization: Bearer hidden'), { refreshToken: 'refreshsecret', password: 'passwordsecret', token: 'ghp_123456789' });
    const raw = fs.readFileSync(path.join(REPORT_DIR, id), 'utf8');
    const report = JSON.parse(raw);
    assert.match(report.error.stack, /reports.test.js/);
    for (const secret of ['topsecret', 'hidden', 'refreshsecret', 'passwordsecret', 'ghp_123456789']) assert.ok(!raw.includes(secret), secret);
    assert.ok(raw.includes('[REDACTED]'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
