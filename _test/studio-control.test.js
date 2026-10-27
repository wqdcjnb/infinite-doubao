"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const vm=require('node:vm');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StudioClient}=require('../src/studio-bridge');
const {decryptInput,NativeAdapter}=require('../src/server-executor');
let StudioControl;
try {({StudioControl}=require('../src/studio-control'));} catch(error) {if(error.code!=='MODULE_NOT_FOUND')throw error;}

const flush=async(times=8)=>{for(let i=0;i<times;i++)await new Promise(resolve=>setImmediate(resolve));};
async function until(check) {
  for(let i=0;i<200;i++) {if(check())return;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.fail('control did not reach the expected boundary');
}
function deferred() {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function encrypted(input,token='private-token') {
  const key=crypto.createHash('sha256').update('doubao-admin-input-v1:'+token).digest(),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(input),'utf8'),cipher.final()]);
  return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
}
function descriptor(id='session-1',accountId='account-1',version='environment-1') {
  return {id,accountId,account:{id:accountId,name:'隔离账号',environment:{version,encrypted:{iv:'fixture',tag:'fixture',data:'fixture'}}},expiresAt:Date.now()+35000};
}
function inputCommand(id,input,expiresAt=Date.now()+3000) {return {id,action:'input',inputEncrypted:encrypted(input),expiresAt};}
function command(id,action) {return {id,action,expiresAt:Date.now()+3000};}
function page() {
  const events=[],captures=[],scripts=[],loads=[],win=new EventEmitter(),wc=new EventEmitter();
  let closed=false;
  Object.assign(wc,{isDestroyed:()=>closed,getURL:()=> 'https://www.doubao.com/chat/',
    debugger:{sendCommand:async(method,value)=>{events.push({method,value});}},
    capturePage:async(...args)=>{captures.push(args);return {toJPEG:()=>Buffer.from('jpeg-'+captures.length),getSize:()=>({width:1000,height:800})};},
    executeJavaScript:async source=>{scripts.push(source);return {loggedIn:true};},
    loadURL:async url=>{loads.push(url);}});
  Object.assign(win,{webContents:wc,getContentSize:()=>[1000,800],isDestroyed:()=>closed,destroy:()=>{closed=true;win.emit('closed');}});
  return {win,wc,events,captures,scripts,loads};
}
function setup(t,options={}) {
  assert.equal(typeof StudioControl,'function','dedicated continuous control runner is missing');
  const browser=options.browser||page(),waits=[],publishes=[],configured=[],accounts={open:options.open||(async()=>browser.win)};
  const client=new StudioClient({siteUrl:'https://studio.example',executorId:'executor-1',sessionId:'executor-session-1',token:'private-token',fetch:async(url,request)=>{
    assert.equal(String(url),'https://studio.example/api/studio/doubao/executor/control');
    assert.equal(request.method,'POST');assert.equal(request.redirect,'error');assert.equal(request.headers.authorization,'Bearer private-token');
    const body=JSON.parse(request.body);
    assert.equal(body.executorId,'executor-1');assert.equal(body.version,'doubao-workbench/1');assert.equal(body.executorSessionId,'executor-session-1');
    if(body.action==='wait') {const pending=deferred();waits.push({pending,request,body});return pending.promise;}
    assert.equal(body.action,'publish');publishes.push(body);
    if(options.publish)return options.publish(body,request);
    return Response.json({ok:true});
  }});
  const adapter=options.adapter||{accounts,account:op=>{configured.push(op);return {id:'local-'+op.accountId,studioEnvironment:{version:op.payload.account.environment.version}};}};
  const runner=new StudioControl({client,adapter,accounts,decryptInput}),abort=new AbortController();
  const running=runner.run(abort.signal);
  t.after(async()=>{abort.abort();await running;});
  async function deliver(session,commands=[]) {
    await flush();
    await until(()=>waits.length>0);
    const wait=waits.shift();wait.pending.resolve(Response.json({session,commands}));await flush();return wait;
  }
  const acks=()=>publishes.flatMap(item=>item.acknowledgements||[]);
  return {...browser,runner,client,adapter,waits,publishes,configured,abort,running,deliver,acks};
}

test('continuous frames use the fixed control contract without repeatedly configuring the account',async t=>{
  const h=setup(t);await flush();assert.equal(h.configured.length,0);assert.equal(h.captures.length,0);
  await h.deliver(descriptor());await until(()=>h.captures.length>=3);
  assert.equal(h.configured.length,1);assert.equal(h.configured[0].accountId,'account-1');
  assert.equal(h.configured[0].payload.account.environment.version,'environment-1');
  assert.deepEqual(h.captures[0],[undefined,{stayHidden:true}]);
  const frames=h.publishes.filter(body=>body.frame).map(body=>body.frame);
  assert.ok(frames.length>=2);assert.equal(frames[0].contentType,'image/jpeg');assert.equal(frames[0].width,1000);assert.equal(frames[0].height,800);
  assert.equal(typeof frames[0].capturedAt,'number');assert.equal(frames[0].imageBase64,Buffer.from('jpeg-1').toString('base64'));
  await h.deliver(descriptor());assert.equal(h.configured.length,1);
});

