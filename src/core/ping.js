// 服务器列表 ping（Server List Ping / SLP）
// 协议：握手包(protocol=-1, nextState=1) → status request → length-prefixed JSON
// 支持 SRV 记录、favicon、MOTD 颜色分段、延迟取样。零依赖。
import net from 'node:net';
import dns from 'node:dns/promises';

const DEFAULT_PORT = 25565;

/* ---------------- varint ---------------- */
function writeVarInt(n) {
  const bytes = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos];
    result |= (b & 0x7f) << shift;
    pos += 1;
    if ((b & 0x80) === 0) return { value: result >>> 0, offset: pos };
    shift += 7;
    if (shift > 35) throw new Error('varint 过长');
  }
  return null; // 数据还不够
}

function varintLen(n) {
  return writeVarInt(n).length;
}

function packString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}

/* ---------------- MOTD 解析 ---------------- */
const COLOR_HEX = {
  black: '#000000', dark_blue: '#0000aa', dark_green: '#00aa00', dark_aqua: '#00aaaa',
  dark_red: '#aa0000', dark_purple: '#aa00aa', gold: '#ffaa00', gray: '#aaaaaa',
  dark_gray: '#555555', blue: '#5555ff', green: '#55ff55', aqua: '#55ffff',
  red: '#ff5555', light_purple: '#ff55ff', yellow: '#ffff55', white: '#ffffff',
};

// 把 chat component 展平成 [{text, color, bold}]，同时给纯文本
function flattenMotd(node, inherited = {}, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') {
    if (node) out.push({ text: node, ...inherited });
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) flattenMotd(n, inherited, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const style = { ...inherited };
  if (node.color) style.color = COLOR_HEX[node.color] ?? node.color;
  if (node.bold != null) style.bold = !!node.bold;
  if (node.italic != null) style.italic = !!node.italic;
  if (node.obfuscated != null) style.obfuscated = !!node.obfuscated;
  if (node.text) out.push({ text: String(node.text), ...style });
  if (node.extra) flattenMotd(node.extra, style, out);
  return out;
}

// 老式 § 代码：切成 runs
function legacyToRuns(text) {
  const nameToHex = {
    '0': '#000000', '1': '#0000aa', '2': '#00aa00', '3': '#00aaaa', '4': '#aa0000',
    '5': '#aa00aa', '6': '#ffaa00', '7': '#aaaaaa', '8': '#555555', '9': '#5555ff',
    a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff',
  };
  const runs = [];
  let color = null;
  let bold = false;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '§' && i + 1 < text.length) {
      if (buf) { runs.push({ text: buf, color, bold }); buf = ''; }
      const code = text[i + 1].toLowerCase();
      if (code === 'l') bold = true;
      else if (code === 'r') { color = null; bold = false; }
      else if (nameToHex[code]) { color = nameToHex[code]; bold = false; }
      i += 1;
      continue;
    }
    buf += ch;
  }
  if (buf) runs.push({ text: buf, color, bold });
  return runs;
}

function motdOf(desc) {
  if (desc == null) return { text: '', runs: [] };
  if (typeof desc === 'string') {
    const runs = legacyToRuns(desc);
    return { text: runs.map((r) => r.text).join(''), runs };
  }
  const runs = flattenMotd(desc, {}, []);
  // 展平后仍可能带 § 代码（少见）
  const flat = [];
  for (const r of runs) {
    if (r.text.includes('§')) {
      for (const s of legacyToRuns(r.text)) flat.push({ ...s, color: s.color ?? r.color, bold: s.bold || r.bold });
    } else flat.push(r);
  }
  return { text: flat.map((r) => r.text).join(''), runs: flat.slice(0, 40) };
}

/* ---------------- SRV ---------------- */
async function resolveTarget(host, port) {
  if (port) return { host, port: Number(port), via: 'direct' };
  try {
    const recs = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (recs?.length) {
      const best = recs.sort((a, b) => a.priority - b.priority)[0];
      return { host: best.name, port: best.port, via: 'srv' };
    }
  } catch {
    /* 没有 SRV 记录是常态 */
  }
  return { host, port: DEFAULT_PORT, via: 'default' };
}

