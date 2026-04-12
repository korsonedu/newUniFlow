import fs from 'node:fs';
import path from 'node:path';

const ORDER = ['macos', 'ipados', 'windows'];
const ROOT = process.cwd();
const STATE_DIR = path.join(ROOT, '.tmp');
const STATE_PATH = path.join(STATE_DIR, 'platform-rollout.json');

const nowIso = () => new Date().toISOString();

const normalizeTarget = (raw) => String(raw || '').trim().toLowerCase();

const ensureStateDir = () => {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
};

const defaultState = () => ({
  version: 1,
  updatedAt: nowIso(),
  done: {
    macos: null,
    ipados: null,
    windows: null,
  },
});

const readState = () => {
  if (!fs.existsSync(STATE_PATH)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return defaultState();
    }
    return {
      version: 1,
      updatedAt: parsed.updatedAt || nowIso(),
      done: {
        macos: parsed.done?.macos ?? null,
        ipados: parsed.done?.ipados ?? null,
        windows: parsed.done?.windows ?? null,
      },
    };
  } catch {
    return defaultState();
  }
};

const writeState = (state) => {
  ensureStateDir();
  const payload = {
    ...state,
    updatedAt: nowIso(),
  };
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const assertTarget = (target) => {
  if (!ORDER.includes(target)) {
    console.error(`Unknown target "${target}". Expected one of: ${ORDER.join(', ')}`);
    process.exit(1);
  }
};

const previousTargets = (target) => {
  const index = ORDER.indexOf(target);
  return ORDER.slice(0, Math.max(0, index));
};

const canProceed = (state, target) => {
  const blockers = previousTargets(target).filter((name) => !state.done[name]);
  return {
    ok: blockers.length === 0,
    blockers,
  };
};

const printStatus = (state) => {
  console.log('UniFlow Platform Rollout Lane');
  console.log(`State file: ${STATE_PATH}`);
  console.log(`Updated: ${state.updatedAt}`);
  for (const target of ORDER) {
    const mark = state.done[target] ? 'DONE' : 'TODO';
    console.log(`- ${target}: ${mark}${state.done[target] ? ` (${state.done[target]})` : ''}`);
  }
};

const main = () => {
  const [actionRaw, targetRaw] = process.argv.slice(2);
  const action = String(actionRaw || 'status').trim().toLowerCase();
  const target = normalizeTarget(targetRaw);
  const state = readState();

  if (action === 'status') {
    printStatus(state);
    return;
  }

  if (action === 'reset') {
    writeState(defaultState());
    console.log('Platform rollout state reset.');
    return;
  }

  if (action === 'require') {
    assertTarget(target);
    const check = canProceed(state, target);
    if (!check.ok) {
      console.error(
        `Target "${target}" is blocked. Complete first: ${check.blockers.join(', ')}`,
      );
      process.exit(1);
    }
    console.log(`Target "${target}" is allowed.`);
    return;
  }

  if (action === 'mark') {
    assertTarget(target);
    const check = canProceed(state, target);
    if (!check.ok) {
      console.error(
        `Cannot mark "${target}" done. Complete first: ${check.blockers.join(', ')}`,
      );
      process.exit(1);
    }
    const nextState = {
      ...state,
      done: {
        ...state.done,
        [target]: nowIso(),
      },
    };
    writeState(nextState);
    console.log(`Marked "${target}" as done.`);
    return;
  }

  console.error(`Unknown action "${action}". Use: status | require <target> | mark <target> | reset`);
  process.exit(1);
};

main();
