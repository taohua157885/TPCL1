// 显卡偏好：给 java.exe 写 Windows 的「高性能 GPU」偏好（HKCU，无需管理员）
// 背景：这台机器的整合包崩溃是 Intel 核显驱动 igxelpicd64.dll 里的 0xC0000005，
// 让 java 走独显是最直接的修法。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';

const reg = (args) => {
  try {
    const out = execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || e.message) };
  }
};

/** 读当前 java.exe 的 GPU 偏好：'high' | 'power' | null */
export function getGpuPreference(javaPath) {
  if (!javaPath) return null;
  const r = reg(['query', KEY, '/v', javaPath]);
  if (!r.ok) return null;
  const m = r.out.match(/GpuPreference=(\d+)/);
  if (!m) return null;
  const v = Number(m[1]);
  if (v === 2) return 'high';
  if (v === 1) return 'power';
  return null;
}

/** 设置/清除 java.exe 的 GPU 偏好 */
export function setGpuPreference(javaPath, high) {
  if (!javaPath) return { ok: false, error: '没有 Java 路径' };
  if (!fs.existsSync(javaPath)) return { ok: false, error: 'Java 不存在：' + javaPath };
  if (high) {
    const r = reg(['add', KEY, '/v', javaPath, '/t', 'REG_SZ', '/d', 'GpuPreference=2;', '/f']);
    return { ok: r.ok, value: 'high', error: r.ok ? undefined : r.out.slice(0, 200) };
  }
  const r = reg(['delete', KEY, '/v', javaPath, '/f']);
  return { ok: true, value: null, note: r.ok ? undefined : '原本没有这一项' };
}

/** 列出显卡（名字 + 驱动版本）；失败返回空数组 */
export function listGpus() {
  try {
    const ps = [
      '-NoProfile', '-Command',
      'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.DriverVersion)" }',
    ];
    const out = execFileSync('powershell', ps, { encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 15000 });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, driver] = l.split('|');
        return { name: name || '', driver: driver || '' };
      })
      .filter((g) => g.name);
  } catch {
    return [];
  }
}

/** 判断某个显卡名是不是独显（用来给 UI 提一句） */
export function looksDiscrete(name) {
  const n = String(name || '').toLowerCase();
  if (/intel|uhd|iris|radeon\(tm\) graphics|vega \d+ graphics|microsoft basic/.test(n)) return false;
  return /nvidia|geforce|rtx|gtx|radeon rx|arc a\d|quadro|mx\d{3}/.test(n) || /amd|nvidia/.test(n);
}
