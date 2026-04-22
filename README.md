# UniFlow

UniFlow 是一个事件驱动（Event Sourcing）的教学白板 MVP，核心能力是“可编辑操作时间轴”。

## 当前 macOS 架构口径

- 当前交付形态：`Tauri + Rust native_core + WebView(React/Vite)`
- 当前已具备：macOS 桌面打包、Rust 原生时间轴核心、原生命令桥、原生文件/对话框能力
- 当前未达成：`AppKit/SwiftUI` 级别的纯原生 macOS UI
- 对外描述应使用：
  - “macOS 桌面应用，含原生核心与原生打包，UI 仍由 WebView 承载”
  - 不应描述为“纯原生 macOS UI”或“完全不是 web 套壳”

## 快速开始

```bash
npm install
npm run doctor:macos
npm run dev
```

## 笔迹引擎参数调节（perfect-freehand）

当前 UniFlow 的笔迹主通路已统一为 `perfect-freehand`，包含：
- 白板实时预览
- 白板历史回放（时间轴重放）
- MP4 导出渲染

### 代码入口

- 参数与路径生成：`/Users/eular/Desktop/UniFlow-2/src/application/drawing/perfectStroke.ts`
- 采样与 pressure 入链：`/Users/eular/Desktop/UniFlow-2/src/application/drawing/strokeSampling.ts`
- 白板输入与实时渲染：`/Users/eular/Desktop/UniFlow-2/src/components/canvas/WhiteboardCanvas.tsx`
- 导出渲染：`/Users/eular/Desktop/UniFlow-2/src/utils/mp4Exporter.ts`

### 如何调参数

在 `perfectStroke.ts` 中调整以下函数：
- `resolvePenTuningBySize(size)`
- `resolveHighlightTuningBySize(size)`

每组返回三个核心参数（即 `getStroke` 的第二参数）：
- `thinning`
- `smoothing`
- `streamline`

说明：
- `size` 由工具区粗细档位决定（工具区点选粗细 -> `width` -> world width -> freehand `size`）。
- 笔迹存在真实 pressure 时，使用 `[x, y, pressure]` 输入并强制 `simulatePressure: false`。
- 无真实 pressure 时自动回退 `simulatePressure: true`。

### 当前粗细档位与参数联动

- Pen 粗细档：`2 / 4 / 8`
- Highlight 粗细档：`12 / 20 / 30`

粗细变化不只改 `size`，也会触发不同 tuning 档位（`thinning/smoothing/streamline`）：
- 细笔：更高 `streamline`，优先消除快写折线感
- 中笔：平衡跟手与稳定
- 粗笔/高亮：降低 `thinning`，保持边缘稳定

### 热加载调参测试

```bash
npm run dev:web
```

或（macOS 桌面）

```bash
npm run dev:desktop
```

调参后直接书写即可热更新验证，重点观察：
- 快速长线是否仍有明显折线
- 抬笔后是否出现“消失再固化”
- 录制中是否掉帧卡顿

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
npm run refresh:macos-release
npm run accept:macos -- status
npm run gate:macos-release
```

macOS 人工验收记录：

```bash
npm run accept:macos -- status
npm run accept:macos -- set app_launch_render pass "App launched and first page rendered."
npm run accept:macos -- set recording_timeline_progress pass "Short recording advanced playhead and wrote timeline events."
npm run accept:macos -- notes "Manual verification completed on local macOS desktop session."
npm run refresh:macos-release
npm run gate:macos-release
```

macOS 最短 smoke 回归：

1. 运行 `npm run verify:macos`
2. 打开 `/Users/eular/Desktop/UniFlow-2/src-tauri/target/release/bundle/macos/UniFlow.app`
3. 新建或打开项目，确认第一页正常显示
4. 执行一次最短录制，确认时间轴新增事件、播放头推进正常
5. 执行一次结构编辑（建议：split 或 ripple delete），确认预览仍可回放
6. 执行一次导出，确认任务完成且导出前后一致
7. 读取 `/Users/eular/Desktop/UniFlow-2/.tmp/macos-build-report.json`，确认本次构建产物路径与架构口径
8. 用 `npm run accept:macos -- set ...` 回填人工验收结果，然后执行 `npm run refresh:macos-release && npm run gate:macos-release`

构建报告：

`/Users/eular/Desktop/UniFlow-2/.tmp/macos-build-report.json`

smoke 报告：

`/Users/eular/Desktop/UniFlow-2/.tmp/macos-smoke-report.json`

发布记录：

`/Users/eular/Desktop/UniFlow-2/.tmp/macos-release-record.md`

人工验收记录：

`/Users/eular/Desktop/UniFlow-2/.tmp/macos-manual-acceptance.json`

发布检查清单：

`/Users/eular/Desktop/UniFlow-2/.tmp/macos-release-checklist.md`

原生 UI 迁移清单：

`/Users/eular/Desktop/UniFlow-2/MACOS_NATIVE_UI_MIGRATION_CHECKLIST.md`

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
