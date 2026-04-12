import { execSync } from 'node:child_process';

const target = String(process.argv[2] || 'all').trim().toLowerCase();

const baseChecks = [
  { name: 'node', cmd: 'node -v' },
  { name: 'npm', cmd: 'npm -v' },
];

const macosChecks = [
  { name: 'rustc (for macOS Tauri)', cmd: 'rustc --version' },
  { name: 'cargo (for macOS Tauri)', cmd: 'cargo --version' },
];

const ipadosChecks = [
  { name: 'xcodebuild (for iPadOS)', cmd: 'xcodebuild -version' },
  { name: 'pod (for iPadOS)', cmd: 'pod --version' },
];

const windowsChecks = [
  { name: 'rustc (for Windows Tauri)', cmd: 'rustc --version' },
  { name: 'cargo (for Windows Tauri)', cmd: 'cargo --version' },
];

const byTarget = {
  all: [...baseChecks, ...macosChecks, ...ipadosChecks, ...windowsChecks],
  macos: [...baseChecks, ...macosChecks],
  ipados: [...baseChecks, ...ipadosChecks],
  windows: [...baseChecks, ...windowsChecks],
};

if (!byTarget[target]) {
  console.error(`Unknown target "${target}". Expected: all | macos | ipados | windows`);
  process.exit(1);
}

console.log(`UniFlow platform doctor target: ${target}`);
for (const check of byTarget[target]) {
  try {
    const result = execSync(check.cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    console.log(`OK  ${check.name}: ${result}`);
  } catch {
    console.log(`MISS ${check.name}`);
  }
}
