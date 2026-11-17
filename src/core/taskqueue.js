import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// One installation at a time: installers share libraries and .part files.
export class TaskQueue {
  constructor({ report = () => null, limit = 200, file = null, resolveRun = null } = {}) {
    this.tasks = new Map();
    this.report = report;
    this.limit = limit;
    this.running = false;
    this.file = file;
    this.resolveRun = resolveRun;
    this.restore();
  }
  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const rows = [...this.tasks.values()].map(({ run, key, ...t }) => t);
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ schema: 1, tasks: rows }), 'utf8');
    fs.renameSync(this.file + '.tmp', this.file);
  }
  checkpoint() {
    try { this.persist(); } catch (error) {
      try { this.report(error, { source: 'queue-save' }); } catch {}
    }
  }
  restore() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.schema !== 1 || !Array.isArray(data.tasks)) throw new Error('任务记录格式不正确');
      for (const row of data.tasks.slice(-this.limit)) {
        if (!row || typeof row.id !== 'string' || !row.input) continue;
        const t = { ...row, key: JSON.stringify(row.input) };
        // Never restart installers implicitly after an unclean shutdown.
        if (!t.done) Object.assign(t, { done: true, status: 'interrupted', stage: '上次未完成，点击继续', error: null });
        this.tasks.set(t.id, t);
      }
    } catch (error) { try { this.report(error, { source: 'queue-restore' }); } catch {} }
  }
  add(label, input, run) {
    const key = JSON.stringify(input);
    const existing = [...this.tasks.values()].find(t => !t.done && t.key === key);
    if (existing) return this.view(existing);
    if ([...this.tasks.values()].filter(t => !t.done).length >= this.limit) throw new Error('等待任务过多，请稍后再添加');
    const t = { id: randomUUID(), label, input, key, run, status: 'queued', stage: '等待下载', percent: 0, startedAt: Date.now(), done: false, error: null };
    this.tasks.set(t.id, t);
    this.trim();
    try { this.persist(); } catch (error) { this.tasks.delete(t.id); throw error; }
    queueMicrotask(() => this.drain());
    return this.view(t);
  }
  view(t) {
    const { run, key, ...data } = t;
    return { ...data, position: t.status === 'queued' ? [...this.tasks.values()].filter(x => x.status === 'queued').findIndex(x => x.id === t.id) + 1 : 0 };
  }
  list() { return [...this.tasks.values()].map(t => this.view(t)); }
  cancel(id) {
    const t = this.tasks.get(id);
    if (!t || !['queued', 'interrupted'].includes(t.status)) return false;
    Object.assign(t, { status: 'cancelled', done: true, stage: '已取消', finishedAt: Date.now() });
    this.checkpoint();
    return true;
  }
  retry(id) {
    const t = this.tasks.get(id);
    if (!t || !['failed', 'cancelled', 'interrupted'].includes(t.status)) throw new Error('此任务无法重试');
    const run = this.resolveRun ? this.resolveRun(t.input) : t.run;
    if (typeof run !== 'function') throw new Error('无法恢复此任务，请重新添加');
    return this.add(t.label, t.input, run);
  }
  clear() { for (const [id, t] of this.tasks) if (t.done && t.status !== 'interrupted') this.tasks.delete(id); this.checkpoint(); }
  trim() {
    for (const [id, t] of this.tasks) {
      if (this.tasks.size <= this.limit) break;
      if (t.done) this.tasks.delete(id);
    }
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const t = [...this.tasks.values()].find(t => t.status === 'queued');
        if (!t) break;
        Object.assign(t, { status: 'running', stage: '准备中', runningAt: Date.now() });
        this.checkpoint();
        try {
          const result = await t.run(e => {
            t.stage = String(e?.text || e?.stage || '处理中');
            if (Number.isFinite(e?.percent)) t.percent = Math.max(0, Math.min(100, Math.round(e.percent)));
          });
          if (result?.ok === false || result?.failed?.length) throw new Error(result.error || (result.failed?.length ? `${result.failed.length} 个文件下载失败，请重试` : '任务执行失败，请重试'));
          Object.assign(t, { result, status: 'completed', percent: 100, stage: '已完成' });
        } catch (error) {
          Object.assign(t, { status: 'failed', error: String(error.message || error), stage: '失败' });
          try { t.report = this.report(error, { task: t.label, input: t.input }); } catch { /* Reporting must not block the queue. */ }
        } finally {
          t.done = true;
          t.finishedAt = Date.now();
          this.checkpoint();
        }
      }
    } finally { this.running = false; }
  }
}
