'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const {
  REQUIRED_NOTARY_ENV,
  missingReleaseEnv,
  assertDeveloperIdSignature,
} = require('../scripts/sign-notarize-mac');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function check(name, fn) {
  fn();
  console.log(`  ✓ ${name}`);
}

console.log('[M1] macOS public release fails closed');
check('all notarization credentials are required', () => {
  assert.deepStrictEqual(missingReleaseEnv({}), REQUIRED_NOTARY_ENV);
  assert.deepStrictEqual(missingReleaseEnv({
    APPLE_ID: 'developer@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'secret',
    APPLE_TEAM_ID: 'TEAM123',
  }), []);
});

check('ad-hoc and non-hardened signatures are rejected', () => {
  assert.throws(
    () => assertDeveloperIdSignature('Signature=adhoc\nTeamIdentifier=not set\nflags=0x2(adhoc)'),
    /ad-hoc signed/
  );
  assert.throws(
    () => assertDeveloperIdSignature(
      'Authority=Developer ID Application: Example (TEAM123)\nTeamIdentifier=TEAM123\nflags=0x0(none)'
    ),
    /Hardened Runtime/
  );
  assert.doesNotThrow(() => assertDeveloperIdSignature(
    'Authority=Developer ID Application: Example (TEAM123)\nTeamIdentifier=TEAM123\nflags=0x10000(runtime)'
  ));
});

const packageMac = read('scripts/package-mac.sh');
check('release packaging never falls back to ad-hoc signing', () => {
  assert.match(packageMac, /LLMPET_MAC_SIGN_MODE:-release/);
  assert.match(packageMac, /sign-notarize-mac\.js" --check-env/);
  assert.match(packageMac, /sign-notarize-mac\.js"/);
  assert.match(packageMac, /mac-\$ARCH-unsigned\.zip/);
});

check('local package carries generated-program registration support', () => {
  assert.match(packageMac, /hook \.agents \.claude/);
  assert.match(packageMac, /scripts\/register-generated-program\.js/);
});

const threePiece = read('scripts/three-piece.sh');
check('three-piece publishing is guarded and verifies main equality', () => {
  assert.match(threePiece, /status --porcelain/);
  assert.match(threePiece, /merge --no-ff/);
  assert.match(threePiece, /package:mac:dev/);
  assert.match(threePiece, /push "\$REMOTE" "\$MAIN_BRANCH:\$MAIN_BRANCH"/);
  assert.match(threePiece, /LOCAL_MAIN.*REMOTE_MAIN/s);
});

const verifyMac = read('scripts/verify-mac-release.sh');
check('verification covers signature, ticket, quarantine and Gatekeeper', () => {
  assert.match(verifyMac, /Signature=adhoc/);
  assert.match(verifyMac, /Developer ID Application:/);
  assert.match(verifyMac, /Hardened Runtime/);
  assert.match(verifyMac, /stapler validate/);
  assert.match(verifyMac, /com\.apple\.quarantine/);
  assert.match(verifyMac, /spctl --assess/);
});

const workflow = read('.github/workflows/release.yml');
check('Release workflow imports secrets and runs the strict verifier', () => {
  for (const name of [
    'APPLE_DEVELOPER_ID_P12_BASE64',
    'APPLE_DEVELOPER_ID_P12_PASSWORD',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${name}`));
  }
  assert.match(workflow, /security import .* -t agg -f pkcs12/);
  assert.match(workflow, /npm run package:mac/);
  assert.match(workflow, /npm run verify:mac/);
  assert.doesNotMatch(workflow, /npm run package:mac:dev/);
});

const pkg = require('../package.json');
check('signing helpers are direct, pinned development dependencies', () => {
  assert.strictEqual(pkg.devDependencies['@electron/osx-sign'], '1.3.3');
  assert.strictEqual(pkg.devDependencies['@electron/notarize'], '2.5.0');
});

console.log('macOS release checks passed');
