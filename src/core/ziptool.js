import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * 纯 Node 的 zip 读写工具。
 * 存在的理由：Windows 自带 bsdtar 读 GBK 文件名的 zip 会解成乱码 `[Iron?ķ???ħ????]`，
 * 而且没法按名字提取（名字对不上），所以整合包导入必须自己解析 zip。
 * - 文件名：未置 UTF-8 标志位（0x800）时先试 UTF-8，出现替换字符就按 GBK 解
 * - 压缩方式：0=store / 8=deflate（整合包里不会出现别的）
 * - zip64：支持 EOCD64 + 0x0001 扩展字段
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CD = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function decodeName(buf, flags) {
  const utf8 = () => new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (flags & 0x800) return utf8();
  const u = utf8();
  if (!u.includes('\uFFFD')) return u;
  try {
    return new TextDecoder('gbk', { fatal: false }).decode(buf);
  } catch {
    return u;
  }
}

class ZipReader {
  constructor(file) {
    this.file = file;
    this.fd = null;
    this.size = 0;
  }

  async open() {
    this.fd = await fs.promises.open(this.file, 'r');
    this.size = (await this.fd.stat()).size;
    return this;
  }

  async close() {
    try { await this.fd?.close(); } catch {}
    this.fd = null;
  }

  async read(offset, length) {
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.fd.read(buf, 0, length, offset);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  }

  /** 找 EOCD，返回 { count, cdSize, cdOffset } */
  async endRecord() {
    const tailLen = Math.min(this.size, 66 * 1024);
    const tail = await this.read(this.size - tailLen, tailLen);
    let idx = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { idx = i; break; }
    }
    if (idx < 0) throw new Error('不是有效的 zip（找不到 EOCD）');
    let count = tail.readUInt16LE(idx + 10);
    let cdSize = tail.readUInt32LE(idx + 12);
    let cdOffset = tail.readUInt32LE(idx + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // The ZIP64 locator occupies the 20 bytes immediately before the EOCD.
      const locator = await this.read(this.size - tailLen + idx - 20, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50) throw new Error('zip64 定位记录损坏');
      const locOff = Number(locator.readBigUInt64LE(8));
      const rec = await this.read(locOff, 56);
      if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new Error('zip64 记录损坏');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }
    return { count, cdSize, cdOffset };
  }

  async entries() {
    const { count, cdSize, cdOffset } = await this.endRecord();
    const cd = await this.read(cdOffset, cdSize);
    const list = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== SIG_CD) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        let e = 0;
        while (e + 4 <= extra.length) {
          const id = extra.readUInt16LE(e);
          const len = extra.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (uncompSize === 0xffffffff && q + 8 <= e + 4 + len) { uncompSize = Number(extra.readBigUInt64LE(q)); q += 8; }
            if (compSize === 0xffffffff && q + 8 <= e + 4 + len) { compSize = Number(extra.readBigUInt64LE(q)); q += 8; }
            if (localOffset === 0xffffffff && q + 8 <= e + 4 + len) { localOffset = Number(extra.readBigUInt64LE(q)); q += 8; }
            break;
          }
          e += 4 + len;
        }
      }
      const raw = decodeName(nameBuf, flags);
      const name = raw.replace(/\\/g, '/').replace(/^\.\//, '');
      list.push({ name, flags, method, compSize, uncompSize, localOffset, dir: name.endsWith('/') || compSize === 0 && /\/$/.test(raw) });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return list;
  }

  async readEntryData(entry) {
    const head = await this.read(entry.localOffset, 30);
    if (head.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`条目头损坏：${entry.name}`);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const start = entry.localOffset + 30 + nameLen + extraLen;
    if (entry.compSize === 0) return Buffer.alloc(0);
    const data = await this.read(start, entry.compSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
  }
}

/** 列目录（名字已正确解码） */
export async function listEntries(file) {
  const z = await new ZipReader(file).open();
  try {
    return await z.entries();
  } finally {
    await z.close();
  }
}

/** 读单个成员为原始字节（找不到返回 null） */
export async function readEntry(file, name) {
  const z = await new ZipReader(file).open();
  try {
    const list = await z.entries();
    const want = String(name).replace(/\\/g, '/').replace(/^\.\//, '');
    const hit = list.find((e) => e.name === want) ?? list.find((e) => e.name.toLowerCase() === want.toLowerCase());
    if (!hit) return null;
    return await z.readEntryData(hit);
  } finally {
    await z.close();
  }
}

/** 是否存在某个成员 */
export async function hasEntry(file, name) {
  const list = await listEntries(file);
  const want = String(name).replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return list.some((e) => e.name.toLowerCase() === want);
}

/** 读单个成员为文本 */
export async function readText(file, name) {
  const z = await new ZipReader(file).open();
  try {
    const list = await z.entries();
    const want = String(name).replace(/\\/g, '/').replace(/^\.\//, '');
    const hit = list.find((e) => e.name === want) ?? list.find((e) => e.name.toLowerCase() === want.toLowerCase());
    if (!hit) throw new Error(`压缩包里没有 ${want}`);
    const buf = await z.readEntryData(hit);
    return buf.toString('utf8');
  } finally {
    await z.close();
  }
}

/**
 * 解压。
 * opts.prefix：只解这个前缀下的条目，并去掉该前缀（'overrides/' → 直接铺到目标根部）
 * opts.filter：自定义 (entry) => boolean
 * opts.bare：为 true 时不带前缀也解（默认解全部）
 */
export async function extract(file, destRoot, opts = {}) {
  const z = await new ZipReader(file).open();
  let n = 0;
  try {
    const list = await z.entries();
    for (const entry of list) {
      if (entry.dir) continue;
      let rel = entry.name;
      if (opts.prefix) {
        if (!rel.toLowerCase().startsWith(opts.prefix.toLowerCase())) continue;
        rel = rel.slice(opts.prefix.length);
      }
      if (!rel || rel.endsWith('/')) continue;
      if (opts.filter && !opts.filter(entry, rel)) continue;
      const to = path.join(destRoot, rel);
      if (!path.resolve(to).startsWith(path.resolve(destRoot) + path.sep)) throw Error('压缩包成员超出目标目录'); // 防目录穿越
      await fs.promises.mkdir(path.dirname(to), { recursive: true });
      const buf = await z.readEntryData(entry);
      try {
        await fs.promises.writeFile(to, buf, { flag: opts.keepExisting ? 'wx' : 'w' });
      } catch (error) {
        if (!opts.keepExisting || error.code !== 'EEXIST') throw error;
      }
      n += 1;
      if (opts.onFile && n % 50 === 0) opts.onFile(n, entry.name);
    }
    return n;
  } finally {
    await z.close();
  }
}
