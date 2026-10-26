'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('验证弹窗被检测后显示所属账号窗口，关闭页面会释放轮询且不操作验证码',async()=>{
 const source=fs.readFileSync(require.resolve('../src/main.js'),'utf8').replace(/\r\n/g,'\n');const start=source.indexOf('async (inst, { signal } = {}) => {',source.indexOf('resolveDraftDriver:'));const end=source.indexOf('\n  },\n  findWebContents',start);
 let tick,cleared=0,required=false,win;const notices=[];
 class Window {constructor(){win=this;this.events={};this.shows=0;this.focuses=0;this.webContents={setWindowOpenHandler(){},executeJavaScript:async expression=>{assert.match(expression,/verifycenter\/captcha/);assert.doesNotMatch(expression,/click\(|dispatchEvent/);return required}};}on(name,fn){this.events[name]=fn}isDestroyed(){return !!this.destroyed}destroy(){this.destroyed=true;this.events.closed()}async loadURL(){}setTitle(t){this.title=t}show(){this.shows++}focus(){this.focuses++}}
 const pages=new Set();const open=vm.runInNewContext('('+source.slice(start,end)+'\n})',{prepareSession:async()=>{},mainWindow:{isDestroyed:()=>false},BrowserWindow:Window,webviewPreloadPath:()=>'',draftWindows:pages,setInterval:fn=>{tick=fn;return 1},clearInterval:()=>{cleared++},pushToUi:(channel,payload)=>notices.push(payload),log:{warn(){}},URL,driverMod:{open:async()=>({})}});
 const controller=new AbortController();const driver=await open({id:'account-2',name:'豆包-2',partition:'partition',url:'https://www.doubao.com/chat/'},{signal:controller.signal});
 await tick();assert.equal(win.shows,0);required=true;await tick();assert.equal(win.shows,1);assert.equal(win.focuses,1);assert.match(win.title,/豆包-2/);assert.equal(notices[0].instanceId,'account-2');await tick();assert.equal(win.shows,1);
 driver.close();assert.ok(cleared);assert.equal(pages.size,0);
});
