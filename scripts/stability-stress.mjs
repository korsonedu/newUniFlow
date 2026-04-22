import { spawnSync } from 'node:child_process';

const loopsRaw = Number(process.argv[2] ?? '3');
const loops = Number.isFinite(loopsRaw) && loopsRaw > 0 ? Math.floor(loopsRaw) : 3;

const run = (args) => {
  const startedAt = Date.now();
  const result = spawnSync('npm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  const elapsedMs = Date.now() - startedAt;
  return {
    code: result.status ?? 1,
    elapsedMs,
  };
};

console.log(`[stability-stress] loops=${loops}`);

for (let i = 1; i <= loops; i += 1) {
  console.log(`\n[stability-stress] round ${i}/${loops} -> test:timeline`);
  const timeline = run(['run', 'test:timeline']);
  if (timeline.code !== 0) {
    console.error(`[stability-stress] FAIL round=${i} step=test:timeline elapsedMs=${timeline.elapsedMs}`);
    process.exit(1);
  }
  console.log(`[stability-stress] PASS round=${i} step=test:timeline elapsedMs=${timeline.elapsedMs}`);

  console.log(`\n[stability-stress] round ${i}/${loops} -> test:stability`);
  const matrix = run(['run', 'test:stability']);
  if (matrix.code !== 0) {
    console.error(`[stability-stress] FAIL round=${i} step=test:stability elapsedMs=${matrix.elapsedMs}`);
    process.exit(1);
  }
  console.log(`[stability-stress] PASS round=${i} step=test:stability elapsedMs=${matrix.elapsedMs}`);
}

console.log(`\n[stability-stress] ALL PASS loops=${loops}`);

