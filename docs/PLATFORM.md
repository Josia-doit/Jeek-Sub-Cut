# 平台架构设计

本文件描述 JeekSubCut 源码工程的组织方式与扩展规则。它面向一个明确目标：从字幕剪辑工作台，逐步长成一套完整的视频剪辑软件 —— 多轨道编辑、素材片段、视频特效、转场、人像美颜、画面调色，以及之后新增的任何能力。

这类软件最常见的失败方式不是「做不出来」，而是「加不动」：一个调色面板的改动牵动时间轴、预览、导出三处；删掉一个特效却留下一堆悬空引用。所以整个架构只围绕一条主线：

> **把能力切成互不认识的模块，让它们只通过内核定义的契约对话。**

## 一、三条硬约束

| 约束 | 含义 | 验证方式 |
| --- | --- | --- |
| 可整块插拔 | 一个功能就是一个包；删掉这个包，其余部分仍能构建、仍能运行 | `tools/check-boundaries.mjs` + 删包演练 |
| 单向依赖 | 依赖只能朝下：`apps → features → engine → core → contracts`；禁止反向引用、禁止功能包之间互相引用 | 边界检查脚本，纳入 `npm test` |
| 一键本地构建 | 拿到仓库后 `npm install && npm run build` 就得到可运行产物，不装额外全局工具、不写代码、不下载预编译大文件 | 安装脚本 + 干净环境实测 |

第三条直接决定了工具链选择：仓库用 **npm workspaces**（Node 自带），而不是需要额外安装 pnpm / yarn / turbo 的方案。用户机器上有 Node 18+ 就够了。

## 二、分层总览

```
┌───────────────────────────────────────────────────────────┐
│ apps/                          组装层：把模块拼成程序        │
│   desktop   editor   render-service                         │
├───────────────────────────────────────────────────────────┤
│ features/                      功能模块：可整块增删改         │
│   timeline  subtitles  preview  audio  asr  export         │
│   media  effects  transitions  color  beauty  …            │
│   （每个包只依赖 contracts + core，彼此不认识）              │
├───────────────────────────────────────────────────────────┤
│ engine/                        合成与渲染抽象                │
│   RenderProvider 接口 / 时间轴求值 / 帧求值 / 编解码桥       │
├───────────────────────────────────────────────────────────┤
│ core/                          内核：不认识任何具体功能       │
│   工程文档 / 命令与撤销 / 事件总线 / 模块注册表 / 持久化      │
├───────────────────────────────────────────────────────────┤
│ contracts/                     契约：只有类型与接口，零实现   │
└───────────────────────────────────────────────────────────┘
```

依赖方向严格单向、只朝下。内核不知道「字幕」或「调色」是什么，功能包之间也没有 import 关系。带来的直接结果：新增一个功能 = 新增一个包 + 注册贡献点；删除一个功能 = 删掉这个包，其他包一行都不用改。

## 三、技术栈定案

| 层 | 选型 | 为什么是它 |
| --- | --- | --- |
| 仓库组织 | **npm workspaces monorepo** | Node 自带、零额外工具；一个包就是一块功能，物理上隔离 |
| 语言 | **TypeScript（strict）** | 类型即契约。大型模块化工程里，接口先于实现能挡住绝大多数跨模块破坏 |
| 编辑器 UI | **React + Vite** | 时间轴、参数面板、拖拽交互都是状态密集 UI；生态成熟、构建快、与 Electron 无缝 |
| 状态 | **Zustand（按模块 slice）+ Immer** | 每个模块自己管自己的 slice，不需要一张全局大 reducer；命令 / 快照撤销好接 |
| 数据模型 | **纯 TypeScript 的 ProjectDocument** | 与 UI、渲染、进程都无关的唯一真相源，可序列化、可版本化迁移 |
| 渲染 | **RenderProvider 接口 + 可替换实现** | 字幕动效、视频轨、GPU 特效走不同实现，上层零改动（见 §四.5） |
| 桌面壳 | **Electron** | 多窗口、原生文件对话框、本地文件读写，是最省事的跨平台桌面基座 |
| 边界约束 | **自研 `check-boundaries.mjs`** | 零依赖、能跑在没有装任何 lint 工具的用户机器上，规则随仓库走 |
| 测试 | **`node:test`（契约/单元）+ 行为探针（端到端）** | Node 内置，不需要测试框架也能 `npm test` |
| 构建 | `npm run setup` && `npm start` | 一键安装依赖、二进制与模型，再一键启动，安装结果＝开发工作区 |