test('first compositor capture failure recovers on the next tick without publishing a fatal error',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const h=setup(t),capture=h.wc.capturePage;let attempts=0;
  h.wc.capturePage=(...args)=>{if(++attempts===1)throw Error('UnknownVizError');return capture(...args);};
  await h.deliver(descriptor());assert.equal(attempts,1);assert.equal(h.publishes.some(body=>body.error),false);
  t.mock.timers.tick(200);await flush();
  assert.equal(attempts,2);assert.equal(h.publishes.filter(body=>body.frame).length,1);assert.equal(h.publishes.some(body=>body.error),false);
  await h.deliver(descriptor(),[inputCommand('after-warmup',{kind:'text',text:'只发送一次'})]);
  assert.equal(h.acks().find(ack=>ack.id==='after-warmup')?.ok,true);assert.deepEqual(h.events.map(item=>item.value.text),['只发送一次']);
  assert.equal(h.configured.length,1);assert.equal(h.win.isDestroyed(),false);
});

test('five consecutive capture failures report once while ticker work stays bounded',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const h=setup(t);let attempts=0;h.wc.capturePage=async()=>{attempts++;throw Error('UnknownVizError');};
  await h.deliver(descriptor());
  for(let i=0;i<3;i++) {t.mock.timers.tick(200);await flush();}
  assert.equal(attempts,4);assert.equal(h.publishes.some(body=>body.error),false);
  t.mock.timers.tick(200);await flush();
  const errors=h.publishes.filter(body=>body.error);assert.equal(attempts,5);assert.equal(errors.length,1);assert.match(errors[0].error,/画面.*失败/);
  for(let i=0;i<3;i++) {t.mock.timers.tick(200);await flush();}
  assert.equal(attempts,8);assert.equal(h.publishes.filter(body=>body.error).length,1);assert.equal(h.publishes.some(body=>body.frame),false);
});

test('a successful frame resets consecutive failure counting before another failure burst',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const h=setup(t),capture=h.wc.capturePage;let attempts=0;
  h.wc.capturePage=(...args)=>{if(++attempts!==3)throw Error('UnknownVizError');return capture(...args);};
  await h.deliver(descriptor());
  for(let i=0;i<6;i++) {t.mock.timers.tick(200);await flush();}
  assert.equal(attempts,7);assert.equal(h.publishes.filter(body=>body.frame).length,1);assert.equal(h.publishes.some(body=>body.error),false);
  t.mock.timers.tick(200);await flush();assert.equal(h.publishes.filter(body=>body.error).length,1);
});

test('a new control session starts its own capture warmup allowance',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const h=setup(t);h.wc.capturePage=async()=>{throw Error('UnknownVizError');};await h.deliver(descriptor());
  for(let i=0;i<3;i++) {t.mock.timers.tick(200);await flush();}
  await h.deliver(descriptor('session-2'));
  for(let i=0;i<3;i++) {t.mock.timers.tick(200);await flush();}
  assert.equal(h.publishes.some(body=>body.error),false);
  t.mock.timers.tick(200);await flush();assert.equal(h.publishes.filter(body=>body.error).length,1);
});

test('real NativeAdapter persists account setup once and continuous captures leave the local store untouched',async t=>{
  const P=require('../src/paths'),store=require('../src/store'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'studio-control-store-'));
  P.init({home:temporary});store.load();let saves=0;
  const original=store.save;store.save=()=>{saves++;return original();};
  const adapter=new NativeAdapter({journal:{},client:{},accounts:{},environment:{configure:(inst,environment)=>{inst.studioEnvironment={version:environment.version};}}});
  const h=setup(t,{adapter});
  t.after(()=>{store.save=original;fs.rmSync(temporary,{recursive:true,force:true});});
  await h.deliver(descriptor());const setupSaves=saves;assert.ok(setupSaves>0);
  await until(()=>h.captures.length>=3);await h.deliver(descriptor());assert.equal(saves,setupSaves);
});

test('rapid inputs remain serial while a frame upload is blocked and receive immediate acknowledgements',async t=>{
  const blocked=deferred(),h=setup(t,{publish:body=>body.frame?blocked.promise.then(()=>Response.json({ok:true})):Response.json({ok:true})});
  await h.deliver(descriptor());await until(()=>h.publishes.some(body=>body.frame));
  await h.deliver(descriptor(),[inputCommand('text-1',{kind:'text',text:'第一段中文'}),inputCommand('text-2',{kind:'text',text:'第二段中文'})]);
  await until(()=>h.acks().length===2);
  assert.deepEqual(h.events.map(item=>[item.method,item.value.text]),[['Input.insertText','第一段中文'],['Input.insertText','第二段中文']]);
  assert.deepEqual(h.acks(),[{id:'text-1',ok:true},{id:'text-2',ok:true}]);
  blocked.resolve(Response.json({ok:true}));
});

