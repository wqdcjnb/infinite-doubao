# Linux 主动领取执行端

本入口是豆包工坊的独立运行模式：`electron . --studio-executor --studio-config /absolute/private/executor.json`。不加载桌面主窗口，不启动原有 HTTP、MCP 或网页版端口。需要 Linux 原生 Electron、服务用户可用的图形显示（例如已经准备好的虚拟显示）和独立、可写的持久目录；不能把 Windows EXE 当成 Linux 服务。

素材工厂账号环境支持管理员明确选择服务器出口（加密配置`proxy:{mode:"direct"}`），或沿用独立HTTP/HTTPS/匿名SOCKS5代理。缺失或无效配置仍拒绝，独立代理失败不回退直连。每个账号继续使用独立持久会话和固定环境，线路切换清理旧连接及鉴权；服务器出口账号共用IP，主站重复出口检查保持。

代码已通过285项纯 Node 离线测试。Ubuntu24.04/x86_64 的 Electron43.2.0 已在启用 Chromium 沙箱、关闭TCP监听并认证的Xvfb显示下通过空白页及真实服务窗口/驱动验证：自动化脚本正常加载、二次导航重新注入、只读获取标题成功、截图10247字节。实际renderer的NoNewPrivs=1、Seccomp=2，页面无require/process。账号人工登录、100条真实任务、下载上传与重启后的真实对话恢复由部署后的真实业务验收确认，不能用本地HTML或模拟测试代替成片验收。

## 私有配置

以下只是格式示例，地址、目录与执行端标识需要与主站管理员配置一致。配置和令牌文件不进入 Git，不在命令行传令牌：

```json
{
  "siteUrl": "https://existing-material-studio.example",
  "executorId": "doubao-linux-1",
  "tokenFile": "/var/lib/doubao-executor/private/executor.token",
  "stateDir": "/var/lib/doubao-executor/state",
  "operationConcurrency": 2,
  "maxDraftPages": 4,
  "trackingPages": 2
}
```

`siteUrl` 默认必须是现有主站的 HTTPS origin；本机测试允许 HTTP loopback。仅在私有配置明确设为 `allowLocalHttp:true` 时，允许使用通过 `os.networkInterfaces()` 确认为本机已有网卡地址的 HTTP 字面 IP；域名、未分配 IP 或只因属于某个私网段均不能启用此例外。此选项不修改监听器、TLS、代理或网络配置，HTTPS 始终校验证书。`tokenFile` 和 `stateDir` 必须是绝对路径，Linux 令牌文件必须为 0600。令牌文件只存独立执行端令牌，不能使用管理员登录 Cookie。首次使用全新的专用 stateDir；禁止复制桌面端 store、Cookie 或私人账号会话。服务用户独立登录的 Cookie 和 IndexedDB 保存在该目录，保留目录才能恢复原草稿和原对话。

批次上限为服务端批准的 100 条；`maxDraftPages` 默认 4，限制同时等待接收/确认的独立页面（允许 1–8），不是一次开 100 个浏览器。`trackingPages` 默认 2，限制取回队列并发。`operationConcurrency` 默认 2，允许慢发送期间继续领取管理员登录操作。单账号的发送与队列沿用原有互斥。批次完成判定、0.5 积分和 168 小时冷却均由主站负责，执行端不会根据本地桌面额度判定整个批次结束。

## Linux 服务示例

仅供后续由运维审查和部署，仓库不会安装、启动或重启服务。示例假设已有对应服务用户、Linux Electron 和 `:99` 显示，不创建显示服务，也不改变网络设置：

