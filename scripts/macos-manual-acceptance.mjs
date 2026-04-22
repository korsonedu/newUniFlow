import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const tmpDir = path.join(root, '.tmp');
const manualAcceptancePath = path.join(tmpDir, 'macos-manual-acceptance.json');

const defaultManualAcceptance = () => ({
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
});

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const ensureTmpDir = () => {
  fs.mkdirSync(tmpDir, { recursive: true });
};

const deriveOverallStatus = (checks) => {
  if (!Array.isArray(checks) || checks.length === 0) {
    return 'pending';
  }
  if (checks.some((item) => item.status === 'fail')) {
    return 'fail';
  }
  if (checks.every((item) => item.status === 'pass')) {
    return 'pass';
  }
  return 'pending';
};

const readManualAcceptance = () => {
  ensureTmpDir();
  if (!fs.existsSync(manualAcceptancePath)) {
    const initial = defaultManualAcceptance();
    fs.writeFileSync(manualAcceptancePath, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
    return initial;
  }
  const parsed = JSON.parse(fs.readFileSync(manualAcceptancePath, 'utf8'));
  const fallback = defaultManualAcceptance();
  const checks = Array.isArray(parsed.checks) && parsed.checks.length > 0
    ? parsed.checks
    : fallback.checks;
  return {
    generatedAt: parsed.generatedAt || fallback.generatedAt,
    updatedAt: parsed.updatedAt || fallback.updatedAt,
    status: deriveOverallStatus(checks),
    notes: typeof parsed.notes === 'string' ? parsed.notes : '',
    checks,
  };
};

const writeManualAcceptance = (manualAcceptance) => {
  const normalized = {
    ...manualAcceptance,
    status: deriveOverallStatus(manualAcceptance.checks),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manualAcceptancePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
};

const printStatus = (manualAcceptance) => {
  const checks = Array.isArray(manualAcceptance.checks) ? manualAcceptance.checks : [];
  const passed = checks.filter((item) => item.status === 'pass').length;
  const failed = checks.filter((item) => item.status === 'fail').length;
  const pending = checks.length - passed - failed;

  console.log('UniFlow macOS manual acceptance');
  console.log(`- file: ${manualAcceptancePath}`);
  console.log(`- status: ${manualAcceptance.status}`);
  console.log(`- summary: ${passed}/${checks.length} passed, ${failed} failed, ${pending} pending`);
  console.log(`- updatedAt: ${manualAcceptance.updatedAt}`);
  for (const check of checks) {
    console.log(`- ${check.id}: ${check.status} | ${check.label}${check.notes ? ` | ${check.notes}` : ''}`);
  }
  if (manualAcceptance.notes) {
    console.log(`- notes: ${manualAcceptance.notes}`);
  }
};

const command = process.argv[2] ?? 'status';
const manualAcceptance = readManualAcceptance();

if (command === 'status') {
  printStatus(manualAcceptance);
  process.exit(0);
}

if (command === 'set') {
  const checkId = process.argv[3];
  const nextStatus = process.argv[4];
  const note = process.argv.slice(5).join(' ').trim();
  if (!checkId || !nextStatus) {
    fail('Usage: node ./scripts/macos-manual-acceptance.mjs set <checkId> <pass|fail|pending> [note]');
  }
  if (!['pass', 'fail', 'pending'].includes(nextStatus)) {
    fail(`Invalid status "${nextStatus}". Expected one of: pass, fail, pending.`);
  }
  const nextChecks = manualAcceptance.checks.map((item) => (
    item.id === checkId
      ? { ...item, status: nextStatus, notes: note || item.notes || '' }
      : item
  ));
  if (!nextChecks.some((item) => item.id === checkId)) {
    fail(`Unknown check id "${checkId}".`);
  }
  const updated = writeManualAcceptance({
    ...manualAcceptance,
    checks: nextChecks,
  });
  printStatus(updated);
  process.exit(0);
}

if (command === 'notes') {
  const note = process.argv.slice(3).join(' ').trim();
  const updated = writeManualAcceptance({
    ...manualAcceptance,
    notes: note,
  });
  printStatus(updated);
  process.exit(0);
}

if (command === 'reset') {
  const updated = writeManualAcceptance(defaultManualAcceptance());
  printStatus(updated);
  process.exit(0);
}

fail('Supported commands: status, set, notes, reset');
