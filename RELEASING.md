# 发布操作单（GitHub 转公开 / npm）

本文件只在仓库里，不随 npm 包发布（`package.json.files` 未包含它）。

## A. GitHub 仓库转公开（需要本人网页操作）

本机没有 `gh` CLI，也没有可用 token，所以这一步只能手点：

1. 打开 `https://github.com/tianDe966/dsh-voice-speak/settings`。
2. 拉到最下方 **Danger Zone** → **Change repository visibility** → **Make public** → 按提示输入仓库名确认。
3. 转公开后回来告诉我，我会做两件事：
   - 把 `README.md` 的安装说明从「本地 link」改为公开 clone 地址，并复查没有别处泄露本机路径；
   - 用公开地址重新克隆一次，确认 `node --test` 仍 35/35。

转公开前的自查（我已查过，记录在此）：
- 仓库只含插件本体（`lib/`、`test/`、`README`、`CHANGELOG`、`LICENSE`、`cordis.patch.yml`、`package.json`）。
- 不含 `~/.dsh/remote-notify.json`（QQ 授权码）、不含 `D:\DSH_Project\TTS` 语音资产、不含个人路径（`.gitignore` 已排除 `_probe/`、`*.log`）。

## B. npm 发布（**由本人手动执行**，模型只准备命令）

本机 npm 已有网页授权的登录态，`npm publish` **不需要输验证码**（2026-10-29 实测两次）。不要再去创建「Bypass 2FA」的 granular token——npm 正在弃用这类 token，用它会失败或只把版本挂起（见经验库 2026-10-29 条目）。

**模型负责**：改版本号、同步 README/CHANGELOG、跑测试与打包预检、给出下面这段可直接粘贴的命令、发布后回查 registry。

**本人负责**：在 cmd 里执行（模型会在发布前把版本号填好）：

```bat
cd /d D:\DSH_Project\plugin01\dsh-voice-speak
npm publish --access public
```

发布完成后告诉模型一声，模型会复核：

```powershell
$env:npm_config_cache = "D:\DSH_Project\plugin01\_probe\tmp\npm-cache"
npm view dsh-voice-speak versions --json --prefer-online
npm view dsh-voice-speak dist-tags --json --prefer-online
```

**别只看输出里的 "Published" 字样**：2026-10-29 出现过「输出像成功、registry 其实没有这个版本」的情况，必须回查 `versions` 与 `dist-tags`。

## B2. 可安装性自检（2026-10-29 实跑通过，任何一次发版后都可复跑）

用临时 profile，不碰日常用的 `web` profile：

```sh
# 1) 文档里的安装命令（本地 clone + link）
git clone <仓库地址> _probe/tmp/scratch/repo
dsh plugin --profile scratchprobe add link:D:/.../\_probe/tmp/scratch/repo
dsh --profile scratchprobe --dump-config | findstr tool-voice-speak   # 必须有 - id: tool-voice-speak

# 2) npm tarball 路线（发布 npm 之前也能验）
npm pack --pack-destination _probe/tmp/tgz
dsh plugin --profile scratchprobe2 add file:D:/.../\_probe/tmp/tgz/dsh-voice-speak-<版本>.tgz
dsh --profile scratchprobe2 --dump-config | findstr tool-voice-speak

# 3) 收尾：删掉临时 profile 与临时目录
```

实测结论（2026-10-29）：两条路线都出现 `- id: tool-voice-speak`，说明「陌生人照 README 能装」这条最低验收标准已经满足；npm 发布只是换一个来源。

## C. 每次发版的固定流程（本机已自动化）

```sh
cd D:\DSH_Project\plugin01
git tag -a v<版本> -m "<摘要>"
git branch -D release-head
git subtree split --prefix=dsh-voice-speak -b release-head
git push publish release-head:refs/heads/main
git push publish v<版本>
```

然后做静态备份 `D:\DSH_Project\backup\dsh-voice-speak-V<版本>`（插件目录、`经验库/`、`.gitattributes`、`.gitignore`、`VERSION.md`）。

## D. 发布前最容易漏的四件事

1. **`package.json` 首字节必须是 `{`**：PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，DSH 加载会整包跳过；改完用 `dsh --profile web --dump-config | findstr tool-voice-speak` 验一次。
2. **README 顶部的「本版本：`x.y.z`」要手改**：它不读 `package.json`，2026-10-29 就因为漏改被用户在 GitHub 上看到 `3.1.1`；CHANGELOG 顶部也要加新版本段。
3. **标签打在新提交上**：subtree split 之后再打标签，否则远端标签指向旧树。
4. **npm 首次发布**：先 `npm whoami` 确认登录态（未登录报 `ENEEDAUTH`），再 `npm publish`；`prepublishOnly` 会自动跑测试。
