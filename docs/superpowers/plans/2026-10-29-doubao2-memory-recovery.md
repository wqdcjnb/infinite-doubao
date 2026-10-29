# 豆包-2 内存与离线恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 恢复专属执行端在线并安全接续原无图批次未发送后缀，保留已有发送证据。

**Architecture:** 基于精确 Native 生产版本修补恢复验证，复用现有只读检查和严格后缀续发。仅修改 Native 专属资源和并发配置，不发布共享 Web。

**Tech Stack:** Node.js / Electron、systemd cgroup v2、专属 SQLite。

**Spec:** docs/superpowers/specs/2026-10-29-doubao2-memory-recovery-design.md

## Global Constraints

- 不改网络；不重启 Web、Worker 和其他板块；不删除历史或释放预占。
- 已发与未知项永不进入未发送续发名单；维持原任务、账号和草稿身份。
- 三项并发改为 1，MemoryHigh 预算通过后为 2560MiB，MemoryMax 保持 3072MiB。
- 本轮不触发生成确认；真实发送与成片验收分别报告。

## Review Focus

- 50 条无图恢复不得绕过原不可变快照或额外附件检查。
- 原 9 条与新出现的未知项不可重发。
- 重复恢复/续发与过期证据不可产生再次发送。
- 维护与续发不得改变其他容器、网络、模型、积分账本和非目标账号业务。
- 回退必须保留维护期间新增的消息证据。

## Task 1: 无图恢复兼容

Files: src/server-executor.js; _test/real-unstarted-continuation.test.js.

- [ ] 新增 50 条无图、9 已发/41 未发、重复恢复及未知项拒绝重发测试，观察 RED。
- [ ] 最小修改参考图数量和原附件列表长度验证，观察 GREEN。
- [ ] 执行相关 Native 测试与完整测试命令，记录平台限制及失败。
- [ ] 提交本次代码和设计/计划。

## Task 2: 维护准备与审核

- [ ] 创建新的 root 私有审计目录和回滚记录，复核当前生产来源、任务集合、资源预算及所有保护对象。
- [ ] 准备有锁、有前置条件、受控备份和范围验证的分步维护工具；对拒绝路径做本地验证。
- [ ] 对整个代码与维护方案做一次独立审查。

## Task 3: 受控恢复

- [ ] 暂停豆包接单，保全原任务和回执；必要时先在既有硬限内缓解原进程软限压力，使旧回执闭合。
- [ ] 只安装验证过的 Native 差异及三项并发 1；资源调整只针对专属单元。
- [ ] 恢复心跳，核对原发送租约及原消息锚点；检查后仅续发证明为未发送的原后缀。
- [ ] 监控至续发操作闭合，核对新增回执、无重复、无生成意图及保护对象不变；记录仍待人工核验项。
