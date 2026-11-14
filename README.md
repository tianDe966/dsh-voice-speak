# dsh-voice-speak

**「老大，报告出来了，快回来看看！」**

让 DeepSeek Harness 里的 AI 真的开口找你——配上屏幕右下角弹出的「鲸鱼娘」气泡，做你的专属进度秘书。

- **零第三方依赖**，纯 ESM JavaScript，无构建步骤
- **仅 Windows**（语音与桌面气泡都依赖系统能力）
- 本版本：`3.5.0`（版本演进见 [CHANGELOG.md](CHANGELOG.md)）

---

## 🐳 大概是这样

```
23:47  你切去看编译日志了，AI 在后台跑完一轮——

🗣️   「老大，编译过了，测试全绿，回来看一眼。」
🐳   屏幕右下角同时浮出「鲸鱼娘」气泡，写着同一句话。
```

它说人话、不念代码路径；你不在屏幕前，它也会来找你。

## 🆕 3.6.0 新增了什么

**"说"这条线全齐了，顺手还能听音频文件。**

| 能力 | 3.5.0 | 3.6.0 |
|---|---|---|
| 在对话里念一句 | `say` | `say`（不变） |
| 把**整段长文本**合成成音频文件 | 得自己找外部脚本 | **`tools\voice-local.ps1`** 自带，出真 mp3，还能混进视频 |
| **音频文件转文字** | 没有 | **`tools\stt-groq.ps1`**（Groq `whisper-large-v3-turbo`） |
| 一次能念多长 | 合成超时 15 s ≈ **2200 字** | 60 s ≈ **9000 字** |
| 语音资产怎么装 | README 里散着写 | **`tools\setup-voice-assets.ps1`** 一键体检 / 下载 / 校验 / 注册 |

- **两个脚本进了包**：以前它们散在作者自己的工具目录里，别人装了也用不上。现在 `tools/` 自带，靠 `$PSScriptRoot` 自寻址，换机器不用改路径。
- **念白上限 2200 → 9000 字**：`HELPER_TIMEOUT_MS` 从 15 s 提到 60 s（实测 **6.7 ms 合成 / 1 字**）。
- **语音资产不再"只字不提"**：给了体检脚本 + 可执行的安装指令，并明确「微软的东西不进仓库」。

## 🆕 3.5.0 新增了什么

气泡那张脸，从「一块方形贴图」变成真正的圆形头像，而且能换成你自己的角色。

| | 3.4.x | 3.5.0 |
|---|---|---|
| 形状 | 56 px 方形 `Image`，非方图被压扁 | 正圆（WPF `Ellipse` + `ImageBrush` + `UniformToFill`），非方图裁边、不压扁 |
| 描边 | 无 | 1 px 冷色描边，压在浅色壁纸上也认得出 |
| 换图 | 改代码 | 环境变量或一行 JSON，**每句重读，不用重启 dsh** |
| npm 包里有没有默认头像 | **没有**（`files` 漏了 `assets/`） | 有，`assets/avatar.png` |