test('capture is independent of a pending input and slow reports keep only the latest pending frame',async t=>{
  const blocked=deferred(),input=deferred(),h=setup(t,{publish:body=>body.frame?blocked.promise.then(()=>Response.json({ok:true})):Response.json({ok:true})});
  h.wc.debugger.sendCommand=async(method,value)=>{h.events.push({method,value});return input.promise;};
  await h.deliver(descriptor());await h.deliver(descriptor(),[inputCommand('slow-text',{kind:'text',text:'中文'})]);
  await until(()=>h.captures.length>=4);assert.equal(h.publishes.filter(body=>body.frame).length,1);
  const latest=h.captures.length;blocked.resolve(Response.json({ok:true}));await flush();
  const frames=h.publishes.filter(body=>body.frame);assert.equal(frames.length,2);
  assert.equal(frames[1].frame.imageBase64,Buffer.from('jpeg-'+latest).toString('base64'));
  input.resolve();await until(()=>h.acks().some(ack=>ack.id==='slow-text'));
});

test('completed input requests a feedback frame without waiting for the next 200ms tick',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const h=setup(t);await h.deliver(descriptor());const before=h.captures.length;
  await h.deliver(descriptor(),[inputCommand('feedback',{kind:'text',text:'反馈'})]);await flush();
  assert.equal(h.captures.length,before+1);assert.equal(h.acks().find(ack=>ack.id==='feedback')?.ok,true);
});

test('delivered and expired commands never replay, including commands queued behind a slow input',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const blocked=deferred(),h=setup(t);h.wc.debugger.sendCommand=async(method,value)=>{h.events.push({method,value});if(value.text==='first')await blocked.promise;};
  const first=inputCommand('first',{kind:'text',text:'first'}),second=inputCommand('expires-in-queue',{kind:'text',text:'expired'},Date.now()+1000);
  await h.deliver(descriptor(),[first,second]);await flush();t.mock.timers.tick(1500);blocked.resolve();await flush();
  await h.deliver(descriptor(),[first,second,inputCommand('already-expired',{kind:'text',text:'expired'},Date.now()-1)]);
  assert.deepEqual(h.events.map(item=>item.value.text),['first']);
  assert.equal(h.acks().find(ack=>ack.id==='expires-in-queue')?.ok,false);
});

test('a session switch fences each step of an in-flight click before it can reach a new account',async t=>{
  const blocked=deferred(),h=setup(t);h.wc.debugger.sendCommand=async(method,value)=>{h.events.push({method,value});if(value.type==='mousePressed')await blocked.promise;};
  await h.deliver(descriptor(),[inputCommand('old-click',{kind:'click',x:0.25,y:0.5})]);
  assert.equal(h.events.length,1);await h.deliver(descriptor('session-2','account-2'));
  blocked.resolve();await flush();assert.equal(h.configured.length,2);
  assert.equal(h.win.isDestroyed(),true);assert.equal(h.events.length,1);
  await h.deliver(descriptor('session-1'),[inputCommand('late-old',{kind:'text',text:'stale'})]);
  assert.equal(h.events.length,1);assert.equal(h.configured.length,2);
});

test('closing a held drag destroys only its old window without synthesizing a release or click',async t=>{
  const h=setup(t);await h.deliver(descriptor(),[inputCommand('drag-down',{kind:'pointer',phase:'down',x:0.2,y:0.3})]);
  await h.deliver(null);await flush();
  assert.equal(h.win.isDestroyed(),true);assert.equal(h.events.length,1);assert.equal(h.win.listenerCount('closed'),0);
});

test('a new session opens a fresh window after a held drag while old input cannot reach it',async t=>{
  const old=page(),fresh=page();let opened=0;const h=setup(t,{browser:old,open:async()=>++opened===1?old.win:fresh.win});
  await h.deliver(descriptor(),[inputCommand('drag-down',{kind:'pointer',phase:'down',x:0.2,y:0.3})]);
  await h.deliver(descriptor('session-2'),[inputCommand('new-click',{kind:'click',x:0.4,y:0.5})]);
  assert.equal(old.win.isDestroyed(),true);assert.equal(fresh.win.isDestroyed(),false);assert.equal(old.events.length,1);
  assert.deepEqual(fresh.events.map(item=>[item.value.type,item.value.x,item.value.y]),[['mousePressed',400,400],['mouseReleased',400,400]]);
  assert.equal(h.acks().find(ack=>ack.id==='new-click')?.ok,true);
});

test('a click expiring after mouse down destroys the old window without completing the target click',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const down=deferred(),h=setup(t);h.wc.debugger.sendCommand=async(method,value)=>{h.events.push({method,value});if(value.type==='mousePressed')await down.promise;};
  await h.deliver(descriptor(),[inputCommand('expired-click',{kind:'click',x:0.2,y:0.3},Date.now()+1000)]);
  t.mock.timers.tick(1500);down.resolve();await flush();
  assert.equal(h.win.isDestroyed(),true);assert.equal(h.events.length,1);assert.equal(h.runner.session,null);
});

