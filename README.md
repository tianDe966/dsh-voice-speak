# dsh-voice-speak

> 让 DeepSeek Harness 里的 AI 真的开口说话：一句话、异步、不阻塞收尾；开口的同时，屏幕右下角浮出同一条文字的气泡。

给 DSH 加两样东西：一个 `say` 工具，和一段「什么时候该说话、怎么说」的系统提示词。插件只做这两件事，其余判断留给模型——它知道你在忙别的、不一定盯着屏幕。

- **零第三方依赖**，纯 ESM JavaScript，无构建步骤
- **仅 Windows**（语音与桌面气泡都依赖系统能力）
- 本版本：`3.1.1`

---

## 为什么需要它

聊天窗口里的回答，只有你正看着才有用。你起身倒水、去看编译日志、切到别的窗口，AI 做完事你也不知道。

`dsh-voice-speak` 补的是这一层：**值得你回来看一眼的事，用声音喊你一声**。它不播报每一条回复，只在你需要抬头的时候开口——阶段成果、关键进展、卡住了需要你决定。

## 功能

| 能力 | 说明 |
| --- | --- |
| `say` 工具 | AI 把一句话交给语音，立刻返回「已交给语音播报」，不阻塞任务收尾 |
| 三引擎音色链路 | 本地离线「晓晓」→ Edge 在线自然音色 → Windows 内置语音，逐级兜底，**断网也出声** |
| 串行队列 | 多句排队逐条播，最多排 3 句，满了丢等待队列里最旧的那句；正在说的那句永不打断 |
| 桌面气泡 | 独立桌面窗口（非网页元素），不抢焦点、贴右下角、只留一个、按真实播放时长关闭 |
| 事件驱动自动播报 | 审批等待、提问等待、长后台任务、长轮次收尾由插件兜底提醒，不依赖模型是否记得 |
| 可关、可强制 | 环境变量控制引擎与自动播报，`say` 本身不受影响 |

## 环境要求

- Windows 10 / 11
- Node.js **>= 20**
- DeepSeek Harness，且使用 `web` profile（其他 profile 同样可挂载，气泡与语音是系统级能力）

## 安装

插件通过 profile 的 pnpm 管理，`dsh plugin` 会把参数转发给该 profile 目录下的 pnpm。

**从 npm 安装：**

```sh
dsh plugin --profile web add dsh-voice-speak
```

**从本地目录安装（开发或未发布时）：**

```sh
git clone https://github.com/tianDe966/dsh-voice-speak.git
dsh plugin --profile web add link:D:/path/to/dsh-voice-speak/dsh-voice-speak
```

**确认装上了：**

```sh
dsh --profile web --dump-config | findstr tool-voice-speak
```

配置树里出现 `tool-voice-speak` 才算激活。挂载是热的，当轮会话就能用。

**确认真的出声：** 让 AI 说一句，或看运行日志：

```powershell
Get-Content (Join-Path $env:TEMP 'dsh-voice-speak.log') -Tail 5
```

应看到类似一行：

```
2026-10-28 22:35:21.815 engine=local voice=Xiaoxiao pitch=+10% rate=-4% len=17 play_ms=4777 OK
```

## 使用

### AI 侧：一个工具

模型调用 `say({ text }): { status: 'queued' | 'muted', text }`。`queued` 表示「已交给播报」，语音在后台说完，任务不等它；`muted` 表示当前处于远程模式静默，这句没有出声（会写一行日志），不要当成已经播过。

### 什么时候开口

插件的提示词会随会话注入，规定四类时机（按优先级）：

1. **重要阻碍**（必说）：需要你授权/审批、需要你动手或补信息、外部卡住、同一个问题修两次仍失败
2. **阶段性成果**（必说）：功能跑通、测试通过、报告或文件交付、关键 bug 定位
3. **关键进展/突破**（说）：方案定了、方向变了、难题解决、关键数据出来了
4. **每轮收尾**（说）：这一轮只要给了结论、交付物或下一步，就报一句

不说：刚开始做、正在做、单步命令、无结论的尝试、复述计划；只寒暄只闲聊且没有结论的轮次；同一件事不重复说，一轮主动播报不超过 3 次。

措辞口径：一句话、不超过 30 字、最多两个小句，说人话，不念文件路径和错误堆栈。

> 口径可以在系统提示词里按你的习惯改，也可以让项目里的偏好文件覆盖——插件会把裁决权让给用户偏好（见 `lib/prompt.js` 末段）。

### 插件侧：四类事件自动兜底

模型会忘、会漏，所以关键事件由插件自己判定：

