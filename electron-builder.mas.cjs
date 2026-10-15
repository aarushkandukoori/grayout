// Mac App Store build config. Used only through the npm scripts:
//   npm run mas:dev   local sandbox test build (ad-hoc signed, arm64, no profile)
//   npm run mas       store build (Apple Distribution, provisioning profile, arm64)
//
// Kept separate from package.json "build" on purpose: electron-builder 26 builds
// the mas config as deepAssign({}, mac, mas), and that merge CONCATENATES arrays,
// so anything in mac.extraResources (the private-API Color Filters helper,
// helper/grayscale) would ship in the App Store build. Here nothing is inherited
// from the direct build except the app id, name, file list and purpose strings.
//
// Environment (all optional):
//   MAS_TEAM_ID       Apple team ID, 10 characters. Default JQ8RG44463, the free
//                     personal team, which is enough for local mas-dev builds.
//                     Set the paid team's ID for the store build.
//   MAS_APP_ID        Overrides the bundle id of a mas-dev build, for example
//                     com.aarushkandukoori.grayout.mastest for local sandbox
//                     tests, so they never touch the installed app's Screen
//                     Recording grant, data container or keychain item. The
//                     store build (mas) refuses any other id than the default.
//   MAS_BUILD         CFBundleVersion, up to three integers. Bump on every upload.
//   MAS_DEV_IDENTITY  mas-dev signing identity: "-" (ad-hoc, the default) or the
//                     SHA-1 of an Apple Development certificate of MAS_TEAM_ID,
//                     which keeps grants and keychain access across rebuilds.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = require('./package.json').build;

const DEFAULT_TEAM_ID = 'JQ8RG44463';
const ENTITLEMENTS = 'build/entitlements.mas.plist';
const PROFILE = 'build/mas/Grayout_Mac_App_Store.provisionprofile'; // gitignored; from developer.apple.com

function fromEnv(name, fallback, valid, what) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!valid.test(raw)) throw new Error(`electron-builder.mas.cjs: ${name}=${JSON.stringify(raw)} is not ${what}`);
  return raw;
}

const TEAM_ID = fromEnv('MAS_TEAM_ID', DEFAULT_TEAM_ID, /^[A-Z0-9]{10}$/, 'a 10-character Apple team ID');
const APP_ID = fromEnv('MAS_APP_ID', base.appId, /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/, 'a reverse-DNS bundle id');
const BUILD = fromEnv('MAS_BUILD', '1', /^\d{1,9}(\.\d{1,9}){0,2}$/, 'a CFBundleVersion of up to three integers');
const DEV_IDENTITY = fromEnv('MAS_DEV_IDENTITY', '-', /^(-|[0-9A-Fa-f]{40})$/, '"-" or a 40-character certificate SHA-1');

/**
 * True when electron-builder was asked for the store target. It loads this
 * file in its own CLI process, so the targets are in process.argv: a `mas`
 * argument (also as `--mac=mas` or `mas:arm64`) is the store build, even next
 * to `mas-dev`; `mas-dev` alone is not.
 */
function buildsStoreTarget(argv = process.argv) {
  return argv.some(arg => arg.split(/[=,]/).some(t => t.split(':')[0] === 'mas'));
}

// The store profile is for the default id, and neither osx-sign nor codesign
// compares it with the bundle id, so a MAS_APP_ID left set from a sandbox test
// would sign a store pkg that Apple only rejects at upload.
if (APP_ID !== base.appId && buildsStoreTarget()) {
  throw new Error(`electron-builder.mas.cjs: MAS_APP_ID=${APP_ID} is for mas-dev test builds only; ` +
    `the store build (mas) must use ${base.appId}. Unset MAS_APP_ID and build again.`);
}

/**
 * The app's entitlements, with application-groups set to <team>.<bundle id>.
 * Electron's MAS build registers its Mach rendezvous port under that group and
 * aborts at launch without it (tested 2026-10-15). The committed file holds
 * the default team and bundle id; any other pair gets a copy in a temp folder,
 * so a test build never edits a tracked file.
 */
function entitlementsFor(team, appId, outRoot = os.tmpdir()) {
  const template = fs.readFileSync(path.join(__dirname, ENTITLEMENTS), 'utf8');
  const groups = [...template.matchAll(/<string>([A-Z0-9]{10}\.[^<]+)<\/string>/g)];
  if (groups.length !== 1) throw new Error(`${ENTITLEMENTS}: expected exactly one application group`);
  const want = `${team}.${appId}`;
  if (groups[0][1] === want) return ENTITLEMENTS;
  const dir = path.join(outRoot, `grayout-mas-${want}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'entitlements.mas.plist');
  fs.writeFileSync(file, template.replace(groups[0][0], `<string>${want}</string>`));
  return file;
}

const config = {
  appId: APP_ID,
  productName: base.productName,          // "Grayout"; the store name is set in App Store Connect
  copyright: base.copyright,
  directories: { output: 'dist', buildResources: 'build' },
  files: base.files,
  asar: true,
  // The overlay helper only (sandbox-safe gray, frontmost app). Never
  // helper/grayscale: it uses private MediaAccessibility API (2.5.1).
  extraResources: [{ from: 'helper', to: 'helper', filter: ['grayout-overlay'] }],
  publish: null,                          // no app-update.yml: App Store updates only (2.4.5(vii))
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false
  },
  mac: {
    // electron-builder reads these from `mac` even for MAS builds
    // (macPackager.applyCommonInfo takes minimumSystemVersion, category, icon
    // and extendInfo from mac).
    category: 'public.app-category.productivity',
    minimumSystemVersion: '13.0',
    icon: 'build/icon.icns',
    x64ArchFiles: 'Contents/Resources/helper/grayout-overlay', // identical in both slices of a universal build
    extendInfo: {
      LSUIElement: true,
      ElectronTeamID: TEAM_ID,
      ITSAppUsesNonExemptEncryption: false,
      NSScreenCaptureUsageDescription: base.mac.extendInfo.NSScreenCaptureUsageDescription,
      NSCameraUsageDescription: base.mac.extendInfo.NSCameraUsageDescription,
      // Electron's template Info.plist ships generic purpose strings and an ATS
      // opt-out that Grayout never uses; null deletes a key.
      NSMicrophoneUsageDescription: null,
      NSAudioCaptureUsageDescription: null,
      NSBluetoothAlwaysUsageDescription: null,
      NSBluetoothPeripheralUsageDescription: null,
      NSAppleEventsUsageDescription: null,
      NSAppTransportSecurity: null
    }
  },
  mas: {
    type: 'distribution',
    identity: TEAM_ID,                    // matches "Apple Distribution: ... (TEAM)" and "3rd Party Mac Developer Installer: ... (TEAM)"
    provisioningProfile: PROFILE,
    hardenedRuntime: false,
    preAutoEntitlements: true,            // adds application-identifier and team-identifier from the profile
    entitlements: entitlementsFor(TEAM_ID, APP_ID),
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    entitlementsLoginHelper: 'build/entitlements.mas.loginhelper.plist',
    bundleVersion: BUILD,
    artifactName: 'Grayout-${version}-mas.${ext}'
  },
  masDev: {
    // Local sandbox test build. It runs on this Mac and can never be uploaded.
    identity: DEV_IDENTITY,
    provisioningProfile: null,
    // Restricted entitlements (application-identifier, team-identifier)
    // without a profile get an ad-hoc app killed at launch (AMFI -424).
    preAutoEntitlements: false
  }
};

module.exports = config;