test('an already expired pointer up destroys the held window instead of leaving it for reuse',async t=>{
  const h=setup(t);await h.deliver(descriptor(),[inputCommand('drag-down',{kind:'pointer',phase:'down',x:0.2,y:0.3})]);
  await h.deliver(descriptor(),[inputCommand('expired-up',{kind:'pointer',phase:'up',x:0.2,y:0.3},Date.now()-1)]);await flush();
  assert.equal(h.win.isDestroyed(),true);assert.equal(h.events.length,1);
});

test('a rejected normal mouse up destroys uncertain held state without retrying that release',async t=>{
  const h=setup(t);h.wc.debugger.sendCommand=async(method,value)=>{h.events.push({method,value});if(value.type==='mouseReleased'&&value.clickCount===1)throw Error('release failed');};
  await h.deliver(descriptor(),[inputCommand('failed-click',{kind:'click',x:0.2,y:0.3})]);await flush();
  assert.equal(h.win.isDestroyed(),true);assert.equal(h.events.length,2);
});

test('lost key down response on session close destroys the old window without replaying any key',async t=>{
  const down=deferred(),h=setup(t);h.wc.debugger.sendCommand=async(method,value)=>{h.events.push({method,value});if(value.type==='keyDown')await down.promise;};
  await h.deliver(descriptor(),[inputCommand('old-key',{kind:'key',key:'ArrowLeft',modifiers:['Shift']})]);
  await h.deliver(null);await flush();down.resolve();await flush();
  assert.equal(h.win.isDestroyed(),true);assert.deepEqual(h.events.map(item=>[item.value.type,item.value.key,item.value.modifiers]),[['keyDown','ArrowLeft',8]]);
});

test('a key expiring between down and up destroys the old window without replaying key down',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const down=deferred(),h=setup(t);h.wc.debugger.sendCommand=async(method,value)=>{h.events.push({method,value});if(value.type==='keyDown')await down.promise;};
  await h.deliver(descriptor(),[inputCommand('expired-key',{kind:'key',key:'a',modifiers:['Control']},Date.now()+1000)]);
  t.mock.timers.tick(1500);down.resolve();await flush();
  assert.equal(h.win.isDestroyed(),true);assert.deepEqual(h.events.map(item=>[item.value.type,item.value.key,item.value.modifiers]),[['keyDown','a',2]]);
});

test('completed mouse and key pairs leave the existing window and login dialog open on session close',async t=>{
  const h=setup(t);await h.deliver(descriptor(),[inputCommand('normal-click',{kind:'click',x:0.2,y:0.3}),inputCommand('normal-key',{kind:'key',key:'ArrowLeft'})]);
  await h.deliver(null);assert.equal(h.win.isDestroyed(),false);assert.equal(h.events.length,4);
});

test('runner disposal closes an interrupted held window without synthesizing mouse up',async t=>{
  const h=setup(t);await h.deliver(descriptor(),[inputCommand('dispose-drag',{kind:'pointer',phase:'down',x:0.2,y:0.3})]);
  h.abort.abort();await h.running;assert.equal(h.win.isDestroyed(),true);assert.equal(h.events.length,1);
});

test('cleanup never sends input to a destroyed old browser window',async t=>{
  const h=setup(t);await h.deliver(descriptor(),[inputCommand('drag-down',{kind:'pointer',phase:'down',x:0.2,y:0.3})]);
  h.win.destroy();await flush();assert.equal(h.events.length,1);
});

test('environment changes and mismatched account descriptors cannot mutate the existing session',async t=>{
  const h=setup(t);await h.deliver(descriptor());
  await h.deliver(descriptor('session-1','account-1','changed'),[inputCommand('changed',{kind:'text',text:'wrong environment'})]);
  assert.equal(h.events.length,0);assert.equal(h.configured.length,1);
  const mismatched=descriptor('session-2','account-2');mismatched.account.id='account-3';
  await h.deliver(mismatched,[inputCommand('wrong-account',{kind:'text',text:'wrong account'})]);
  assert.equal(h.events.length,0);assert.equal(h.configured.length,1);
});

test('local environment mutation is checked immediately before every browser input event',async t=>{
  const h=setup(t);await h.deliver(descriptor());
  h.runner.session.inst.studioEnvironment.version='changed-locally';
  await h.deliver(descriptor(),[inputCommand('wrong-version',{kind:'text',text:'stale'})]);
  assert.equal(h.events.length,0);
});

test('commands that expire while the account window opens are never delivered after navigation finishes',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const opening=deferred(),browser=page(),h=setup(t,{browser,open:()=>opening.promise});
  await h.deliver(descriptor(),[inputCommand('opening-expired',{kind:'text',text:'stale'},Date.now()+1000)]);
  t.mock.timers.tick(1500);opening.resolve(browser.win);await flush();
  assert.equal(h.events.length,0);assert.equal(h.acks().find(ack=>ack.id==='opening-expired')?.ok,false);
});

