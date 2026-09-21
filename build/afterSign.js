// Re-sign the outer bundle ad-hoc with an identifier-based designated requirement.
// Ad-hoc signatures default to `designated => cdhash H"..."`, which changes every build and
// makes macOS treat each update as a new app for Screen Recording / Camera / Keychain grants.
// This is inferred to help (not yet verified end to end) and is also the known fix for
// electron-builder #9529 (ad-hoc builds opening the camera with no frames).
//
// Two passes, not one. BUILD-SPEC §4 wrote this as a single
// `codesign --force --deep --sign - -r '=designated => identifier "…"'`, but with --deep the
// requirement is stamped onto every nested helper/framework too, whose identifiers are
// com.github.Electron.helper etc. The outer seal then records a requirement those nested
// bundles cannot satisfy and `codesign --verify --deep --strict` fails with
// "nested code is modified or invalid" (reproduced on Electron 44.4.3's Electron.app,
// 2026-09-21). Deep ad-hoc first (nested code keeps its cdhash DR), then the outer bundle
// alone gets the identifier DR: verify passes and `codesign -d -r-` shows the identifier.
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const id = context.packager.appInfo.id; // com.aarushkandukoori.grayout
  const codesign = args => execFileSync('codesign', args, { stdio: 'inherit' });

  codesign(['--force', '--deep', '--sign', '-', appPath]);
  codesign(['--force', '--sign', '-', '-r', `=designated => identifier "${id}"`, appPath]);
  codesign(['--verify', '--deep', '--strict', '--verbose=2', appPath]);

  // Hard gate: the whole point is the identifier DR on the outer bundle.
  const dr = spawnSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8' });
  const text = String(dr.stdout || '') + String(dr.stderr || '');
  if (!text.includes(`designated => identifier "${id}"`)) {
    throw new Error(`afterSign: designated requirement missing on ${appPath}:\n${text}`);
  }
  console.log(`afterSign: ${path.basename(appPath)} ad-hoc signed, designated => identifier "${id}"`);
};
