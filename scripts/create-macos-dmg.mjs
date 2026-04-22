import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const tauriConfigPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
const productName = tauriConfig.productName || 'UniFlow';
const version = tauriConfig.version || '0.1.0';
const bundleRoot = path.join(root, 'src-tauri', 'target', 'release', 'bundle');
const macosAppPath = path.join(bundleRoot, 'macos', `${productName}.app`);
const dmgDir = path.join(bundleRoot, 'dmg');
const stagingDir = path.join(root, '.tmp', 'macos-dmg-root');
const arch = process.arch === 'arm64' ? 'aarch64' : process.arch;
const dmgPath = path.join(dmgDir, `${productName}_${version}_${arch}.dmg`);

if (!fs.existsSync(macosAppPath)) {
  console.error(`Missing macOS app bundle: ${macosAppPath}`);
  process.exit(1);
}

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });
fs.mkdirSync(dmgDir, { recursive: true });
fs.cpSync(macosAppPath, path.join(stagingDir, `${productName}.app`), { recursive: true });
fs.rmSync(dmgPath, { force: true });

execFileSync(
  'hdiutil',
  [
    'create',
    '-volname',
    productName,
    '-srcfolder',
    stagingDir,
    '-ov',
    '-format',
    'UDZO',
    dmgPath,
  ],
  {
    cwd: root,
    stdio: 'inherit',
  },
);

console.log(`Created headless macOS dmg: ${dmgPath}`);
