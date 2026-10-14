# windows-tools

Windows 桌面观察与自动化插件，运行在**严格后台模式**：只观察、只向窗口投递消息，**不移动光标、不注入前台键鼠、不请求前台**。为 AI Agent 提供：**看**（状态 / UIA 元素快照 / **元素定位与读取** / **后台窗口截图**）、**动**（后台点击 / 后台输入 / 后台快捷键 / 后台滚轮 / **窗口操作**）、**等**（条件等待，替代盲目 sleep）。

> **严格后台是硬约束，不是默认值。** 宿主层里不存在任何前台能力（无 `SetCursorPos`/`mouse_event`/`SendInput`/`SetForegroundWindow`/`SetActiveWindow`/`AttachThreadInput`/`BringWindowToTop`，也没有真实按键注入路径）；动类工具**必须**带 `window`，否则直接报错。代价见 [严格后台模式与代价](#严格后台模式与代价)。

同一份逻辑同时面向两个宿主发布：

- `opencode/` — **OpenCode v2** 插件（配置目录热加载，无需重启）
- `dsh/` — **DeepSeek Harness** 插件（profile 配置层 / `--patch` 覆盖层）

实现：常驻 PowerShell 5.1 宿主进程（`host/wt-host.ps1`），插件通过 JSON 行协议调用；除系统自带组件外**零依赖**。

---

## 工具清单

| dsh 工具名 | OpenCode 工具名 | 说明 |
|---|---|---|
| `windows_status` | `windows.status` | 环境总览：屏幕/显示器、光标位置、前台窗口、全部可见窗口（矩形、进程名、窗口状态；窗口置顶时行尾多一个 ` topmost`）。**只读** |
| `windows_snapshot` | `windows.snapshot` | UI 元素树（按钮/输入框/列表项…含屏幕坐标）；`target` 指定窗口。**只读** |
| `windows_screenshot` | `windows.screenshot` | PNG 截图；`window` = **后台抓窗口（被遮挡可抓）**；`x/y/width/height` 区域（四个必须一起给或全不给）；`scale` 放大 1–4x；`filePath` 已存在时**默认拒绝覆盖**，须显式 `overwrite: true`（扩展名必须 `.png`）；**默认目录自带的截图有保留策略**（见下） |
| `windows_find` | `windows.find` | **元素定位**：每行 `[i] <名称> \| <类型> \| automationId=<id> \| rect=<屏幕 x>,<y>,<w>,<h> \| enabled=<b>`；`i` 就是 click/read/type 的 `element.index`；字段大小写不敏感**子串**、多字段 AND；只列屏上且矩形非空的元素（不套"可交互类型"白名单，静态文本也能找到）；无命中输出 `no element matched`（不是错误）；`limit` 默认 20、上限 200，被截断时输出 `truncated: showing N of M matches`。**只读** |
| `windows_read` | `windows.read` | **读文本**：`window` = 该窗口内 Document/Edit 的文本（**Label 不计入**，只给 `window` 时）；`element` = 指定元素（ValuePattern → TextPattern → 元素名），需同时给 `window` 作为搜索根；都不给 = 当前焦点控件。**只读** |
| `windows_click` | `windows.click` | **后台点击**：`window` **必填**，消息投给该窗口（`x/y` 是它的**客户区**坐标）；`element`（配 `window`）= 按元素点击，投到元素矩形中心（`strategy=background-post`）。回执两段不同信息：`element ...` = **本次操作的目标元素**，`point hit: ...` = **投递时刻屏幕上该点真实命中的窗口/元素**（被遮挡时会写成遮挡者，不一致是正常的）。`verified` **恒为 `false`**——送达 ≠ 应用真的响应。**驱动得了经典 Win32/Qt，驱动不了 WPF/WinUI**（见「限制」） |
| `windows_scroll` | `windows.scroll` | **后台滚轮**：`window` **必填**，滚轮消息投给该窗口；`amount` 正数上滚、负数下滚 |
| `windows_type` | `windows.type` | **后台输入**（精确 Unicode，含中文）：`window` **必填**；`element`（配 `window`）= 按元素写入，回退链只剩 `wm-settext`（WM_SETTEXT 到元素的原生句柄）→ `keystream`，回执写明 `[strategy=…] [verified=…]`。**UIA ValuePattern 这条腿已按严格后台要求删除**（WPF 上会偶发抢前台），因此**无原生句柄的元素（如 WPF TextBox）会被明确拒绝**而不是静默失败。不写剪贴板 |
| `windows_shortcut` | `windows.shortcut` | **后台快捷键**（ctrl+s、alt+tab…）：`window` **必填**，按键消息投给该窗口 |
| `windows_window` | `windows.window` | **窗口操作**：`move`/`resize`/`minimize`/`maximize`/`restore`/`close`/`topmost`；宿主这些动作**不请求前台**（`SetWindowPos` + `SWP_NOACTIVATE`、`ShowWindow`、`WM_CLOSE`；层内没有 `SetForegroundWindow`/`SetActiveWindow`），但 `minimize` 作用在**前台窗口**上时 Windows 会把前台交给 Z 序里的下一个窗口（见「限制」）；回执给出**操作后实测**的 `rect=`/`state=`/`topmost=`，`move`/`resize` 允许 **±2px** 的 DPI 取整误差（4px 以上仍报失败），且回报的永远是实测值而不是入参；**没有 focus/activate**（严格后台模式不提供） |
| `windows_process` | `windows.process` | **进程枚举**（只读，不 kill）：**默认只列可见且标题非空的顶层窗口**（每行一个窗口：`<pid> <name> \| <title> \| visible=<b>`，同一 pid 可多行）——这样同进程的隐藏辅助窗口（`Default IME`/`CiceroUIWndFrame`…）不会把真窗口挤出 `limit`；`includeHidden: true` 才补列隐藏窗口，此时才可能出现 `visible=false`；`name` 按**进程映像名**大小写不敏感子串过滤（结尾 `.exe` 可省，纯数字 = 精确 PID）；无命中输出 `no process matched`；`limit` 默认 50、上限 200 |
| `windows_clipboard` | `windows.clipboard` | 读/写剪贴板（用户明确保留写入能力） |
| `windows_wait` | —（用 `wait_for` 的 settle 替代） | 固定等待 0.1–30 秒 |
| `windows_wait_for` | `windows.wait_for` | 条件等待：`foreground`/`window`（标题）/`element`（元素出现，附命中行）/`windowgone`（窗口消失）/`text`（窗口文本含子串，附上下文片段）/`pixel`/`region`/`settle`；**超时抛错**；需要值的 kind 必须给非空值（空串会立即命中）；区域参数须四个一起给 |

**dsh 14 个工具 / OpenCode 13 个工具**（OpenCode 侧没有 `windows_wait`，用 `wait_for` 的 `settle` 替代）。
**已按严格后台要求删除**：`windows_move`、`windows_drag`（纯前台鼠标语义）与 `windows_app`（启动程序/激活窗口必然弹窗或抢前台）；`windows_click` 的 `allowForeground`、`windows_type` 的 `activate`/`mode:'paste'` 也一并删除。**启动程序或把窗口带到前台，请由用户手工完成。**


### 元素选择器（`find` 与 `click`/`read`/`type` 共用）

```json
{"name": "...", "type": "Edit", "automationId": "...", "className": "...", "index": 0}
```

- 每个字段都是**大小写不敏感子串**，多字段 **AND**；`type` 用 UIA 短名（`Button`/`Edit`/`Text`/…），也接受 `ControlType.Edit` 这种带前缀写法。
- 搜索范围 = `target`/`window` 指定窗口的**全部后代元素**，按 UIA 树序；跳过 `IsOffscreen` 与空矩形元素。
- `index` = 在**同一组选择器**命中的列表里取第 i 个（0 起），顺序与 `find` 打印一致。**只给 `index` 不给任何判别条件会报错**（歧义选择器不许蒙一个默认值）。
- **宿主无状态**：不存在"上一次 find 的结果"这种东西，两次调用之间窗口内容变了 `index` 就会错位——稳定做法是带上 `automationId`/`className` 一起选。
- `element` 配 `click`/`type` 时必须同时给 `window`（搜索根），否则报错。

### 写入与点击的策略上报

`windows_type`（元素路径）与 `windows_click`（元素路径）的响应**总是**以 ` [strategy=<leg>]` 和 `[verified=<true|false>]` 结尾，`verified` 只在**真的回读到效果**时才是 `true`：

| strategy | 何时出现 | 是否动剪贴板 / 请求前台 |
|---|---|---|
| `wm-settext` | 元素有原生窗口句柄：`WM_SETTEXT` 直接写给该句柄（经典 Win32/Qt 子控件就是这种） | 都不 |
| `keystream` | 回退到后台字符流（投给该元素句柄或窗口的输入句柄） | 都不（**不是**剪贴板） |
| `background-post` | 元素点击的唯一路径：在元素矩形中心后台投递鼠标消息 | 都不 |

**回退链的红线**：不使用剪贴板、不请求前台焦点、找不到可用后台路径就**如实报错**而不是静默降级。链上每一腿都真实上报——`strategy` 不会被编造，`verified=false` 就是没回读到。点击类回执的 `verified` **恒为 `false`**：宿主只能确认消息已送达，无法观察应用是否真的响应（`type` 能回读文本框内容，所以它的 `verified` 有真值）。

> **`uia-value-pattern` 与 `uia-invoke-pattern` 两条腿已被删除**（严格后台模式）：两者都会经由目标应用的 UIA provider 触发前台切换（WPF 上实测：`InvokePattern` 必抢，`ValuePattern.SetValue` 约 1/10 会抢）。因此**无原生句柄的元素（例如 WPF 的 `TextBox`/`TextBlock`）无法用元素腿写入**，插件会给出明确错误并建议改用窗口级 `keystream` 或剪贴板。

---

## 严格后台模式与代价

**宿主能担保的（代码层可 grep 验证）**：不存在 `SetCursorPos` / `SetPhysicalCursorPos` / `mouse_event` / `SendInput`，也不存在 `SetForegroundWindow` / `SetActiveWindow` / `AttachThreadInput` / `BringWindowToTop` / `SwitchToThisWindow`；没有任何真实按键/文本注入路径；所有"动"都通过 `PostMessage`/`SendMessage` 投递给指定窗口。动类工具（`click`/`scroll`/`shortcut`/`type`）**没有 `window` 就直接报错**，不存在前台回退。

**平台与语义上的残留（宿主担保不了，必须知道）**：

1. **WPF 上的输入能力归零**：唯一能写进 WPF 的腿（`ValuePattern.SetValue`）会偶发抢前台，已按严格后台要求移除；`wm-settext` 需要原生句柄（WPF 控件没有），`keystream` 的合成消息 WPF 也不认。→ **WPF 元素输入会明确报错**，不会静默失败。
2. **后台点击对 WPF/WinUI 无效**：合成鼠标消息不会变成它们的输入事件（8 变体消融实测）。消息能送达，应用不响应——回执如实写 `verified=false`。
3. **启动程序 / 把窗口带到前台，只能由用户手工做**：插件不再提供 `windows_app`，也没有任何 activate 类工具。
4. **`minimize` 的系统语义**：若被最小化的窗口**此刻正是前台窗口**，Windows 会把前台交给 Z 序里的下一个窗口（等同用户点最小化按钮）。这不是宿主在请求前台，但**是可见的影响**。
5. **目标应用自己的 provider 仍可能有自己的动作**：例如某些应用在被 `WM_SETTEXT`/投递消息后会自己激活窗口。宿主不做任何前台调用，但**不能保证目标应用不这么做**；`type` 的元素腿若观测到目标窗口从非前台变成前台，会在回执里追加 `activated=true`（观测窗口＝写入前 → 写入后 250ms；窗外发生的激活不归因到该次调用）。
6. **`windows_clipboard` 的写入会改用户剪贴板**：这是用户明确保留的能力，用之前请自行确认。


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
**验证**：在任意 OpenCode 会话中查看工具目录应出现 `windows.status` 等 13 个工具；或直接调用 `windows.status`。

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

**附加自检（只读，可选）**：`find` / `procs` / `read` 都是只读命令，可用一条命令连发多条请求（宿主按行读 JSON）来确认新命令可用。把 `WT` 换成任意当前存在的窗口标题片段：

```powershell
@(
  '{"cmd":"procs","name":"explorer","limit":3}',
  '{"cmd":"find","target":"WT","limit":3}',
  '{"cmd":"read","target":"WT"}'
) | powershell.exe -NoProfile -ExecutionPolicy Bypass -File $HOST
```

预期：`procs` 每行形如 `<pid> <name> | <title> | visible=<b>`（无命中为 `no process matched`）；`find` 每行形如 `[0] <名称> | <类型> | automationId=… | rect=… | enabled=…`（无命中为 `no element matched`，两者都是 `"ok":true`）。

---

## 使用示例（后台优先）

```
看   ：windows_status
       windows_snapshot({ target: "记事本" })
       windows_screenshot({ window: "记事本" })            # 被遮挡也能抓，不打扰用户
       windows_find({ window: "记事本", type: "Button" })  # 元素定位，拿到 [i]
       windows_read({ window: "记事本" })                  # 窗口内可读文本
动   ：windows_click({ window: "记事本", x: 120, y: 60 })   # 后台点击（客户区坐标；window 必填）
       windows_click({ window: "记事本", element: { automationId: "SaveButton" } })  # 按元素后台点击
       windows_type({ window: "记事本", text: "hello" })    # 后台输入（ASCII 可靠；window 必填）
       windows_type({ window: "记事本", element: { name: "搜索" }, text: "hello" })   # 按元素写入（回执带 strategy/verified）
       windows_scroll({ window: "记事本", amount: -3 })     # 后台滚轮
       windows_shortcut({ window: "记事本", keys: "ctrl+s" })  # 后台快捷键
窗管 ：windows_window({ action: "resize", target: "记事本", width: 900, height: 600 })  # 后台调整并回报实测尺寸
       windows_window({ action: "topmost", target: "记事本", on: false })
查   ：windows_process({ name: "Weixin" })                   # 带窗口的进程，一行一个窗口
等   ：windows_wait_for({ kind: "settle" })                  # 等渲染稳定
       windows_wait_for({ kind: "window", value: "下载", timeoutSeconds: 20 })
       windows_wait_for({ kind: "element", target: "记事本", automationId: "SaveButton", timeoutSeconds: 10 })
需要启动程序、把窗口带到前台、移动光标或按住拖拽时：**由用户手工完成**——本插件严格后台，不提供这些能力。
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

> 该适配对其他 Qt 自绘应用同样生效（点击/输入自动投顶层窗口）；对 WinUI/UWP 应用后台中文仍可能乱码，而严格后台模式下**没有前台输入这条退路**——请改用剪贴板 + 用户手工粘贴，或由用户直接输入。

## 限制与安全

- **平台**：仅 Windows 10/11；依赖系统自带 PowerShell 5.1。
- **严格后台的硬边界**：动类工具缺 `window` 直接报错；宿主不移动光标、不注入前台键鼠、不请求前台。平台侧残留（WPF 输入归零、WPF/WinUI 后台点击无效、启动/激活需用户手工、`minimize` 的前台交接）单列在 [严格后台模式与代价](#严格后台模式与代价)，请先读那一节。
- **后台操作是 best-effort**：经典 Win32 与 Qt 自绘应用（含微信 4.x 客户端）可靠；Chromium/Electron 可能靠 UIA 命中但不收合成输入，WinUI/UWP 后台中文输入会乱码；**这些场景本插件不提供前台退路**。
- **元素定位的覆盖面取决于目标应用有没有 UIA provider（实测边界，别期待"都能用"）**：WPF/WinUI/Chromium 这类自带 UIA provider 的应用会给出正确的 `ControlType`（`Button`/`Edit`/`Text`…）和稳定的 `AutomationId`；而**经典 Win32/Qt 应用的子控件经由系统默认 HWND provider 暴露**，实测结果是：`ControlType` 一律是 `Pane`，`AutomationId` 是**十进制窗口句柄**（每次运行都变，不可当标识用），只有 `ClassName` 带真实控件类名（如 `WindowsForms10.EDIT…`）。因此对经典应用请用 `className`/`name` 选择器；`automationId` 选择器在它们上面没有意义。`type` 的元素腿现在只剩 `wm-settext`（有原生句柄时）与 `keystream`——`strategy` 会如实告诉你是哪条。
- **元素点击只有一条腿：后台投递**（`strategy=background-post`）。宿主层内没有任何 `SetForegroundWindow`/`SetActiveWindow`，也没有 UIA `InvokePattern` 分支——`InvokePattern.Invoke()` 在 WPF 上必抢前台（实测，且目标窗口设了 `WS_EX_NOACTIVATE` 也拦不住），已按严格后台要求删除。**但"宿主不请求前台"不等于"目标窗口不会跑到前台"**：目标应用自己的 provider 可能自己这么做（见下一条）。
- **后台点击对 WPF/WinUI 无效——平台事实，不是消息没发出去（实测 8 种变体无一提触发）**：WPF 的鼠标输入来自真实输入系统，`PostMessage`/`SendMessage` 的 `WM_MOUSEMOVE`/`WM_LBUTTONDOWN`/`WM_LBUTTONUP`（客户端坐标或屏幕坐标、带不带 `WM_MOUSEACTIVATE`）都不会变成 WPF 的鼠标事件，对**非活动**窗口尤其如此。实测（自建 WPF 夹具，按钮 Click 会落盘标记）：
  ```
  v1 Post move+down+up (client, 宿主当前路径) -> Click fired: False
  v2 Send move+down+up (client)               -> Click fired: False
  v3 Post down+up only / v4 Send down+up only -> Click fired: False
  v5 Post (screen coords) / v6 Send (screen)  -> Click fired: False
  v7 Post WM_MOUSEACTIVATE + move+down+up     -> Click fired: False
  v8 InvokePattern（对照，必须触发）           -> Click fired: True
  ```
  对照的 WinForms Panel 后台点击**能让合成消息真的到达经典 Win32 控件**（判据覆盖到此：探针的 `WndProc` 收到 `WM_LBUTTONDOWN`/`WM_LBUTTONUP` 并计数），所以「后台点击」对经典 Win32/Qt 有效、对 WPF/WinUI 无效。**注意判据的边界**：它证明的是"消息送达控件"，**事件是否进一步被应用逻辑消费取决于应用自身**——例如 WinForms 的 `Button` 还依赖真实指针位置（`Control.MousePosition`），被遮挡或指针不在按钮上时它不会认为自己被按下。严格后台模式下**没有前台退路**：要操作 WPF/WinUI 的元素，只能由用户手工操作，或改用键盘可达的路径（本插件不提供）。`verified=false` 是如实上报：送达可观测，应用是否响应不可观测。
- **UIA 调用耗时取决于目标进程的消息泵**：跨进程 UIA 每次属性读取/树遍历都要等目标 UI 线程响应。目标用「`Dispatcher.Invoke(Background)` + `Start-Sleep`」这类**节流**泵时，一次 `find` 实测 **~12.8 秒**；同一台机器上目标跑真正的消息循环（`Dispatcher.Run()` / `Application.Run()`）时，4 次 `find` 合计 **860 毫秒**（含宿主冷启动）。测到「UIA 很慢」先看目标的泵，别先怀疑宿主。
- **WPF 上 `type` 的元素腿为什么被删掉（可复现的证据）**：目标应用自己的 UIA provider 在 `ValuePattern.SetValue` 里可能激活窗口（与 `InvokePattern` 抢前台同类）。夹具侧独立仪器化（记录目标窗口自身的 `Activated` 事件 + 轮询 `IsActive`，不依赖桌面当前有没有前台窗口）三轮对照：`type`+element **3/28**，而 `read`+element（只读同一个 ValuePattern）、`type`+window（keystream）、`click`+element（background-post）合计 **0/32**——可复现，单个调用上仍有随机性（约 1/10）。**宿主那条链本来就没有任何焦点调用**（现在整条 `ValuePattern` 腿连同全文件的前台 API 一起被删了，可以用函数名与 API 名 grep 核对），但"provider 会不会激活自己的窗口"宿主控制不了，所以严格后台模式的选择是**整条腿不要**：无原生句柄的元素（WPF `TextBox`/`TextBlock`）现在会被**明确拒绝**，不会静默失败。
- **保留的 `wm-settext`/`keystream` 仍有 `activated=true` 上报**：写入前后持续观测目标窗口是否从"非前台"变成"前台"（写入等待期间每 10ms 采样一次，写入后再采样 250ms），观测到就追加 `activated=true`（并注明是目标应用 provider 的行为、宿主未请求焦点）；没有观测到就不追加。**观测窗口的边界**：早于写入开始、或晚于写入后 250ms 才发生的激活不属于任何一次调用（实测：无 `activated=true` 不代表这次写入没有触发激活，只代表窗口在宿主观测的那段时间里没有变成前台）。20 轮对照实测：窗口 80ms 时一致 17/20，扩到 250ms 后 **20/20**（无漏报、无虚报）。
- **`wm-settext` 的适用范围**：只有当元素能拿到原生窗口句柄（`NativeWindowHandle != 0`）时这条腿才可用；**无句柄的元素（WPF 的 `TextBox`/`TextBlock` 等）没有可用的后台写入腿，会直接报错**（错误文案说明 ValuePattern 腿已按严格后台要求移除），而不是静默失败。回读不到内容时 `verified=false`——消息发出去了不等于内容落地。
- **`windows_window` 的诚实语义**：这些动作**不请求前台**（宿主层内根本没有 `SetForegroundWindow`/`SetActiveWindow`；`Invoke-WtWinOp` 只用 `SetWindowPos`+`SWP_NOACTIVATE`/`ShowWindow`/`WM_CLOSE`），回报的是**操作后重新测量**的矩形/状态/置顶位；测量与请求不符就报错。已知情形：最小化的窗口无法被 move/resize（先 `restore`）；`close` 只发 `WM_CLOSE`，若应用弹确认框，1.5 秒内窗口仍在就会报错而不是假装关闭成功。**一个系统语义而非宿主行为**：若被 `minimize` 的窗口此刻**正是前台窗口**，Windows 的 `SW_MINIMIZE` 会把前台交给 Z 序里的下一个窗口——这是最小化本身的语义（等同用户点最小化按钮），不是宿主在"抢"焦点；目标不是前台窗口时实测前台不变。
- **`winop move` 不做坐标钳制（有意为之）**：允许任意坐标，**含负值**——实测 `{"action":"move","x":-30000,"y":-30000}` 会照做并如实回执 `rect=-30000,-30000,...`。理由：多显示器布局里副屏坐标本来就可能是负的（主屏左侧的显示器），钳制会弄坏合法布局。（历史上那个会移动光标、带虚拟桌面越界校验的 `windows_move` 已按严格后台要求删除，现在只有这一条窗口移动路径。）
- **被最小化的窗口里没有"屏上元素"**：`find` 与 `wait_for kind=element` 只认屏上且矩形非空的元素（契约 §8），所以窗口最小化时它们匹配不到任何东西——这不是 bug。要么先 `winop restore`，要么用 `wait_for kind=window` 等窗口本身。
- **截图保留策略（默认目录）**：客户端在自己生成默认路径时会给宿主带 `prune: true`，宿主只清理该目录中**文件名匹配 `screenshot-*.png`（大小写不敏感）**的文件，保留最近 20 张（可用环境变量 `WINDOWS_TOOLS_SCREENSHOT_KEEP` 调整，夹紧 1–500），并在回执里报告 `|pruned=<n>` 或 `|pruned=<n> (k failures)`；删除失败不会让截图调用失败。**调用方显式传了 `filePath` 时一律不裁剪**，同目录里不符合命名规则的文件一概不动。
- **宿主脚本缓存保留策略（启动时清理）**：插件每换一版宿主就会在临时目录里 materialize 一份 `wt-host-<内容哈希16位>.ps1`，旧版本不会自己消失。宿主**在启动时**（一次性，无定时器、无后台任务）清理自己所在目录，规则：
  - **目录守卫**：只有当目录 basename 是 `dsh-windows-tools` 或 `opencode-windows-tools` 时才启用清理；**在仓库里直接跑 `windows-tools/host/wt-host.ps1` 时一个文件都不会动**（实测：非 `*-windows-tools` 目录下前后清单完全一致）。
  - **只删**匹配 `^wt-host-[0-9a-fA-F]{16}\.ps1$` 的文件；**永不删**正在运行的脚本、不带哈希的 `wt-host.ps1`（OpenCode 的安装副本命名）、以及任何不匹配的文件（截图、用户文件）。
  - 保留**最新 N 个**（按 `LastWriteTime` 降序，含正在运行的那个）：默认 **N=3**，环境变量 `WINDOWS_TOOLS_HOST_KEEP` 可覆盖，夹紧 **1–20**。
  - 删除失败不影响宿主启动或任何调用（忽略并继续）；整段逻辑外层也包了 `try/catch`。
  实测（自建 scratch）：`5 假脚本 + 运行副本 + screenshot-x.png + notes.txt + 无哈希 wt-host.ps1` → 清理后只剩**运行副本 + 最新 2 个**，两个非匹配文件与无哈希副本原样保留、运行脚本未被删；`WINDOWS_TOOLS_HOST_KEEP=1` → 只剩运行副本 1 个。
- **Qt / 微信适配**：Qt 窗口的后台点击/输入投给**顶层窗口**（渲染子窗口会忽略合成消息）；微信 4.x 的输入栈按 **GBK（代码页 936）** 字节流解码；插件显式调用 `Encoding.GetEncoding(936)`（不再用随系统 locale 变化的 `Encoding.Default`），因此可直接后台输入中文。
- **参数校验（失败即报错，不静默兜底）**：`windows_click`/`windows_scroll`/`windows_shortcut`/`windows_type` **缺 `window` 直接报错**（文案说明严格后台模式并给出指引）；`windows_screenshot` 的 `filePath` 目标已存在时默认拒绝覆盖（须显式 `overwrite: true`，扩展名必须 `.png`，拒绝时不动原文件）；截图区域 `x/y/width/height` 必须四个一起给或全不给；`windows_wait_for` 的 `foreground`/`window`/`text` 必须给非空 `value`，`element` 必须给至少一个选择器字段，`windowgone`/`element`/`text` 必须给 `target`；元素选择器**只给 `index`** 会报错（歧义选择器不许蒙默认值）；`click` 既不给 `x/y` 也不给 `element` 会报错；无原生句柄的元素写入会报错（见上）。
- **后台截图**：被遮挡窗口可抓；**最小化窗口不可抓**（会明确报错）；极少数 GPU 渲染应用可能黑屏。
- **"后台"不等于"目标窗口一定不会跑到前台"**：宿主不请求前台（这一点由代码层保证，可 grep），但目标应用自己的 provider 可能把它的窗口带到前台（WPF 已实测，`type` 保留腿会以 `activated=true` 上报）；另外 `minimize` 作用在前台窗口上时，前台会被 Windows 交给 Z 序里的下一个窗口。需要绝对无打扰时，先确认目标应用类型再决定用不用这些腿。
- **UIA 元素树**依赖目标应用的无障碍支持：VS Code 需以 `--force-renderer-accessibility` 启动或设置 `"editor.accessibilitySupport": "on"`。
- **安全**：插件具备完整桌面控制能力（截屏、读取窗口内容、**向指定窗口投递输入消息**、窗口状态操作、剪贴板读写），但**严格后台模式下不含光标移动与前台键鼠注入**；自身不含审批门禁。仅在可信会话安装使用。

## 卸载

- **OpenCode**：删除 `%USERPROFILE%\.config\opencode\plugins\windows-tools\` 整个目录（热加载自动卸载）。
- **dsh**：从 profile 补丁中删除对应的 `insert` 行（或启动时不再传 `--patch`），重启进程。

## 维护与构建

- `host/wt-host.ps1` 是**唯一逻辑源头**。
- **宿主 JSON 行协议的健壮性约定**：`stdin` 按 **UTF-8** 解码（`[Console]::OpenStandardInput()` + `StreamReader`），所以客户端既可以发**原始 UTF-8**，也可以发**纯 ASCII 转义**（`\uXXXX`，两个插件就是用这种形式，避免依赖控制台代码页）；`stdout` 恒为 UTF-8。命令名：`status`/`snapshot`/`screenshot`/`hit`/`mouse`/`keys`/`type`/`clipboard`/`waitfor`/`find`/`read`/`winop`/`procs`，其中 `click` 是 `mouse` + `mode:'click'` 的别名（两种等价）。严格后台模式下没有 `activate`/`launch`，`mouse` 只接受 `click`/`scroll`。
- **两个保留策略（都可配、都在客户端/宿主自己身上生效）**：截图默认目录用 `WINDOWS_TOOLS_SCREENSHOT_KEEP`（默认 20，夹紧 1–500，见「限制与安全」）；宿主脚本缓存用 `WINDOWS_TOOLS_HOST_KEEP`（默认 3，夹紧 1–20，启动时清理，带目录名守卫）。
- 修改后运行构建器重新生成 dsh 版（内嵌宿主）：
  ```powershell
  node windows-tools\build\build.mjs
  ```
  构建器自带断言（14 个工具注册、1 个 `apply` 导出），失败即中止，不会产出坏文件。
- OpenCode 版（`opencode/index.ts`）直接读取同目录的 `wt-host.ps1`，无需构建；发布更新后使用方需重新复制或重新克隆。