test('five seconds without the command channel fences a late response even when fetch ignores abort',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const h=setup(t);await h.deliver(descriptor());assert.equal(h.waits.length,1);const late=h.waits.shift();
  t.mock.timers.tick(5000);await flush();
  late.pending.resolve(Response.json({session:descriptor(),commands:[inputCommand('late',{kind:'text',text:'must not run'})]}));await flush();
  assert.equal(h.events.length,0);assert.equal(h.configured.length,1);assert.equal(late.request.signal.aborted,true);
});

test('an expired session stops input even if the channel later renews the same session id',async t=>{
  t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000000});
  const h=setup(t),session=descriptor();session.expiresAt=Date.now()+1000;await h.deliver(session);
  t.mock.timers.tick(1000);await flush();
  await h.deliver(descriptor(),[inputCommand('late-expired',{kind:'text',text:'stale'})]);assert.equal(h.events.length,0);assert.equal(h.configured.length,1);
});

test('window destruction and executor session changes stop subsequent browser input',async t=>{
  const h=setup(t);await h.deliver(descriptor());h.win.destroy();
  await h.deliver(descriptor(),[inputCommand('closed',{kind:'text',text:'stale'})]);assert.equal(h.events.length,0);
  h.client.sessionId='executor-restarted';
  await h.deliver(descriptor('session-2'),[inputCommand('restarted',{kind:'text',text:'stale'})]);assert.equal(h.events.length,0);
});

test('pointer dragging, coordinate edges, wheel location and modified editing keys use the expected CDP events',async t=>{
  const h=setup(t);await h.deliver(descriptor(),[
    inputCommand('down',{kind:'pointer',phase:'down',x:0.2,y:0.3,button:'left'}),
    inputCommand('move',{kind:'pointer',phase:'move',x:1,y:1}),
    inputCommand('up',{kind:'pointer',phase:'up',x:0.9,y:0.8}),
    inputCommand('wheel',{kind:'scroll',x:0.1,y:0.2,deltaX:0,deltaY:400}),
    inputCommand('select',{kind:'key',key:'a',modifiers:['Control']}),
    inputCommand('left',{kind:'key',key:'ArrowLeft',modifiers:['Shift']}),
    inputCommand('enter',{kind:'key',key:'Enter'})
  ]);await until(()=>h.acks().length===7);
  assert.deepEqual(h.events.slice(0,4).map(item=>[item.value.type,item.value.x,item.value.y,item.value.buttons]),[
    ['mousePressed',200,240,1],['mouseMoved',999,799,1],['mouseReleased',900,640,0],['mouseWheel',100,160,0]
  ]);
  const keys=h.events.slice(4).map(item=>item.value);
  assert.equal(keys[0].modifiers,2);assert.equal(keys[0].key,'a');assert.equal(keys[0].code,'KeyA');assert.equal(keys[0].windowsVirtualKeyCode,65);
  assert.equal(keys[2].modifiers,8);assert.equal(keys[2].key,'ArrowLeft');assert.equal(keys[2].windowsVirtualKeyCode,37);
  assert.equal(keys[4].text,'\r');assert.equal(keys[5].type,'keyUp');
});

test('malformed encrypted inputs, unsupported keys and invalid coordinates fail without browser side effects',async t=>{
  const h=setup(t),bad=inputCommand('bad-cipher',{kind:'text',text:'private secret'});bad.inputEncrypted.tag=Buffer.alloc(16).toString('base64');
  await h.deliver(descriptor(),[bad,inputCommand('bad-coordinate',{kind:'click',x:2,y:0}),inputCommand('bad-key',{kind:'key',key:'F5'}),inputCommand('plain-letter',{kind:'key',key:'a'}),inputCommand('bad-modifier',{kind:'key',key:'a',modifiers:['Super']})]);
  await until(()=>h.acks().length===5);assert.equal(h.events.length,0);assert.equal(h.acks().every(ack=>ack.ok===false),true);
  assert.equal(JSON.stringify(h.publishes).includes('private secret'),false);
});

test('inherited property names are rejected as pointer phases and key names before any browser input',async t=>{
  const h=setup(t);await h.deliver(descriptor(),[inputCommand('prototype-key',{kind:'key',key:'toString'}),inputCommand('prototype-pointer',{kind:'pointer',phase:'constructor',x:0.2,y:0.3})]);
  await until(()=>h.acks().length===2);assert.equal(h.events.length,0);assert.equal(h.acks().every(ack=>ack.ok===false),true);
});

