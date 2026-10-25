"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const executor=require('../src/server-executor');
const driver=require('../src/driver');
class BrowserBoundary extends EventEmitter {
  constructor(options) {
    super();this.options=options;this.webContents=new EventEmitter();this.closed=false;
    const wc=this.webContents;wc.isDestroyed=()=>this.closed;wc.setWindowOpenHandler=()=>{};
    wc.debugger=Object.assign(new EventEmitter(),{attach:()=>{},sendCommand:async()=>({})});
    wc.executeJavaScript=async source=>vm.runInContext(source,this.page);
    wc.loadURL=async url=>{
      this.page=vm.createContext({window:{},navigator:{userAgent:'native-browser'},document:{title:url,readyState:'complete'},location:{href:url}});
      wc.emit('dom-ready');wc.emit('did-finish-load');
    };
    this.loadURL=url=>wc.loadURL(url);this.isDestroyed=()=>this.closed;
    this.destroy=()=>{this.closed=true;this.emit('closed');};
  }
}
test('studio window keeps sandbox and context isolation, installs real automation without Node preload on each navigation',async()=>{
  assert.equal(typeof executor.createStudioWindow,'function','missing sandbox-compatible studio window');
  const inst={id:'sandbox-studio',partition:'persist:studio-fixture'};
  const win=executor.createStudioWindow(inst,{BrowserWindow:BrowserBoundary,enhancer:{enabled:true,model:'seedance_v2.0',duration:10}});
  assert.equal(win.options.webPreferences.sandbox,true);assert.equal(win.options.webPreferences.contextIsolation,true);
  assert.equal(win.options.webPreferences.nodeIntegration,false);assert.equal(Object.hasOwn(win.options.webPreferences,'preload'),false);
  await win.loadURL('data:text/html,local-first');
  const actual=await driver.open(inst,{webContents:win.webContents,timeoutMs:1000});
  assert.equal(await actual.title(),'data:text/html,local-first');assert.equal(win.page.navigator.userAgent,'native-browser');
  assert.equal(win.page.window[actual.key+'_enh'].model,'seedance_v2.0');
  await win.loadURL('data:text/html,local-second');
  assert.equal(await actual.ready(1000),true);assert.equal(await actual.title(),'data:text/html,local-second');win.destroy();
});
test('studio account lifecycle uses the same sandbox window factory before blank and account navigation',async()=>{
  assert.equal(typeof executor.createStudioWindow,'function','missing sandbox-compatible studio window');
  let created;
  const source=fs.readFileSync(path.join(__dirname,'../src/web-accounts.js'),'utf8'),inst={id:'sandbox-account',partition:'persist:sandbox-account',url:'https://www.doubao.com/chat/'};
  const module={exports:{}};
  vm.runInNewContext(source,{module,require:name=>name==='electron'?{BrowserWindow:class{constructor(){throw new Error('desktop window used by studio mode');}}}:name==='./store'?{find:()=>inst,get:()=>({settings:{}})}:name==='./driver'?driver:require(name)});
  const accounts=new module.exports.WebAccounts({prepareSession:async()=>{},createWindow:account=>(created=executor.createStudioWindow(account,{BrowserWindow:BrowserBoundary,enhancer:{}})),preload:()=>{throw new Error('legacy preload requested');},wake:()=>{},publish:()=>{},log:{warn:()=>{}}});
  const win=await accounts.open(inst.id);assert.equal(win,created);assert.equal(win.options.webPreferences.sandbox,true);
  const actual=await driver.open(inst,{webContents:win.webContents,timeoutMs:1000});assert.equal(await actual.title(),inst.url);accounts.stop();
});

test('dedicated lifecycle awaits document-start hook before target and waits for completed target navigation',async()=>{
  const order=[],inst={id:'ordered',partition:'persist:ordered',url:'https://www.doubao.com/chat/'};
  const source=fs.readFileSync(path.join(__dirname,'../src/web-accounts.js'),'utf8'),module={exports:{}};
  vm.runInNewContext(source,{module,require:name=>name==='electron'?{}:name==='./store'?{find:()=>inst,get:()=>({settings:{}})}:name==='./driver'?driver:require(name)});
  const win=new BrowserBoundary({});win.webContents.loadURL=async url=>{order.push(url);if(url===inst.url)await new Promise(resolve=>setImmediate(()=>{order.push('loaded');resolve();}));};
  const accounts=new module.exports.WebAccounts({prepareSession:async()=>order.push('session'),createWindow:()=>win,prepareWindow:async()=>order.push('document-start'),awaitNavigation:true,wake:()=>{},publish:()=>{},log:{warn:()=>{}}});
  await accounts.open(inst.id);assert.deepEqual(order,['session','about:blank','document-start',inst.url,'loaded']);accounts.stop();
});

test('failed dedicated preparation destroys partial window and does not return it on retry',async()=>{
  const inst={id:'failed',partition:'persist:failed',url:'https://www.doubao.com/chat/'};
  const source=fs.readFileSync(path.join(__dirname,'../src/web-accounts.js'),'utf8'),module={exports:{}};
  vm.runInNewContext(source,{module,require:name=>name==='electron'?{}:name==='./store'?{find:()=>inst,get:()=>({settings:{}})}:name==='./driver'?driver:require(name)});
  let created=0;const windows=[];
  const accounts=new module.exports.WebAccounts({prepareSession:async()=>{},createWindow:()=>{created++;const win=new BrowserBoundary({});windows.push(win);return win;},prepareWindow:async()=>{throw Error('preparation failed');},awaitNavigation:true,wake:()=>{},publish:()=>{},log:{warn:()=>{}}});
  await assert.rejects(accounts.open(inst.id),/preparation/);assert.equal(windows[0].isDestroyed(),true);
  await assert.rejects(accounts.open(inst.id),/preparation/);assert.equal(created,2);assert.equal(accounts.find(inst),null);
});
