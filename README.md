# 拾拾 / Pip

**A little companion for the work between the work.**

一个面向产品经理的课程项目原型：把会议记录变成清晰摘要，单独捡出发送邮件、安排跟进、分享更新等零碎事务，让 PM 查看、修改并批准后再交给助手处理。

产品定位、英文 value proposition、MVP 路线与验证指标见 [产品计划](docs/PRODUCT_PLAN.md)。

## 桌面版：宠物 + 会议录音转写

桌面版让 Pip 悬浮在其他应用上方，可以拖动位置，点击打开会议面板。选择麦克风和电脑会议声音，主动开始录音；文本约每 20 秒一段更新，再用于生成摘要和任务建议。转写调用 OpenAI，需要配置 API key，不是逐字实时字幕。

```bash
npm install
npm run desktop
```

若还没有 `.env`，先把 `.env.example` 复制为 `.env`，填入 `OPENAI_API_KEY`；桌面版不需要 `EXTENSION_ID`，也不需要另外运行 `npm start`。没有 key 时可以打开桌面界面，但不能调用语音转写。

macOS 录制系统声音建议使用打包后的应用，让系统权限归属 Pip：

```bash
npm run desktop:package
```

详细启动、应用路径、权限设置和第一次录音测试见 [桌面版使用说明](docs/DESKTOP.md)。Chrome 扩展和网页预览仍可按下面的方式独立使用。

## 网页与扩展功能

- 粘贴会议记录，或载入示例会议，查看摘要、主要行动项和零碎任务。
- 查看任务对应的原文证据，修改草稿，批准或忽略任务。
- 批准后完成本地草稿生成（演示委托流程），可复制或下载文本；不会发送邮件、创建日历事件或发布消息。
- 在本地保存工作状态；提供可拖动的小宠物和 Chrome 侧边栏入口。
- 默认使用本地规则演示分析；可选择通过本地服务调用真实 AI。

网页与扩展不录音，也不自动读取网页或会议字幕；桌面版仅在用户点击开始后录音。“演示分析”是规则匹配，不代表真实 AI 的理解能力；估算耗时也不是已测得的节省时间。

## 可选：安装 Chrome extension

1. 打开 `chrome://extensions`，开启右上角的 **Developer mode / 开发者模式**。
2. 点击 **Load unpacked / 加载已解压的扩展程序**，选择本项目的 `extension` 文件夹，**不要选项目根目录**。完整路径为 `/Users/sujinlu/CS177Project/extension`。
3. 将 Pip 固定在工具栏，打开普通的 HTTP/HTTPS 网页，点击 Pip 图标。
4. 在侧边栏粘贴会议记录；网页中的宠物可以拖动，点击宠物可再次打开侧边栏。

需要 Chrome 116 或更新版本。Chrome 内部页面等受限页面不能注入宠物，请在普通网页上试用。宠物仅在用户主动点击扩展后出现在当前网页中，不会出现在所有应用之上。侧边栏是 Chrome 提供的扩展能力，参见 [Chrome Side Panel 文档](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)。

扩展入口是 `extension/sidepanel.html`，通过 `manifest.json` 的 `side_panel.default_path` 注册；后台脚本处理工具栏点击，`content.js` 把宠物放到当前网页。

默认演示模式无需启动本地服务，也不需要打开 localhost 网页。真实 AI 模式需要在本机保持 `npm start` 运行。

## 可选：网页预览 / 本地 AI 服务

需要 Node.js；建议使用 Node 24 或更新版本。网页预览和本地 AI 服务只使用 Node 内置模块；`npm install` 是桌面版所需的安装步骤。

```bash
npm start
```

打开 <http://localhost:4173>。这是开发用网页预览；真正的扩展通过上面的 Chrome 加载步骤使用。

```bash
npm test
```

此前网页与扩展版本已通过 22 项 Node 测试，以及宽屏和 360px 窄屏的 Playwright 浏览器冒烟检查，覆盖审批、编辑、忽略与恢复、下载、持久化、导航、宠物拖动、AI 错误、新会议和重置。另外已在独立 Chrome 156 测试环境中实际加载未打包扩展，验证工具栏点击、网页宠物注入、原生 360px 侧边栏、编辑后批准草稿，以及任务徽标从 4 更新为 3；未修改个人 Chrome 配置。桌面录音的验证范围见 [桌面版使用说明](docs/DESKTOP.md)。

## 可选：接入真实 AI

1. 将 `.env.example` 复制为 `.env`。
2. 在 `.env` 填写 `OPENAI_API_KEY`；`OPENAI_MODEL` 可按账户可用模型调整，默认示例为 `gpt-4o-mini`。
3. 若在扩展中使用 AI，从 `chrome://extensions` 的 Pip 卡片复制扩展 ID，填入 `.env` 的 `EXTENSION_ID`。本地网页预览不需要这项配置。
4. 启动或重新启动 `npm start`。
5. 在界面中主动选择 AI 分析模式，再提交会议记录。

API key 只由本地 Node 服务读取，不应写入扩展代码、浏览器存储或提交到 Git。AI 分析会将用户提交的会议文本发送给 OpenAI；演示模式在浏览器中运行。没有配置 key 或请求失败时，界面会显示错误，不会把演示结果伪装成 AI 结果。

AI 在桌面版中还负责语音转写。邮件、日历、Slack 等真实执行接口仍是后续开发项。

## 两分钟课堂演示

1. 载入示例会议，说明 PM 的主要决策与会后行政事务是两类不同的工作。
2. 分析记录，展示摘要与任务列表。
3. 打开一项任务，展示原文证据，修改邮件或更新草稿。
4. 批准一个任务，复制或下载生成的本地草稿；忽略另一项，说明用户始终掌握执行权。
5. 拖动小宠物，展示它作为轻量入口的体验。

当前只保留一场会议；添加新会议会替换旧会议的任务和操作记录。任务与草稿保存在当前浏览器的本地存储中，网页预览与扩展的状态不会自动互通，也不支持多个窗口同时编辑。请用示例或脱敏内容演示；如需清空，可使用界面重置功能或清除该来源的浏览器存储。

## 代码入口

| 文件 | 用途 |
| --- | --- |
| `desktop/main.cjs`、`preload.cjs` | 原生窗口、权限、受限 IPC 与主进程 AI 调用 |
| `desktop/pet.html`、`meeting.html` | 桌面宠物与录音面板 |
| `desktop/audio-capture.mjs`、`audio-worklet.js` | 麦克风与系统音频采集、音量反馈和分段 |
| `desktop/transcription.mjs` | 音频转写请求与错误处理 |
| `extension/sidepanel.html`、`sidepanel.css` | 扩展专用的紧凑侧边栏入口 |
| `extension/app.js`、`styles.css` | 共享任务逻辑与基础样式 |
| `extension/index.html`、`install.html` | 开发用网页预览与扩展安装指引 |
| `extension/lib/analyzer.mjs` | 无需 key 的演示分析器 |
| `extension/lib/sample.mjs` | 可重复演示的示例会议 |
| `extension/manifest.json`、`background.js` | Chrome 扩展配置与事件处理 |
| `extension/content.js` | 用户主动唤起的网页小宠物 |
| `server.mjs` | 本地静态服务与可选 AI 分析接口 |
| `tests/` | 核心逻辑测试 |
| `docs/PRODUCT_PLAN.md` | 产品计划与课堂项目路线 |

下一步先用一次短会议验证双方声音、转写和任务审核，再找目标用户评估是否减少会后负担；外部执行渠道先选一个接入。