test('dedicated startup runs live control beside generation and aborts both on quit',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/server-executor.js'),'utf8'),app=new EventEmitter(),started=[],module={exports:{}};
  const data={instances:[],tasks:[],taskDrafts:[],taskTemplates:[],proxies:[],settings:{}};
  const config={stateDir:path.resolve(os.tmpdir(),'studio-control-startup-fixture'),tokenFile:path.resolve(os.tmpdir(),'private-token'),executorId:'executor-1',siteUrl:'https://studio.example'};
  Object.assign(app,{commandLine:{getSwitchValue:()=>path.resolve(os.tmpdir(),'executor.json')},setPath:()=>{},requestSingleInstanceLock:()=>true,whenReady:async()=>{},quit:()=>{},exit:()=>{}});
  const fakeFs={mkdirSync:()=>{},statSync:()=>({mode:0o600}),readFileSync:file=>file===config.tokenFile?'private-token':JSON.stringify(config)};
  class Bridge {run(signal) {started.push({kind:'generation',signal});return new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}}
  class Control {run(signal) {started.push({kind:'control',signal});return new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}}
  const queue={init:()=>{},recoverTemplateTasks:()=>{},pause:()=>{}};
  const modules={
    'node:fs':fakeFs,'./paths':{init:()=>{},dir:()=>config.stateDir},'./store':{load:()=>{},get:()=>data,save:()=>true},'./orchestrator':queue,'./task-drafts':{},'./task-templates':{},
    './studio-bridge':{Journal:class{},StudioClient:class{constructor(){this.sessionId='executor-session-1';}},StudioBridge:Bridge},'./studio-control':{StudioControl:Control},'./active-delivery':require('../src/active-delivery'),
    electron:{app,BrowserWindow:class{},session:{},net:{}},'./interceptor':{},'./driver':{},'./web-accounts':{WebAccounts:class{stop(){}}},'./studio-environment':{StudioEnvironment:class{}}
  };
  vm.runInNewContext(source,{module,require:name=>Object.hasOwn(modules,name)?modules[name]:require(name),process:{argv:[],env:{},platform:process.platform,stderr:{write:()=>{}},once:()=>{}},AbortController});
  const runtime=await module.exports.start();assert.deepEqual(started.map(item=>item.kind),['generation','control']);assert.ok(runtime.control);
  app.emit('before-quit');assert.equal(started.every(item=>item.signal.aborted),true);
});

function loginDocument({modalVisible=false,buttonVisible=true}={}) {
  let clicks=0;
  function element(text,shown) {return {innerText:text,textContent:text,getBoundingClientRect:()=>({width:shown?200:0,height:shown?100:0}),getAttribute:()=>'',querySelector:()=>null};}
  const modal=element('手机号登录 扫码登录 验证码',modalVisible),button=element('登录',buttonVisible);button.click=()=>{clicks++;};
  const document={querySelectorAll:selector=>selector.includes('dialog')?[modal]:selector.includes('button')?[button]:[],body:{innerText:'豆包 登录'}};
  return {document,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),clicks:()=>clicks};
}
test('login navigation preserves an existing visible official modal and does not reload or click again',async t=>{
  const h=setup(t),dom=loginDocument({modalVisible:true});
  h.wc.executeJavaScript=async source=>source.includes('querySelectorAll')?vm.runInNewContext(source,dom):{loggedIn:false};
  await h.deliver(descriptor(),[command('login','navigate')]);await until(()=>h.acks().length===1);
  assert.equal(h.acks()[0].ok,true);assert.equal(h.loads.length,0);assert.equal(dom.clicks(),0);
});

test('login navigation clicks a visible official login button while ignoring a hidden stale modal',async t=>{
  const h=setup(t),dom=loginDocument();
  h.wc.executeJavaScript=async source=>source.includes('querySelectorAll')?vm.runInNewContext(source,dom):{loggedIn:false};
  await h.deliver(descriptor(),[command('login','navigate')]);await until(()=>h.acks().length===1);
  assert.equal(h.acks()[0].ok,true);assert.equal(h.loads.length,0);assert.equal(dom.clicks(),1);
});

test('missing official login entry reports an actionable failure instead of claiming a login dialog opened',async t=>{
  const h=setup(t),dom=loginDocument({buttonVisible:false});
  h.wc.executeJavaScript=async source=>source.includes('querySelectorAll')?vm.runInNewContext(source,dom):{loggedIn:false};
  await h.deliver(descriptor(),[command('login','navigate')]);await until(()=>h.acks().length===1);
  assert.equal(h.acks()[0].ok,false);assert.match(h.acks()[0].error,/登录/);assert.equal(dom.clicks(),0);
});

test('login navigation leaves a foreign page once and reports a missing entry without reloading the fresh homepage',async t=>{
  const h=setup(t),dom=loginDocument({buttonVisible:false});h.wc.getURL=()=> 'about:blank';
  h.wc.executeJavaScript=async source=>source.includes('querySelectorAll')?vm.runInNewContext(source,dom):{loggedIn:false};
  await h.deliver(descriptor(),[command('login-from-blank','navigate')]);await until(()=>h.acks().length===1);
  assert.deepEqual(h.loads,['https://www.doubao.com/chat/']);assert.equal(h.acks()[0].ok,false);
});

test('slow best-effort login detection does not hold frames or command delivery',async t=>{
  const login=deferred(),h=setup(t);h.wc.executeJavaScript=()=>login.promise;
  await h.deliver(descriptor());await until(()=>h.captures.length>=3);
  await h.deliver(descriptor(),[inputCommand('login-pending',{kind:'text',text:'仍可输入'})]);await until(()=>h.acks().length===1);
  assert.equal(h.acks()[0].ok,true);login.resolve({loggedIn:false});
});

