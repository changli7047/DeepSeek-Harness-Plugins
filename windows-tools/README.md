# windows-tools

Windows 桌面观察与自动化插件。为 AI Agent 提供：**看**（状态 / UIA 元素快照 / **后台窗口截图**）、**动**（点击 / 输入 / 快捷键 / 拖拽 / 滚轮，支持不打扰用户的后台模式）、**等**（条件等待，替代盲目 sleep）。

同一份逻辑同时面向两个宿主发布：

- `opencode/` — **OpenCode v2** 插件（配置目录热加载，无需重启）
- `dsh/` — **DeepSeek Harness** 插件（profile 配置层 / `--patch` 覆盖层）

实现：常驻 PowerShell 5.1 宿主进程（`host/wt-host.ps1`），插件通过 JSON 行协议调用；除系统自带组件外**零依赖**。

---

## 工具清单

| dsh 工具名 | OpenCode 工具名 | 说明 |
|---|---|---|
| `windows_status` | `windows.status` | 环境总览：屏幕/显示器、光标位置、前台窗口、全部可见窗口（矩形、进程名、窗口状态） |
| `windows_snapshot` | `windows.snapshot` | UI 元素树（按钮/输入框/列表项…含屏幕坐标）；`target` 指定窗口 |
| `windows_screenshot` | `windows.screenshot` | PNG 截图；`window` = **后台抓窗口（被遮挡可抓）**；`x/y/width/height` 区域（四个必须一起给或全不给）；`scale` 放大 1–4x；`filePath` 已存在时**默认拒绝覆盖**，须显式 `overwrite: true`（扩展名必须 `.png`） |
| `windows_click` | `windows.click` | 点击并回报**命中元素**（UIA hit-test）；`window` = 后台客户区点击（不动鼠标/不抢焦点） |
| `windows_move` | `windows.move` | 移动鼠标 |
| `windows_drag` | `windows.drag` | 按住左键拖拽 |
| `windows_scroll` | `windows.scroll` | 滚轮，回报指针下元素；`window` = 后台投递 |
| `windows_type` | `windows.type` | 精确 Unicode 输入（含中文）+ **前台模式输入后回读校验**（后台 `window` 模式不校验，返回 `(background: not verified)`）；`keys`/`paste` 两种模式；`activate` 原子激活；`window` = 后台投递 |
| `windows_shortcut` | `windows.shortcut` | 快捷键（ctrl+s、alt+tab…）；`activate`/`window` |
| `windows_app` | `windows.app` | 启动程序/文档/URL（带参数，报告新窗口标题）或激活窗口（自动恢复最小化） |
| `windows_clipboard` | `windows.clipboard` | 读/写剪贴板 |
| `windows_wait` | —（用 `wait_for` 的 settle 替代） | 固定等待 0.1–30 秒 |
| `windows_wait_for` | `windows.wait_for` | 条件等待：`foreground`（前台标题）/`window`（窗口出现）/`pixel`（像素变化）/`region`（区域像素差异）/`settle`（渲染稳定）；**超时抛错**；`foreground`/`window` 必须给非空 `value`（空串会立即命中），区域参数须四个一起给 |

---

## AI 安装

> 以下步骤面向执行安装的 AI Agent / 用户。先完成前置检查，再按你的宿主选择 A 或 B，最后必须运行「自检」。

### 前置检查

```powershell
# 必须全部满足：Windows 10/11；PowerShell 5.1 可用
$PSVersionTable.PSVersion    # 期望 Major=5
```

### 方式 A：OpenCode v2

```powershell
# $REPO = 本仓库克隆后的绝对路径（按实际修改）
$REPO = "$env:USERPROFILE\DeepSeek-Harness-Plugins"

$dir = Join-Path $env:USERPROFILE '.config\opencode\plugins\windows-tools'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item "$REPO\windows-tools\opencode\index.ts" "$dir\index.ts" -Force
Copy-Item "$REPO\windows-tools\host\wt-host.ps1"  "$dir\wt-host.ps1" -Force

# 期望：两个文件都存在
Get-ChildItem $dir | Select-Object Name, Length
```

**生效方式**：OpenCode 会监听配置目录并热加载，**无需重启**。
**验证**：在任意 OpenCode 会话中查看工具目录应出现 `windows.status` 等 12 个工具；或直接调用 `windows.status`。

