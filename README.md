# UniFlow

UniFlow 是一个事件驱动（Event Sourcing）的教学白板 MVP，核心能力是“可编辑操作时间轴”。

## 快速开始

```bash
npm install
npm run doctor:macos
npm run dev
```

## Web 构建

```bash
npm run build
```

## 多平台分发策略（轻量）

- 发布顺序锁定：`macOS -> iPadOS -> Windows`
- macOS：Tauri 原生包（`.app` / `.dmg`）
- iPadOS：Capacitor iOS 容器应用，或直接安装 PWA
- Windows：Tauri 原生包（`.msi` / `nsis`）

说明：
- 桌面端使用 Tauri，减少运行时体积，避免 Electron 级别臃肿。
- iPad 端同时支持 App 容器和 PWA 分发，按渠道灵活选择。
- 当不强制原生安装包时，macOS / Windows 也可直接用 PWA 安装。

发布顺序门禁（脚本）：

```bash
npm run rollout:status
npm run verify:macos
npm run verify:ipados
npm run verify:windows
```

说明：
- `verify:ipados` 仅在 `verify:macos` 成功后允许。
- `verify:windows` 仅在 `verify:ipados` 成功后允许。
- 可用 `npm run rollout:reset` 重置阶段状态。

## 桌面端（Tauri）

前置依赖（桌面打包）：

```bash
brew install rustup-init
rustup-init -y
source $HOME/.cargo/env
```

开发调试：

```bash
npm run dev:desktop
```

macOS 一键调试（带依赖检查 + 详细日志）：

```bash
npm run dev:macos:debug
```

说明：
- 该命令会自动检查 `rustc/cargo`，缺失时会给出安装指引并中止。
- 桌面端命令会自动执行图标预检，若缺失会从 `public/favicon.svg` 自动生成 Tauri 所需图标。
- 默认注入 `RUST_BACKTRACE=1`、`RUST_LOG=info`，Rust 崩溃栈和运行日志会直接输出在终端。
- 前端日志在 Tauri 窗口 DevTools（开发模式）查看。
- 如果只想看最终打包行为，可追加 `--release`：`npm run dev:macos:debug -- --release`

常见错误排查：
- `failed to open icon ... src-tauri/icons/icon.png`
  - 执行：`npm run desktop:prepare`
  - 然后重试：`npm run dev:macos:debug`

打包：

```bash
npm run build:desktop:mac
npm run build:desktop:win
```

macOS 发布验证（推荐）：

```bash
npm run verify:macos
```

构建产物目录：

`src-tauri/target/release/bundle/`

## iPadOS（Capacitor）

同步 Web 资源到 iOS 工程：

```bash
npm run mobile:sync
```

打开 Xcode 工程（用于 TestFlight / App Store 分发）：

```bash
npm run mobile:ipad
```

iPadOS 发布验证（需先完成 macOS）：

```bash
npm run verify:ipados
```

## PWA

项目已启用 `vite-plugin-pwa`，构建后的 Web 版本可在支持的浏览器中安装为应用。