test('disposal cancels outstanding HTTP and capture work, detaches listeners, and never replays a late command',async t=>{
  const capture=deferred(),h=setup(t);h.wc.capturePage=()=>capture.promise;
  await h.deliver(descriptor());const waiting=h.waits.shift();h.abort.abort();await h.running;
  assert.equal(waiting.request.signal.aborted,true);assert.equal(h.win.listenerCount('closed'),0);
  waiting.pending.resolve(Response.json({session:descriptor(),commands:[inputCommand('after-stop',{kind:'text',text:'stale'})]}));
  capture.resolve({toJPEG:()=>Buffer.from('late')});await flush();assert.equal(h.events.length,0);assert.equal(h.publishes.length,0);
});

function deliverySetup(t) {
  const {ActiveDeliveryPages}=require('../src/active-delivery'),pages=new ActiveDeliveryPages(),browser=page();let configured=0,cancelled=0,valid=true;
  t.after(()=>pages.closeAll());
  const state={captchaDetected:true,captcha:{id:'captcha-1',rect:{x:100,y:100,width:400,height:300},focused:true}};
  const target={accountId:'account-1',operationId:'send-1',batchId:'batch-1',environmentVersion:'environment-1',executorSessionId:'executor-session-1'};
  const driver={window:browser.win,webContents:browser.wc,call:async()=>state};
  const entry=pages.register({...target,taskId:'task-1',draftId:'draft-1',instance:{id:'native',studioEnvironment:{version:'environment-1'}},driver,checkLease:()=>{if(!valid)throw Error('lease expired');},cancel:()=>{cancelled++;browser.win.destroy();}});
  const adapter={deliveryPages:pages,account:()=>{configured++;throw Error('live page must not configure an account');}};
  const h=setup(t,{browser,adapter,open:async()=>{throw Error('must not open a replacement page');}});
  const session={...descriptor(),target:{kind:'delivery',operationId:'send-1',batchId:'batch-1'}};
  return {...h,pages,entry,state,target,session,configuredCount:()=>configured,cancelled:()=>cancelled,expire:()=>{valid=false;},binding:{taskId:'task-1',pageId:entry.pageId,captchaId:'captcha-1'}};
}
function deliveryCommand(h,id,action,input) {return {id,action,...(input?{inputEncrypted:encrypted(input)}:{}),binding:h.binding,expiresAt:Date.now()+3000};}

