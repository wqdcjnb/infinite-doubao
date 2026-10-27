"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {NativeAdapter}=require('../src/server-executor');
const log=require('../src/logger');

function deferred() {let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};}
const flush=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};

// No store/config initialization, account opening, page input, or real API calls.
// The real adapter and ActiveDeliveryPages share this borrowed original page;
// only the external solver and disk-writing logger are replaced.
function fixture(t,solver,options={}) {
  const captchaConfig=Object.hasOwn(options,'captchaConfig')?options.captchaConfig:{enabled:true,apiKey:'offline-fixture-only',model:'offline-model'};
  const logs=[];t.mock.method(log,'info',(event,payload)=>{logs.push({event,payload});});
  const calls=[],cancelled=[],win=new EventEmitter(),state={captchaDetected:true,captcha:{id:'challenge',rect:{x:10,y:20,width:350,height:450},focused:true}};
  let preserved=0,resumed=0,leaseCurrent=true,checks=0;
  Object.assign(win,{isDestroyed:()=>false,getContentSize:()=>[1000,800]});
  const driver={window:win,webContents:{isDestroyed:()=>false},
    preserve:()=>{preserved++;},resumeAutoClose:()=>{resumed++;return true;},
    call:async method=>{assert.equal(method,'readNativeDeliveryState');calls.push(method);return state;}};
  const invocations=[];
  const adapter=new NativeAdapter({journal:{},client:{},accounts:{},sessionId:'offline-session',captchaConfig,
    captchaSolver:async options=>{invocations.push(options);return solver(options);}});
  t.after(()=>adapter.deliveryPages.closeAll());
  const operation={id:'offline-operation',accountId:'offline-account',batchId:'offline-batch'};
  const instance={id:'offline-instance',studioEnvironment:{version:'offline-environment'}};
  const page=adapter.registerDelivery(operation,'offline-task','offline-draft',instance,driver,error=>cancelled.push(error),
    {checkLease:()=>{checks++;if(!leaseCurrent)throw Error('fixture lease expired');}});
  return {adapter,page,driver,state,calls,cancelled,invocations,logs,checks:()=>checks,preserved:()=>preserved,resumed:()=>resumed,
    expire:()=>{leaseCurrent=false;},binding:()=>({taskId:page.taskId,pageId:page.pageId})};
}

test('repeated snapshots of one registered delivery page trigger exactly one native solver attempt',async t=>{
  const entered=deferred(),finish=deferred();
  const expected={solved:false,manualRequired:true,reason:'offline_manual',diagnostics:{attempts:1}};
  const f=fixture(t,async options=>{options.check();entered.resolve();await finish.promise;options.check();return expected;});
  t.after(()=>finish.resolve());
  await f.page.snapshot();await entered.promise;
  await Promise.all(Array.from({length:5},()=>f.page.snapshot()));
  assert.equal(f.invocations.length,1);assert.equal(f.page.activeSteps,1);assert.equal(f.page.solverAttempted,true);
  const options=f.invocations[0];assert.equal(options.driver,f.driver);assert.equal(options.signal.aborted,false);assert.equal(options.model,'offline-model');
  assert.equal(typeof options.check,'function');assert.ok(f.checks()>0);assert.equal(f.page.keepOpen,true);
  finish.resolve();assert.deepEqual(await f.page.solverPromise,expected);
  await f.page.snapshot();assert.equal(f.invocations.length,1);assert.equal(f.page.activeSteps,0);assert.equal(f.page.solverAbort,null);
  assert.equal(f.cancelled.length,0);assert.equal(f.logs.length,1);assert.equal(f.logs[0].payload.reason,'offline_manual');
  assert.equal(JSON.stringify(f.logs).includes('offline-fixture-only'),false);
});

test('human takeover aborts recognition immediately and waits for its active automation step to leave',async t=>{
  const entered=deferred(),aborted=deferred(),cleanup=deferred();let takeoverFinished=false;
  const f=fixture(t,async({signal,check})=>{
    check();signal.addEventListener('abort',()=>aborted.resolve(),{once:true});entered.resolve();
    await aborted.promise;await cleanup.promise;
    assert.equal(signal.aborted,true);assert.throws(check,/human control/);
    return {solved:false,manualRequired:true,reason:'cancelled',diagnostics:{attempts:1}};
  });
  t.after(()=>cleanup.resolve());
  await f.page.snapshot();await entered.promise;
  const originalPage=f.page,originalDriver=f.page.driver;
  const takeover=f.page.takeover(f.binding()).then(()=>{takeoverFinished=true;});
  try {
    await aborted.promise;await flush();
    assert.equal(f.invocations[0].signal.aborted,true);assert.equal(f.page.activeSteps,1);
    assert.equal(f.page.pauseRequested,true);assert.equal(f.page.manual,false);assert.equal(takeoverFinished,false);
    assert.equal(f.page.humanTouched,true);assert.equal(f.page.keepOpen,true);
  } finally {cleanup.resolve();}
  const outcome=await f.page.solverPromise;await takeover;
  assert.equal(outcome.reason,'cancelled');assert.equal(f.page,originalPage);assert.equal(f.page.driver,originalDriver);
  assert.equal(f.page.activeSteps,0);assert.equal(f.page.manual,true);assert.equal(f.page.pauseRequested,false);assert.equal(f.page.solverAbort,null);
  await f.page.snapshot();assert.equal(f.invocations.length,1);assert.equal(f.resumed(),0);assert.equal(f.cancelled.length,0);
});

test('failed solver mouse release reaches the existing pending-release hook and keeps automatic input held',async t=>{
  const point={x:216.5,y:340.25};
  const expected={solved:false,manualRequired:true,reason:'operation_failed',diagnostics:{attempts:1,released:false,releaseFailed:true,releasePoint:point}};
  const f=fixture(t,async({check})=>{check();return expected;}),pending=[];
  f.adapter.onSolverReleasePending=(page,releasePoint)=>{pending.push({page,releasePoint,held:page.inputHeld,kept:page.keepOpen,active:page.activeSteps});};
  await f.page.snapshot();assert.deepEqual(await f.page.solverPromise,expected);
  assert.equal(pending.length,1);assert.equal(pending[0].page,f.page);assert.deepEqual(pending[0].releasePoint,{x:216.5,y:340.25});
  assert.equal(pending[0].held,true);assert.equal(pending[0].kept,true);assert.equal(pending[0].active,0);
  assert.equal(f.page.inputHeld,true);assert.equal(f.page.keepOpen,true);assert.equal(f.page.activeSteps,0);
  delete f.state.captcha;f.state.captchaDetected=false;
  assert.equal(await f.page.observe(f.binding(),{automatic:true}),false);
  assert.equal(f.page.inputHeld,true);assert.equal(f.page.keepOpen,true);assert.equal(f.resumed(),0);
  await f.page.snapshot();assert.equal(pending.length,1);assert.equal(f.invocations.length,1);
});

test('disabled automatic solving or an absent caller key never starts a native solver',async t=>{
  for(const captchaConfig of [{enabled:false,apiKey:'offline-fixture-only'},{enabled:true,apiKey:''},undefined]) {
    const f=fixture(t,async()=>{assert.fail('solver must stay unused');},{captchaConfig});
    await f.page.snapshot();await f.page.snapshot();await flush();
    assert.equal(f.invocations.length,0);assert.equal(f.page.solverAttempted,undefined);assert.equal(f.page.activeSteps,0);
    assert.equal(f.page.keepOpen,true);f.page.close();
  }
});
