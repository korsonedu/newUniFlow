import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const tauriConfigPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
const productName = tauriConfig.productName || 'UniFlow';
const bundleRoot = path.join(root, 'src-tauri', 'target', 'release', 'bundle');
const macosAppPath = path.join(bundleRoot, 'macos', `${productName}.app`);
const dmgDir = path.join(bundleRoot, 'dmg');
const dmgFiles = fs.existsSync(dmgDir)
  ? fs.readdirSync(dmgDir)
    .filter((file) => file.endsWith('.dmg'))
    .map((file) => path.join(dmgDir, file))
  : [];

if (!fs.existsSync(macosAppPath)) {
  console.error(`Missing macOS app bundle: ${macosAppPath}`);
  process.exit(1);
}

if (dmgFiles.length === 0) {
  console.error(`Missing macOS dmg artifact under: ${dmgDir}`);
  process.exit(1);
}

const readCmd = (cmd) => {
  try {
    return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return null;
  }
};

const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  productName,
  version: tauriConfig.version || null,
  architecture: {
    desktopShell: 'tauri',
    uiRuntime: 'react-vite-webview',
    nativeCore: 'rust-native-core-via-tauri-commands',
    strictNativeMacOSUI: false,
    note: 'Current macOS delivery is a Tauri desktop app with native Rust services and a WebView UI, not an AppKit/SwiftUI pure-native UI.',
  },
  appBundle: macosAppPath,
  dmgArtifacts: dmgFiles,
  toolchain: {
    node: readCmd('node -v'),
    npm: readCmd('npm -v'),
    rustc: readCmd('rustc --version'),
    cargo: readCmd('cargo --version'),
  },
  reproducibleSteps: [
    'npm run doctor:macos',
    'cargo test --manifest-path ./src-tauri/Cargo.toml',
    'npm run typecheck',
    'npm run test:timeline',
    'npm run build:desktop:mac',
    'npm run report:macos-build',
  ],
};

const reportDir = path.join(root, '.tmp');
const reportPath = path.join(reportDir, 'macos-build-report.json');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log('UniFlow macOS build report');
console.log(`- app: ${macosAppPath}`);
for (const dmg of dmgFiles) {
  console.log(`- dmg: ${dmg}`);
}
console.log(`- report: ${reportPath}`);
