'use strict';
// Optional task context (src/tasks.js): a markdown task file and Canvas to-dos.
// Neither exists in the Mac App Store edition.
const { test, describe, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('tasks');
const channel = require('../src/channel');
const tasks = require('../src/tasks');

const REAL_FETCH = globalThis.fetch;
afterEach(() => { globalThis.fetch = REAL_FETCH; channel._setForTests(null); tasks._resetCanvasCache(); });
after(() => helpers.cleanup(dir));

const TASK_FILE = path.join(dir, 'todo.md');
fs.writeFileSync(TASK_FILE, '- [ ] write report\n- [x] done already\n* [ ] read chapter 3\nnot a task\n');
const CFG = { tasksFile: TASK_FILE, canvas: { baseUrl: 'https://canvas.example.edu' } };

function stubCanvas() {
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    const body = String(url).includes('/todo') ? [{ assignment: { name: 'Problem Set 4' } }] : [];
    return { ok: true, status: 200, json: async () => body };
  };
  return calls;
}

describe('direct edition', () => {
  test('reads open items from the task file and Canvas to-dos', async () => {
    const calls = stubCanvas();
    const r = await tasks.gatherTasks(CFG, 'canvas-token');
    assert.deepEqual(r.file, ['write report', 'read chapter 3']);
    assert.deepEqual(r.canvas, ['Problem Set 4']);
    assert.equal(r.canvasError, null);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(u => u.startsWith('https://canvas.example.edu/api/v1/')));
  });

  test('no token: no Canvas request', async () => {
    const calls = stubCanvas();
    const r = await tasks.gatherTasks(CFG, '');
    assert.deepEqual(r.canvas, []);
    assert.equal(calls.length, 0);
  });
});

describe('Mac App Store edition', () => {
  test('no task file and no Canvas: empty lists, no file read, no request', async () => {
    channel._setForTests('mas');
    const calls = stubCanvas();
    const r = await tasks.gatherTasks(CFG, 'canvas-token');
    assert.deepEqual(r, { canvas: [], canvasError: null, file: [] });
    assert.equal(calls.length, 0);
  });

  test('a missing config is tolerated', async () => {
    channel._setForTests('mas');
    assert.deepEqual(await tasks.gatherTasks(undefined, ''), { canvas: [], canvasError: null, file: [] });
  });
});
