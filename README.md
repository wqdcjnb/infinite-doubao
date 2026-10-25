# 豆包工坊（无限豆包）

Windows 桌面应用，使用 Electron、JavaScript 和 Python 构建。当前版本为 **1.2.1**，内部项目标识沿用 `infinite-doubao`。

## 下载与安装

前往 [Releases](https://github.com/wqdcjnb/infinite-doubao/releases/latest) 下载 Windows x64 安装包 `DoubaoWorkshop-1.2.1-Setup.exe`，双击安装后通过桌面「豆包工坊」快捷方式启动。

发行附件中的 `SHA256SUMS.txt` 用于校验下载文件。在 PowerShell 中运行：

```powershell
Get-FileHash .\DoubaoWorkshop-1.2.1-Setup.exe -Algorithm SHA256
```

新安装默认使用 `%LOCALAPPDATA%\Programs\豆包工坊`。升级已有版本会沿用原安装位置。账号、会话、任务、素材和设置保存在 `%APPDATA%\无限豆包`，与程序目录分开。

## 主要功能

- 多账号环境与独立浏览器会话、代理配置和指纹检查。
- 任务模板、分镜编排、生成队列及本地视频素材管理。
- 图片与视频人脸遮挡处理、剪映草稿导出。
- 本地 REST API、MCP、SSE 和命令行入口。

生成能力和额度以对应服务实际提供的权限为准。

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

## 数据与凭据

仓库不包含账号、Cookie、API Token、用户设置、任务记录、素材、运行日志或本地备份。凭据只在使用者本机配置；不要将用户数据目录或 `.env` 文件提交到 Git。

源码当前沿用 `package.json` 中的 `UNLICENSED` 标识。第三方运行时、库和模型按各自许可使用，发行包保留其已有许可文件。