**为什么不用「零框架原生 TS」**：后期要做的多轨时间轴、参数化特效面板、拖拽、撤销、设置页，会让零框架方案自己长出一个半成品框架，模块边界反而更模糊。

**为什么不用运行时微前端 / 动态插件加载**：桌面单机应用不需要远程下发模块；编译期分包 + 注册表已经能实现整块插拔，还保留了完整类型检查和 tree-shaking。

## 四、五道解耦机制

### 4.1 契约层（`packages/contracts`）

只有类型、接口、常量，**没有任何实现、没有任何依赖**。所有模块都只 import 这里。改实现不动契约，就不会波及其他模块；要改契约时，类型检查会立刻列出所有受影响点。

核心契约：`ProjectDocument`、`Track`、`Clip`、`Effect`、`Asset`、`Module`、`Contribution`、`Command`、`RenderRequest` / `RenderResult`。

### 4.2 贡献点注册表（Contribution Points）

模块之间**不直接调用**，而是向内核「注册能力」。内核按注册表组装界面与行为：

| 贡献点 | 用途 | 举例 |
| --- | --- | --- |
| `trackTypes` | 声明一种轨道类型及其片段数据结构 | 字幕轨、音频轨、视频轨 |
| `panels` | 注册一个可停靠面板 | 字幕列表、调色面板、特效库 |
| `commands` | 注册一条可撤销命令 | 切分片段、添加字幕、应用 LUT |
| `tools` | 注册工具条按钮 / 快捷键 | 切分、录音、语音转字幕 |
| `inspectors` | 为某种片段提供属性编辑器 | 文字属性、美颜强度 |
| `effects` | 注册一种效果处理器 | 转场、滤镜、调色、美颜 |
| `exporters` | 注册一种导出目标 | MP4、SRT、工程包 |
| `settings` | 注册设置项 | 帧率、后端、缓存目录 |

删掉一个模块 = 它注册的所有贡献点一起消失。其余模块从注册表读能力，不持有对方的引用，因此不会留下悬空依赖。

### 4.3 工程文档是唯一真相源（ProjectDocument）

时间轴上的轨道、片段、效果参数、素材引用、调色 LUT、美颜强度，全都是 `ProjectDocument` 里的纯数据节点。UI 只做投影，渲染引擎只做求值，导出只做序列化。

这一条带来的好处是连锁的：撤销/重做、工程存读、多模块协同（比如「同步」让音频拖动带着字幕走）、跨进程传递，全都变成对同一份数据的操作，不需要模块之间私下同步状态。

数据节点只用稳定的 `id` 互相引用，**不允许对象嵌套引用**。片段通过 `trackId` 归属轨道、通过 `assetId` 引用素材，效果通过 `clipId` 挂载 —— 这是「牵一发不动全身」在数据层的保证。

### 4.4 命令模式 + 快照撤销

所有写操作都封装成 `Command`（`apply` / `invert` / 可选的 `merge`）。内核持有命令栈，负责合并短时间内的连续操作、限制栈深、驱动 Ctrl+Z / Ctrl+Y。模块只提交命令，不自己管撤销状态。

状态快照是整包 `ProjectDocument` 的不可变副本（Immer 结构共享让它的成本很低），因此任何新模块接入撤销都不需要额外适配。

### 4.5 可替换的渲染引擎（RenderProvider）

渲染被抽象成一句话：**给定 `ProjectDocument` 与时间点，返回一帧画面**。

```
RenderProvider.renderFrame({ document, timeMs, width, height }) → Frame
RenderProvider.renderRange({ document, fromMs, toMs, onProgress }) → RenderHandle
```

不同能力可以挂不同实现，互不锁死：

| 实现 | 擅长 | 用于 |
| --- | --- | --- |
| 程序化帧渲染（React 驱动） | 字幕动效、文字排版、矢量图形 | 瀑布流字幕、特效文字 |
| 浏览器解码 + 合成（WebCodecs / WebGL） | 素材片段、实时预览、转场 | 多轨视频编辑 |
| GPU 处理（WebGPU / 着色器） | 画面调色、人像美颜、滤镜 | 后期能力 |
| 编码管线（ffmpeg） | 成片编码、音轨混合、格式封装 | 导出 |

