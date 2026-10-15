'use strict';
// The Mac App Store build is configured in electron-builder.mas.cjs and the
// build/entitlements.mas*.plist files, apart from package.json "build" (the
// direct download). A wrong line in either is invisible until App Review or a
// launch crash, so the invariants are pinned here:
//   - the private-API grayscale helper never reaches the MAS bundle, and the
//     overlay helper never reaches the direct one;
//   - the entitlements are exactly what the sandboxed app and its children
//     need (tested on this Mac 2026-10-15, see the comments in each file);
//   - build/afterSign.js leaves MAS builds alone;
//   - both editions' purpose strings name OpenAI, and nothing asks for Apple
//     Events.
// scripts/verify-mas.sh checks the same things on a built app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json'));
const CONFIG = path.join(ROOT, 'electron-builder.mas.cjs');
const ENV_KEYS = ['MAS_TEAM_ID', 'MAS_APP_ID', 'MAS_BUILD', 'MAS_DEV_IDENTITY'];

/** Loads the MAS config fresh, with exactly these MAS_* variables set. */
function loadMas(env = {}) {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve(CONFIG)];
  try { return require(CONFIG); }
  finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    delete require.cache[require.resolve(CONFIG)];
  }
}

/** The top-level keys of a flat entitlements plist: { key: true | [strings] }. */
function entitlements(file) {
  const src = fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const out = {};
  for (const m of src.matchAll(/<key>([^<]+)<\/key>\s*(<true\/>|<false\/>|<array>([\s\S]*?)<\/array>)/g)) {
    out[m[1]] = m[2] === '<true/>' ? true : m[2] === '<false/>' ? false : [...m[3].matchAll(/<string>([^<]*)<\/string>/g)].map(s => s[1]);
  }
  return out;
}

/** A plist document from strings, booleans, arrays and objects. */
function plistXml(value) {
  const v = x => (x === true ? '<true/>' : x === false ? '<false/>'
    : Array.isArray(x) ? `<array>${x.map(v).join('')}</array>`
    : typeof x === 'object' ? `<dict>${Object.entries(x).map(([k, y]) => `<key>${k}</key>${v(y)}`).join('')}</dict>`
    : `<string>${String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`);
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0">${v(value)}</plist>\n`;
}

/** Every extraResources entry electron-builder could merge into a MAS build. */
function masResources(cfg) {
  return [cfg.extraResources, cfg.mac && cfg.mac.extraResources, cfg.mas && cfg.mas.extraResources, cfg.masDev && cfg.masDev.extraResources]
    .flatMap(list => (Array.isArray(list) ? list : list ? [list] : []));
}
const filtersOf = list => list.flatMap(r => (typeof r === 'string' ? [r] : [].concat(r.filter || r.from || [])));