### 方式 B：DeepSeek Harness (dsh)

dsh 插件是 ESM 源码，运行时**按文件位置向上解析裸导入**（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis` …）。所以插件文件必须位于 dsh 源码仓库中**已铺好 `node_modules` 的那一层** —— 惯例是 `<dsh-repo>/scratch-plugin/src/`。先把生成的插件复制过去，再让 `name:` 指向**这个副本**：

```powershell
# $REPO = 本仓库克隆后的绝对路径（按实际修改）；$DSH = dsh 源码仓库的绝对路径（按实际修改）
$REPO = "$env:USERPROFILE\DeepSeek-Harness-Plugins"
$DSH  = "$env:USERPROFILE\deepseek-harness"

# 1) 把 dsh 版插件复制到已铺好 node_modules 的那一层
$dst = Join-Path $DSH 'scratch-plugin\src\windows-tools.ts'
Copy-Item "$REPO\windows-tools\dsh\windows-tools.ts" $dst -Force

# 期望：副本存在
Get-Item $dst | Select-Object FullName, Length
```

> 放到别处也能用，但那个位置必须自备能解析 `@deepseek-ai/dsh-tools` 的 `node_modules`（裸导入逐级向上查找）。**把 `name:` 直接指向本仓库克隆目录会以 `Cannot find module '@deepseek-ai/dsh-tools'` 失败。**
> 副本是快照：本仓库更新（重新构建）后需重新执行上面的复制命令。

然后**任选一种**挂载方式：

**B1. 覆盖层启动（临时、最简）**

```powershell
# 1) 将 dsh/windows-tools.cordis.yml 复制到任意位置，把文件里的
#    <ABSOLUTE_PATH_TO_PLUGIN_FILE> 替换为 $dst 的绝对路径
#    （即 <dsh-repo>/scratch-plugin/src/windows-tools.ts）
# 2) 启动时传入：
dsh web --patch '<该 yml 的绝对路径>'
```

**B2. profile 常驻（推荐）**

在目标 profile 的补丁文件末尾追加以下 YAML（`name` 必须是**绝对路径**，且指向上面那个副本）：

```yaml
- insert:
    - id: windows-tools
      name: '<$DSH 绝对路径>/scratch-plugin/src/windows-tools.ts'
```

补丁文件位置：

- Web/CLI：`%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`（如 `web`）
- Desktop：`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`

**注意（重要）**：该文件已是 UTF-8 内容，追加时保持 **UTF-8（无 BOM）** 编码，建议用编辑器追加，不要在 PowerShell 里用默认编码的 `Add-Content` 直接写中文路径。

**生效方式**：重启对应 dsh 进程（Web 服务重启 / 桌面应用重启）。
**验证**：启动日志**不得出现** `did not activate` 或 `failed to import`；会话中调用 `windows_status` 应返回屏幕信息。

### 自检（两种宿主通用，先跑宿主级自检）

```powershell
$HOST = "$REPO\windows-tools\host\wt-host.ps1"
'{"cmd":"status"}' | powershell.exe -NoProfile -ExecutionPolicy Bypass -File $HOST
```

预期输出两行 JSON（第二行为当前桌面状态，结构如下）：

```
{"ok":true,"ready":true}
{"ok":true,"output":"screen: virtual (0,0) 2560x1440 monitors=1\n- monitor 0: ...\nfocus...\nwindows (N):\n  ..."}
```

> 若在控制台直接执行时中文显示乱码，属控制台编码现象；请以 JSON 结构（`"ok":true`、`screen:` 开头）判定成功。经宿主调用的输出为正确 UTF-8。

---

## 使用示例（后台优先）

```
看   ：windows_status
       windows_snapshot({ target: "记事本" })
       windows_screenshot({ window: "记事本" })            # 被遮挡也能抓，不打扰用户
动   ：windows_click({ window: "记事本", x: 120, y: 60 })   # 后台点击（客户区坐标）
       windows_type({ window: "记事本", text: "hello" })    # 后台输入（ASCII 可靠）
强力 ：windows_type({ activate: "记事本", text: "中文", clear: true })  # 前台精确输入（短暂借用焦点）
等   ：windows_wait_for({ kind: "settle" })                  # 等渲染稳定
       windows_wait_for({ kind: "window", value: "下载", timeoutSeconds: 20 })