上层只面对接口。将来把字幕渲染从「React 帧渲染」升级为「WebGPU 合成」，或者为调色新增一条 GPU 流水线，都不需要改时间轴、面板、导出模块。

### 4.6 稳定的进程边界

桌面主进程、编辑器窗口、渲染服务之间使用**版本化的 JSON / HTTP 契约**（`/api/v1/...`）。渲染、识别、GPU 处理这类重任务放在独立进程，界面不会被长任务卡住；契约带版本号，服务端升级时旧客户端能明确收到不兼容提示，而不是静默错位。

## 五、模块包规范

每个功能包都是自洽的最小单元：

```
packages/features/<name>/
├─ package.json          只声明 @jeek/contracts、@jeek/core 依赖
├─ src/
│  ├─ index.ts           唯一公共出口：导出一个 Module 定义
│  ├─ contributions.ts   贡献点声明
│  ├─ commands.ts        该模块的可撤销命令
│  ├─ panel.tsx          UI（若有）
│  └─ …                  内部实现，外部不可见
└─ README.md             这个模块负责什么、贡献了什么
```

三条规矩：

1. **只有一个公共出口**：包外只能 `import { … } from '@jeek/feature-xxx'`，禁止深路径 import 内部文件。
2. **依赖声明即边界**：功能包的 `package.json` 里不允许出现其他功能包；只能依赖 `contracts` 与 `core`（需要渲染能力时加 `engine`）。
3. **不持有全局可变状态**：所有状态放进 `ProjectDocument` 或自己的 slice，通过事件总线广播变化。

### 唯一模块清单

组装层不直接引用任何功能包。`apps/editor/src/modules.config.ts` 是唯一的启用清单，当前启用 `timeline / subtitles / preview / audio / asr / export` 六个模块，界面里的工具栏、面板、检查器、设置项与导出格式全部由它们的贡献点生成。增删功能只改这一个文件：清单里删掉一行，对应模块的贡献点、面板与按钮一起消失，其余功能包、内核、引擎一行都不用改。

## 六、边界强制（`tools/check-boundaries.mjs`）

零依赖脚本，扫描所有 `packages/` 与 `apps/` 源码的 import 语句并断言：

| 规则 | 禁止的情况 |
| --- | --- |
| 层级单向 | `core` 引用 `engine` / `features` / `apps`；`contracts` 引用任何实现包 |
| 功能隔离 | `features/*` 引用另一个 `features/*` |
| 公共出口 | 跨包使用深路径 `@jeek/xxx/src/…` |
| 依赖声明 | 代码里 import 了包，但 `package.json` 没声明 |

它跑在 `npm test` 里，也在构建前跑一次。规则随仓库走，用户机器上不需要装 ESLint 也能守住架构。

## 七、能力演进：每项新功能怎么「整块插入」

| 未来能力 | 新增包 | 贡献点 | 数据模型扩展 | 渲染实现 |
| --- | --- | --- | --- | --- |
| 多轨视频编辑 | `features/media` | `trackTypes:video` / `inspectors` / `tools` | `Asset`、`VideoClip`（源内偏移、变换） | WebCodecs 解码 + 合成 |
| 视频特效 | `features/effects` | `effects` / `panels` / `inspectors` | `Effect` 节点挂到 `clipId` | 着色器 / 帧后处理 |
| 转场 | `features/transitions` | `effects:transition` / `panels` | `Transition` 节点挂到两片段交界 | 双源混合求值 |
| 画面调色 | `features/color` | `panels` / `inspectors` / `effects:color` | `ColorGrade`（LUT、曲线、HSL） | GPU 色彩流水线 |
| 人像美颜 | `features/beauty` | `panels` / `inspectors` / `effects:beauty` | `BeautyParams` | GPU 人脸处理流水线 |
| 音频与录音 | `features/audio` ✓ | `trackTypes:audio` / `panels` / `tools` / `inspectors` | `{startMs,endMs,inMs}`、峰值波形 | WebAudio 按片段重建音轨 |
| 语音转字幕 | `features/asr` ✓ | `tools` / `panels` / `settings` | 复用 `SubtitleClip` | 渲染服务调本地识别引擎 |
| 画面与动效 | `features/preview` ✓ | `panels` / `tools` / `settings` / `effects` | 按帧求值、堆叠与旋转 | Canvas 绘制 + captureStream 导出 |
| 导出 | `features/export` ✓ | `exporters` / `panels` / `settings` | 码率、格式、音轨开关 | 服务端 ffmpeg 转码 |

