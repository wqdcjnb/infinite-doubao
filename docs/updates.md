# 软件更新发布

客户端默认地址为 `http://10.1.11.88:17824/latest.json`。用户点击顶部「检查更新」，查看说明并下载，校验通过后点击「安装并重启」。首次启用此功能的旧版本需先手动安装一次 1.3.1 或更新版本。

生成或排队任务、界面遮脸任务尚未结束时不允许安装。安装前保存模板修改和本地数据，等待旧进程退出，然后沿用原安装目录覆盖更新并重新打开应用。安装器失败会显示错误；下载失败可以重新检查并重试。账号、会话、草稿、任务、素材和用户设置继续保存在原用户目录。

macOS 使用同一服务器的 `latest-darwin-arm64.json` 或 `latest-darwin-x64.json`。清单必须匹配当前架构并带有效签名，下载 DMG 后校验大小与 SHA-256。点击「打开安装镜像」后应用退出，由用户拖拽替换应用，再重新打开；不会执行 Windows 安装参数。

## 已部署服务器

- 主机：`10.1.11.88`，TCP 端口 `17824`，仅监听该地址。
- 程序及发布根目录：`C:\ProgramData\DoubaoWorkshopUpdates`。
- Windows 计划任务：`DoubaoWorkshopUpdates`，SYSTEM 身份开机启动，异常退出后重试。
- 防火墙规则同名，仅允许 LocalSubnet 访问该地址的更新端口。
- HTTP 服务只允许 GET/HEAD 读取三个平台清单和指定格式的 EXE/DMG，不提供上传或目录浏览。
- 上传通过现有 SSH 别名 `codex-10-1-11-88`，不需要客户端登录或配置 Token。

服务器脚本位于 `build/update-server.cjs`、`build/activate-update.cjs` 和 `build/install-update-server.ps1`。需要重新部署时，将这三个文件以及 `src/update-public-key.pem` 复制到服务器根目录，在服务器的管理员 PowerShell 中执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\DoubaoWorkshopUpdates\install-update-server.ps1
```

脚本执行策略参数仅作用于该进程。不要改变服务器地址或换签名公钥，除非同时规划客户端迁移。

## 每次发版

1. 同步 `package.json`、`src/brand.js`、安装器和页面显示的版本号，使用递增的 `主.次.修订` 版本。
2. 验证代码，重新打包应用和安装包；在本机覆盖安装并验证快捷方式和数据保留。
3. 准备 UTF-8 更新说明文本，运行以下命令。私钥默认读取本机 `%LOCALAPPDATA%\DoubaoWorkshopPublisher\update-private.pem`，也可用 `DOLAMOD_UPDATE_KEY` 指定本机路径。

```powershell
npm run publish:lan -- --installer "dist\豆包工坊 v1.3.1 安装包.exe" --notes-file "build\release-notes.txt"
```

命令将安装包复制为 `DoubaoWorkshop-<版本>-Setup.exe`，生成签名 `latest.json` 和 `SHA256SUMS.txt`，通过 SSH 上传临时目录。服务器验证签名、大小和 SHA-256，通过后先放置完整安装包，再原子替换版本清单。禁止版本回退或把同一个版本替换成不同内容。上传失败时旧版本保持可用，修复连接后重跑命令即可。

仅生成发布文件而不上传，可运行 `node build/publish-update.mjs` 并提供相同参数（不加 `--upload`）。默认产物目录为 `build/lan-update-release/<版本>`。随后将已验收源码推到 GitHub，并把同一个安装包、`SHA256SUMS.txt` 和 `latest.json` 放到该版本 Release。GitHub 源码推送不会自动构建安装包或发布客户端更新。

## 签名与备份

Mac 安装包使用同一发布密钥生成更新清单，分别运行（路径以实际构建产物为准）：

```powershell
node build/publish-update.mjs --platform darwin --arch arm64 --installer "dist/mac-arm64/DoubaoWorkshop-1.4.0-mac-arm64.dmg" --notes-file "build/release-notes.txt" --upload
node build/publish-update.mjs --platform darwin --arch x64 --installer "dist/mac-x64/DoubaoWorkshop-1.4.0-mac-x64.dmg" --notes-file "build/release-notes.txt" --upload
```

三个平台清单独立更新，旧 Windows 客户端仍读取 `latest.json`。部署新版服务端脚本后再发布首个 Mac 包。更新清单签名用于校验发布来源，不等同于 Apple 的 Developer ID 签名或公证。

发布私钥只在发布者本机保存，不能加入仓库、客户端、HTTP 发布目录或 GitHub 附件。`src/update-public-key.pem` 是客户端内置公钥，可以公开。发布脚本会检查私钥是否与客户端公钥匹配。

应将私钥安全备份；换发布电脑时从备份恢复同一私钥，并配置 SSH 连接。不要为每次发版生成新密钥，否则已安装的客户端会拒绝新版本。服务器只保存公钥，不保存私钥或客户端账号数据。

## 验证

```powershell
node --test _test/update.test.js
& _test/installer-locks.test.ps1
```

`_test/update.e2e.js` 需要 `DM_TEST_RUNTIME` 指向包含当前代码的测试版应用，使用独立测试数据目录和端口 9256。它验证下载及界面状态，不运行测试安装文件。正式交付还应验证完整安装及快捷方式启动。
