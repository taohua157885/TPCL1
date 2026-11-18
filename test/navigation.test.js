import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('initialization binds every settings link and navigation button', () => {
  const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const node = dataset => ({
    dataset, listeners: {}, attrs: {}, classList: {contains:()=>true, add(){}, toggle(){}},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setAttribute(key, value) { this.attrs[key] = value; },
    removeAttribute(key) { delete this.attrs[key]; },
    getBoundingClientRect() { return {top:0}; }, scrollIntoView() {},
  });
  const links = ['general','paths'].map(settingsJump=>node({settingsJump}));
  const nav = ['home','download'].map(view=>node({view}));
  const page = node({});
  const selectAll = s => s.includes('settings-jump') ? links : s.includes('nav-btn') ? nav : [];
  const doc = { querySelector: s => selectAll(s)[0] || page, querySelectorAll: selectAll, getElementById:()=>page };
  const selectors = source.split(/\r?\n/).filter(line => line.startsWith('const $ =') || line.startsWith('const $$ =')).join('\n');
  const section = (start, end) => source.slice(source.indexOf(start),source.indexOf(end, source.indexOf(start)));
  const code = selectors + '\n' + section('function bindNavigation()', 'function bind()') +
    section('function showView(name)', '/* ---------------- 版本列表') + '\nbindNavigation();';
  const noop = () => {};
  const state = {remote:true};
  vm.runInNewContext(code, {document:doc, state, sweep:noop, applyI18n:noop, startTaskPoll:noop, stopLanPoll:noop});
  assert.equal(links[0].attrs['aria-current'],'location');
  for (const item of links) item.listeners.click();
  nav[1].listeners.click();
  assert.equal(state.view,'download');
  assert.equal(nav[1].attrs['aria-current'],'page');
});