```ini
[Unit]
Description=Doubao workbench outbound executor
After=graphical.target

[Service]
Type=simple
User=doubao-executor
WorkingDirectory=/opt/doubao-workbench
Environment=DISPLAY=:99
ExecStart=/opt/electron/electron /opt/doubao-workbench --studio-executor --studio-config /var/lib/doubao-executor/private/executor.json
Restart=on-failure
RestartSec=10
UMask=0077
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

本入口使用独立 Chromium persist 会话，通过专用 studio-environment 工厂应用逐账号代理和固定指纹；不调用桌面共享代理认证缓存或 Cookie 导入函数。没有新增监听端口、反向代理、端口映射、DNS、防火墙、隧道或 Docker 网络配置；如果服务器的现有访问条件不足，应单独提出所需变更并取得授权。

## 协议 v1

所有控制请求发送到 `POST /api/studio/doubao/executor`，`Authorization: Bearer <独立令牌>`；JSON 固定包含 `executorId` 和 `version: "doubao-workbench/1"`：

- `heartbeat`：`{ action, executorId, version, leases: [{ operationId, leaseToken }], sessionId }`，每 15 秒续租，包括长时间浏览器操作与待回报记录。
- `claim`：`{ action, executorId, version }`；接收 `{ operation: null | { id, kind, accountId, taskId?, batchId?, leaseToken, leaseUntil, payload } }`。
- `report`：再加 `operationId`、`leaseToken`、`outcome: success|failure|uncertain|progress` 和 `receipt`。

任务引用图片必须带 `downloadUrl`，只接受同主站 origin，禁止重定向；按快照顺序下载并核验 MIME、文件标识、20 MiB 单张上限、精确大小和 SHA-256。引用文件名不用于构造本地路径。签名下载 URL 和管理员输入明文不写入执行日志/操作日志。

`import` 直接调用已有 `orchestrator.saveDrafts` 保存豆包原生草稿，回执 `{draftId,nativeBinding}`。`send` 调用已有原生草稿展开、精确编号匹配、发送、独立接收和参数确认流程，回执 `{tasks:[{taskId,status:'submitted'|'failed'|'uncertain',localTaskId?,conversationId?,error?}]}`。接收后保留同一账号、任务编号和对话地址，`track` 用原有队列恢复原对话，回执 `{taskId,localTaskId?,conversationId?,status:'running'|'completed'|'failed',error?}`。只有豆包明确拒绝本次生成才报告 failed；超时、登录异常或来源不确定保留为待核对。

完成后先上传 MP4，再回报 completed：`POST /api/studio/doubao/executor/result?taskId=...`，原始文件正文，`Content-Type: video/mp4`。除 Bearer 外携带 `x-doubao-executor-id`、`x-doubao-operation-id`、`x-doubao-lease-token`、`x-doubao-sha256`。发送前检查 MP4 ftyp、文件大小（默认上限 128 MiB）与 SHA-256。上传失败只重传同一个持久化成片；下载失败也只恢复同一已提交对话，不重新生成。

## 管理员登录

账号操作使用相同的领取/回报通道，不开放远程调试端口。`payload.action` 支持 `open|frame|input|navigate|probe`；navigate 只允许固定豆包 `/chat/` 地址。input 由主站加密为 `payload.inputEncrypted: {iv,tag,data}`，三个字段均为 Base64：AES-256-GCM，12 字节随机 IV，16 字节 tag，key 为 `SHA256('doubao-admin-input-v1:'+独立执行端令牌)`。解密仅在内存中进行，操作日志只留密文。输入对象支持：

- `{kind:'click',x,y}`：相对截图的 0–1 坐标。
- `{kind:'text',text}`：人工输入的文字（主站上限 2000 字符）。
- `{kind:'key',key}`：Enter、Tab、Backspace、Escape。
- `{kind:'scroll',deltaX,deltaY}`：两个绝对值不超过 4000 的有限整数。

用现有 WebAccounts 的隐藏窗口、capturePage 和 CDP 输入能力执行，回报 `{imageBase64,contentType:'image/jpeg',width,height,capturedAt,loginState:'logged_in'|'logged_out'|'unknown'}`；JPEG 上限 1 MiB。管理员自行处理密码、验证码和扫码。中断的输入操作只取新截图，不自动重放密码、OTP 或按键。

## 防重复与恢复

`studio-journal.json` 以临时文件、fsync 和原子替换保存稳定任务/草稿/操作映射，再进行网页副作用；Linux 同步父目录。相同操作重复领取只回报原回执。发送前原有原生草稿记录还会保存提交意图；丢失发送响应或进程中断时，只从持久化原草稿、已接收对话和本地任务恢复，证据不足回报 uncertain，禁止自动再点发送。不同操作再次导入同一已发送任务，也会使用原生绑定记录，不重新创建草稿。发生磁盘/日志损坏时应保留现场核对，不能删除日志后当成新任务重跑。

`studioTaskId` 标记只影响本模式导入的任务：原有队列遇到失败时保留提交标记，禁止进入重新派发；普通桌面任务沿用原有行为。批量原生发送增加可选窗口上限和 `startQueue:false`，默认桌面路径保持原先行为。

## 离线验收

```powershell
node --test _test/studio-bridge.test.js
npm test
```

测试复用真实本地草稿/任务仓和 orchestrator，替换外部 HTTP 和网页驱动边界；不登录真实豆包，不请求真实生成。覆盖持久化前置、重复/中断发送不重放、原生绑定和原对话关联、页面并发上限、服务模式入口隔离、原桌面额度行为保留、引用哈希/大小、登录命令加密、成片回传失败只重传。不能用这些模拟结果替代真实浏览器/服务器验收。

## 历史基线与进度回报

此前服务端入口基于用户指定仓库 `https://github.com/wqdcjnb/infinite-doubao` 的最新主分支 **1.5.9 / 87d7cf87bf133679baa3f9eb1729e89adebb588b**。保留新版三个准备工作位的连续投递和已接收对话不重复加载逻辑；服务模式用额外信号量限制全部准备/回执/确认窗口数，桌面默认不设置此上限。

