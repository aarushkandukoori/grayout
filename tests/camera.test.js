'use strict';
// When the webcam may be open (src/camera.js shouldRun / sync): only while a
// check could use a frame. main.js calls sync on every config change, consent
// change and status report, so it must be idempotent.
const { describe, test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

const dir = helpers.freshUserData('camera');
const windows = [];
class FakeWindow {
  constructor(opts) { this.opts = opts; this.destroyed = false; this.handlers = {}; windows.push(this); }
  on(ev, fn) { this.handlers[ev] = fn; }
  loadFile() {}
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}
helpers.stubElectron({ BrowserWindow: FakeWindow });

const camera = require('../src/camera');

after(() => { camera.destroy(); helpers.cleanup(dir); });

const WATCHING = Object.freeze({ camera: true, consent: true, running: true, paused: false });
const open = () => windows.filter(w => !w.destroyed).length;

describe('shouldRun', () => {
  test('open only with the camera on, consent given, and the loop started and not paused', () => {
    assert.equal(camera.shouldRun(WATCHING), true);
  });

  test('each condition alone closes it', () => {
    for (const [why, over] of [
      ['camera option off', { camera: false }],
      ['no consent (never given, or withdrawn)', { consent: false }],
      ['loop not started (setup or the consent card)', { running: false }],
      ['paused (menu bar, timed, setup not finished, consent wait)', { paused: true }]
    ]) {
      assert.equal(camera.shouldRun({ ...WATCHING, ...over }), false, why);
    }
  });

  test('anything but a clear answer is a no', () => {
    assert.equal(camera.shouldRun(), false);
    assert.equal(camera.shouldRun({}), false);
    assert.equal(camera.shouldRun({ ...WATCHING, camera: 'true' }), false);
    assert.equal(camera.shouldRun({ ...WATCHING, consent: 1 }), false);
    assert.equal(camera.shouldRun({ ...WATCHING, paused: undefined }), false, 'an unknown pause state counts as paused');
    assert.equal(camera.shouldRun({ ...WATCHING, running: undefined }), false);
  });
});

describe('sync', () => {
  beforeEach(() => { camera.destroy(); windows.length = 0; });

  test('opens one window and keeps it across repeated calls', () => {
    assert.equal(camera.sync(WATCHING), true);
    assert.equal(camera.sync(WATCHING), true);
    assert.equal(camera.sync(WATCHING), true);
    assert.equal(windows.length, 1, 'never recreated while open');
    assert.equal(open(), 1);
    assert.equal(windows[0].opts.show, false, 'hidden');
  });

  test('closes on withdrawal, on pause and when the option goes off; reopens on grant or resume', () => {
    camera.sync(WATCHING);
    assert.equal(camera.sync({ ...WATCHING, consent: false }), false);
    assert.equal(open(), 0, 'consent withdrawn: the device is released');
    camera.sync({ ...WATCHING, consent: false });
    assert.equal(windows.length, 1, 'closing twice is harmless');
    camera.sync(WATCHING);
    assert.equal(open(), 1, 'consent granted again');
    camera.sync({ ...WATCHING, paused: true });
    assert.equal(open(), 0, 'paused');
    camera.sync(WATCHING);
    assert.equal(open(), 1, 'resumed');
    camera.sync({ ...WATCHING, camera: false });
    assert.equal(open(), 0, 'option off');
    assert.equal(windows.length, 3);
    assert.equal(camera.getStatus(), 'off');
  });

  test('never opens before consent or while setup is unfinished, whatever the camera option says', () => {
    camera.sync({ camera: true, consent: false, running: false, paused: true });
    camera.sync({ camera: true, consent: true, running: true, paused: true });
    camera.sync({ camera: true, consent: false, running: true, paused: false });
    assert.equal(windows.length, 0);
  });

  test('a window macOS or the user closed is replaced on the next sync', () => {
    camera.sync(WATCHING);
    windows[0].destroyed = true;
    windows[0].handlers.closed();
    camera.sync(WATCHING);
    assert.equal(windows.length, 2);
    assert.equal(open(), 1);
  });
});

describe('main.js wiring', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = name => {
    const start = main.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `main.js has ${name}`);
    return main.slice(start, main.indexOf('\n}\n', start));
  };

  test('the camera is opened and closed only through camera.sync, gated on consent and the loop', () => {
    assert.equal(/camera\.(create|destroy)\(/.test(main), false, 'no direct create() or destroy()');
    const sync = body('syncCamera');
    assert.match(sync, /camera\.sync\(/);
    assert.match(sync, /consent\.satisfied\(\)/);
    assert.match(sync, /config\.camera === true/);
    assert.match(sync, /\.running === true/);
    assert.match(sync, /\.paused !== false/);
  });

  test('every place that changes what may run syncs the camera', () => {
    for (const fn of ['applyConfig', 'startWatching', 'waitForConsent', 'onStatus']) {
      assert.match(body(fn), /syncCamera\(/, `${fn} calls syncCamera`);
    }
    assert.match(main, /onConsentGranted: \(\) => \{[^}]*syncCamera\(\);/, 'on grant');
    assert.match(main, /onConsentRevoked: \(\) => syncCamera\(\)/, 'on withdrawal');
  });
});
