import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

execSync('npx tsc -p tsconfig.timeline-regression.json', {
  cwd: root,
  stdio: 'inherit',
});

const outDir = path.resolve(root, '.tmp/timeline-regression');
fs.writeFileSync(
  path.resolve(outDir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2),
);
const cliPath = path.resolve(outDir, 'application/timeline/stabilityMatrix.cli.js');
const output = execSync(`node "${cliPath}"`, {
  cwd: root,
  encoding: 'utf8',
});
process.stdout.write(output);
const reportLine = output
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line.startsWith('ReportJSON: '));
if (reportLine) {
  const json = reportLine.slice('ReportJSON: '.length);
  const stabilityOutDir = path.resolve(root, '.tmp/stability');
  fs.mkdirSync(stabilityOutDir, { recursive: true });
  fs.writeFileSync(path.resolve(stabilityOutDir, 'stability-matrix.json'), `${json}\n`);
}