发送期间每次心跳可附带同租约的 `outcome:progress` 回报，`receipt.tasks` 只包含已有持久化接收证据的任务。`confirmed:false` 表示只确认豆包接收；仅当持久化确认意图为 sent、页面明确检测到视频生成开始/视频结果或原任务已完成时，才给出 `confirmed:true`。普通的“处理中”文字不会当成已确认生成。进度回报与最终回报按顺序发送，防止迟到的进度覆盖最终结果。


## 租约、轮转与异常隔离

心跳返回 `{executorId,lastSeenAt,serverTime,leases:[{operationId,leaseUntil}]}`，时间为服务端毫秒。执行端使用“服务端剩余时长 + 请求发起时的本地单调时钟”记录截止时间，保守扣除请求耗时，不因两台机器时钟偏差获得额外租约。只有服务端明确续租的操作才延长；心跳失败不能延长截止时间。

原生导入保存、发送、生成确认和管理员输入在每次新副作用前检查有效租约。过期后停止后续发送与确认，不写新的确认意图；已收到的原对话回执仍保存，原任务只读取回和下载可以继续。服务模式的只读取回队列不自行发送新的生成确认。

`track` 的 `outcome:progress` 是一次只读轮询结束，服务端将同一操作移回队尾并清除当前租约，让其他任务公平取回；下次以同一操作编号、全新租约再查同一原任务。执行端只在 track 的新租约下重新执行只读检查；send/import 不采用这种重放规则。服务端应保留旧租约已接受的进度回执，以便进度响应丢失时对完全相同的旧回报作幂等确认。

确定的 HTTP 409 回报冲突只隔离对应操作日志记录，原结果保留供核对，其它任务和账号可以继续领取。暂时的回报错误保留原回执重试，同时继续处理其它待回报条目。大于 128 MiB 或格式不符的原 MP4 保留本地并转人工核对，不自动重传超大文件，也不重新生成。


## 账号环境合同（2026-10-26）

`payload.account.environment` 包含不可变 UUID `version`、masked 元数据和 `encrypted:{iv,tag,data}`。密文为 `{proxy:{mode:'custom',url},fingerprint:{seed,language,timezone,screen}}`，AES-256-GCM，key 为 `SHA256('doubao-account-env-v1:'+token)`。执行端只在内存持有代理用户名/密码，私有账号状态只保存加密快照、版本、摘要和固定指纹档案；不写代理明文。不同版本修改同账号环境会关闭该账号的旧登录窗口；平台必须先禁止活动批次及未完成操作修改环境。缺失配置不能新开账号环境；原已保存环境可供恢复原任务。

`prepareStudioSession` 在首次目标导航前 await `fixed_servers` 配置，只有一条账号代理，使用 `<-loopback>` 禁止 Chromium 隐式本机绕过，不含 DIRECT fallback；失败中止。不同 persist session 的认证通过 `webContents.session` 路由，主进程探针用绑定 session 的 `net.request` 自己处理 login challenge，不按全局 host:port 缓存。目标站的 HTTP 认证不会得到代理密码。修改配置清理该 session 的连接和认证缓存，保留 Cookie。

