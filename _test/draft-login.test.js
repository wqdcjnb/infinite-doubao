"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Driver } = require("../src/driver");

test("新草稿页先返回未知、短暂登录入口，再确认登录，不能第一次检查就判过期", async () => {
  const driver = new Driver({ instance: { id: "test" } });
  const states = [{ loggedIn: false, by: "unknown" }, { loggedIn: false, by: "login-button" }, { loggedIn: true, by: "avatar" }];
  driver.isLoggedIn = async () => states.shift();
  assert.equal((await driver.waitForLogin({ timeoutMs: 2000 })).loggedIn, true);
  assert.equal(states.length, 0);
});

test("登录等待超时保留明确未登录或未知的原因，不使用 Cookie 猜测成功", async () => {
  const driver = new Driver({ instance: { id: "test" } });
  for (const by of ["unknown", "login-button"]) {
    driver.isLoggedIn = async () => ({ loggedIn: false, by });
    assert.deepEqual(await driver.waitForLogin({ timeoutMs: 10 }), { loggedIn: false, by });
  }
});

test("草稿页加载时短暂上下文切换可恢复，停止或页面关闭及时退出", async () => {
  const driver = new Driver({ instance: { id: "test" }, webContents: { isDestroyed: () => false } });
  let calls = 0;
  driver.isLoggedIn = async () => { if (!calls++) throw new Error("context destroyed"); return { loggedIn: true }; };
  assert.equal((await driver.waitForLogin({ timeoutMs: 1000 })).loggedIn, true);
  await assert.rejects(driver.waitForLogin({ check: () => { throw new Error("已停止批量操作"); } }), /已停止/);
  driver.webContents.isDestroyed = () => true;
  driver.isLoggedIn = async () => { throw new Error("页面已关闭"); };
  await assert.rejects(driver.waitForLogin(), /页面已关闭/);
});