test.describe('electron-builder.mas.cjs', () => {
  const cfg = loadMas();

  test('ships the overlay helper and never the private-API grayscale helper', () => {
    const res = masResources(cfg);
    assert.deepEqual(filtersOf(res), ['grayout-overlay']);
    assert.equal(JSON.stringify(cfg).includes('grayscale'), false, 'no mention of helper/grayscale anywhere in the MAS config');
    assert.equal(cfg.mac.x64ArchFiles, 'Contents/Resources/helper/grayout-overlay');
    assert.equal(cfg.files.some(f => /helper/.test(f)), false, 'helpers are resources, never app files');
  });

  test('inherits only names and files from package.json, never its mac block', () => {
    assert.equal(cfg.appId, 'com.aarushkandukoori.grayout');
    assert.equal(cfg.productName, 'Grayout', 'the in-app name stays Grayout; the store name lives in App Store Connect');
    assert.deepEqual(cfg.files, pkg.build.files);
    assert.equal('afterSign' in cfg, false, 'the direct build ad-hoc re-sign hook is not part of the MAS config');
    assert.equal(cfg.mac.identity, undefined, 'mac.identity "-" from package.json must not leak into mas');
    assert.equal(cfg.publish, null, 'no app-update.yml: App Store updates only');
  });

  test('Info.plist: menu bar app, macOS 13, no encryption export, no template junk', () => {
    const info = cfg.mac.extendInfo;
    assert.equal(cfg.mac.minimumSystemVersion, '13.0');
    assert.equal(info.LSUIElement, true);
    assert.equal(info.ITSAppUsesNonExemptEncryption, false);
    assert.equal(info.ElectronTeamID, 'JQ8RG44463');
    for (const k of ['NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription',
      'NSBluetoothPeripheralUsageDescription', 'NSAppleEventsUsageDescription', 'NSAppTransportSecurity']) {
      assert.equal(info[k], null, `${k} must be deleted (null) from Electron's template plist`);
    }
    assert.equal(info.NSScreenCaptureUsageDescription, pkg.build.mac.extendInfo.NSScreenCaptureUsageDescription);
    assert.equal(info.NSCameraUsageDescription, pkg.build.mac.extendInfo.NSCameraUsageDescription);
  });

  test('store build: Apple Distribution of the team, profile, sandbox entitlement files', () => {
    const mas = cfg.mas;
    assert.equal(mas.type, 'distribution');
    assert.equal(mas.identity, 'JQ8RG44463');
    assert.equal(mas.provisioningProfile, 'build/mas/Grayout_Mac_App_Store.provisionprofile');
    assert.equal(mas.hardenedRuntime, false);
    assert.equal(mas.preAutoEntitlements, true);
    assert.equal(mas.entitlements, 'build/entitlements.mas.plist');
    assert.equal(mas.entitlementsInherit, 'build/entitlements.mas.inherit.plist');
    assert.equal(mas.entitlementsLoginHelper, 'build/entitlements.mas.loginhelper.plist');
    assert.equal(mas.bundleVersion, '1');
    assert.match(read('.gitignore'), /^build\/mas\/$/m, 'the profile folder is never committed');
    assert.match(read('.gitignore'), /^\*\.provisionprofile$/m);
  });

  test('local build: ad-hoc, no profile, no restricted entitlements', () => {
    assert.equal(cfg.masDev.identity, '-');
    assert.equal(cfg.masDev.provisioningProfile, null);
    assert.equal(cfg.masDev.preAutoEntitlements, false, 'an ad-hoc app with application-identifier is killed at launch (AMFI -424)');
  });

  test('MAS_TEAM_ID, MAS_APP_ID, MAS_BUILD and MAS_DEV_IDENTITY flow through, with a matching app group', () => {
    const c = loadMas({ MAS_TEAM_ID: 'ABCDE12345', MAS_APP_ID: 'com.aarushkandukoori.grayout.mastest', MAS_BUILD: '7', MAS_DEV_IDENTITY: 'a'.repeat(40) });
    assert.equal(c.appId, 'com.aarushkandukoori.grayout.mastest');
    assert.equal(c.mac.extendInfo.ElectronTeamID, 'ABCDE12345');
    assert.equal(c.mas.identity, 'ABCDE12345');
    assert.equal(c.mas.bundleVersion, '7');
    assert.equal(c.masDev.identity, 'a'.repeat(40));
    // A temp copy, never an edit to the tracked file.
    assert.ok(path.isAbsolute(c.mas.entitlements));
    assert.ok(c.mas.entitlements.startsWith(os.tmpdir()));
    const e = entitlements(c.mas.entitlements);
    assert.deepEqual(e['com.apple.security.application-groups'], ['ABCDE12345.com.aarushkandukoori.grayout.mastest']);
    assert.equal(e['com.apple.security.app-sandbox'], true);
    assert.deepEqual(entitlements('build/entitlements.mas.plist')['com.apple.security.application-groups'], ['JQ8RG44463.com.aarushkandukoori.grayout']);
  });

  test('bad MAS_* values stop the build instead of producing a broken bundle', () => {
    assert.throws(() => loadMas({ MAS_TEAM_ID: 'team' }), /MAS_TEAM_ID/);
    assert.throws(() => loadMas({ MAS_APP_ID: 'grayout' }), /MAS_APP_ID/);
    assert.throws(() => loadMas({ MAS_BUILD: '2.0.0.1' }), /MAS_BUILD/, 'macOS allows at most three integers');
    assert.throws(() => loadMas({ MAS_DEV_IDENTITY: 'Apple Development' }), /MAS_DEV_IDENTITY/);
  });

  test('exports nothing electron-builder does not know (its schema rejects unknown keys)', () => {
    assert.deepEqual(Object.getOwnPropertyNames(cfg).sort(),
      ['appId', 'asar', 'copyright', 'directories', 'electronFuses', 'extraResources', 'files', 'mac', 'mas', 'masDev', 'productName', 'publish']);
  });
});

