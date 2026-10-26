# 专用执行端连续人工控制

`server-executor` 在原生成桥接旁启动 `StudioControl`，共用现有 `StudioClient` 的主站 origin、Bearer、executorId 与进程 sessionId。沿用原启动和私有配置，无新增配置项、监听端口或服务。管理员明确连接账号后才打开该账号的持久浏览器窗口；原生成领取和回报协议保留。

控制请求使用 `POST /api/studio/doubao/executor/control`，固定包含 `action`、`executorId`、`version:"doubao-workbench/1"`、`executorSessionId`。

- `wait` 接收 `{session:null|{id,accountId,account:{id,name,environment},expiresAt},commands:[{id,action,inputEncrypted?,expiresAt}]}`。活动会话服务端最长 250ms 返回，空闲最长 20 秒。
- `publish` 增加 `sessionId`，可含 `frame`、`acknowledgements:[{id,ok,error?}]`、`error`。JPEG frame 为 `{imageBase64,contentType:"image/jpeg",width,height,capturedAt:number,loginState}`。

账号环境只在新会话开始时通过 `NativeAdapter.account` 配置和持久化一次。每 200ms 采集画面，操作结束后立即再请求一帧；登录状态用 `new Driver(...).isLoggedIn()` 独立探测，不等待每帧自动化就绪。截图沿用生产已验证的 Electron 双参数 `capturePage(undefined, {stayHidden:true})`，JPEG 质量 70、上限 1 MiB。

命令接收、串行浏览器输入、画面上传和回执上传分别推进。画面只允许一份在途、一份待发，待发画面被更新画面替换；回执也限制在途请求与待发数量。慢上传不会锁住输入或积累截图。

隐藏页面刚加载时的偶发截图预热失败由后续 200ms 采集继续读取，不立即断开会话。每会话连续 5 次截图失败才报告一次明确错误；成功生成一帧后清零，切换会话也重新计数。失败计数上限为 5，截图仍只保留一份在途采集；此容错不重试输入或 HTTP 控制请求。

输入沿用 `doubao-admin-input-v1` AES-GCM，仅在内存解密，支持归一化 click、pointer 的 down/move/up、带位置的 scroll、中文 text，以及明确修饰键的编辑/导航 key。修饰键为 Alt、Control、Meta、Shift；字母键必须带修饰键。所有 CDP 输入步骤前复核会话、账号环境版本、执行端代次、连接时间与命令截止时间。

已交付命令在执行前记入内存去重；到期、断线、切换或窗口关闭后不自动重放。活动请求在 4.5 秒超时，并另设最长 5 秒会话看门狗；即便底层请求忽略 abort 后迟到，也不能恢复旧会话输入。关闭会话会清空待发图片、输入、回执并解除窗口监听。账号 Cookie 和窗口持久存储不因此清除。

鼠标按下或按键按下从送入 CDP 前开始跟踪，只在对应释放成功后清除。中途过期、失败、断线、退出或切换时若仍有按下状态，直接销毁该账号的旧 BrowserWindow，不补发可能触发按钮的 mouseup、click 或 keyup。管理员重新连接后用相同持久 partition 重开，Cookie 保留；代价是这类中断会刷新临时页面。正常完成配对操作的会话继续保留原窗口和已有登录弹窗。

`open`/`frame` 请求新画面；`navigate` 对应“前往登录页”：先识别可见登录、扫码、验证码弹窗，已打开则保持；否则点击可见官方登录按钮，需要时才打开固定豆包首页。找不到入口会明确回执失败，管理员继续人工完成扫码、短信和验证码。

离线验证：

```powershell
node --test _test/studio-control.test.js _test/studio-window.test.js _test/studio-startup.test.js _test/studio-environment.test.js _test/studio-bridge.test.js
npm test
```

这些测试使用假的 HTTP/Electron 边界和隔离本地 store，覆盖背压、输入串行、会话/环境 fencing、迟到请求、过期不重放、拖动、中文输入、登录弹窗和进程退出。真实内网帧率、P95 延迟、中文字体及免费登录仍需集成验收；未执行真实视频生成。

`_test/studio-control.e2e.cjs` 可选真实 Chrome 验证关闭按下窗口不会误点顶层或跨源 iframe 的 pointer-capture 按钮，不补发已过期点击/按键、不触发原生拖放，并验证重开后 Cookie 与正常输入。安装 Playwright 后运行 `node _test/studio-control.e2e.cjs`；复用其他工程的依赖时，将 `DOUBAO_PLAYWRIGHT_PACKAGE` 设为该工程 `package.json` 的绝对路径。页面请求全部由本地 fixture 拦截，不连接真实豆包账号。

Electron 参数依据：[webContents.capturePage](https://www.electronjs.org/docs/latest/api/web-contents/#contentscapturepagerect-opts)。