```

---

## 微信 4.x（Qt）操作指南

微信桌面版 4.x 是 Qt 自绘窗口（进程名 `Weixin`），主窗口标题**跟随当前会话变化**。插件已内置全部适配（点击/输入自动投给顶层窗口、中文按 **GBK（代码页 936）** 字节编码，不依赖系统默认代码页），AI 按以下要点即可全程后台操作：

1. **定位窗口**：不要用"微信"当标题找——用进程名 `window: "Weixin"`（或 `windows_status` 里的 pid）；定位失败时的报错里也会带这条提示。
2. **坐标空间**：`windows_screenshot({ window: ... })` 返回图像素 = 客户区坐标，`windows_click` 的 `x/y` 用同一空间，所见即所得。
3. **打开会话**：先截图确认左侧会话列表的行位置，再后台点击对应行（切换后窗口标题会变成该会话名，属正常现象）。
4. **输入文字**：`windows_type({ window: "Weixin", text: "..." })`——中文不会乱码，无需前台（插件显式按 936 编码，英文/日文等非中文 locale 的机器上同样正确）。
5. **发送**：后台点击输入框右下角「发送」按钮（比回车稳，不受个人"回车发送"设置影响）。
6. **每步截图核验**（会话标题、输入框内容），确认无误再发送。

> 该适配对其他 Qt 自绘应用同样生效（点击/输入自动投顶层窗口）；对 WinUI/UWP 应用后台中文仍可能乱码，需要精确输入时改用前台 `activate`。

## 限制与安全

- **平台**：仅 Windows 10/11；依赖系统自带 PowerShell 5.1。
- **后台操作是 best-effort**：经典 Win32 与 Qt 自绘应用（含微信 4.x 客户端）可靠；Chromium/Electron 可能靠 UIA 命中但不收合成输入，WinUI/UWP 后台中文输入会乱码；此类场景用前台 `activate` 模式。
- **Qt / 微信适配**：Qt 窗口的后台点击/输入投给**顶层窗口**（渲染子窗口会忽略合成消息）；微信 4.x 的输入栈按 **GBK（代码页 936）** 字节流解码；插件显式调用 `Encoding.GetEncoding(936)`（不再用随系统 locale 变化的 `Encoding.Default`），因此可直接后台输入中文。
- **参数校验（失败即报错，不静默兜底）**：`windows_screenshot` 的 `filePath` 目标已存在时默认拒绝覆盖（须显式 `overwrite: true`，扩展名必须 `.png`，拒绝时不动原文件）；截图区域 `x/y/width/height` 必须四个一起给或全不给（只给一半报错，不再静默按全屏或从 (0,0) 处理）；`windows_wait_for` 的 `foreground`/`window` 必须给非空 `value`；前台键鼠坐标必须落在虚拟桌面范围内，越界报错、`SetCursorPos` 失败如实报错而不是假报成功。
- **后台截图**：被遮挡窗口可抓；**最小化窗口不可抓**（会明确报错）；极少数 GPU 渲染应用可能黑屏。
- **前台操作**会移动真实光标并改变焦点；能用 `window` 参数就用它，可完全避免打扰。
- **UIA 元素树**依赖目标应用的无障碍支持：VS Code 需以 `--force-renderer-accessibility` 启动或设置 `"editor.accessibilitySupport": "on"`。
- **安全**：插件具备完整桌面控制能力（键鼠模拟、截屏、窗口内容读取），且自身不含审批门禁。仅在可信会话安装使用。

## 卸载

- **OpenCode**：删除 `%USERPROFILE%\.config\opencode\plugins\windows-tools\` 整个目录（热加载自动卸载）。
- **dsh**：从 profile 补丁中删除对应的 `insert` 行（或启动时不再传 `--patch`），重启进程。

## 维护与构建

- `host/wt-host.ps1` 是**唯一逻辑源头**。
- 修改后运行构建器重新生成 dsh 版（内嵌宿主）：
  ```powershell
  node windows-tools\build\build.mjs
  ```
  构建器自带断言（13 个工具注册、1 个 `apply` 导出），失败即中止，不会产出坏文件。
- OpenCode 版（`opencode/index.ts`）直接读取同目录的 `wt-host.ps1`，无需构建；发布更新后使用方需重新复制或重新克隆。
