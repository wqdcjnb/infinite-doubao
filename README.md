# 豆包工坊

Windows / macOS 桌面应用，使用 Electron、JavaScript 和 Python 构建。当前版本为 **1.4.0**。

## 下载与安装

前往 [Releases](https://github.com/wqdcjnb/infinite-doubao/releases/latest) 下载对应安装包：

| 系统 | 安装包 | 安装方式 |
| --- | --- | --- |
| Windows x64 | `DoubaoWorkshop-1.4.0-Setup.exe` | 双击安装，通过桌面「豆包工坊」启动 |
| macOS 13+，Apple 芯片 | `DoubaoWorkshop-1.4.0-mac-arm64.dmg` | 打开镜像，将应用拖入 Applications |
| macOS 13+，Intel | `DoubaoWorkshop-1.4.0-mac-x64.dmg` | 打开镜像，将应用拖入 Applications |

Mac 包内置 Python、OpenCV、FFmpeg 和 ffprobe，无需另装开发环境。首版使用临时签名，**尚未经过 Apple Developer ID 签名和公证**，系统可能提示无法验证开发者。项目不修改系统安全设置。Mac 更新时退出旧版，拖入并替换应用，再重新打开；用户数据位于 `~/Library/Application Support/无限豆包`，替换应用不会删除该目录。此内部目录名用于兼容数据。

发行附件中的 `SHA256SUMS.txt` 用于校验下载文件。在 PowerShell 中运行：

```powershell
Get-FileHash .\DoubaoWorkshop-1.4.0-Setup.exe -Algorithm SHA256
```

新安装默认使用 `%LOCALAPPDATA%\Programs\豆包工坊`。升级已有版本会沿用原安装位置和用户数据目录，保留账号、会话、任务、素材和设置。

可点击顶部「检查更新」→「下载更新」→「安装并重启」。应用从更新服务器获取安装包，显示下载进度，验证版本签名及安装包 SHA-256 后更新。首次使用需安装带更新按钮的版本，之后不用再拉取源码。设置中的更新源留空即使用默认服务器。

维护者发布新版本的命令、服务器部署和签名私钥备份要求见 [软件更新发布](docs/updates.md)。

1.3.1 优化了安装流程：首次安装解压后直接移动目录；覆盖安装通过 SHA-256 复用未变化的文件，仅解压、替换新增或变化的文件，减少重复磁盘写入。进度条会在整个安装完成后到达 100%。

## 主要功能

- 多账号环境与独立浏览器会话、代理配置和指纹检查。
- 任务模板、分镜编排、生成队列及本地视频素材管理。
- 独立草稿箱：复用不同任务模板和附件快照，指定同一个豆包账号，通过“工作任务 · 云电脑”批量提交。
- 图片与视频人脸遮挡处理、剪映草稿导出。
- 本地 REST API、MCP、SSE 和命令行入口。

生成能力和额度以对应服务实际提供的权限为准。

在“任务提交”左侧勾选多个不同模板，点击“所选模板加入草稿箱”，添加成功后停留在当前模板，显示成功信息条，方便继续编辑和添加。发送时打开顶部“任务提交”和“任务队列”之间的独立“草稿箱”页面。在页面顶部的“保存 / 发送账号”下拉框指定一个豆包号，点击“① 存入所选账号的豆包草稿”，将所选提示词和参考素材一起保存到该账号网页左侧的原生“草稿”。保存完成后点击“② 一起发送所选草稿”：固定通过工作任务云电脑，由所属账号发送，豆包接收一条后立即发送下一条，不等待视频生成完成。整批发送后复用现有任务队列取回各条视频；“直接生成视频”和其他正常提交仍按原规则分配账号。

旧版本仅保存在本机的草稿显示“待存入豆包”，选择账号后可统一存为云电脑草稿。已存入网页的草稿会显示所属账号；如需换号，在“任务提交”中将模板再次加入草稿箱，选择目标账号保存。旧版已存入网页的对话草稿需重新加入云电脑草稿。模板修改不影响已存草稿。部分失败时保留未发送记录；发送结果未确认时不会自动重发，请先核对豆包最近任务。移除软件中的草稿记录不会删除豆包网页里的原生草稿。

## 源码结构

| 目录 | 内容 |
| --- | --- |
| `src/` | Electron 主进程、业务模块和本地接口 |
| `renderer/` | 桌面界面 |
| `py/` | 人脸处理脚本与 YuNet 模型 |
| `tools/asar.mjs` | ASAR 打包与解包工具 |
| `build/` | 应用打包及单文件安装包构建脚本 |
| `installer/` | Windows C# 安装程序 |
| `_test/` | 单元测试和本机集成测试脚本 |
| `docs/` | 历史实现记录，部分内容对应旧版本 |

## 开发与验证

本项目没有 npm 运行时依赖清单中的第三方库；Electron 运行时需要单独准备。开发时可使用已配置到 PATH 的 Electron 执行 `npm start`，或使用运行时中的可执行文件打开项目目录。

在项目目录使用 Node.js 运行单元测试（PowerShell）：

```powershell
$testFiles = Get-ChildItem .\_test\*.test.js | ForEach-Object { $_.FullName }
node --test @testFiles
```

`*.e2e.js` 等集成脚本依赖独立测试数据目录、已启动应用或指定的调试端口，不能直接当作普通单元测试运行；部分脚本保留了开发机器路径和历史版本断言。

## 构建 Windows 安装包

现有构建脚本使用本地 Electron 运行时，不自动下载 Electron。准备 Windows x64 Electron 运行时、可用的 Python（含 `cv2` 和 `numpy`）及 .NET Framework 4.x C# 编译器。视频处理需将 `ffmpeg.exe` 放到 `tools/`，可选附带 `ffprobe.exe`。

在项目目录执行，替换运行时路径：

```powershell
node build/build.mjs --runtime "C:\path\to\electron-runtime" --out dist --name "豆包工坊"
node build/installer.mjs --app "dist\豆包工坊" --out dist --name "豆包工坊"
```

Python 默认从 PATH 查找，也可通过环境变量 `DOLAMOD_PYTHON` 指定。构建会将 Python、OpenCV、NumPy 和模型打包进应用。现有脚本保留开发机的运行时及 FFmpeg 回退路径，在其他机器上应显式提供运行时并准备 `tools/ffmpeg.exe`。

## 构建 macOS 安装包

在相应架构的 Mac 上准备 Xcode 命令行工具、NASM 和 pkg-config，运行 `npm run pack:mac`。脚本下载并校验固定版本的 Electron、可迁移 Python 和依赖源文件，安装精确版本的 OpenCV/NumPy，编译不依赖 Homebrew 动态库的 FFmpeg/x264，生成 `dist/mac-arm64/` 或 `dist/mac-x64/` 下的 DMG 和 SHA-256 文件。包内保留第三方许可和 FFmpeg/x264 源码及构建参数。构建需要网络，安装后离线视频处理不依赖系统工具。

GitHub Actions 的 `macOS packages` 工作流分别使用 Apple 芯片和 Intel macOS 环境运行单元测试、构建、安装镜像、启动主窗口和视频遮脸验证。它产出待验收附件；若已有对应同一提交的 Release 草稿，会将验证通过的 DMG 附到草稿，不自动公开 Release 或发布客户端更新。开发者可在 Mac 本机钥匙串准备 Developer ID，并设置 `DOLAMOD_MAC_SIGN_IDENTITY` 和可选的 `DOLAMOD_MAC_NOTARY_PROFILE` 启用正式签名及公证；凭据不入库。

Mac 剪映入口使用系统的文件打开方式寻找“应用程序”中的剪映/CapCut。不同剪映版本是否将文件插入当前工程，仍取决于该软件的文件关联支持。

## 数据与凭据

仓库不包含账号、Cookie、API Token、用户设置、任务记录、素材、运行日志或本地备份。凭据只在使用者本机配置；不要将用户数据目录或 `.env` 文件提交到 Git。

源码当前沿用 `package.json` 中的 `UNLICENSED` 标识。第三方运行时、库和模型按各自许可使用，发行包保留其已有许可文件。