/* ---------------- 单次 ping ---------------- */
function pingOnce(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    let chunks = Buffer.alloc(0);
    const socket = net.createConnection({ host, port });

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(value);
    };

    const timer = setTimeout(() => done(new Error('连接超时')), timeoutMs);
    socket.on('error', (e) => done(e));
    socket.on('close', () => { if (!settled) done(new Error('服务器关闭了连接')); });

    socket.on('connect', () => {
      const hostBuf = packString(host);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      const protoBuf = writeVarInt(0xffffffff); // protocol -1，表示只要状态
      const body = Buffer.concat([
        Buffer.from([0x00]), // packet id 0x00 = handshake
        protoBuf,
        hostBuf,
        portBuf,
        Buffer.from([0x01]), // next state = status
      ]);
      socket.write(Buffer.concat([writeVarInt(body.length), body]));
      // status request：长度 1 + packet id 0x00
      socket.write(Buffer.from([0x01, 0x00]));
    });

    socket.on('data', (d) => {
      chunks = Buffer.concat([chunks, d]);
      try {
        const len = readVarInt(chunks, 0);
        if (!len) return;
        if (chunks.length < len.offset + len.value) return;
        let pos = len.offset;
        const pid = readVarInt(chunks, pos);
        if (!pid) return;
        pos = pid.offset;
        const slen = readVarInt(chunks, pos);
        if (!slen) return;
        pos = slen.offset;
        const json = chunks.subarray(pos, pos + slen.value).toString('utf8');
        const data = JSON.parse(json);
        done(null, { data, latency: Date.now() - started });
      } catch (e) {
        done(new Error('响应解析失败：' + e.message));
      }
    });
  });
}

/**
 * ping 一个服务器，最多试 3 次取最小延迟。
 * @param {{host:string, port?:number, timeoutMs?:number}} opts
 */
export async function pingServer({ host, port, timeoutMs = 5000 } = {}) {
  if (!host) return { online: false, host, error: '没有填地址' };
  const hostClean = String(host).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const target = await resolveTarget(hostClean, port);

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data, latency } = await pingOnce(target.host, target.port, timeoutMs);
      const motd = motdOf(data.description);
      return {
        online: true,
        host: hostClean,
        resolvedHost: target.host,
        port: target.port,
        via: target.via,
        latency,
        version: { name: data.version?.name ?? '', protocol: data.version?.protocol ?? null },
        players: {
          online: data.players?.online ?? 0,
          max: data.players?.max ?? 0,
          sample: (data.players?.sample ?? []).slice(0, 12).map((p) => p.name),
        },
        motd: motd.text,
        motdRuns: motd.runs,
        favicon: typeof data.favicon === 'string' && data.favicon.startsWith('data:image') ? data.favicon : null,
      };
    } catch (e) {
      lastErr = e;
      const code = e?.code;
      // 地址解析不了就没必要重试
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') break;
    }
  }

  const code = lastErr?.code;
  const reason =
    code === 'ENOTFOUND' ? '域名解析失败'
      : code === 'ECONNREFUSED' ? '服务器拒绝连接（可能没开或端口不对）'
        : code === 'ETIMEDOUT' || lastErr?.message === '连接超时' ? '连接超时'
          : code === 'ECONNRESET' ? '连接被重置'
            : lastErr?.message || '未知错误';
  return { online: false, host: hostClean, port: target.port, via: target.via, error: reason };
}

/** 并行 ping 一批服务器 */
export async function pingAll(list, concurrency = 6) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      const s = list[idx];
      try {
        out[idx] = { ...(await pingServer({ host: s.host, port: s.port, timeoutMs: s.timeoutMs ?? 5000 })), id: s.id };
      } catch (e) {
        out[idx] = { id: s.id, host: s.host, online: false, error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return out.filter(Boolean);
}
