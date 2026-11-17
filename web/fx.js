/**
 * 赛博朋克交互层
 *  1) 音效：全部 WebAudio 实时合成，零素材。设计目标是"清脆"——
 *     只用正弦/三角波的高频短音，噪声只做 8ms 的气口，低频一概不碰。
 *  2) 语音：点模块时用系统语音合成播报一句女声机械音（pitch 调高、语速略快，
 *     播报前先"嘀"一声，听感更像终端在应答）。
 */

/* ------------------------------------------------------------ 音频引擎 */
let ac = null;
let master = null;
let enabled = true;

function ctx() {
  if (!ac) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ac = new C();
    master = ac.createGain();
    master.gain.value = 0.5;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 6;
    master.connect(comp).connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

/** 一个指数扫频的短音 */
function tone({ type = 'sine', from, to, dur = 0.05, gain = 0.06, when = 0 }) {
  const a = ctx();
  if (!a) return;
  const t0 = a.currentTime + when;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to && to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  // 10ms 起音 + 指数收尾，避免爆音
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + Math.min(0.008, dur * 0.3));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.01);
}

/** 极短高频噪声，只做点击的"气口"，不参与低频 */
function tick({ dur = 0.008, gain = 0.02, hp = 4200, when = 0 }) {
  const a = ctx();
  if (!a) return;
  const t0 = a.currentTime + when;
  const len = Math.max(1, Math.floor(a.sampleRate * dur));
  const buf = a.createBuffer(1, len, a.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(master);
  src.start(t0);
}

/* ------------------------------------------------------------ 音色表（清脆版） */
const SOUNDS = {
  hover() { tone({ from: 2600, to: 2100, dur: 0.028, gain: 0.012 }); },
  click() { tick({ dur: 0.007, gain: 0.02 }); tone({ from: 1750, to: 1250, dur: 0.03, gain: 0.05 }); },
  tap() { tone({ from: 2200, dur: 0.022, gain: 0.035 }); },
  nav() { tone({ from: 980, to: 1320, dur: 0.05, gain: 0.045 }); tone({ from: 1960, dur: 0.03, gain: 0.02, when: 0.02 }); },
  launch() {
    [660, 990, 1480].forEach((f, i) => tone({ from: f, dur: 0.06, gain: 0.05, when: i * 0.055 }));
    tick({ dur: 0.006, gain: 0.02, when: 0.16 });
  },
  ok() { [880, 1174, 1568].forEach((f, i) => tone({ from: f, dur: 0.055, gain: 0.045, when: i * 0.05 })); },
  err() { tone({ type: 'triangle', from: 420, to: 300, dur: 0.11, gain: 0.05 }); tone({ type: 'triangle', from: 300, to: 220, dur: 0.12, gain: 0.04, when: 0.09 }); },
  ding() { tone({ from: 1320, dur: 0.05, gain: 0.04 }); tone({ from: 1980, dur: 0.04, gain: 0.02, when: 0.03 }); },
};

export const fx = {
  play(name) {
    if (!enabled) return;
    const f = SOUNDS[name];
    if (!f) return;
    try { f(); } catch { /* 音频被浏览器策略挡住时静默 */ }
  },
  isEnabled() { return enabled; },
  setEnabled(v) { enabled = Boolean(v); },
};

/* ------------------------------------------------------------ 视觉反馈 */
function ripple(el, ev) {
  if (!el || el.dataset.noRipple === '1') return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const size = Math.max(r.width, r.height) * 1.6;
  const x = (ev?.clientX ?? r.left + r.width / 2) - r.left;
  const y = (ev?.clientY ?? r.top + r.height / 2) - r.top;
  const span = document.createElement('span');
  span.className = 'fx-ripple';
  span.style.width = span.style.height = `${size}px`;
  span.style.left = `${x - size / 2}px`;
  span.style.top = `${y - size / 2}px`;
  if (getComputedStyle(el).position === 'static') el.classList.add('fx-host');
  el.appendChild(span);
  setTimeout(() => span.remove(), 620);
}

function pulse(el) {
  if (!el || el.dataset.noRipple === '1') return;
  el.classList.remove('fx-pulse');
  void el.offsetWidth; // 强制重排，保证连续点击也能重放
  el.classList.add('fx-pulse');
  setTimeout(() => el.classList.remove('fx-pulse'), 520);
}

/** 切视图时的一道扫描光 */
export function sweep() {
  const v = document.querySelector('.view.active');
  if (!v) return;
  v.classList.remove('fx-sweep');
  void v.offsetWidth;
  v.classList.add('fx-sweep');
  setTimeout(() => v.classList.remove('fx-sweep'), 650);
}

/* ------------------------------------------------------------ 全局委托 */
const HOVER_SEL = 'button, .card, .row-item, .tab, .nav-btn, .pill, [data-act], [data-install], [data-toggle], [data-del]';
let lastHover = null;
let hoverAt = 0;

export function initFx() {

  const stored = localStorage.getItem('tpcl-sfx');
  enabled = stored === null ? true : stored === '1';
  syncButton();

  // 按下：涟漪 + 脉冲 + 音效（这一帧就有反馈，不等接口）
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('button, .card, .row-item, .tab, .nav-btn, .acc-chip, [data-act], [data-install], [data-toggle], [data-del]');
    if (!el) return;
    let kind = 'click';
    if (el.id === 'btn-launch') kind = 'launch';
    else if (el.matches('.nav-btn, .tab')) kind = 'nav';
    else if (el.matches('input[type="checkbox"], select, .tiny-btn, .mini-btn, .icon-btn')) kind = 'tap';
    fx.play(kind);
    ripple(el, e);
    pulse(el);
  }, true);

  // 划过：很轻的刻度音
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest(HOVER_SEL);
    if (!el || el === lastHover) return;
    lastHover = el;
    const now = performance.now();
    if (now - hoverAt < 45) return;
    hoverAt = now;
    fx.play('hover');
  }, true);
  document.addEventListener('pointerout', (e) => {
    if (e.target === lastHover) lastHover = null;
  }, true);

  // 下拉、复选变化也给一声
  document.addEventListener('change', (e) => {
    if (e.target.matches('input[type="checkbox"], select')) fx.play('tap');
  }, true);

  document.addEventListener('click', (e) => {
    const b = e.target.closest('#btn-sfx');
    if (b) fx.setEnabled(!enabled);
  });
}

function syncButton() {
  const b = document.getElementById('btn-sfx');
  if (!b) return;
  b.textContent = enabled ? '🔊' : '🔇';
  b.classList.toggle('off', !enabled);
  b.title = enabled ? '音效：开' : '音效：关';
  try { localStorage.setItem('tpcl-sfx', enabled ? '1' : '0'); } catch { /* noop */ }
}

/* 供外部改开关（保持一致） */
fx.setEnabled = (v) => {
  enabled = Boolean(v);
  syncButton();
};
