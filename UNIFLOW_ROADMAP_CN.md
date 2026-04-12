# UniFlow 路线图（执行基线）
更新时间：2026-04-12  
适用范围：`/Users/eular/Desktop/UniFlow-2` 全仓

## 1. 执行规则（从现在开始强制）
1. 不再做“单点修补式”改动，所有改动必须挂靠到本路线图条目。  
2. 每次开发按优先级执行：`T0 > T1 > T2`。  
3. 每个条目必须满足“可验证验收标准”，并通过命令验证。  
4. 时间轴相关功能必须保持“单一真值”：状态只由事件重放得到。  
5. 结构性编辑（split/delete/ripple/insert-gap/retime）必须事务化、可 undo/redo。
6. 平台交付顺序固定：`macOS -> iPadOS -> Windows`，不得跳步。

---

## 2. 当前状态总览
- 已完成（核心基线）：
  - 时间轴命令事务化：`delete_range/ripple_delete/split/delete_future/move_event/insert_gap/delete_event/insert_event`
  - 录制主时钟与画布输入时钟统一（共享 runtime）
  - 导出作业队列化（取消/重试/进度）
  - 导出时基一致性断言（fingerprint + duration/event/audio max）
  - 主时钟播放漂移自动校正（preview 播放期 drift stabilize）
  - 项目层/录制层文件选择流程接入平台 `dialog` 适配
  - 时间轴回归测试脚本：`npm run test:timeline`（当前 10 条用例通过）
  - 平台抽象新增：`audioContext/frameScheduler`，音频上下文与帧调度从 UI/引擎直连中收敛
  - 导出链路接入平台 `ExportAdapter`，应用层不再直接落盘
  - 工作栏参数模型收敛：`ToolParameterModel(color/width/opacity/smoothing/snap)` 已接入画布
  - 原生迁移 Phase-1：Rust `native_core`（时间轴引擎）+ Tauri 时间轴命令桥 + 前端 `NativeTimelineAdapter`（自动降级到 TS 引擎）
  - 发布顺序门禁：新增 `scripts/release-lane.mjs`，支持 `require/mark/status/reset`，执行顺序强制为 `macOS -> iPadOS -> Windows`
  - 仓库基线提交：`763642d`（本地主分支 `main`，工作区已清洁）
- 进行中：
  - 代码层统一错误返回（`Result<T,E>`）与错误码收敛
  - 平台能力进一步抽象（file/dialog/audio/export）
  - GitHub 远端推送阻塞：已配置 `origin=git@github.com:korsonedu/newUniFlow.git`，待机器完成 GitHub 认证后执行 `git push -u origin main`

---

## 3. T0（最高优先，必须先收口）

## T0-1 工具区重构（ToolWorkbench）
目标：工具互斥、切换无副作用、状态机驱动。  
范围：`src/components/canvas/*`, `src/application/tools/*`

- 交付项
  - 工具状态机统一为 `idle -> drawing -> committing`
  - 工具参数模型统一：颜色/粗细/透明度/平滑度/吸附
  - 所有工具动作写入时间轴事件
- 验收标准
  - 工具切换时无残留临时态
  - 暂停状态下动作为点事件，不产生错误时长块

状态：进行中（基础完成，参数模型已统一，交互细节待收敛）
进度补充（2026-04-12）：
- 录制层返回键重构为顶栏 icon-only，不再压住白板工具区。
- ToolWorkbench 升级为“主工具 + 二级弹出菜单”形态，支持 Apple 风格轻量 popover。
- 新增高亮笔工具（独立颜色/粗细/透明度参数），并接入时间轴事件流。
- 工具二级功能已接入实际逻辑：笔迹平滑、对象网格吸附、橡皮半径。
- 录制层进一步改为单行 overlay 结构，返回键与工具区同一水平层级，释放垂直空间。
- 修复二级菜单层级与遮挡：工具弹出菜单提升到白板顶层，避免被画布与轨道遮挡。

## T0-2 操作区重构（OperationBar）
目标：录制/播放/编辑/导出状态统一驱动按钮可用性。  
范围：`src/components/timeline/*`, `src/application/operations/*`

- 交付项
  - 操作区状态机：`idle/recording/playing/editing/exporting`
  - 按状态禁用无效按钮，杜绝“可点无效”
- 验收标准
  - 所有按钮行为在状态切换后一致

状态：已完成第一版（继续做细节校正）
进度补充（2026-04-12）：
- OperationBar 改为分组式单行布局（录制/播放、录制模式、剪辑、吸附、时钟），减少按钮堆叠感。
- 操作区与时间码视觉分层重构，保证一屏内可读性与点击密度。

## T0-3 主时钟内核（MasterClock + RecordingClock）
目标：音频、播放头、事件重放、导出统一时基。  
范围：`src/application/clock/*`, `src/components/timeline/*`, `src/components/canvas/*`, `src/utils/mp4Exporter.ts`

- 交付项
  - 录制、预览、导出统一时间基
  - 去除 `performance.now()` 与音频时钟混用引起的漂移
- 验收标准
  - 长时间播放/录制后音画偏差可控（无累积漂移）
  - 导出与预览关键时间点一致

状态：进行中（核心链路完成，继续压测）
进度补充（2026-04-12）：
- 新增主时钟回归用例 `master_clock_seek_reanchor`，覆盖“播放中 seek 后锚点重绑”场景，防止 seek 后漂移校正误触发。

