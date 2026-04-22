import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const tmpDir = path.join(root, '.tmp');
const buildReportPath = path.join(tmpDir, 'macos-build-report.json');
const smokeReportPath = path.join(tmpDir, 'macos-smoke-report.json');
const manualAcceptancePath = path.join(tmpDir, 'macos-manual-acceptance.json');
const checklistPath = path.join(tmpDir, 'macos-release-checklist.md');
const releaseRecordPath = path.join(tmpDir, 'macos-release-record.md');

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const ensureFile = (filePath, hint) => {
  if (!fs.existsSync(filePath)) {
    fail(`Missing required file: ${filePath}\n${hint}`);
  }
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

ensureFile(buildReportPath, 'Run `npm run verify:macos` first.');
ensureFile(smokeReportPath, 'Run `npm run smoke:macos` or `npm run refresh:macos-release` first.');
ensureFile(manualAcceptancePath, 'Run `npm run accept:macos -- status` or `npm run checklist:macos-release` first.');
ensureFile(checklistPath, 'Run `npm run checklist:macos-release` first.');
ensureFile(releaseRecordPath, 'Run `npm run report:macos-release` first.');

const buildReport = readJson(buildReportPath);
const smokeReport = readJson(smokeReportPath);
const manualAcceptance = readJson(manualAcceptancePath);
const checks = Array.isArray(manualAcceptance.checks) ? manualAcceptance.checks : [];

const failures = [];

if (!smokeReport.ok) {
  failures.push('macOS smoke preflight is not PASS.');
}
if (buildReport.architecture?.strictNativeMacOSUI !== false) {
  failures.push('Architecture report must keep strictNativeMacOSUI=false until AppKit/SwiftUI migration is done.');
}

const failedChecks = checks.filter((item) => item.status === 'fail');
const pendingChecks = checks.filter((item) => item.status !== 'pass' && item.status !== 'fail');

for (const item of failedChecks) {
  failures.push(`Manual acceptance failed: ${item.id} (${item.label})${item.notes ? ` | ${item.notes}` : ''}`);
}
for (const item of pendingChecks) {
  failures.push(`Manual acceptance pending: ${item.id} (${item.label})`);
}

if (failures.length > 0) {
  console.error('UniFlow macOS release gate: BLOCKED');
  for (const item of failures) {
    console.error(`- ${item}`);
  }
  process.exit(1);
}

console.log('UniFlow macOS release gate: READY');
console.log(`- build report: ${buildReportPath}`);
console.log(`- smoke report: ${smokeReportPath}`);
console.log(`- manual acceptance: ${manualAcceptancePath}`);
console.log(`- checklist: ${checklistPath}`);
console.log(`- release record: ${releaseRecordPath}`);