- **默认头像换了人**：原来那张 `assets/voice-cover.png` 是作者自用形象，已从仓库删除。你装到的是蓝发女仆「大肥鱼」，不是你用不上的别人的立绘。
- **顺手补了个洞**：3.4.x 的 `files` 里没有 `assets/`，从 npm 装的人其实一直拿不到气泡头像，只是没人报过。
- 想换成自己的角色：见下面「[换成你自己的头像](#换成你自己的头像)」，两步、不用重启。

## ✨ 核心特性

- 🗣️ **不念原文，说人话**：这句话由模型按你的偏好当场改成口语（「老大，报告出来了，回来看看」），不是把回答、文件路径、代码堆栈干巴巴念一遍。
- 🐳 **鲸鱼娘桌面气泡**：浏览器最小化也看得见——独立桌面小窗、不抢焦点、按真实播放时长自动关闭。气泡左侧是**正圆头像**（3.5.0 起由方形贴图改成真圆，带 1 px 冷色描边），默认蓝发女仆「大肥鱼」，一条配置就能换成你自己的立绘。
- ⚡ **断网也能极速出声**：四条路径逐级兜底（本地离线「晓晓」→ SAPI 适配器 → Edge 在线 → Windows 内置）。本地离线这一路实测合成 **0.3–0.5 秒**（旧 SAPI 路径同长度约 2 秒），想断网都难。
- 🛡️ **只在关键节点开口**：卡住了、要你拍板、长任务完成——插件自己兜底播报，不依赖模型记不记得，也不废话连篇。
- 🔀 **说完一句再说下一句**：多句排队逐条播，最多排 3 句，满了丢等待队列里最旧的那句；正在说的那句永不打断。
- 🎬 **长文本直接出片**：`tools\voice-local.ps1` 把任意长度文本合成 wav / mp3，还能按时间戳混进视频（视频流直接 copy，不重编码）。开机动画的配音就是这么来的。
- 📝 **也能听音频文件**：`tools\stt-groq.ps1` 把 mp3 / m4a / wav 转成文字（Groq `whisper-large-v3-turbo`），25 MB 以内都行，密钥走环境变量或 `~/.dsh/voice-speak.json`。

> 插件本体只做两件事：一个 `say` 工具，一段「什么时候该说、怎么说」的系统提示词。其余判断留给模型——它知道你在忙别的、不一定盯着屏幕。

## 📦 安装

**环境要求**：Windows 10 / 11、Node.js ≥ 20、DeepSeek Harness 的 `web` profile（其他 profile 同样可挂载，语音与气泡是系统级能力）。

插件通过 profile 的 pnpm 管理，`dsh plugin` 会把参数转发给该 profile 目录下的 pnpm。

**从 npm 安装（推荐）：**

```sh
dsh plugin --profile web add dsh-voice-speak
```

**从本地目录安装（开发、或想跟 main 分支）：**

```sh
git clone https://github.com/tianDe966/dsh-voice-speak.git
dsh plugin --profile web add link:D:/path/to/dsh-voice-speak
```

> 如果 `dsh plugin ... add dsh-voice-speak` 卡住没反应（个别网络环境下见过，pnpm 在 profile 里拉包时会一直等），改用 tarball 这条路，能绕过 profile 的依赖解析：
>
> ```sh
> npm pack dsh-voice-speak --pack-destination D:/tmp
> dsh plugin --profile web add file:D:/tmp/dsh-voice-speak-3.5.0.tgz
> ```

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
2026-10-30 15:37:51.871 engine=local voice=Xiaoxiao via=helper pitch=+10% rate=-4% len=52 synth_ms=460 audio_ms=9740 play_ms=11467 OK
```

---

## 为什么需要 dsh-voice-speak

DSH 的语音插件大致已经分成三类，都很好，也都很明确：

- **输入型**（语音输入、全双工对话）：你按住麦克风说话，或像打电话一样你一句我一句——要你先开口。
- **播报型**（如 [`dsh-voice-alert`](https://github.com/loyalchiiina/dsh-voice-alert)、[`dsh-voice-announcer`](https://github.com/flashyiyi/dsh-voice-announcer)）：回合结束自动响一声，内容是固定文案——「完成」「失败」「会话名 + 第几轮」，或换成音效。
- **来电型**（如 [`dsh-voice-call`](https://github.com/PandaPolo/dsh-voice-call)）：agent 想说话时发起来电，你接听后才会播放。

`dsh-voice-speak` 是第四种：**让模型自己组织那句话，立刻说，不问你接不接**。

- **不念原文，也不是模板**：模型调用 `say({ text })` 交一句**它自己写的话**——「老大，编译过了，测试全绿，回来看一眼」。口径是 30 字以内的口语，不是预制音效、不是「完成/失败」档位，也不是把回答原文念一遍。
- **桌面气泡兜底**：听不见的时候，屏幕右下角浮出「鲸鱼娘」气泡写着同一句话；不抢焦点，按真实播放时长关闭。
- **只在关键节点开口**：卡住了、要你拍板、阶段完成——事件由插件自己兜底判定，不依赖模型记不记得。

**那么，当你不看着屏幕，或者 AI 在后台长跑时，AI 如何主动找到你？** 答案就是一句人话：值得你回来看一眼的事，用声音喊你一声。

（这几类可以共存：输入型负责听你说，本插件负责替你喊。）

## 什么时候开口

### AI 侧：一个工具

模型调用 `say({ text }): { status: 'queued' | 'muted', text }`。`queued` 表示「已交给播报」，语音在后台说完，任务不等它；`muted` 表示当前处于远程模式静默，这句没有出声（会写一行日志），不要当成已经播过。

### 四类时机（按优先级）

插件的提示词会随会话注入：

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

## 桌面气泡

说话时右下角出现一个小窗，标题「鲸鱼娘」，左侧一张圆形头像，右边写的就是正在念的那句话。

- 独立桌面窗口，浏览器最小化也在
- `WS_EX_NOACTIVATE`，弹气泡不抢焦点，正在打的字不会被抢走
- 贴右下角、按 DPI 真实工作区定位，任意缩放下不出界
- 同一时刻只留一个气泡，后一句顶替前一句
- 关闭时机取自真实播放时长，不是按字数估算

### 换成你自己的头像

气泡头像默认用包里那张 `assets/avatar.png`（大肥鱼）。想换成自己的角色，两步：

1. 把图片放到任意一个**纯 ASCII 路径**下，例如 `D:\DSH_Project\xiaolan-assets\avatar.png`（含中文的路径 WPF 容易读不出来，尤其是 `C:\Users\你的中文名\` 这种）；
2. 在 `~/.dsh/voice-speak.json` 里写这个路径：

   ```json
   { "avatar": "D:\\DSH_Project\\xiaolan-assets\\avatar.png" }
   ```

配置**每句话都会重读**，改完不用重启 dsh，下一句就换脸。也可以用环境变量 `DSH_VOICE_SPEAK_AVATAR` 直接指图片（优先级更高），两者都没配就走包内默认图。

图片建议 **正方形、128 px 以上、边缘已经是圆形或愿意被裁成圆形**——气泡按 `UniformToFill` 填进正圆，非正方形会被裁掉两侧。找不到文件时气泡自动退回纯文字，不会报错也不会挡住说话。

如果想让**对话界面里的每条消息**也带上同一张头像，那是皮肤插件的事，见下面的「搭配推荐」。

## 搭配推荐：`@dsh-voice/voice`（实时麦克风识别）

**强烈建议搭配使用**，两边职责不重叠：

| | `dsh-voice-speak`（本插件） | `@dsh-voice/voice`（全双工） |
|---|---|---|
| 方向 | **说**：agent → 用户 | **听**：用户 → agent |
| 触发 | 模型决定开口 | 用户按 `Ctrl+Shift+V` 说话 |
| 引擎 | 本地离线晓晓 / SAPI / Edge 兜底 | 浏览器流式 ASR + Silero VAD + 本地 whisper |
| 附加 | 桌面气泡、事件兜底、音频文件合成与转写 | 语音审批（说「允许 / 拒绝」）、实时字幕、开口打断 |

一边管出、一边管进，两个装在一起才是一个完整的语音会话。本插件不评价全双工的取舍，只说明分工。

## 搭配推荐：dsh-remote-notify / dsh-channel-wechat

如果你会把电脑扔下不管、改用手机或微信继续对话，建议同时安装配套插件 **`dsh-remote-notify`**：

- `send_email`：阶段性汇报直接发到邮箱（SMTP 自填，收件人固定）
- `set_remote_mode`：进入远程模式后语音自动静默、不再打断你；回到本地时手动关掉，或直接发一条桌面消息——插件会把标记自动解除

两者配合的效果是：**你在电脑前 → 用声音喊你；你不在电脑前 → 不吵，改用邮件与微信**。单装 `dsh-voice-speak` 完全可用，只是少了这层「人不在」的切换。

再配上 **`dsh-channel-wechat`** 通道，汇报还能直接发到手机微信——人在路上也知道进度，甚至能让它给你讲个故事……啊呸，汇报工作。

---

## 为什么不再用另外两个语音插件

作者本机实测（2026-11-14，Windows 11 / Edge 157 / 有代理）。把踩过的坑摆出来，省得你也走一遍。

### `dsh-voice`（0.3.7）

- 5 个工具里 **3 个依赖 edge-tts**：`voice_tts` / `voice_list` / `voice_preview`。
- 实测**全部 403**：直连、走代理、`Sec-MS-GEC-Version` 从 `143` 改到 `157.0.4341.46`、UA 同步升到 `Edg/157` —— 全是 403。微软在协议层拒绝，**与网络无关**（`curl` 直连该域名返 400，说明 TCP/TLS 是通的；`ws` 走同一代理连通用 WSS 站点可以 OPEN）。
- 剩下 `voice_stt`（Groq）能用，但本插件已用 `tools\stt-groq.ps1` 覆盖，不必每轮背着 5 个工具的 schema。
- **本插件的处理**：从 `bundles` 移除，包本体留在 `dependencies`，想装回来写回一行即可。

### `@motong/dsh-voice`（0.4.3）

- `dependencies` 只声明了 `ws`，但以 `link:` 挂载时 pnpm 不会进目录装依赖 → `Cannot find package 'ws'`，插件直接起不来。
- 手工补上 `ws` 之后，它的朗读同样走 edge-tts，**同样 403**。
- 源码里没有 `proxyUrl` 支持（grep 零命中），连绕的路都没有。
- **本插件的处理**：已删除。

> 你的环境能跑通、或者觉得哪条写错了，欢迎去 [Issues](https://github.com/tianDe966/dsh-voice-speak/issues) 提，乐意改。

## 🧩 语音资产（微软语音包）怎么落地

**本仓库不含任何微软资产** —— SDK 和 Narrator 自然语音包都是微软的知识产权，随插件分发属于侵权，而且微软随时可能下架。所以这里只给「怎么接线」，资产留在你自己的机器上。

| 组件 | 干什么 | 从哪来 |
|---|---|---|
| Microsoft Cognitive Services Speech SDK（Embedded Speech） | 离线合成引擎 | 微软官方 |
| `MicrosoftWindows.Voice.zh-CN.Xiaoxiao.1_1.0.9.0_x64`（MSIX） | 晓晓自然语音本体 | 微软商店包（NVDA 中文站等镜像有原版） |
| [NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter) v0.2.11 | 把 Narrator 语音暴露成 SAPI voice | GitHub Releases |

### 体检

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\setup-voice-assets.ps1 -VerifyOnly
```

### 安装（脚本代劳）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\setup-voice-assets.ps1 `
  -Msix "D:\Downloads\MicrosoftWindows.Voice.zh-CN.Xiaoxiao.1_1.0.9.0_x64__cw5n1h2txyewy.Msix"
```

脚本会校验 SHA256（默认值就是微软原版那个哈希）→ 解 MSIX → 写 `HKCU` 配置 → 提示你用管理员 `regsvr32` 注册适配器 → 复查（`SpeechSynthesizer` 里能看到 `Xiaoxiao` 才算成）。

### 把这段贴给你家 AI

让 AI 替你把环境装好，省得自己一条条敲：

```
请帮我在 Windows 上装好 dsh-voice-speak 的本地离线语音资产：
1. 检查 D:\DSH_Project\TTS 下是否有
   SpeechSDK\win-x64\Microsoft.CognitiveServices.Speech.extension.embedded.tts.dll、
   NaturalVoices\Xiaoxiao\MSTTSLocZhCN.dat、
   NaturalVoiceSAPIAdapter\x64\NaturalVoiceSAPIAdapter.dll；
2. 缺哪样就告诉我该从哪下载。MSIX 期望 SHA256 =
   E069D67BEC8443AECFF49FBB971F46E72094F9A56177FD3C94734EF164542EDF；
3. 跑 <插件目录>\tools\setup-voice-assets.ps1 -VerifyOnly 看体检结果；
4. 需要注册 DLL 时用管理员权限 regsvr32，x64 和 x86 各一条；
5. 最后用 PowerShell 的 System.Speech 列出已安装语音，确认其中出现 Xiaoxiao。
全程不要装非官方来源的二进制，所有路径保持全 ASCII。
```

**兜底顺序**：本地晓晓 → SAPI 适配器 → Edge 在线 → Windows 内置 Huihui。前两条挂了会自动往下掉，不会没声。

## 进阶配置

<details>
<summary><b>点击展开：音色与调音（含「断网也保持同一说话人」的离线方案）</b></summary>

默认按下面的顺序尝试，前一档不可用就落下一档（三条引擎、四条路径）：

| 顺序 | 引擎 | 是否需要网络 | 说明 |
| --- | --- | --- | --- |
| 1 | 本地离线「晓晓」（自带 helper） | 否 | 3.4.0 起走微软 Embedded Speech SDK，不注册 SAPI、不要管理员 |
| 2 | 本地离线「晓晓」（SAPI 适配器） | 否 | 老路子，装了适配器的机器上作为 helper 的后备；适配器需自行安装，插件不分发、不代注册 |
| 3 | Edge 在线自然音色 | 是 | `zh-CN-XiaoxiaoNeural`，零依赖手写 WebSocket 协议 |
| 4 | Windows 内置语音 | 否 | 最后兜底，音色明显老一些，但一定出声 |

默认调音：`pitch=+10Hz` / `rate=-4%`（本地引擎用 SSML 的 `+10% / -4%` 对齐）。想换成自己的声线，只改 `lib/tts.js` 顶部三个常量，不动其它逻辑。

**音色表里的耗时是实测值**（本机，`engine=local … via=helper synth_ms=…`）：普通一句话合成 0.3–0.5 s，旧 SAPI 路径同长度约 2 s。首声随之提前约 1.5 s（这个数由合成耗时推算，没有单独埋点首声时间）。句子越长越慢，52 字句子合成约 0.46 s、音频约 9.7 s。

**可选：开启离线自然音色。** 默认走 Edge 在线音色即可用。想要断网也保持同一说话人，需要在本机准备两样东西（都**不进仓库**，也不进 npm 包）：

1. **语音模型**：微软 Narrator 自然语音包 `Microsoft Xiaoxiao (Natural)`（微软签名 MSIX，解压即用），或者其他语音包。
2. **合成 SDK**：微软 Embedded Speech SDK 的 x64 运行文件（`Microsoft.CognitiveServices.Speech.core.dll`、`...extension.embedded.tts.dll`、`...onnxruntime.dll`、`...codec.dll`、`...csharp.dll` 加 VC 运行库），放在一个独立目录里。

> **npm 包里没有 `bin/dsh-tts-helper.exe`**（只有 `tools/tts-helper/` 的 C# 源码），所以从 npm 安装的用户要自己编译一次，编译只需要 .NET Framework 自带的 `csc.exe`。

然后编译插件自带的 helper：

```powershell
node tools/build-tts-helper.mjs --sdk "D:\DSH_Project\TTS\SpeechSDK\win-x64"
```

产物是 11 KB 的 `bin/dsh-tts-helper.exe`（只有我们自己的代码，二进制不入库、不进 npm 包）。运行时它按需从 `--sdk` 目录加载微软的 DLL，用本机已安装语音模型自带的许可信息初始化引擎，再合成 24 kHz/16-bit/单声道 WAV 交给常驻播放进程。

路径可用环境变量覆盖；找不到 helper 或 SDK 就自动回落到 SAPI 适配器，再回落到 Edge。

> 说明：这一步用的是**你本机已安装的微软语音资产**，属于本机自用的**非官方用法**，不是微软授权的分发方式——所以语音模型、Speech SDK 与 helper 二进制都不随插件分发，本 README 也不提供下载指引。做法参考了开源适配器 [NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)。

</details>

<details>
<summary><b>点击展开：环境变量</b></summary>

| 变量 | 取值 | 作用 |
| --- | --- | --- |
| `DSH_VOICE_SPEAK_ENGINE` | `auto`（默认）/ `local` / `edge` / `sapi` | 强制某一路引擎，跳过前面的顺序 |
| `DSH_VOICE_SPEAK_FALLBACK` | `off` | 关掉事件驱动的自动播报，`say` 不受影响 |
| `DSH_VOICE_SPEAK_SDK` | 目录 | helper 加载的 Speech SDK 目录；默认 `D:\DSH_Project\TTS\SpeechSDK\win-x64`（作者本机路径，第三方需覆盖） |
| `DSH_VOICE_SPEAK_VOICE_DIR` | 目录 | 语音模型目录；默认 `D:\DSH_Project\TTS\NaturalVoices\Xiaoxiao`（同上） |
| `DSH_VOICE_SPEAK_NO_HELPER` | `1` | 禁用 helper，强制走 SAPI 适配器那一路（排错用） |
| `DSH_VOICE_SPEAK_NO_HOLD` | `1` | 关掉「播放期间让宿主等这句播完」的定时器（默认开，上限 18 s；只影响宿主要退出的场景） |
| `DSH_VOICE_SPEAK_AVATAR` | 图片路径 | 气泡左侧头像；优先于 `~/.dsh/voice-speak.json` 的 `avatar` 字段。路径请用纯 ASCII |

</details>

<details>
<summary><b>点击展开：日志与排错（没声音、句尾被截怎么查）</b></summary>

诊断日志按句一行，写在 `%TEMP%\dsh-voice-speak.log`：

```
engine=local|edge|sapi voice=… pitch=… rate=… len=… audio_ms=… play_ms=… OK|ERR
```

`audio_ms` 只有本地与内置语音给得出（渲染出的 PCM 时长）；Edge 是 MP3，日志里换成 `synth_ms=…`（云端合成耗时）加 `play_ms=…`（到播完的总耗时）。

**完全没声音**，按顺序看：

1. 日志最后一行是否 `OK`。有 `play_ms=… OK` 说明语音已送到默认输出设备，问题在系统侧（输出设备选错、音量静音、应用音量）。
2. `ERR read ECONNRESET` 是 Edge 云端被重置，插件会自动重试并回落，声音通常仍出。
3. `engine=local … UNAVAILABLE` 表示没找到本地晓晓，已回落 Edge——想用离线音色就按上面「音色与调音」里的离线方案装。
4. `say` 返回 `status: 'muted'`：说明远程模式标记 `~/.dsh/rules/remote-mode.on` 存在，这句被静默，日志里有一行 `say 已静默（remote-mode 标记存在，未出声）`。**桌面端收到一条用户消息会自动删掉该标记**（微信会话的回合不算），所以人回到电脑前说话、语音就恢复，不需要谁记得关远程模式。
5. `audio_ms` 是渲染出的音频真实时长，`play_ms` 是子进程总耗时（含渲染与排队），两者差 1–2 秒属正常。

**句尾被截**（最后一个字像被挂电话）：3.1.2 及以前只发生在蓝牙耳机（A2DP）下——A2DP 在应用关闭音频流时会丢弃耳机端未播完的缓冲。3.2.0 起本地语音改为常驻播放进程，3.3.0 起 Edge 与内置语音也走同一常驻进程与同一端点，蓝牙与外放均已实测完整。若升级后仍被截：

1. 查日志里的 `engine`：`engine=local`／`engine=edge`／`engine=sapi device=resident` 三种都落在常驻进程的同一个端点上；只有 `engine=sapi mode=…`（没有 `device=resident`）才是回落到了每句一个进程的老路径，那条路径在蓝牙下会截；
2. 查是否每句都在重建设备：`play_ms` 若接近 `audio_ms + 1.3 s`，说明 worker 在反复重建（多半是空闲 60 s 超时或崩溃重启）。

</details>

<details>
<summary><b>点击展开：已知限制（装之前值得看一眼）</b></summary>

1. **只说、不听**：没有语音输入与双向对话
2. **只支持 Windows**：语音引擎、气泡、MCI 播放都依赖系统能力
3. **不是音色克隆**：是现成音色调参
4. **宿主退出时最多等 18 秒**：播放期间插件会挂一个定时器让宿主等这句播完再走，上限 18 秒（2026-10-30 由 10 秒上调，因为 52 字句子实测整段要 11.5 秒）。但 `process.exit()`、关控制台窗口、`taskkill /T` 这类硬退仍会当场掐断当前句——不预留孤儿播放。
5. **云端协议是外部依赖**：微软改接口时云端路径可能失效，届时自动回落内置语音，功能不断
6. **气泡比首声早约 0.5 秒**：气泡在调用瞬间出现，语音要先合成。3.4.0 换成 helper 这条路之前，这个差值是 1–1.5 秒（合成慢）
7. **自动播报阈值偏保守**：长轮 120 s / 长任务 90 s / 静默窗 30–45 s，可按实际体感再调
8. **常驻一个 PowerShell 进程**：三条引擎都落在这个常驻进程与同一个音频端点上——本地语音把 WAV 直接写进 waveOut；Edge 的 MP3 由同一进程用 MCI 播放，并有一路循环静音流撑住端点不空闲（A2DP 在端点空闲时才丢缓冲）；内置语音渲染进同一个 waveOut 设备。空闲 60 s 才退出。只有常驻进程完全起不来时，才会回落到「每句一个进程」的老路径。
9. **超过 60 s 不说话的第一句要多等约 1.3 s**：设备要从关闭状态重新打开
10. **npm 包不含离线语音能力**：helper 二进制、微软 Speech SDK 与语音模型都不随包分发；上面出现的 `D:\DSH_Project\TTS\…` 只是作者本机路径，第三方要自己准备并用环境变量覆盖，否则第一档（helper）直接落空，自动回落到 SAPI 适配器 / Edge。

</details>

<details>
<summary><b>点击展开：开发（跑测试、目录结构、两条不能改的工程约束）</b></summary>

```sh
cd dsh-voice-speak
node --test        # 35 项：触发判定 + 事件接线 + 静默路径 + worker 协议，不需要出声
```

纯 ESM、无构建步骤、无第三方依赖。目录：

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 入口：注册 `say`、注入提示词、接 `session/event` 与 `jobs.events` |
| `lib/prompt.js` | 提示词全文（改口吻/触发口径只动这里） |
| `lib/triggers.js` | 自动播报判定、去重、静默窗、时长阈值 |
| `lib/tts.js` | 播放层：队列 + 三引擎调度 + 日志 |
| `lib/edge.js` | Edge TTS 客户端（TLS 握手、WebSocket 帧、`Sec-MS-GEC v2` token） |
| `lib/pet-bridge.js` | 桌面气泡窗（含圆形头像的解析与绘制） |
| `cordis.patch.yml` | 一行挂载声明 |

`lib/tts.js` 里有两处不能改的工程约束：PowerShell 一律用 `-EncodedCommand`（不拼 `-Command` 字符串），播放子进程用 attached + `unref()` 而不是 `detached`。原因都记在仓库经验库里。

</details>

---

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