## T0-4 时间轴编辑事务化
目标：结构编辑命令原子化，undo/redo 以事务为单位。  
范围：`src/application/timeline/transactions.ts`, `src/store/useWhiteboardStore.ts`

- 交付项
  - 全命令走统一事务执行器
  - 事务元数据完整保留到历史栈
- 验收标准
  - 任意命令序列可稳定 undo/redo
  - 不出现状态断裂和播放头非法跳变

状态：已完成（持续补回归）

## T0-5 导出作业系统（ExportJobService）
目标：导出后台化、可恢复、可追踪。  
范围：`src/application/export/*`, `src/store/useExportJobStore.ts`, `src/App.tsx`

- 交付项
  - 队列、取消、重试、失败可恢复
  - 导出前一致性断言
- 验收标准
  - 导出不中断主编辑流
  - 失败有明确错误信息

状态：已完成第一版（后续补历史记录与持久化）

## T0-6 代码分层强约束
目标：`domain/application/infrastructure/ui` 依赖方向清晰。  
范围：全仓

- 交付项
  - 平台能力统一从 `infrastructure/platform` 提供
  - UI 不直接依赖底层实现细节
- 验收标准
  - 新增功能可在不改 UI 的情况下替换平台实现

状态：进行中（已抽出 fileSave，继续扩展）
进度补充：已新增 `audioIO/dialog/audioContext/frameScheduler/exportAdapter` 平台模块并接入录制输入、回放/预览帧调度、导出与落盘解耦。
进度补充（UI 统一化）：新增 `components/ui` 轻量 Cupertino 原子组件层（首个组件 `CupertinoSwitch`），用于统一开关语义与视觉规范，避免引入重型第三方 UI 库。
进度补充（原生化）：新增 `src-tauri/src/native_core/*` 与 `native_timeline_*` Tauri 命令，前端新增 `src/infrastructure/platform/nativeTimeline.ts` 作为原生优先引擎适配层（失败自动回退 TS）。
进度补充（平台节奏）：`platform-doctor` 新增目标模式（`macos/ipados/windows`），配套 `verify:macos/verify:ipados/verify:windows` 脚本门禁。

---

## 4. T1（高优先）

## T1-1 笔迹与图形质量
- 高精采样、曲线拟合、压感/速度映射预留接口
- 形状对象化扩展（矩形/圆/箭头/文本）
- 验收：放大后笔迹平滑、对象编辑稳定

## T1-2 课件保真链路
- PDF/PPT/PPTX 分层导入策略（原生优先，前端兜底）
- 页面背景与缩略图缓存统一
- 验收：分页正确、清晰度可控、导入稳定

## T1-3 性能与线程化
- 波形计算、缩略图、笔迹后处理迁移 Worker/OffscreenCanvas
- 验收：录制/编辑主链路接近 60fps，播放卡顿显著下降

## T1-4 测试体系
- 属性测试：时间轴命令组合与可逆性
- 回放一致性测试：同输入同输出
- 导出一致性回归：预览与导出关键帧对齐
- 当前基线：`npm run test:timeline`（持续扩展）
  - 当前覆盖：事务可逆、录制历史边界、导出一致性与关键帧一致性
  - 新增覆盖：主时钟漂移校正（单轮 + 多轮节流校正）
  - 新增覆盖：结构编辑后预览/导出状态与音频活动窗口一致性

## T1-5 平台适配层
- 统一 `PlatformAdapter(file/dialog/audio/export)`，覆盖 macOS/iPadOS/Windows
- 验收：平台行为一致，差异点可配置

---

## 5. T2（中优先）
- 可观测性：性能埋点、导出链路 tracing、错误分级上报
- CI 门禁：lint/typecheck/test/build 跨平台矩阵
- 项目层生产化：模板、批量编排、导出预设

---

## 6. 迭代节奏（按此执行）
每一轮迭代固定流程：
1. 选取本路线图最高优先未完成条目  
2. 完成代码实现  
3. 运行验证命令：  
   - `npm run typecheck`  
   - `npm run test:timeline`  
   - `npm run build`  
4. 更新本文件“状态”与“下一轮目标”

---

## 7. 下一轮固定目标（锁定）
1. `macOS First`：先完成 macOS 发布闭环（开发调试、验证、打包、回归）  
2. `T0-6`：将时间轴核心路径逐步切到 `NativeTimelineAdapter`（先 `getStateAtTime/insert/delete/ripple`，再命令事务）  
3. `T0-3`：主时钟压测与边界修正（长录制/长播放/导出一致性）  
4. `iPadOS Second`：在 macOS 完成后推进 iPadOS（手势、Pencil、稳定性）  
5. `Windows Last`：最后收口 Windows 打包与运行一致性

---

## 8. 仓库协作与发布执行清单（新增）
1. 远端仓库：`https://github.com/korsonedu/newUniFlow`  
2. 分支基线：`main`（后续功能分支建议 `codex/*`）  
3. 推送前固定命令：  
   - `npm run typecheck`  
   - `npm run test:timeline`  
   - `npm run rollout:status`  
4. 平台验证闸门：  
   - `npm run verify:macos`  
   - `npm run verify:ipados`（必须在 macOS 完成后）  
   - `npm run verify:windows`（必须在 iPadOS 完成后）  
5. 每轮提交后必须同步更新本路线图：  
   - 已完成项（含日期）  
   - 当前阻塞项  
   - 下一轮 Top-3 目标
