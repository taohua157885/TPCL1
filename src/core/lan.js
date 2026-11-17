// 局域网 Minecraft 发现：监听 224.0.2.60:4445 的 [MOTD]...[/MOTD][AD]port[/AD]
// 单机开房间时，游戏会周期性广播自己的世界名和端口，这里只被动收，不改任何东西。
import dgram from 'node:dgram';

const GROUP = '224.0.2.60';
const PORT = 4445;
const TTL_MS = 8000; // 超过这么久没再广播就算下线
const MAX = 32;

/** addr:port -> { key, host, port, motd, lastSeen } */
const seen = new Map();
let sock = null;
let started = false;
let lastError = null;

function parse(buf) {
  const text = buf.toString('utf8');
  const motd = text.match(/\[MOTD\]([\s\S]*?)\[\/MOTD\]/)?.[1] ?? '';
  const ad = text.match(/\[AD\](\d+)\[\/AD\]/)?.[1];
  return { motd: motd.trim(), port: ad ? Number(ad) : null };
}

export function startLanWatcher() {
  if (started) return { ok: true, already: true };
  started = true;
  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => {
      lastError = e.message;
      try { sock.close(); } catch { /* ignore */ }
      sock = null;
      started = false;
    });
    sock.on('message', (msg, rinfo) => {
      const { motd, port } = parse(msg);
      if (!port) return;
      const key = `${rinfo.address}:${port}`;
      seen.set(key, { key, host: rinfo.address, port, motd, lastSeen: Date.now() });
      // 简单上限，避免异常环境里无限增长
      if (seen.size > MAX) {
        const oldest = [...seen.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        if (oldest) seen.delete(oldest.key);
      }
    });
    sock.bind(PORT, () => {
      try { sock.addMembership(GROUP); } catch (e) { lastError = e.message; }
      try { sock.setBroadcast(true); } catch { /* ignore */ }
    });
    return { ok: true };
  } catch (e) {
    lastError = e.message;
    started = false;
    return { ok: false, error: e.message };
  }
}

export function listLan() {
  const now = Date.now();
  for (const [k, v] of seen) if (now - v.lastSeen > TTL_MS) seen.delete(k);
  const items = [...seen.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map((v) => ({ ...v, ago: Math.round((now - v.lastSeen) / 1000) }));
  return { watching: Boolean(sock), error: lastError, items };
}

export function stopLanWatcher() {
  try { sock?.close(); } catch { /* ignore */ }
  sock = null;
  started = false;
  seen.clear();
}
