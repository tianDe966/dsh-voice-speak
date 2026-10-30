# 变更记录

本文件记录 `dsh-voice-speak` 的对外变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [3.4.2] - 2026-10-30

### Changed

- **README 按「产品宣传册」逻辑重排**（不改任何代码）：核心特性与安装提到最前，技术细节（音色与离线方案、环境变量、日志排错、已知限制、开发）全部折进 `<details>`，全文 251 → 216 行。新增「为什么选择 dsh-voice-speak」一节，说明它与全双工/语音输入类插件的分工。
- **README 与代码脱节的地方全部对齐**：已知限制「主进程退出会掐断当前句」改为「宿主退出最多等 18 s，只有 `process.exit()` / 关控制台 / `taskkill /T` 才掐断」；气泡提前量「1–1.5 s」改为实测约 **0.5 s**；「三引擎」统一为「三条引擎、四条路径」；补明 npm 包内不含 `bin/dsh-tts-helper.exe`（需自行编译）、默认 SDK/语音目录是作者本机路径（第三方需用环境变量覆盖）、`DSH_VOICE_SPEAK_NO_HOLD`、SAPI 适配器需自行安装。
- 许可表述收敛为「用你本机已安装的语音资产 + 非官方用法 + 不分发、不给下载指引」，不再描述许可串的还原算法。

## [3.4.1] - 2026-10-30

### Changed

- **句尾保护上限 10 s → 18 s**（`lib/tts.js` 的 `HOLD_HOST_MAX_MS`）：播放期间插件会挂一个「别退出」的定时器，让宿主把话说完再走；原来的 10 s 上限会被较长句子正常触发——实测 52 字句子音频 9.74 s、整段 11.47 s，10 s 就放行宿主退出，日志里留下 `hold timeout: 语音未在 10000 ms 内结束，已放行宿主退出`。18 s 覆盖到「30 字口径 + 一定超长」的范围，同时仍是 worker 卡死时的保险阀。只影响「宿主正在退出」的场景（终端一次性 `dsh "…"`），常驻的 `dsh web` 不受影响。

## [3.4.0] - 2026-10-30

### Added

- **自带离线合成 helper，本地晓晓不再依赖 SAPI 注册**：新增 `tools/tts-helper/`（C# 源码）与 `tools/build-tts-helper.mjs`（用 .NET Framework 自带的 `csc.exe` 编译，不需要 VS 或 .NET SDK）。`bin/dsh-tts-helper.exe` 直接调用微软 Embedded Speech SDK 的离线合成能力，许可串由语音模型 `.bin` 文件按固定算法还原，因此**不需要 `regsvr32`、不需要管理员、不经过 PowerShell 与 `System.Speech`**。句子的合成从约 2 s 降到约 0.3 s。
- `lib/tts.js` 的本地路径改成「helper 渲染 WAV → 常驻 worker 播放」：播放层（keep-alive、尾静音、`play_ms` 计量）一行未改，helper 失败时自动回落到 SAPI 适配器，再回落到 Edge。
- 新增环境变量 `DSH_VOICE_SPEAK_SDK` / `DSH_VOICE_SPEAK_VOICE_DIR` / `DSH_VOICE_SPEAK_NO_HELPER`。

### Fixed

- **非 ASCII 输出路径**：Embedded Speech SDK 的本地文件写入在含中文的路径上直接报 `SPXERR_FILE_OPEN_FAILED`。helper 现在检测到非 ASCII 目标路径就改写到自带的 ASCII 临时目录，并在 stdout 里回报真实落地路径，调用方按回报路径播放并清理。
- **worker 脚本长度上限**：PowerShell 脚本经 `-EncodedCommand` 传给 `powershell.exe`，受 Windows 命令行 32767 字符限制。实测 12232 字符源码 = 32620 编码后已 `spawn ENAMETOOLONG`；现在超过 31000 直接抛出可读错误，而不是一个进程起不来的怪错误。

## [3.3.1] - 2026-10-29

### Fixed

