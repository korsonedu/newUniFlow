import { execSync, spawn } from 'node:child_process';
import process from 'node:process';

const isDarwin = process.platform === 'darwin';

if (!isDarwin) {
  console.error('当前脚本仅用于 macOS 调试。');
  process.exit(1);
}

const hasCommand = (cmd) => {
  try {
    execSync(`${cmd} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const missing = [];
if (!hasCommand('rustc')) {
  missing.push('rustc');
}
if (!hasCommand('cargo')) {
  missing.push('cargo');
}

if (missing.length > 0) {
  console.error(`缺少依赖: ${missing.join(', ')}`);
  console.error('请先执行以下命令安装 Rust 工具链：');
  console.error('  brew install rustup-init');
  console.error('  rustup-init -y');
  console.error('  source $HOME/.cargo/env');
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
const child = spawn('npm', ['run', 'dev:desktop', '--', '--verbose', ...extraArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? '1',
    RUST_LOG: process.env.RUST_LOG ?? 'info',
  },
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
