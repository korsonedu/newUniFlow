import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import process from 'node:process';

const requiredIcons = ['src-tauri/icons/icon.png', 'src-tauri/icons/icon.icns', 'src-tauri/icons/icon.ico'];
const sourceSvg = 'public/favicon.svg';

const hasAllIcons = requiredIcons.every((iconPath) => existsSync(iconPath));

if (hasAllIcons) {
  console.log('Tauri icons ready.');
  process.exit(0);
}

if (!existsSync(sourceSvg)) {
  console.error(`Missing icon source: ${sourceSvg}`);
  process.exit(1);
}

console.log('Generating Tauri icons from public/favicon.svg ...');
try {
  execSync(`npx tauri icon ${sourceSvg} -o src-tauri/icons`, { stdio: 'inherit' });
  console.log('Tauri icons generated.');
} catch (error) {
  console.error('Failed to generate Tauri icons.');
  process.exit(1);
}
