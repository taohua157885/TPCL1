import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('dragged modpack opens preview; invalid and multiple drops do not import', async () => {
  const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function bindModpackDrop()');
  const end = source.indexOf('async function showPackSummary', start);
  const listeners = {}, previews = [], messages = [], input = { value: '' };
  const classes = new Set();
  const zone = { setAttribute() {}, classList: { add: x => classes.add(x), remove: x => classes.delete(x) }, addEventListener: (name, fn) => { listeners[name] = fn; } };
  vm.runInNewContext(source.slice(start, end) + '\nbindModpackDrop();', {
    $: selector => selector === '#mp-drop' ? zone : input,
    pickModpackFile() {}, window: {}, document: { addEventListener() {} },
    toast: text => messages.push(text),
    askModpack: async path => previews.push(path),
  });
  const event = files => ({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files } });
  await listeners.drop(event([{ path: 'C:\\packs\\example.mrpack' }]));
  assert.deepEqual(previews, ['C:\\packs\\example.mrpack']);
  assert.equal(input.value, previews[0]);
  await listeners.drop(event([{ path: 'C:\\packs\\bad.exe' }]));
  await listeners.drop(event([{ path: 'a.zip' }, { path: 'b.zip' }]));
  assert.equal(previews.length, 1);
  assert.equal(messages.length, 2);
  listeners.dragenter(event([])); listeners.dragenter(event([]));
  listeners.dragleave(event([])); assert.ok(classes.has('dragging'));
  listeners.dragleave(event([])); assert.ok(!classes.has('dragging'));
});
