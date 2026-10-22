# AGENTS.md

本仓库是 Windows 插件集合，供 OpenCode v2 / DeepSeek Harness (dsh) 宿主安装使用。

## 收到"安装插件"指令时

1. `git clone https://github.com/changli7047/DeepSeek-Harness-Plugins`（或下载 zip），记绝对路径为 `$REPO`。
2. 读对应插件的 `README.md`，执行其 **「AI 安装」** 小节，逐条命令照做，不要自由发挥。
3. 执行其 **「自检」** 命令并核对预期输出；未通过自检不得报告安装成功。
4. 仅支持 Windows 10/11；宿主不存在时不要尝试为其它平台"适配"。
5. **dsh 端的位置约束**：插件文件必须位于 dsh 源码仓库中已铺好 `node_modules` 的那一层（惯例 `<dsh-repo>/scratch-plugin/src/`），补丁里的 `name:` 指向该副本。dsh 插件是 ESM 源码、运行时会导入 `@deepseek-ai/dsh-tools`，裸导入按文件位置向上解析 —— 指向本仓库克隆目录会以 `Cannot find module` 失败。OpenCode 端无此约束。

## 修改本仓库时

- `windows-tools/host/wt-host.ps1` 是唯一逻辑源头；改动后运行
  `node windows-tools/build/build.mjs` 重新生成 `windows-tools/dsh/windows-tools.ts`
  （构建器自带断言：14 个工具注册、1 个 apply 导出，失败即中止）。
- `windows-tools` 运行在**严格后台模式**：宿主层不得出现任何前台能力（光标移动、前台键鼠注入、`SetForegroundWindow`/`SetActiveWindow` 等），动类工具必须带 `window`；新增能力前先读插件 README 的「严格后台」一节。
- `windows-tools/opencode/index.ts` 直接引用同目录 `wt-host.ps1`；发布更新后
  使用方需要重新复制/重新克隆才能拿到新 host。
- `archivist/core/` 是 archivist 插件的唯一逻辑源头，由 `core/archivist.mjs`（入口 / CRUD / 工具表）
  + `core/mod-*.mjs`（分块、索引、检索、证据包、引用核验）组成；改动后运行
  `node archivist/build/build.mjs` 重新生成 `archivist/opencode/index.ts` 与 `archivist/dsh/archivist.ts`。
  构建器把模块内联成一个自包含文件，断言：工具注册数、无残留相对 import、`node --check` 通过、
  顶层重名会报出是哪两个文件（模块内部辅助符号必须带 `ch_/ix_/rt_/ev_/vf_` 前缀）。
- 本机部署：`node archivist/build/deploy.mjs` 把生成物复制到 dsh 源码仓库的
  `scratch-plugin/src/archivist.ts`（profile patch 从那里加载）；覆盖前自动备份、复制后校验 sha256。
  生效需要重启 dsh 宿主。**不要**把 patch 指向本仓库克隆目录（裸导入 `@deepseek-ai/dsh-tools` 会 `Cannot find module`）。
- 保持每个插件 README 的四节结构：功能清单 / AI 安装 / 自检 / 限制与卸载。
- 修改行为后，必须同步更新受影响插件 README 的说明与自检预期。

## 安全边界

插件具备完整桌面控制能力（键鼠模拟、截屏、窗口内容读取）。改动不得绕过宿主的权限体系，也不得引入网络上报。