| 场景 | 判定依据 | 播报 |
| --- | --- | --- |
| 审批等待 | `approval/asked` | 有个操作要你批一下 |
| 提问等待 | `tool/call` 且工具是 `ask_user_question` | 有个问题要你定 |
| 轮次报错 / 阻塞 | `turn/end` 且 reason 为 `error` / `blocked` | 这轮出错了 / 卡住了 |
| 长轮次收尾 | `turn/end` completed 且 ≥120 秒、≥2 次工具调用 | 这轮跑完了 |
| 长后台任务 | `jobs.events` settled、≥90 秒、没有被前台等待 | 后台任务跑完了 / 失败了 |

降噪：同一审批/提问/任务只报一次；模型刚说过话 10 秒内不再补审批/提问；长轮次收尾要求距上次播报 ≥45 秒；后台任务完成要求 ≥30 秒。子代理与官方定时任务（schedule）一律不自动播报——后者交给邮件/微信通道。

## 音色

默认三引擎，先本地后云端：

| 顺序 | 引擎 | 是否需要网络 | 说明 |
| --- | --- | --- | --- |
| 1 | 本地离线「晓晓」（SAPI） | 否 | 需另装微软自然语音 + SAPI 适配器，见下 |
| 2 | Edge 在线自然音色 | 是 | `zh-CN-XiaoxiaoNeural`，零依赖手写 WebSocket 协议 |
| 3 | Windows 内置语音 | 否 | 最后兜底，音色明显老一些，但一定出声 |

默认调音：`pitch=+10Hz` / `rate=-4%`（本地 SAPI 用 SSML 的 `+10% / -4%` 对齐）。想换成自己的声线，只改 `lib/tts.js` 顶部三个常量，不动其它逻辑。

### 可选：开启离线自然音色

默认走 Edge 在线音色即可用。想要**断网也保持同一说话人**，需要在本机装：

- 微软 Narrator 自然语音包 `Microsoft Xiaoxiao (Natural)`（微软签名 MSIX，解压即用）
- [NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)（MIT，把自然语音注册成 SAPI 引擎）

装上后 `System.Speech` 里会出现 `Microsoft Xiaoxiao`，插件会自动优先用它；找不到时自动回落，不影响使用。语音资产与适配器**不进仓库**，装法属于本机环境配置，按项目 README 与适配器文档操作即可。

## 环境变量

| 变量 | 取值 | 作用 |
| --- | --- | --- |
| `DSH_VOICE_SPEAK_ENGINE` | `auto`（默认）/ `local` / `edge` / `sapi` | 强制某一路引擎，跳过前面的顺序 |
| `DSH_VOICE_SPEAK_FALLBACK` | `off` | 关掉事件驱动的自动播报，`say` 不受影响 |

## 桌面气泡

说话时右下角出现一个小窗，标题「鲸鱼娘」，写的就是正在念的那句话。

- 独立桌面窗口，浏览器最小化也在
- `WS_EX_NOACTIVATE`，弹气泡不抢焦点，正在打的字不会被抢走
- 贴右下角、按 DPI 真实工作区定位，任意缩放下不出界
- 同一时刻只留一个气泡，后一句顶替前一句
- 关闭时机取自真实播放时长，不是按字数估算

## 日志与排错

诊断日志按句一行，写在 `%TEMP%\dsh-voice-speak.log`：

```
engine=local|edge|sapi voice=… pitch=… rate=… len=… audio_ms=… play_ms=… OK|ERR
```

`audio_ms` 只有本地与内置语音给得出（渲染出的 PCM 时长）；Edge 是 MP3，日志里换成 `synth_ms=…`（云端合成耗时）加 `play_ms=…`（到播完的总耗时）。

**完全没声音**，按顺序看：

1. 日志最后一行是否 `OK`。有 `play_ms=… OK` 说明语音已送到默认输出设备，问题在系统侧（输出设备选错、音量静音、应用音量）。
2. `ERR read ECONNRESET` 是 Edge 云端被重置，插件会自动重试并回落，声音通常仍出。
3. `engine=local … UNAVAILABLE` 表示没找到本地晓晓，已回落 Edge——想用离线音色就按上面的「可选」重装。
4. `say` 返回 `status: 'muted'`：说明远程模式标记 `~/.dsh/rules/remote-mode.on` 存在，这句被静默，日志里有一行 `say 已静默（remote-mode 标记存在，未出声）`。**桌面端收到一条用户消息会自动删掉该标记**（微信会话的回合不算），所以人回到电脑前说话、语音就恢复，不需要谁记得关远程模式。
5. `audio_ms` 是渲染出的音频真实时长，`play_ms` 是子进程总耗时（含渲染与排队），两者差 1–2 秒属正常。

**句尾被截**（最后一个字像被挂电话）：3.1.2 及以前只发生在蓝牙耳机（A2DP）下——A2DP 在应用关闭音频流时会丢弃耳机端未播完的缓冲。3.2.0 起本地语音改为常驻播放进程，3.3.0 起 Edge 与内置语音也走同一常驻进程与同一端点，蓝牙与外放均已实测完整。若升级后仍被截：

