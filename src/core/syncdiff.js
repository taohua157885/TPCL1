// 云同步「对比」：列出本地/远端差异，不改任何文件
import fs from 'node:fs';
import path from 'node:path';

import { listWorlds, savesDir } from './backup.js';
import { listRemote, syncDir } from './sync.js';

const latestByWorld = (files) => {
  const m = new Map();
  for (const f of files) {
    const cur = m.get(f.world);
    if (!cur || (f.mtime || 0) > (cur.mtime || 0)) m.set(f.world, f);
  }
  return m;
};

/** 返回 { ok, syncDir, version, onlyLocal, onlyRemote, newerLocal, newerRemote, same } */
export async function diffSync(versionId) {
  const root = syncDir();
  if (!root) return { ok: false, error: '还没设置同步目录' };
  const local = listWorlds(versionId) || [];
  const remote = (await listRemote(versionId)).files || [];
  const remoteLatest = latestByWorld(remote);

  const localByName = new Map(local.map((w) => [w.name, w]));

  const onlyLocal = [];
  const onlyRemote = [];
  const newerLocal = [];
  const newerRemote = [];
  let same = 0;

  for (const w of local) {
    const r = remoteLatest.get(w.name);
    if (!r) { onlyLocal.push({ name: w.name, mtime: w.mtime, size: w.size }); continue; }
    // 世界目录 mtime 与远端 zip mtime 直接比：远端是打包时刻，本地是最后写入时刻
    const dt = (w.mtime || 0) - (r.mtime || 0);
    if (dt > 90 * 1000) newerLocal.push({ name: w.name, mtime: w.mtime, remoteMtime: r.mtime, deltaMs: dt });
    else if (dt < -90 * 1000) newerRemote.push({ name: w.name, mtime: w.mtime, remoteMtime: r.mtime, deltaMs: dt, file: r.file });
    else same += 1;
  }
  for (const [name, r] of remoteLatest) {
    if (!localByName.has(name)) onlyRemote.push({ name, stamp: r.stamp, mtime: r.mtime, size: r.size, file: r.file });
  }

  return {
    ok: true,
    syncDir: root,
    version: versionId,
    savesDir: savesDir(versionId),
    counts: { local: local.length, remote: remoteLatest.size, onlyLocal: onlyLocal.length, onlyRemote: onlyRemote.length, newerLocal: newerLocal.length, newerRemote: newerRemote.length, same },
    onlyLocal, onlyRemote, newerLocal, newerRemote,
    at: Date.now(),
  };
}