- **宿主退出时正在播的那句被掐断**：根因不在 worker 的退出逻辑，而是 Windows 上 Node 的子进程会随父进程一起被杀——实测四种 spawn 形态（含 `detached`，它在起播前就 `exit 0`）无一幸存，worker 根本没机会读到 stdin EOF。改为在宿主侧解决：播放期间持有一个不 `unref()` 的定时器占住事件循环，句子播完立即释放；同时把 worker 的 stdio 管道也 `unref()`，否则宿主会为 worker 的 60 s 空闲窗多挂近一分钟。实测：7.6 s 的句子，宿主在 7588 ms 退出（正好播完）；关掉占用则是 7 ms 就退、句子被截断。上限 10 s，可用 `DSH_VOICE_SPEAK_NO_HOLD=1` 复现旧行为。
- 覆盖范围仅限「宿主自然退出（事件循环耗尽）」。宿主若 `process.exit()` 或被控制台关闭、`taskkill /T` 强制终止，仍会截断——这需要把播放进程挪出宿主进程树（计划任务/常驻服务）才能解决。

## [3.3.0] - 2026-10-29

### Changed

- **三条引擎都改走常驻进程与同一音频端点**：`sapi` 不再每句 spawn 一个 PowerShell 直连音频设备，改为由常驻 worker 合成到 24 kHz/16-bit/单声道 WAV 再写进同一个 `waveOut`；`edge` 的 MP3 也不再由每句一个 MCI 子进程播放，改由常驻 worker 在进程内 `mciSendString` 播放。只有常驻进程完全起不来时才回落到老路径。
- **静音 keep-alive 撑住端点**：Edge 播 MP3 期间由 worker 另开一路循环静音流（1 s 静音 WAV，`play … repeat`），并在 MCI 报播完后再撑 500 ms 才停。原因同上：A2DP 在端点空闲或流关闭的瞬间丢缓冲，撑住端点就不丢。
- 播放格式统一为 24 kHz：本地晓晓与内置语音都渲染成 `SpeechAudioFormatInfo(24000, Sixteen, Mono)`，设备只按这个格式开一次。

### Fixed

- Edge 兜底路径在蓝牙耳机下的句尾截断：3.2.0 只修了本地语音，云端与内置路径仍是每句开流，现已覆盖。

### Verified

- `node --test --test-isolation=none` 30/30（发布后补 5 条 worker 协议单测，现 35/35）；三条引擎各说一句的日志：
  - `engine=local voice=Xiaoxiao … audio_ms=2062 play_ms=3610 OK`
  - `engine=edge voice=zh-CN-XiaoxiaoNeural … synth_ms=1958 play_ms=5993 OK`
  - `engine=sapi device=resident voice=default audio_ms=2062 play_ms=3346 OK`

### Known limitations

- 蓝牙下的人耳确认还没做：日志只能证明路径跑通，不能证明句尾听感完整。
- keep-alive 假设端点确实走同一个设备；装了按应用分路的音频路由软件时仍可能被截。

### Published

- 2026-10-29：GitHub 仓库转为公开；npm 发布 `dsh-voice-speak@3.3.0`（`latest` 指向 3.3.0；同名下另有首次发布时产生的 `0.0.0-stage` 占位版本，已弃用说明未能自动写入，`latest` 不受影响）。

## [3.2.1] - 2026-10-29

### Added

- `say` 静默时可观测：远程模式标记存在时仍写一行日志（`say 已静默（remote-mode 标记存在，未出声）：…`），返回 `{ status: 'muted', text }`，`render` 显示「已静默（远程模式），没有出声」。
- 静默自动解除：桌面端收到用户消息（`source.kind` 不是 `schedule`、会话 `cwd` 不在微信通道工作区）即删除 `~/.dsh/rules/remote-mode.on`，并记一行「remote-mode 标记已自动解除」。人回到电脑前不再需要谁记得调 `set_remote_mode(false)`。

### Fixed

- 远程模式忘记关闭后表现为「永远无声、无日志、返回值仍说已播报」。微信会话的回合与官方定时任务不会误解除静默。

## [3.2.0] - 2026-10-29

### Added

- `lib/worker.js`：常驻本地语音进程。整个插件生命周期只开一个 PowerShell 与一个播放设备（`waveOutOpen`），复用同一个 `SpeechSynthesizer`，每句把整段 PCM 一次性写入并轮询 `WHDR_DONE` 等播完。
- 空闲 60 s 才关流退出；崩溃或空闲退出后下一次说话自动重建。

### Fixed