已落地的六块都遵循同一套路：包内只声明贡献点，界面按贡献点渲染，行为通过 `core` 的纯文档变换落到唯一真相源。未来能力沿用同一入口。

每一行都只做「加一个包 + 注册贡献点 + 在数据模型里加节点」。已存在的包不需要为了新功能改代码 —— 这正是「模块化」要买的保险。

## 八、构建与运行

仓库根双击 `安装依赖.bat`（命令行等价 `npm run setup`），一次完成全部环境准备：

```bash
npm ci               # 按 package-lock.json 装依赖，版本与开发机一致
npm run build        # 编译 contracts/core/engine/features + 构建编辑器
npm test             # 边界检查 + 契约 / 行为 / 端到端回归（37 项）
npm run test:types   # 编辑器 TypeScript 严格检查
node tools/install-deps.mjs   # 按 install/deps.json 下载并解包运行时与模型
```

构建产物落在各包的 `dist/` 与 `apps/editor/dist/`；运行时（Electron、ffmpeg、识别引擎与模型）落在 `resources/`，两者都不入库。安装结果写在 `resources/install-state.json`，已装组件自动跳过，支持断点续传、sha256 校验与多镜像回退。最终目录结构与开发工作区 `app/` 一致。

双击 `启动.bat`（命令行等价 `npm start`）后，`tools/launch.mjs` 按固定顺序组装程序：

1. 在独立进程启动渲染服务 `127.0.0.1:5174`，等 `/api/v1/health` 就绪；
2. 用内置静态服务把 `apps/editor/dist/` 挂在 `127.0.0.1:5173`（`--dev` 时改走 Vite 热更新）；
3. 检测到 Electron 运行时就开桌面窗口，否则自动退回系统浏览器；
4. 桌面壳通过 `JEEK_EDITOR_URL` / `JEEK_RENDER_URL` 复用已经启动的服务，不重复占端口；
5. 关闭窗口或 Ctrl+C 时，托管进程一并收干净。

```bash
npm run start:dev      # 热更新
npm run start:browser  # 强制浏览器
npm run check:launch   # 只检查安装状态
npm run check:deps     # 只探测镜像可达性
npm run smoke          # 真起服务：健康 / 页面 / 渲染 / 识别 / 转码 / 404（10 项）
npm run smoke:desktop  # 再加真起 Electron 窗口与界面行为断言（28 项）
```

渲染服务对外提供 `/api/v1/health`、`/api/v1/render`、`/api/v1/render/:id/progress`、`/api/v1/asr` 与 `/api/v1/media/transcode`。识别与转码都把重任务放在独立进程，界面只负责发请求与显示进度。

源码构建与二进制下载解耦：换镜像、换版本只改 `install/deps.json`；改启动方式只动 `tools/launch.mjs`。

## 九、回归测试策略

三层，从快到慢：

1. **契约与边界**（`npm test`）：数据文档增删改、命令撤销/重做、模块注册与卸载、渲染请求校验、依赖方向。纯 Node，毫秒级。
2. **模块行为**：每个功能包自己的单元测试，只测公开出口。
3. **端到端行为探针**：真实启动程序，用 CDP 驱动界面，断言时间轴、预览、导出、识别等可观察行为。旧版已经积累了一整套行为探针，作为「用户可见行为」的基线标尺；新版模块逐个对齐，详见 `docs/REGRESSION.md`（开发侧文档）。

规矩：**改完必须真跑那条执行路径**。语法检查与静态断言查不出运行期问题，也不接受只报「编译通过」。

## 十、安全边界

- 本地服务只监听 `127.0.0.1`，端口随机。
- 渲染进程 `contextIsolation: true`，只暴露白名单桥方法；任意路径读写走主进程对话框。
- 外链只放行 `http/https`，`setWindowOpenHandler` 默认拒绝。
- 工程文件读写由主进程代理，前端不持有任意路径写权限。
