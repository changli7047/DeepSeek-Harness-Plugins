# windows-tools regression suite

行为级回归网。入口固定：

```sh
node windows-tools/tests/run.mjs
```

- **退出码**：`0` = 每个用例都**判定过且通过**；`1` = 有失败；`2` = 没有失败但至少一条判定**无法行使**（INCONCLUSIVE，见下）。SKIP 不算失败。
- 汇总行**永远显式打印四类**：`passed / failed / skipped / inconclusive` —— 不许静默绿。
- 快跑单组：`WT_ONLY=element,window node windows-tools/tests/run.mjs`。
- 不是全绿时 scratch 目录会保留并打印路径（截图、构建副本、夹具描述符、激活日志都在里面）。
- `DSH_REPO=<dsh 检出>` 时额外跑 dsh 装载冒烟（假 ctx 调 `apply()`，断言 17 个工具）；未设则 SKIP。
- 每次运行都打印**夹具最长前台占用秒数**（目标 < 1s）——这是测试脚手架对用户的交代。

## 三类"非通过"结果的区别

| 结果 | 含义 | 是否算通过 |
|---|---|---|
| `SKIP` | 该用例在此环境不适用（例如未设 `DSH_REPO`） | 不算失败，也不算判定过 |
| `INCONCLUSIVE` | **前置条件不满足，判据没有行使**（例如调用前测试窗口已在前台，"这次调用是否激活了它"无法判断） | **不算通过**，且把退出码置为 2 |
| `FAIL` | 判据被行使且不成立 | 失败 |

`INCONCLUSIVE` 存在的理由：verifier 抓到过"全绿但不证明不抢前台"——夹具已在前台时，`activated` 断言走的是恒真的 else 分支。现在这类情形必须显式暴露，不许伪装成 pass。

## 覆盖范围（7 组）

| 组 | 内容 |
|---|---|
| `basic` | `status` / `snapshot`（含 target 过滤）/ 后台截图（window 模式、区域、`.png`、已存在默认拒绝、`overwrite=true`） |
| `element` | `find`（name / type / automationId、大小写不敏感、`ControlType.` 前缀、截断说明、无命中不是错误）、`element` 点击与输入、`read` 回读、`strategy`/`verified` 上报、经典 Win32 上的真实点击效果 |
| `window` | `winop` 八个动作（每步用 `status` 独立核对矩形/状态/topmost；`move`/`resize` 按 ±2px 容差，并各有「容差内通过 / 超容差必须失败」的边界用例）、`procs`（默认只列可见有标题窗口 + `includeHidden` 超集）、`waitfor` 三个新 kind 的正例 + 超时反例 |
| `errors` | 空 value、越界坐标、不存在的窗口、非法 action/mode/命令 —— 必须报错，静默兜底算失败 |
| `hygiene` | 宿主两行自检；三条红线（不移动真实鼠标、不占前台、不碰用户真实截图目录）；截图 `prune`/`pruneKeep`；§20 静态+运行期判据 |
| `build` | 构建幂等（在 `%TEMP%` 副本里跑两次比哈希）+ 仓库产物与当前 host 同步 |
| `dsh` | 生成物静态形状（17 注册 / 1 个 `apply`）+ env 门控装载冒烟 |

## 三条红线怎么被遵守和检查

1. **只用后台模式**：套件从不发前台键鼠输入；`cursorGuard` 用「空闲控制区间」判断真实指针是否本来就被人移动，不可归因时明确记 `not verifiable`，不编造通过或失败。
2. **测试窗口自建自毁，且被激活后立刻让位**：两种夹具都 `ShowActivated=false` + `WS_EX_NOACTIVATE`、自带消息循环、跑完关闭；从不拿用户已打开的应用当靶子。
   - **自我降级**：目标应用的 UIA provider 有时会把夹具窗口带到前台（见下 §20）。夹具一旦发现自己持有**系统前台**，立刻把前台交还给此前持有它的窗口（保留 5 个候选的历史 + shell 兜底），并把自身降到 Z 序底部（`SWP_NOACTIVATE`）。实测单次占用 **~3–40 ms**，套件每次运行都会打印最长值。
   - 两点踩过的坑，都写进代码注释：`ShowWindow(SW_SHOWNOACTIVATE=4)` 具有 `SW_SHOWNORMAL` 语义，会把**最大化窗口还原**（套件自己抓到 `winop maximize` 因此失败）→ 改用 `SW_SHOWNA=8`；占用时长按**系统前台**（`GetForegroundWindow`）测量，WPF 的 `IsActive` 对一个 `WS_EX_NOACTIVATE` 窗口会长时间虚高，用它会把占用算成好几秒。
3. **不碰用户数据**：截图保留策略用**自建 scratch 目录 + 重定向 `TEMP` 的宿主**验证，并断言同目录里不符合 `screenshot-*.png` 的文件不被删；另有「运行前后用户真实 `%TEMP%` 截图目录里既有文件一个都没少」的检查。剪贴板完全不被触碰（套件根本不调用 clipboard）。

## 两个已知的「不是用例问题」的事实（都可复现，不是"偶发"）

