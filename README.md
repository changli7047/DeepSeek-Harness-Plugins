# DeepSeek-Harness-Plugins

面向 AI Agent 桌面端的 Windows 插件集合。支持两种宿主形态：

- **OpenCode v2**（`~/.config/opencode/plugins/`，配置目录热加载）
- **DeepSeek Harness / dsh**（profile 配置层或 `--patch` 覆盖层）

所有插件均为**纯文件型**、无 npm/pip 依赖：`windows-tools` 依赖系统自带的 PowerShell 5.1；`archivist` 直接运行在宿主内置的 Node/TS 运行时上。

**注意：「复制文件即可安装」只对 OpenCode 端成立。** dsh 端的插件是 ESM 源码、会在运行时导入宿主包（如 `@deepseek-ai/dsh-tools`），因此必须放进 dsh 源码仓库中**已铺好 `node_modules` 的那一层**——惯例位置是 `<dsh-repo>/scratch-plugin/src/`——再把 profile 或 `--patch` 覆盖层指向该副本。指向本仓库的克隆目录会以 `Cannot find module '@deepseek-ai/dsh-tools'` 失败。

## 插件目录

| 插件 | 能力 | 适用端 |
|---|---|---|
| [windows-tools](windows-tools/README.md) | Windows 桌面观察与自动化：状态/元素快照、**后台窗口截图**、后台/前台点击与输入、剪贴板、窗口激活与启动、条件等待（dsh 13 个 / OpenCode 12 个工具） | OpenCode v2 + dsh |
| [archivist](archivist/README.md) | 本地长期知识库：资料/对话编译成互链 markdown wiki（检索、校验、索引、日志、免 git 备份，**实测支持千万 token 级数据量**），含双端「对话蒸馏」钩子（13 工具 + 2 钩子） | OpenCode v2 + dsh |

## 给 AI Agent：如何从此仓库安装插件

> 如果你是收到"从这个地址安装插件"指令的 AI，请严格按以下流程执行。

1. 克隆仓库（或下载 zip 解压）到本机任意目录，记其绝对路径为 `$REPO`：
   ```powershell
   git clone https://github.com/changli7047/DeepSeek-Harness-Plugins "$env:USERPROFILE\DeepSeek-Harness-Plugins"
   ```
2. 打开目标插件目录下的 `README.md`，找到其中的 **「AI 安装」** 小节，严格按步骤执行。
3. 执行该 README 中的 **「自检」** 命令，确认输出符合预期后，才算安装成功。
4. 不要跳过平台检查：所有插件目前**仅支持 Windows 10/11**。
5. **dsh 端特别注意**：插件文件必须放进 dsh 源码仓库里已铺好 `node_modules` 的那一层（惯例 `<dsh-repo>/scratch-plugin/src/`），profile 补丁或 `--patch` 的 `name:` 指向**该副本**。指向本仓库的克隆目录会以 `Cannot find module '@deepseek-ai/dsh-tools'` 失败——插件是 ESM 源码，裸导入按文件位置向上解析。

### For AI agents (English quick steps)

1. `git clone https://github.com/changli7047/DeepSeek-Harness-Plugins` and note the absolute path as `$REPO`.
2. Open `<plugin>/README.md` and follow its **"AI install"** section exactly.
3. Run the **self-test** command from that README; verify the output before reporting success.
4. Windows 10/11 only. No npm/pip dependencies; PowerShell 5.1 ships with the OS.

## 环境要求

- Windows 10 / 11（x64）——`archivist` 为文件类插件，理论可跨平台，当前在 Windows 实测
- 宿主运行时：OpenCode v2 或源码运行的 dsh（两者自带 Node/TS 运行时，`archivist` 依赖它）
- Windows PowerShell 5.1（`windows-tools` 依赖；系统自带，无需安装）
- 无网络依赖（安装后插件不访问网络）

## 安全须知

这些插件拥有**完整的桌面控制能力**（`windows-tools`：模拟键鼠、截屏、读取窗口内容）。仅在你信任的 Agent 会话中安装；插件本身不包含审批门禁，是否拦截工具调用由宿主（OpenCode/dsh）的权限策略决定。`archivist` 属文件类插件：只读写你指定的知识库目录与状态文件，不模拟输入、不访问网络。

## 新增插件约定（未来扩展）

1. 每个插件一个**顶级目录**：`<plugin-name>/`
2. 目录内必须有 `README.md`，且至少包含四节：
   - 功能与工具清单
   - **AI 安装**（逐条命令、可直接执行）
   - **自检**（可验证安装成功的命令与预期输出）
   - 限制与卸载
3. 在根 README 的「插件目录」表格中登记一行。
4. 发布物为**预构建产物**；如插件有构建步骤，把构建脚本放进插件目录并写明重生成方法。

## 许可证

[MIT](LICENSE)
