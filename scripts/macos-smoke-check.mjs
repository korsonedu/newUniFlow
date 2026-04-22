import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const reportPath = path.join(root, '.tmp', 'macos-build-report.json');
const smokeReportPath = path.join(root, '.tmp', 'macos-smoke-report.json');
const manualChecklist = [
  'Launch the .app bundle.',
  'Create or open a project and confirm the first page renders.',
  'Record a short session and confirm timeline events advance.',
  'Perform one structural edit (split or ripple delete) and replay.',
  'Export once and confirm the job completes.',
];

if (!fs.existsSync(reportPath)) {
  console.error(`Missing macOS build report: ${reportPath}`);
  console.error('Run `npm run verify:macos` or `npm run report:macos-build` first.');
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const failures = [];

if (report.platform !== 'darwin') {
  failures.push(`Expected report.platform=darwin, got ${report.platform}`);
}
if (!report.appBundle || !fs.existsSync(report.appBundle)) {
  failures.push(`Missing app bundle: ${report.appBundle ?? 'unknown'}`);
}
if (!Array.isArray(report.dmgArtifacts) || report.dmgArtifacts.length === 0) {
  failures.push('Missing dmg artifact entries in report');
} else {
  for (const dmg of report.dmgArtifacts) {
    if (!fs.existsSync(dmg)) {
      failures.push(`Missing dmg artifact on disk: ${dmg}`);
    }
  }
}
if (report.architecture?.strictNativeMacOSUI !== false) {
  failures.push('Architecture report must explicitly mark strictNativeMacOSUI=false');
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure}`);
  }
  process.exit(1);
}

const smokeReport = {
  generatedAt: new Date().toISOString(),
  ok: true,
  buildReportPath: reportPath,
  appBundle: report.appBundle,
  dmgArtifacts: report.dmgArtifacts,
  architecture: report.architecture,
  manualChecklist,
};
fs.writeFileSync(smokeReportPath, `${JSON.stringify(smokeReport, null, 2)}\n`, 'utf8');

console.log('UniFlow macOS smoke preflight');
console.log(`- app: ${report.appBundle}`);
for (const dmg of report.dmgArtifacts) {
  console.log(`- dmg: ${dmg}`);
}
console.log(`- ui runtime: ${report.architecture.uiRuntime}`);
console.log(`- strict native macOS UI: ${report.architecture.strictNativeMacOSUI}`);
console.log(`- smoke report: ${smokeReportPath}`);
console.log('Manual smoke checklist:');
manualChecklist.forEach((item, index) => {
  console.log(`${index + 1}. ${item}`);
});