- **蓝牙耳机（A2DP）下句尾被截断**：A2DP 在应用关闭音频流时丢弃耳机端未播完的缓冲。改为整轮不关流后，耳机只是播到没数据为止，不再丢字——实测蓝牙与外放两种输出下句尾均完整。

### Changed

- 本地路径不再每句 spawn 进程：`tts.js` 删掉每句执行的合成脚本，改走常驻 worker 的行协议（`speak <base64文本> <base64路径>` / `quit`）。第二句起省掉进程启动与语音加载，实测 3.3 s 音频总耗时 3.9 s。
- 文本与路径都走 base64：重定向管道的控制台编码是 ANSI 代码页而非 UTF-8，中文用户名下的临时路径会被解码成乱码并导致合成失败。

## [3.1.2] - 2026-10-29

### Changed

- 本地语音改走「先渲染成 WAV、再播放文件」，不再实时直出：`NaturalVoiceSAPIAdapter` 的实时输出会丢掉句尾，而同一段合成写到文件里是完整的（实测尾部有 143–161 ms 自然收尾静音）。
- 每句尾部补 400 ms 数字静音，播放结束后再等 500 ms 才退出子进程，避免关闭流时吃掉尾音。

### Added

- 日志新增 `audio_ms`：渲染出的音频真实时长（含补齐的静音），与 `play_ms`（子进程总耗时）分开记录。

### Known limitations

- 蓝牙耳机（A2DP）下句尾仍会被截断：A2DP 在应用关闭音频流时会丢弃耳机端尚未播完的缓冲，属链路行为，补静音与延长等待都无效。内置扬声器与有线输出正常。常驻播放进程方案排入 3.2.0。

## [3.1.1] - 2026-10-28

### Added

- 提示词新增「每轮收尾（说）」：一轮里只要给了结论、交付物或下一步，就报一句，不再以「这轮没实质进展」为由省略。
- 提示词末段新增裁决条款：用户偏好文件若写有开口口径，以它为准，本段冲突时不按其执行。

### Changed

- 「不说」清单收窄：原「纯问答、闲聊」改为「只寒暄、只闲聊且没有结论或下一步的轮次」。
- `package.json` 版本号由 `0.1.0` 对齐发布名 `3.1.1`（此前版本号长期未同步）。

### Docs

- 首次补齐对外文件：`README.md`、`LICENSE`（MIT）、`CHANGELOG.md`。

## [3.1.0] - 2026-10-28

### Added

- 本地离线自然语音「晓晓」（SAPI）优先：断网可用，音色与在线版同一说话人。
- Edge 合成重试：`ECONNRESET` 时最多重试 3 次（退避 400 ms / 1200 ms），减少退回到内置机械音色的概率。

### Fixed

- Edge 云端连接被重置后直接回落内置语音的问题。

## [3.0.0] - 2026-10-28

### Added

- 事件驱动的自动播报：审批等待、提问等待、轮次报错/阻塞、长轮次收尾、长后台任务。
- 降噪：同一事件只报一次，模型刚说过话时的静默窗，长轮次收尾与后台任务的时长阈值。
- `test/` 单元测试（触发判定 + 事件接线），`node --test` 不出声即可验证。

### Removed

- M4 的「这一轮用过工具就补一句」兜底——短任务与纯操作轮次不再被凑数播报。

## [2.0.0] - 2026-10-27

### Added

- 桌面气泡：说话时右下角浮出同一条文字，独立桌面窗口、不抢焦点、DPI 感知定位、同一时刻只留一个。
- 气泡跟随真实播放时长关闭（替代按字数估算）。
- 轮末兜底（M4 初版）：整轮没开口时收尾补一句。
- 项上限口径：一句话不超过 30 字、最多两个小句。

### Changed

- 音色锁定为 `zh-CN-XiaoxiaoNeural` + `pitch=+10Hz` + `rate=-4%`（四候选 A/B 后选定）。

## [1.0.0] - 2026-10-27

### Added

- `say` 工具：把一句话交给语音，异步返回，不阻塞会话收尾。
- 系统提示词：规定什么时候该开口、怎么开口。
- 串行队列：多句排队逐条播，上限 3 句、满了丢最旧，正在说的那句不打断。
- Edge 在线自然音色（零依赖手写 WebSocket 协议）+ Windows 内置语音兜底。
- 每句一行的诊断日志（引擎、字长、合成耗时、播放耗时、成败）。
