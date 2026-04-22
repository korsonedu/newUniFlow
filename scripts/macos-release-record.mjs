import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const templatePath = path.join(root, 'MACOS_RELEASE_RECORD_TEMPLATE.md');
const buildReportPath = path.join(root, '.tmp', 'macos-build-report.json');
const smokeReportPath = path.join(root, '.tmp', 'macos-smoke-report.json');
const manualAcceptancePath = path.join(root, '.tmp', 'macos-manual-acceptance.json');
const releaseChecklistPath = path.join(root, '.tmp', 'macos-release-checklist.md');
const rolloutStatePath = path.join(root, '.tmp', 'platform-rollout.json');
const outputPath = path.join(root, '.tmp', 'macos-release-record.md');

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!fs.existsSync(templatePath)) {
  fail(`Missing release record template: ${templatePath}`);
}
if (!fs.existsSync(buildReportPath)) {
  fail(`Missing macOS build report: ${buildReportPath}`);
}
if (!fs.existsSync(smokeReportPath)) {
  fail(`Missing macOS smoke report: ${smokeReportPath}`);
}

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const buildReport = readJson(buildReportPath);
const smokeReport = readJson(smokeReportPath);
const manualAcceptance = fs.existsSync(manualAcceptancePath)
  ? readJson(manualAcceptancePath)
  : { status: 'pending', checks: [] };
const rolloutState = fs.existsSync(rolloutStatePath)
  ? readJson(rolloutStatePath)
  : { done: { macos: null, ipados: null, windows: null } };

const readCmd = (cmd) => {
  try {
    return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return 'unknown';
  }
};

const toBulletList = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    return '- none';
  }
  return items.map((item) => `- ${item}`).join('\n');
};

const toolchainLines = Object.entries(buildReport.toolchain || {}).map(
  ([name, value]) => `- ${name}: ${value ?? 'unknown'}`,
);
const manualChecks = Array.isArray(manualAcceptance.checks) ? manualAcceptance.checks : [];
const manualPassed = manualChecks.filter((item) => item.status === 'pass').length;
const manualFailed = manualChecks.filter((item) => item.status === 'fail').length;
const manualPending = manualChecks.length - manualPassed - manualFailed;

const replacements = {
  generatedAt: new Date().toISOString(),
  gitHead: readCmd('git rev-parse --short HEAD'),
  productName: buildReport.productName ?? 'UniFlow',
  version: buildReport.version ?? 'unknown',
  rolloutMacos: rolloutState.done?.macos ?? 'TODO',
  architectureSummary: `${buildReport.architecture?.desktopShell ?? 'unknown'} + ${buildReport.architecture?.nativeCore ?? 'unknown'} + ${buildReport.architecture?.uiRuntime ?? 'unknown'}`,
  strictNativeMacOSUI: String(buildReport.architecture?.strictNativeMacOSUI ?? 'unknown'),
  appBundle: buildReport.appBundle ?? 'unknown',
  dmgArtifacts: toBulletList(buildReport.dmgArtifacts),
  toolchain: toolchainLines.join('\n'),
  reproducibleSteps: toBulletList(buildReport.reproducibleSteps),
  smokeStatus: smokeReport.ok ? 'PASS' : 'FAIL',
  smokeReportPath,
  manualChecklist: toBulletList(smokeReport.manualChecklist),
  manualAcceptancePath,
  manualAcceptanceSummary: `${manualPassed}/${manualChecks.length} passed, ${manualFailed} failed, ${manualPending} pending`,
  manualAcceptanceStatus: manualAcceptance.status ?? 'pending',
  releaseChecklistPath: fs.existsSync(releaseChecklistPath) ? releaseChecklistPath : 'missing - run `npm run checklist:macos-release`',
  blockingNotes: '当前 UI 仍为 WebView 承载，strictNativeMacOSUI=false；在完成 AppKit/SwiftUI 迁移前，不得对外表述为纯原生 macOS UI。',
};

let content = fs.readFileSync(templatePath, 'utf8');
for (const [key, value] of Object.entries(replacements)) {
  content = content.replaceAll(`{{${key}}}`, value);
}

fs.writeFileSync(outputPath, content, 'utf8');

console.log('UniFlow macOS release record');
console.log(`- template: ${templatePath}`);
console.log(`- build report: ${buildReportPath}`);
console.log(`- smoke report: ${smokeReportPath}`);
console.log(`- output: ${outputPath}`);
