// electron-builder's afterPack hook: sign the packed app ad hoc, before it goes into the DMG. With identity: null
// electron-builder signs nothing, and Apple Silicon won't launch an unsigned app (`devdeck desktop install` also
// checks this signature before installing).
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