1. 查日志里的 `engine`：`engine=local`／`engine=edge`／`engine=sapi device=resident` 三种都落在常驻进程的同一个端点上；只有 `engine=sapi mode=…`（没有 `device=resident`）才是回落到了每句一个进程的老路径，那条路径在蓝牙下会截；
2. 查是否每句都在重建设备：`play_ms` 若接近 `audio_ms + 1.3 s`，说明 worker 在反复重建（多半是空闲 60 s 超时或崩溃重启）。

## 已知限制

1. **只说、不听**：没有语音输入与双向对话
2. **只支持 Windows**：语音引擎、气泡、MCI 播放都依赖系统能力
3. **不是音色克隆**：是现成音色调参
4. **主进程退出会掐断当前句**，不预留孤儿播放
5. **云端协议是外部依赖**：微软改接口时云端路径可能失效，届时自动回落内置语音，功能不断
6. **气泡比首声早约 1–1.5 秒**：气泡在调用瞬间出现，语音要先合成
7. **自动播报阈值偏保守**：长轮 120 s / 长任务 90 s / 静默窗 30–45 s，可按实际体感再调
8. **常驻一个 PowerShell 进程**：三条引擎都落在这个常驻进程与同一个音频端点上——本地语音把 WAV 直接写进 waveOut；Edge 的 MP3 由同一进程用 MCI 播放，并有一路循环静音流撑住端点不空闲（A2DP 在端点空闲时才丢缓冲）；内置语音渲染进同一个 waveOut 设备。空闲 60 s 才退出。只有常驻进程完全起不来时，才会回落到「每句一个进程」的老路径。
9. **超过 60 s 不说话的第一句要多等约 1.3 s**：设备要从关闭状态重新打开

## 搭配推荐：dsh-remote-notify

如果你会把电脑扔下不管、改用手机或微信继续对话，建议同时安装配套插件 **`dsh-remote-notify`**：

- `send_email`：阶段性汇报直接发到邮箱（SMTP 自填，收件人固定）
- `set_remote_mode`：进入远程模式后语音自动静默、不再打断你；回到本地时手动关掉，或直接发一条桌面消息——插件会把标记自动解除

两者配合的效果是：**你在电脑前 → 用声音喊你；你不在电脑前 → 不吵，改用邮件与微信**。单装 `dsh-voice-speak` 完全可用，只是少了这层"人不在"的切换。

## 开发

```sh
cd dsh-voice-speak
node --test        # 30 项：触发判定 + 事件接线 + 静默路径，不需要出声
```

纯 ESM、无构建步骤、无第三方依赖。目录：

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 入口：注册 `say`、注入提示词、接 `session/event` 与 `jobs.events` |
| `lib/prompt.js` | 提示词全文（改口吻/触发口径只动这里） |
| `lib/triggers.js` | 自动播报判定、去重、静默窗、时长阈值 |
| `lib/tts.js` | 播放层：队列 + 三引擎调度 + 日志 |
| `lib/edge.js` | Edge TTS 客户端（TLS 握手、WebSocket 帧、`Sec-MS-GEC v2` token） |
| `lib/pet-bridge.js` | 桌面气泡窗 |
| `cordis.patch.yml` | 一行挂载声明 |

`lib/tts.js` 里有两处不能改的工程约束：PowerShell 一律用 `-EncodedCommand`（不拼 `-Command` 字符串），播放子进程用 attached + `unref()` 而不是 `detached`。原因都记在仓库经验库里。

## 致谢

这个插件站在不少开源项目的肩膀上，按依赖/借鉴程度排序：

- **[DeepSeek Harness](https://github.com/deepseek-ai)**（`@deepseek-ai/dsh`、cordis 插件体系）——工具注册、系统提示词注入、会话/任务事件都在它的公开契约之上
- **[gexgd0419/NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)**（MIT）——把 Azure/微软自然语音接成标准 SAPI 引擎；没有它就没有离线「晓晓」这一层
- **[rany2/edge-tts](https://github.com/rany2/edge-tts)** 与其中的 [Sec-MS-GEC v2 分析（PR #492）](https://github.com/rany2/edge-tts/pull/492)——`lib/edge.js` 的 token 生成与重试策略来自社区对 Edge「朗读」协议的公开研究（代码为独立零依赖实现，非直接移植）
- **`msedge-tts`**（npm）——早期验证协议可用性时用作对照
- **微软「晓晓」自然语音**——音色属于 Microsoft，本插件只做调用
- **本机 `dsh-plugin-photoshop`**（本地插件，非本仓库）——`say` 的 registry-ready 工具定义写法参照了它的 `lib/tool.js`

## 许可

[MIT](LICENSE) © 2026 tianshan123