test('active delivery borrows its own page before any account configuration and clean observer close leaves it alive',async t=>{
  const h=deliverySetup(t);await h.deliver(h.session);await flush();
  assert.equal(h.configuredCount(),0,'borrowing must not run adapter.account/configure');
  const frame=h.publishes.find(body=>body.frame?.delivery)?.frame;assert.ok(frame,'real active-page metadata is missing');assert.equal(frame.delivery.pageId,h.entry.pageId);assert.equal(frame.delivery.taskId,'task-1');
  await h.deliver(null);assert.equal(h.win.isDestroyed(),false);assert.equal(h.cancelled(),0);assert.equal(h.pages.borrow(h.target),h.entry);
});
test('active delivery is readonly until explicit captcha takeover and never permits login navigation',async t=>{
  const h=deliverySetup(t);await h.deliver(h.session);
  await h.deliver(h.session,[deliveryCommand(h,'observe-click','input',{kind:'click',x:.2,y:.25})]);
  assert.equal(h.events.length,0);assert.equal(h.acks().find(a=>a.id==='observe-click')?.ok,false);
  await h.deliver(h.session,[deliveryCommand(h,'takeover','captcha_takeover')]);assert.equal(h.acks().find(a=>a.id==='takeover')?.ok,true);
  await h.deliver(h.session,[deliveryCommand(h,'human-click','input',{kind:'click',x:.2,y:.25})]);assert.deepEqual(h.events.map(e=>e.value.type),['mousePressed','mouseReleased']);
  await h.deliver(h.session,[command('no-navigation','navigate')]);assert.equal(h.loads.length,0);assert.equal(h.acks().find(a=>a.id==='no-navigation')?.ok,false);
});
test('captcha disappearance after mouseDown blocks mouseUp and uses sender cancellation, never another site click',async t=>{
  const h=deliverySetup(t);await h.deliver(h.session);await h.deliver(h.session,[deliveryCommand(h,'takeover','captcha_takeover')]);
  const send=h.wc.debugger.sendCommand;h.wc.debugger.sendCommand=async(method,value)=>{await send(method,value);if(value.type==='mousePressed'){delete h.state.captcha;h.state.captchaDetected=false;}};
  await h.deliver(h.session,[deliveryCommand(h,'race-click','input',{kind:'click',x:.2,y:.25})]);await flush();
  assert.deepEqual(h.events.map(e=>e.value.type),['mousePressed']);assert.equal(h.cancelled(),1);assert.equal(h.pages.pages.size,0);
});
test('each key event rechecks iframe focus, keyUp is not replayed after focus escapes',async t=>{
  const h=deliverySetup(t);await h.deliver(h.session);await h.deliver(h.session,[deliveryCommand(h,'takeover','captcha_takeover')]);
  const send=h.wc.debugger.sendCommand;h.wc.debugger.sendCommand=async(method,value)=>{await send(method,value);if(value.type==='keyDown')h.state.captcha.focused=false;};
  await h.deliver(h.session,[deliveryCommand(h,'race-key','input',{kind:'key',key:'Enter'})]);await flush();
  assert.deepEqual(h.events.map(e=>e.value.type),['keyDown']);assert.equal(h.cancelled(),1);
});
test('disconnect while holding a captcha pointer cancels that sender and does not synthesize release',async t=>{
  const h=deliverySetup(t);await h.deliver(h.session);await h.deliver(h.session,[deliveryCommand(h,'takeover','captcha_takeover')]);
  await h.deliver(h.session,[deliveryCommand(h,'drag-down','input',{kind:'pointer',phase:'down',x:.2,y:.25,button:'left'})]);await h.deliver(null);
  assert.deepEqual(h.events.map(e=>e.value.type),['mousePressed']);assert.equal(h.cancelled(),1);
});
for(const change of ['replaced','gone'])test(`a held captcha pointer cancels its sender when the challenge is ${change} before release`,async t=>{
  const h=deliverySetup(t);await h.deliver(h.session);await h.deliver(h.session,[deliveryCommand(h,'takeover','captcha_takeover')]);
  await h.deliver(h.session,[deliveryCommand(h,'drag-down','input',{kind:'pointer',phase:'down',x:.2,y:.25,button:'left'})]);
  if(change==='replaced')h.state.captcha.id='captcha-2';else {delete h.state.captcha;h.state.captchaDetected=false;}
  await h.runner.capture(h.runner.session);await flush();
  assert.equal(h.cancelled(),1);assert.deepEqual(h.events.map(e=>e.value.type),['mousePressed']);
});
test('a changed operation descriptor cannot reuse the same account Room or trigger a replacement account page',async t=>{
  const h=deliverySetup(t);await h.deliver(h.session);await h.deliver({...h.session,target:{...h.session.target,operationId:'other'}});
  assert.equal(h.configuredCount(),0);assert.equal(h.runner.session,null);assert.equal(h.win.isDestroyed(),false);
});
test('expired current delivery lease rejects input before any underlying event',async t=>{
  const h=deliverySetup(t);await h.deliver(h.session);await h.deliver(h.session,[deliveryCommand(h,'takeover','captcha_takeover')]);assert.equal(h.acks().find(a=>a.id==='takeover')?.ok,true);h.expire();
  await h.deliver(h.session,[deliveryCommand(h,'late','input',{kind:'click',x:.2,y:.25})]);assert.equal(h.events.length,0);
});

test('the same delivery Room follows the next owned page but late observe cannot cancel its held input',async t=>{
  const h=deliverySetup(t);await h.deliver(h.session);h.entry.close();h.win.destroy();
  const next=page();let cancelled=0;
  const entry=h.pages.register({...h.target,taskId:'task-2',draftId:'draft-2',instance:{id:'native',studioEnvironment:{version:'environment-1'}},driver:{window:next.win,webContents:next.wc,call:async()=>h.state},checkLease:()=>{},cancel:()=>{cancelled++;next.win.destroy();}});
  await h.deliver(h.session);await h.runner.capture(h.runner.session);await flush();
  assert.equal(h.runner.session.entry,entry);assert.equal(h.configuredCount(),0);
  const current={...h,binding:{taskId:'task-2',pageId:entry.pageId,captchaId:'captcha-1'}};
  await h.deliver(h.session,[deliveryCommand(current,'new-takeover','captcha_takeover')]);
  await h.deliver(h.session,[deliveryCommand(current,'new-down','input',{kind:'pointer',phase:'down',x:.2,y:.25,button:'left'})]);
  assert.equal(entry.manual,true);assert.equal(h.runner.session.buttons,1);
  await h.deliver(h.session,[{...deliveryCommand(h,'expired-old-observe','observe'),expiresAt:Date.now()-1}]);
  assert.equal(entry.manual,true);assert.equal(cancelled,0);assert.equal(h.runner.session.buttons,1);
  await h.deliver(h.session,[deliveryCommand(h,'old-observe','observe')]);
  assert.equal(h.acks().find(a=>a.id==='old-observe')?.ok,false);assert.equal(entry.manual,true);assert.equal(cancelled,0);assert.equal(h.runner.session.buttons,1);
  await h.deliver(h.session,[deliveryCommand(current,'new-up','input',{kind:'pointer',phase:'up',x:.2,y:.25,button:'left'})]);
  assert.deepEqual(next.events.map(e=>e.value.type),['mousePressed','mouseReleased']);
});
