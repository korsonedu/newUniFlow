import { existsSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';

const requiredIcons = ['src-tauri/icons/icon.png', 'src-tauri/icons/icon.icns', 'src-tauri/icons/icon.ico'];
const userUploadedPng = 'src-tauri/icons/logo-iOS-Default-1024x1024@1x.png';
const fallbackPng = 'src/assets/branding/uniflow-app-icon-standard.png';

const hasAllIcons = requiredIcons.every((iconPath) => existsSync(iconPath));
const sourcePng = existsSync(userUploadedPng) ? userUploadedPng : fallbackPng;
const sourceExists = existsSync(sourcePng);
const shouldRebuild = sourceExists && hasAllIcons
  ? requiredIcons.some((iconPath) => statSync(iconPath).mtimeMs < statSync(sourcePng).mtimeMs)
  : true;

if (!shouldRebuild && hasAllIcons) {
  console.log('Tauri icons ready.');
  process.exit(0);
}

if (!sourceExists) {
  console.error(`Missing icon source: ${sourcePng}`);
  process.exit(1);
}

console.log('Generating padded Tauri icons for macOS compatibility using native helper...');

try {
  const absSourcePng = realpathSync(sourcePng);
  const processedPngPath = 'src-tauri/icons/.processed_icon.png';
  const swiftHelper = 'process_icon.swift';

  // Use native Swift helper to create a high-quality padded PNG (824px in 1024px)
  execSync(`swift "${swiftHelper}" "${absSourcePng}" "${processedPngPath}"`, { stdio: 'inherit' });

  execSync(`npx tauri icon "${processedPngPath}" -o src-tauri/icons`, { stdio: 'inherit' });
  console.log('Tauri icons generated successfully.');
} catch (error) {
  console.error('Failed to generate Tauri icons:', error.message);
  process.exit(1);
}