test.describe('MAS entitlements', () => {
  test('main app: sandbox, its team-prefixed group, network client, camera, nothing else', () => {
    assert.deepEqual(entitlements('build/entitlements.mas.plist'), {
      'com.apple.security.app-sandbox': true,
      'com.apple.security.application-groups': ['JQ8RG44463.com.aarushkandukoori.grayout'],
      'com.apple.security.network.client': true,
      'com.apple.security.device.camera': true
    });
  });

  test('children (Electron helpers, grayout-overlay): exactly sandbox + inherit', () => {
    assert.deepEqual(entitlements('build/entitlements.mas.inherit.plist'), {
      'com.apple.security.app-sandbox': true,
      'com.apple.security.inherit': true
    });
  });

  test('login helper: sandbox only, never inherit (it can run on its own)', () => {
    assert.deepEqual(entitlements('build/entitlements.mas.loginhelper.plist'), {
      'com.apple.security.app-sandbox': true
    });
  });

  test('the app group matches ElectronTeamID and the bundle id', () => {
    const cfg = loadMas();
    const group = entitlements(cfg.mas.entitlements)['com.apple.security.application-groups'][0];
    assert.equal(group, `${cfg.mac.extendInfo.ElectronTeamID}.${cfg.appId}`);
  });

  test('every plist is valid', { skip: process.platform !== 'darwin' && 'plutil is macOS only' }, () => {
    for (const f of ['build/entitlements.mas.plist', 'build/entitlements.mas.inherit.plist', 'build/entitlements.mas.loginhelper.plist']) {
      const r = spawnSync('plutil', ['-lint', path.join(ROOT, f)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stdout}${r.stderr}`);
    }
  });
});

test.describe('build/afterSign.js', () => {
  test('returns before any codesign for a MAS build (and anything not darwin)', async () => {
    const cp = require('child_process');
    const real = { execFileSync: cp.execFileSync, spawnSync: cp.spawnSync };
    const calls = [];
    cp.execFileSync = (...a) => { calls.push(a); throw new Error('codesign must not run'); };
    cp.spawnSync = (...a) => { calls.push(a); throw new Error('codesign must not run'); };
    const file = path.join(ROOT, 'build', 'afterSign.js');
    delete require.cache[file];
    try {
      const afterSign = require(file).default;
      for (const electronPlatformName of ['mas', 'linux', 'win32']) {
        assert.equal(await afterSign({ electronPlatformName, appOutDir: '/nonexistent', packager: { appInfo: { productFilename: 'Grayout', id: 'x' } } }), undefined);
      }
      assert.deepEqual(calls, []);
    } finally {
      Object.assign(cp, real);
      delete require.cache[file];
    }
  });
});

test.describe('package.json: the direct build and the scripts', () => {
  const info = pkg.build.mac.extendInfo;

  test('purpose strings name the Grayout service and OpenAI (5.1.1(ii)), and nothing asks for Apple Events', () => {
    assert.match(info.NSScreenCaptureUsageDescription, /Grayout service, which uses OpenAI/);
    assert.match(info.NSScreenCaptureUsageDescription, /never stored by Grayout/);
    assert.match(info.NSCameraUsageDescription, /Only if you turn it on/);
    assert.match(info.NSCameraUsageDescription, /Grayout service and OpenAI/);
    assert.match(info.NSCameraUsageDescription, /never saves frames/);
    assert.equal('NSAppleEventsUsageDescription' in info, false);
    for (const s of [info.NSScreenCaptureUsageDescription, info.NSCameraUsageDescription]) {
      assert.equal(s.includes('\u2014'), false, 'no em dash in user-facing copy');
    }
  });

  test('the direct download ships the Color Filters helper only, ad-hoc signed as before', () => {
    // The direct build grays with Color Filters and reads the front app with
    // lsappinfo (src/channel.js), so the overlay helper would be dead weight.
    assert.deepEqual(filtersOf([].concat(pkg.build.extraResources)), ['grayscale']);
    assert.equal(pkg.build.mac.x64ArchFiles, 'Contents/Resources/helper/grayscale');
    assert.equal(pkg.build.mac.identity, '-');
    assert.equal(pkg.build.afterSign, 'build/afterSign.js');
    assert.equal(JSON.stringify(pkg.build).includes('grayout-overlay'), false);
  });

  test('mas:dev and mas build through the separate config, arm64 only, and verify the result', () => {
    const s = pkg.scripts;
    assert.match(s['mas:dev'], /electron-builder --config electron-builder\.mas\.cjs --mac mas-dev --arm64 --publish never/);
    assert.match(s['mas:dev'], /bash scripts\/verify-mas\.sh dist\/mas-dev-arm64\/Grayout\.app$/);
    assert.match(s.mas, /electron-builder --config electron-builder\.mas\.cjs --mac mas --arm64 --publish never/);
    assert.match(s.mas, /bash scripts\/verify-mas\.sh dist\/mas-arm64\/Grayout\.app "dist\/mas-arm64\/Grayout-\$npm_package_version-mas\.pkg"$/);
    for (const k of ['mas:dev', 'mas']) {
      assert.match(s[k], /^npm run helper && /, `${k} builds the helper first`);
      assert.equal(/--universal|--x64/.test(s[k]), false, `${k}: arm64 only for the first release`);
    }
    assert.match(s.check, /electron-builder\.mas\.cjs/);
  });
});

test.describe('scripts/verify-mas.sh', () => {
  const src = read('scripts/verify-mas.sh');

  test('is valid bash and fails fast', () => {
    assert.match(src, /^set -euo pipefail$/m);
    const r = spawnSync('bash', ['-n', path.join(ROOT, 'scripts', 'verify-mas.sh')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  test('checks every MAS invariant on the built bundle', () => {
    for (const needle of [
      'helper/grayout-overlay', 'helper/grayscale', 'MADisplayFilterPref', 'app-update.yml', 'com.apple.quarantine',
      'Squirrel.framework', 'com.apple.security.inherit', 'Library/LoginItems', '$TEAM.$BID', 'ElectronTeamID',
      'NSAppleEventsUsageDescription', 'OpenAI', 'embedded.provisionprofile', '3rd Party Mac Developer Installer',
      'codesign --verify --deep --strict'
    ]) {
      assert.ok(src.includes(needle), `verify-mas.sh never checks ${needle}`);
    }
    assert.match(src, /if \[ -n "\$PKG" \]; then/, 'the installer is checked only when a pkg is given');
    assert.equal(/\bopen\s+"?\$APP/.test(src), false, 'it never launches the app');
  });

  test('refuses something that is not an app bundle', () => {
    const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'verify-mas.sh'), os.tmpdir()], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /FAIL/);
  });

  const VERIFY = path.join(ROOT, 'scripts', 'verify-mas.sh');
  const darwinOnly = { skip: process.platform !== 'darwin' && 'xattr, find -xattrname and PlistBuddy are macOS only' };
  const verify = app => spawnSync('bash', [VERIFY, app], { encoding: 'utf8' });
  const QUARANTINE = ['com.apple.quarantine', '0083;00000000;Safari;'];
  const xattr = (...args) => { const r = spawnSync('xattr', args, { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };

  /**
   * An unsigned stand-in for a mas-dev bundle whose Info.plist and contents
   * pass every check before the signature: verify-mas.sh gets as far as
   * codesign --verify unless something earlier fails first.
   */
  function fakeApp(t, padFiles = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grayout-verify-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const app = path.join(dir, 'Grayout.app');
    const info = pkg.build.mac.extendInfo;
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(app, 'Contents', 'Resources', 'helper'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plistXml({
      CFBundleIdentifier: 'com.aarushkandukoori.grayout.mastest', CFBundleExecutable: 'Grayout', ElectronTeamID: 'JQ8RG44463',
      LSUIElement: true, ITSAppUsesNonExemptEncryption: false, LSMinimumSystemVersion: '13.0',
      NSScreenCaptureUsageDescription: info.NSScreenCaptureUsageDescription, NSCameraUsageDescription: info.NSCameraUsageDescription
    }));
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Grayout'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'helper', 'grayout-overlay'), '#!/bin/sh\n', { mode: 0o755 });
    if (padFiles) {
      fs.mkdirSync(path.join(app, 'Contents', 'Resources', 'pad'));
      for (let i = 0; i < padFiles; i++) fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'pad', `${i}.js`), '');
    }
    return app;
  }

  test('a quarantined file anywhere in the bundle fails it', darwinOnly, t => {
    const clean = verify(fakeApp(t));
    assert.match(clean.stderr, /FAIL: codesign --verify/, `the clean stand-in reaches the signature check: ${clean.stderr}`);
    assert.doesNotMatch(clean.stderr, /quarantine/);

    const nested = fakeApp(t);
    xattr('-w', ...QUARANTINE, path.join(nested, 'Contents', 'Resources', 'helper', 'grayout-overlay'));
    assert.match(verify(nested).stderr, /FAIL: com\.apple\.quarantine xattr present on Contents\/Resources\/helper\/grayout-overlay/);

    // xattr -lr follows symlinks and never shows an attribute on the link itself.
    const link = fakeApp(t);
    fs.symlinkSync('helper/grayout-overlay', path.join(link, 'Contents', 'Resources', 'overlay-link'));
    xattr('-s', '-w', ...QUARANTINE, path.join(link, 'Contents', 'Resources', 'overlay-link'));
    assert.match(verify(link).stderr, /FAIL: com\.apple\.quarantine xattr present on Contents\/Resources\/overlay-link/);
  });

  test('a fully quarantined bundle (an unzipped download) fails it', darwinOnly, t => {
    // Hundreds of KB of `xattr -lr` output, more than a pipe holds: the old
    // `xattr -lr | grep -q` under pipefail died of SIGPIPE here and passed.
    const app = fakeApp(t, 2000);
    xattr('-r', '-w', ...QUARANTINE, app);
    const r = verify(app);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /FAIL: com\.apple\.quarantine xattr present on /);
  });
});