登录、草稿、发送和恢复查询窗口共用该 session 与安全窗口工厂。先导航无站点脚本的 about:blank，attach CDP，再设置 UA/UA-CH、时区与 `Page.addScriptToEvaluateOnNewDocument`，完成后才导航目标；仍为 sandbox/contextIsolation/noNode，无远程调试监听。固定种子经过 SHA-256 装配既有档案，语言、时区和屏幕采用保存配置；持久化档案跨重启复用，Chrome 版本按当前真实内核对齐。屏幕限制宽 1280–7680、高 900–4320，能容纳业务窗口。

每次进程启动的 `StudioClient.sessionId` 为新 UUID，heartbeat 携带它。独立 `probe` 返回 `{environmentVersion,executorSessionId,environmentCheck:{proxy,fingerprint}}`。proxy 复用既有同线路 IP 探针/固定错误脱敏；fingerprint 复用页面实际读取与比较，profile 摘要为 `{seed,language,timezone,screen,browserVersion}`。只有 probe 回传环境摘要；普通截图返回 `capturedAt`，不把截图当探针。中断 probe 可重做只读探针；中断 input 只取 frame，禁止自动重放输入。

受限无 GPU 的服务实测，原指纹检查 14 项中 13 项被比较器接受（9 项核心匹配、4 项仅作参考），WebGL context 不可用。专用检查仅在实际值严格为 `no webgl` 时将该项标为 `unsupported`、`capabilities.webgl=false`，message 为“核心环境已校验；WebGL不可用，未校验该项”。这不表示 GPU 指纹已验证；WebGL 可用但值不匹配仍失败，其他核心项仍严格比较。服务配置、GPU 参数没有改动。

| 协议 | 真实受控 Linux Electron 43.2.0 验证 | 边界 |
| --- | --- | --- |
| HTTP Basic 认证 | 同网关两个账号不同凭据、页面和主进程请求通过 | 仅合成凭据，未验证真实公网代理 |
| HTTP 无认证 | 原生 fixed_servers 配置可用；未单独实测 | 必须以实际 probe 结果为准 |
| HTTPS 代理 | 自签测试证书被拒绝 `ERR_PROXY_CERTIFICATE_INVALID` | 保留内核证书验证；受信任证书及其鉴权未实测，必须以真实 probe 结果为准 |
| SOCKS5 无认证 | 受控 localhost SOCKS5 握手及页面通过 | 未验证真实公网出口 |
| SOCKS5 用户名/密码 | 配置阶段明确拒绝 | Chromium 原生不支持，不新增认证桥或服务 |

代理失败实测导航和主进程请求均失败，可直达的 localhost 目标收到 0 次请求。受控 IP 为文档保留地址 `192.0.2.10/20`，不代表真实公网 IP。测试不连接真实豆包账号、不会生成或导入真实草稿。真实代理、实际出口、账号登录和真实成片仍需用户验收。

额外本地回归：`node --test _test/studio-environment.test.js _test/studio-window.test.js _test/studio-bridge.test.js`。真实 Electron harness 为 `_test/studio-environment.e2e.cjs`，只允许固定隔离 smoke 路径，临时 localhost 测试代理在进程退出时关闭。服务器证据位于 `/var/lib/material-studio-doubao/smoke/account-environments-20261026`，沿用服务 uid、sandbox、PrivateTmp/ProtectSystem/ProtectHome 和资源限制，未改生产 unit/current/state/token。

上游差异单独说明：本分支起点是 `fe95bf7`（1.5.10），生产执行端为 `f5afc23`。`f5afc23..fe95bf7` 的 13 文件、191 增/18 删属于已有上游：原生草稿保存时无输入框先点新工作任务、无旧 binding 不做恢复、保存阶段日志和相关测试/版本号；不是本次环境补丁。发布前必须单独审核并明确决定是否纳入，不能把整版 main 当成本补丁发布。

技术依据：[Electron ClientRequest login](https://www.electronjs.org/docs/latest/api/client-request)、[Electron app login](https://www.electronjs.org/docs/latest/api/app#event-login)、[Electron Session setProxy](https://www.electronjs.org/docs/latest/api/session#sessetproxyconfig)、[Chromium proxy support](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)。
