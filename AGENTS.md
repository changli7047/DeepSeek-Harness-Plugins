# AGENTS.md

本仓库是 Windows 插件集合，供 OpenCode v2 / DeepSeek Harness (dsh) 宿主安装使用。

## 收到"安装插件"指令时

1. `git clone https://github.com/changli7047/DeepSeek-Harness-Plugins`（或下载 zip），记绝对路径为 `$REPO`。
2. 读对应插件的 `README.md`，执行其 **「AI 安装」** 小节，逐条命令照做，不要自由发挥。
3. 执行其 **「自检」** 命令并核对预期输出；未通过自检不得报告安装成功。
4. 仅支持 Windows 10/11；宿主不存在时不要尝试为其它平台"适配"。

## 修改本仓库时

- `windows-tools/host/wt-host.ps1` 是唯一逻辑源头；改动后运行
  `node windows-tools/build/build.mjs` 重新生成 `windows-tools/dsh/windows-tools.ts`
  （构建器自带断言：13 个工具注册、1 个 apply 导出，失败即中止）。
- `windows-tools/opencode/index.ts` 直接引用同目录 `wt-host.ps1`；发布更新后
  使用方需要重新复制/重新克隆才能拿到新 host。
- 保持每个插件 README 的四节结构：功能清单 / AI 安装 / 自检 / 限制与卸载。
- 修改行为后，必须同步更新受影响插件 README 的说明与自检预期。

## 安全边界

插件具备完整桌面控制能力（键鼠模拟、截屏、窗口内容读取）。改动不得绕过宿主的权限体系，也不得引入网络上报。
