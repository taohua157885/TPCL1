/**
 * Minecraft 的 log4j 配置有两种输出风格：
 *   1. 普通 PatternLayout —— 一行一条人类可读日志
 *   2. XMLLayout —— 一堆 <log4j:Event>/<log4j:Message><![CDATA[...]]></log4j:Message> 标签
 *
 * 新版（26.x）默认走 XML，直接把标签原样显示到日志面板里非常难看。
 * 这里把 XML 事件流折叠回一行一条：
 *
 *   [19:41:02] [Render thread/INFO] [TextureAtlas]: Created: 2048x2048x4 ...
 */

const EVENT_RE = /<log4j:Event\b([^>]*)>/;
const MSG_CDATA_RE = /<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/;
const MSG_PLAIN_RE = /<log4j:Message>([\s\S]*?)<\/log4j:Message>/;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

const SKIP_RE = /^(<\?xml[^>]*\?>|<\/log4j:Event>|<\/log4j:Log4j>|<log4j:Log4j[^>]*>)$/;

function attrs(str) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(str)) !== null) out[m[1]] = m[2];
  return out;
}

function hhmmss(timestamp, fallback) {
  const n = Number(timestamp);
  const d = Number.isFinite(n) && n > 0 ? new Date(n) : fallback;
  if (!d || Number.isNaN(d.getTime())) return '--:--:--';
  const p = (v) => String(v).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shortLogger(name) {
  if (!name) return '';
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1) : name;
}

export function createLogCleaner() {
  let pending = null; // 最近一个还没输出消息的 log4j:Event
  let inThrowable = false; // 正在读 <log4j:Throwable><![CDATA[ ... ]]></log4j:Throwable>

  return {
    /**
     * 喂一行原始输出。
     * @returns {{text: string, level: string} | null} null 表示这一行被折叠掉了
     */
    push(rawLine) {
      const line = rawLine.replace(/\r$/, '');
      const t = line.trim();

      // Throwable 块是多行的：开头 <log4j:Throwable><![CDATA[ ，结尾 ]]></log4j:Throwable>
      if (inThrowable) {
        const ends = t.includes(']]></log4j:Throwable>') || t === ']]>' || t.includes(']]>');
        const body = t.replace(/\]\]><\/log4j:Throwable>?$/, '').replace(/^\]\]>/, '').replace(/^\]\]/, '');
        if (ends) inThrowable = false;
        if (!body.trim()) return null;
        return { text: body, level: 'error' };
      }
      if (t.startsWith('<log4j:Throwable>')) {
        inThrowable = true;
        const rest = t
          .replace(/^<log4j:Throwable>/, '')
          .replace(/<!\[CDATA\[/, '')
          .replace(/\]\]><\/log4j:Throwable>$/, '')
          .replace(/<\/log4j:Throwable>$/, '');
        if (/<\/log4j:Throwable>/.test(t)) inThrowable = false;
        return rest.trim() ? { text: rest, level: 'error' } : null;
      }

      if (!t) return null;
      if (SKIP_RE.test(t)) return null;

      const ev = EVENT_RE.exec(t);
      if (ev) {
        const a = attrs(ev[1]);
        pending = { timestamp: a.timestamp, level: a.level, thread: a.thread, logger: a.logger };
        // 同一行里可能紧跟着 Message（XMLLayout 偶尔不换行）
        const rest = t.slice(ev.index + ev[0].length);
        const inline = MSG_CDATA_RE.exec(rest) ?? MSG_PLAIN_RE.exec(rest);
        if (!inline) return null;
        return this.push(`<log4j:Message>${inline[1]}</log4j:Message>`);
      }

      const msg = MSG_CDATA_RE.exec(t) ?? MSG_PLAIN_RE.exec(t);
      if (msg) {
        const p = pending ?? {};
        const time = hhmmss(p.timestamp, new Date());
        const thread = p.thread || 'main';
        const level = (p.level || 'INFO').toUpperCase();
        const logger = shortLogger(p.logger);
        const head = logger ? `${time} [${thread}/${level}] [${logger}]: ` : `${time} [${thread}/${level}]: `;
        const text = msg[1].replace(/\s+$/, '');
        const out = [];
        for (const seg of text.split('\n')) out.push(head + seg);
        pending = null;
        return { text: out.join('\n'), level: level === 'ERROR' || level === 'FATAL' ? 'error' : 'stdout' };
      }

      if (t.startsWith('<log4j:Throwable>')) {
        const inner = t.replace(/^<log4j:Throwable>/, '').replace(/<\/log4j:Throwable>$/, '');
        return { text: inner, level: 'error' };
      }

      // 普通布局，或者别的东西，原样透出（顺手剥掉残留的 CDATA 包装）
      const clean = line.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
      const isErr = /^\s*(ERROR|FATAL|Exception|Caused by|\s+at )/.test(clean);
      return { text: clean, level: isErr ? 'error' : 'stdout' };
    },
  };
}