- **WPF 上后台点击不会触发控件（可复现）**：`background-post` 只把鼠标消息投递给窗口，WPF 的输入系统不把它变成路由事件。宿主侧 8 变体消融（Post/Send、DOWN/UP、有无 MOUSEMOVE、客户区/屏幕坐标、带不带 `WM_MOUSEACTIVATE`）**全部不触发**，只有 `uia-invoke-pattern` 能触发（而它需要 `allowForeground: true`，会抢前台，本套件从不发送）。处置：
  - `element/click-by-automationId`（WPF）断言**双向诚实性**——`verified` 必须与实际可观测效果一致（现在：处理器没跑 + `verified=false` → 绿；将来真能驱动 WPF 则 true+true 也绿；唯独「没生效却报 verified=true」会红）；
  - 「点击真的有效」挪到**经典 Win32**，用**同一个请求形状**：`element/click-delivers-to-a-win32-control` 点夹具里一个自定义 `Label`（`WtMessageProbe`），它自己的 `WndProc` 统计 `WM_LBUTTONDOWN`/`WM_LBUTTONUP` 并写进 scratch，断言的是**合成消息确实到达了控件** —— 与真实光标位置无关，确定性。
  - **WinForms `Button` 是已知平台细节，不算投递失败**：`Button` 在 mouse-up 时用 `Control.MousePosition`（**真实光标**）判断指针是否落在自己矩形内，所以后台投递的点击只在用户指针恰好位于该按钮上时才触发 `Click`（实测：光标不在按钮上时 **0/6**）。`element/click-on-a-winforms-button-is-a-platform-detail` 因此只断言「走的是 `background-post` + 回执点名了被命中的元素」，它是否触发**只记录、不判定**（要它稳定触发就得移动用户鼠标，红线禁止）。
- **WPF 上 `type` 的元素腿会激活目标窗口（可复现）**：`ValuePattern.SetValue` 是 WPF 上唯一真正能写入的后台腿（WPF 控件无原生句柄 → `wm-settext` 不可达；合成键鼠消息 WPF 不认）。实测：本套件本地仪器化 `type`+element **1/12**，implementer-host 复测 **3/28**，而 `read`/`keystream`/`click` 对照合计 **0/32 全零**；宿主该链**没有任何焦点 API**，是目标应用的 UIA provider 在 `SetValue` 里干的。处置（协议 §20：接受为平台事实，但**必须被上报**）——`hygiene/type-element-leg-activations-are-reported` 断言三件事：
  1. **静态**：`Invoke-WtElementType`（`host/wt-host.ps1`）里不得出现 `SetFocus`/`SetForegroundWindow`/`ShowWindow`/`AttachThreadInput` 等焦点 API；
  2. `find` / `wait_for` / `screenshot` 不得激活窗口；
  3. `type` 元素腿**真的激活了**（在宿主的观测窗内）就必须报 `activated=true`，**没激活就不得声称**——只有这两类不一致算红。
  - 该用例**最多重试 20 次**（激活概率 ~1/10）：命中一次即视为正向分支已覆盖；若观察到的激活**短于宿主 10ms 采样间隔**（夹具让位太快，物理上不可观测）则不算实现说谎，累计后报 `INCONCLUSIVE`（仍然不算通过）。
- **测试窗口必须用真消息循环（否则 UIA 慢十倍）**：夹具用 `Dispatcher.Run()` / `Application.Run()` 而非「泵一次睡 40ms」。后者会让每次跨进程 UIA 调用从毫秒级放大到 ~10 秒（同一宿主、同一机器实测 12766ms vs ~0ms）。

## 两种夹具

| 夹具 | 文件 | 用途 |
|---|---|---|
| WPF（默认） | `lib/fixture.ps1` | UIA 语义主夹具：`AutomationId`=`x:Name`、`ControlType` 正确、`ValuePattern`/`InvokePattern` 可用；`type` 元素腿的真实写入靠它 |
| 经典 Win32（WinForms） | `lib/fixture-win32.ps1` | 证明「后台点击**真的有效**」的那一侧：子控件经默认 HWND provider 暴露（`ControlType=Pane`、`AutomationId`=十进制句柄），所以用 `name`/`className` 选择器 |

两者都：不激活、自带消息循环、自我降级、跑完关闭、把描述符写进 scratch；都会把自己**系统前台占用**的跳变写进 `<scratch>/activated-<tag>.txt`（外加 `demote ...` 诊断行，解析器只认 `isActive=` 行）。这份日志是**局部事实**，不受「桌面当前有没有前台窗口」影响，也是能抓住 §20 那条平台行为的关键。

## 写用例的纪律

- 断言必须**会在行为回归时失败**：不许空断言、不许把「投递成功」当成「功能生效」。
- 判据说不了话时必须报 `INCONCLUSIVE`，**不许算 pass**。
- 失败信息要能让人一眼看出**哪条判据挂了**并附宿主逐字输出。
- 每条结论都要有独立信道核对（例如 `winop` 的状态用 `status` 交叉验证，而不是让工具自证）。
