# AI 安装说明 · V0.5.2

这份说明供能使用本机文件、PowerShell 和浏览器的 AI 执行。

1. 确认源码已解压到可写、长期保留的目录。不要在 ZIP 内启动；检查 Windows x64 与 PowerShell 5.1。无需管理员权限。读取 `package.json` 和 `scripts/runtime-manifest.json`。
2. 如本机已经运行图纸工作台，读取 `http://127.0.0.1:17863/api/health`；如果来源目录不同，不强制停止或覆盖，向用户说明已有版本并处理其明确的升级需求。每个人从空索引开始，不从发布者电脑复制 data。
3. 在源码目录执行以下命令。安装脚本下载并校验隔离的运行环境，检查 PDF 依赖，创建桌面快捷方式并打开网页。

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
   ```

   无界面验收可加 `-NoLaunch -NoShortcut`；可加 `-DownloadCache "完整缓存目录"` 使用已校验缓存。下载缓存中需要 Node ZIP、Python ZIP、两个 wheel；文件名与校验值见 manifest。不永久更改系统执行策略。

4. 必须读取 `/api/health` 核对 `application=DrawingWorkbench`、`version=0.5.2` 和 appDirectory；再读取 `/api/status`，检查索引已启动、监听状态和 AI 默认配置。打开浏览器确认界面可用。
5. 首次默认扫描可访问盘符。若用户指定文件夹，在设置保存其完整路径。首次全盘扫描可能较久；区分“正在扫描”和“已全部完成”，无法访问的目录说明真实原因。
6. 用用户授权的临时目录创建合成 PDF 或 DWG 占位文件，验证新保存文件能被检索、时间戳备份归组，以及原文件未改动。合成 DWG 不代表 CAD 几何预览通过；PDF 预览需用真实有效的合成 PDF。验收记录留在临时工作目录，不进入仓库。
7. 默认不保存、不测试任何真实 DeepSeek 密钥。告诉用户可在设置填写自己的 Key；有明确授权才进行连接测试或付费 AI 调用。没有 Key 时，关键词搜索与规则分类仍正常。
8. 完成后报告安装目录、桌面入口、网址、数据保存位置、验证结果及实际失败项。不要把提供命令当成安装完成。

## 启动与调试

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\启动图纸工作台.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\停止图纸工作台.ps1
```

日志：`%LOCALAPPDATA%\DrawingWorkbench\data\logs`。关闭网页后仍在后台运行；退出后台使用停止脚本。

隔离验收可为启动进程设置以下环境变量，不要写进同事的正式配置：

```powershell
$env:DRAWING_WORKBENCH_DATA = '临时验收目录\data'
$env:DRAWING_WORKBENCH_ROOTS = '["临时验收目录的完整路径"]'
$env:DRAWING_WORKBENCH_PORT = '17864'
$env:DRAWING_WORKBENCH_HEADLESS = '1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\启动图纸工作台.ps1 -BackgroundOnly
```

环境变量均需替换为真实完整路径；启动和停止使用相同环境。测试结束恢复这些临时环境变量。程序只监听 `127.0.0.1`，不开放局域网或公网。

如果网络不能访问官方域名，保留明确错误，向用户说明需恢复网络或提供由可信来源下载并校验的缓存。不换成来历不明的二进制文件。

## V0.5.2 升级与验收

已有用户的升级必须先备份 SQLite 一致性副本和设置，正常停止旧服务后再保留完整个人数据目录（含本机加密凭据、用量、缓存）。先在隔离 DATA 迁移演练，核对历史人工分类、标签、归组映射、扫描设置和凭据指纹，再切换正式服务和桌面入口。启用自动启动的用户需核对登录入口指向新目录；保持原开关状态。

验收样本放在明确的临时目录，并将该目录加入正式排除设置；默认全盘扫描排除 `.test-tmp`。自动测试使用明确位于 `.test-tmp` 内的扫描根时只在该隔离根覆盖这一排除项。清理验收索引不删除物理文件。

核对空搜索清详情、订单批次规范键、跨版本组合筛选、原图后加入仍保持整组已整理、分类冲突确认、规则分批预览确认、AI 人工标签保留及真实版本证据。云端 AI 使用 mock 验收，不擅自进行付费连接测试。详细版本变更见 `版本记录.md`。

如升级失败，正常停止新版，保留失败目录，恢复升级前完整个人数据目录及桌面/登录入口，再启动旧程序。不要让旧程序直接写已经迁移的新数据库。
