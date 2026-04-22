import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const tmpDir = path.join(root, '.tmp');
const buildReportPath = path.join(tmpDir, 'macos-build-report.json');
const smokeReportPath = path.join(tmpDir, 'macos-smoke-report.json');
const manualAcceptancePath = path.join(tmpDir, 'macos-manual-acceptance.json');
const checklistPath = path.join(tmpDir, 'macos-release-checklist.md');

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const ensureJsonExists = (filePath, hint) => {
  if (!fs.existsSync(filePath)) {
    fail(`Missing required file: ${filePath}\n${hint}`);
  }
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

ensureJsonExists(buildReportPath, 'Run `npm run verify:macos` or `npm run report:macos-build` first.');
ensureJsonExists(smokeReportPath, 'Run `npm run smoke:macos` first.');

const buildReport = readJson(buildReportPath);
const smokeReport = readJson(smokeReportPath);

const defaultManualAcceptance = {
  generatedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'pending',
  notes: '',
  checks: [
    {
      id: 'app_launch_render',
      label: 'App launches on macOS and the first project page renders correctly.',
      status: 'pending',
      notes: '',
    },
    {
      id: 'recording_timeline_progress',
      label: 'A short recording creates timeline events and the playhead advances correctly.',
      status: 'pending',
      notes: '',
    },
    {
      id: 'structural_edit_alignment',
      label: 'One structural edit keeps preview playback, waveform, and export state aligned.',
      status: 'pending',
      notes: '',
    },
    {
      id: 'export_fingerprint_match',
      label: 'One export completes and matches the expected timeline fingerprint.',
      status: 'pending',
      notes: '',
    },
    {
      id: 'release_wording_guardrail',
      label: 'External release wording does not claim AppKit/SwiftUI pure-native UI.',
      status: 'pending',
      notes: 'Current architecture is Tauri + Rust native_core + WebView(React/Vite).',
    },
  ],
};

if (!fs.existsSync(manualAcceptancePath)) {
  fs.writeFileSync(
    manualAcceptancePath,
    `${JSON.stringify(defaultManualAcceptance, null, 2)}\n`,
    'utf8',
  );
}

const manualAcceptance = readJson(manualAcceptancePath);

const summarizeStatus = (status) => {
  if (status === 'pass') {
    return '[x]';
  }
  if (status === 'fail') {
    return '[!]';
  }
  return '[ ]';
};

const manualChecks = Array.isArray(manualAcceptance.checks)
  ? manualAcceptance.checks
  : defaultManualAcceptance.checks;
const passedChecks = manualChecks.filter((item) => item.status === 'pass').length;
const failedChecks = manualChecks.filter((item) => item.status === 'fail').length;
const pendingChecks = manualChecks.length - passedChecks - failedChecks;

const renderNotes = (notes) => {
  const text = typeof notes === 'string' ? notes.trim() : '';
  return text.length > 0 ? ` — ${text}` : '';
};

const lines = [
  '# UniFlow macOS Release Checklist',
  '',
  `- Generated At: ${new Date().toISOString()}`,
  `- Build Report: ${buildReportPath}`,
  `- Smoke Report: ${smokeReportPath}`,
  `- Manual Acceptance: ${manualAcceptancePath}`,
  `- Product: ${buildReport.productName ?? 'UniFlow'} ${buildReport.version ?? 'unknown'}`,
  `- Architecture: ${buildReport.architecture?.desktopShell ?? 'unknown'} + ${buildReport.architecture?.nativeCore ?? 'unknown'} + ${buildReport.architecture?.uiRuntime ?? 'unknown'}`,
  `- strictNativeMacOSUI: ${String(buildReport.architecture?.strictNativeMacOSUI ?? 'unknown')}`,
  '',
  '## Automated Checks',
  '',
  `- [${smokeReport.ok ? 'x' : '!'}] macOS smoke preflight completed`,
  `- [x] .app bundle present: ${buildReport.appBundle ?? 'unknown'}`,
  `- [x] DMG artifact count: ${Array.isArray(buildReport.dmgArtifacts) ? buildReport.dmgArtifacts.length : 0}`,
  '',
  '## Manual Acceptance',
  '',
  `- Summary: ${passedChecks}/${manualChecks.length} passed, ${failedChecks} failed, ${pendingChecks} pending`,
];

for (const item of manualChecks) {
  lines.push(`- ${summarizeStatus(item.status)} ${item.label}${renderNotes(item.notes)}`);
}

lines.push('');
lines.push('## Notes');
lines.push('');
lines.push(`- Manual acceptance overall status: ${manualAcceptance.status ?? 'pending'}`);
lines.push(`- Manual acceptance notes:${renderNotes(manualAcceptance.notes) || ' none'}`);

fs.writeFileSync(checklistPath, `${lines.join('\n')}\n`, 'utf8');

console.log('UniFlow macOS release checklist');
console.log(`- build report: ${buildReportPath}`);
console.log(`- smoke report: ${smokeReportPath}`);
console.log(`- manual acceptance: ${manualAcceptancePath}`);
console.log(`- checklist: ${checklistPath}`);
console.log(`- summary: ${passedChecks}/${manualChecks.length} passed, ${failedChecks} failed, ${pendingChecks} pending`);
