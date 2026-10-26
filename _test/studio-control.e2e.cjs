"use strict";
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const {EventEmitter}=require('node:events');
const path=require('node:path');
const crypto=require('node:crypto');
const runtime=process.env.DOUBAO_PLAYWRIGHT_PACKAGE?createRequire(path.resolve(process.env.DOUBAO_PLAYWRIGHT_PACKAGE)):require;
const {chromium}=runtime('playwright');
const {StudioControl}=require('../src/studio-control');
const {StudioClient}=require('../src/studio-bridge');
const {decryptInput}=require('../src/server-executor');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check) {for(let i=0;i<300;i++){if(await check())return;await delay(5);}throw Error('native cleanup boundary timed out');}
function encrypted(input) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update('doubao-admin-input-v1:fixture-token').digest(),iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(input),'utf8'),cipher.final()]);return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')};
}
async function main() {
  const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1000,height:800}}),waits=[],acks=[],sent=[];
  const abort=new AbortController();let current,heldResponse,holdMouse=false,holdKey=false,running,windowNumber=0;
  const origin='https://fixture.invalid',frameOrigin='https://frame.fixture.invalid';
  const session=id=>({id,accountId:'fixture-account',account:{id:'fixture-account',name:'本机隔离页面',environment:{version:'fixture-environment'}},expiresAt:Date.now()+35000});
  const input=(id,value,expiresAt=Date.now()+3000)=>({id,action:'input',inputEncrypted:encrypted(value),expiresAt});
  const fixture=nested=>`<style>body{margin:0}button{position:absolute;left:40px;top:40px;width:200px;height:100px}input{position:absolute;left:40px;top:180px;width:400px;height:40px}#drag{position:absolute;left:40px;top:300px;width:100px;height:100px;background:teal}#drop{position:absolute;left:300px;top:300px;width:150px;height:150px;background:silver}iframe{position:absolute;left:40px;top:480px;width:500px;height:250px}</style><button>不能误点</button><input value="abcdef"><div id="drag" draggable="true">drag</div><div id="drop">drop</div>${nested?`<iframe src="${frameOrigin}/target"></iframe>`:''}<script>
    window.state={held:false,keys:[],dragStarts:0};
    const bump=name=>{const old=document.cookie.split('; ').find(item=>item.startsWith(name+'='));document.cookie=name+'='+(Number(old?.split('=')[1]||0)+1)+';path=/;Secure;SameSite=Lax'};
    const button=document.querySelector('button');button.onclick=()=>bump('clicks');button.onpointerdown=e=>button.setPointerCapture(e.pointerId);
    document.addEventListener('pointerdown',()=>state.held=true);document.addEventListener('pointerup',()=>state.held=false);document.addEventListener('pointercancel',()=>state.held=false);
    document.addEventListener('keydown',e=>{if(!state.keys.includes(e.code))state.keys.push(e.code)});document.addEventListener('keyup',e=>state.keys=state.keys.filter(key=>key!==e.code));
    document.querySelector('#drag').ondragstart=e=>{state.dragStarts++;e.dataTransfer.setData('text/plain','local-fixture')};
    document.querySelector('#drop').ondragover=e=>e.preventDefault();document.querySelector('#drop').ondrop=e=>{e.preventDefault();bump('drops')};
  </script>`;
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(![origin,frameOrigin].includes(url.origin))return route.abort();
    return route.fulfill({contentType:'text/html',body:fixture(url.origin===origin)});
  });
  await context.addCookies([{name:'loginFixture',value:'keep-session',url:origin,secure:true,sameSite:'Lax'}]);
  async function cookie(name,site=origin) {return (await context.cookies()).find(item=>item.name===name&&item.domain===new URL(site).hostname)?.value;}
  async function open() {
    if(current&&!current.win.isDestroyed())return current.win;
    const page=await context.newPage();await page.goto(origin+'/target');const cdp=await context.newCDPSession(page),win=new EventEmitter(),owner=++windowNumber;let closed=false;
    win.isDestroyed=()=>closed||page.isClosed();win.getContentSize=()=>[1000,800];win.destroy=()=>{if(closed)return;closed=true;win.emit('closed');void page.close().catch(()=>{});};
    win.webContents={isDestroyed:win.isDestroyed,getURL:()=> 'https://www.doubao.com/chat/',
      debugger:{sendCommand:async(method,value)=>{
        sent.push({owner,method,value});const result=await cdp.send(method,value);
        if((holdMouse&&value?.type==='mousePressed')||(holdKey&&value?.type==='keyDown'))await new Promise(resolve=>{heldResponse=resolve;});return result;
      }},executeJavaScript:source=>page.evaluate(source),loadURL:()=>{throw Error('real upstream navigation is forbidden');},capturePage:async()=>({toJPEG:()=>Buffer.from('fixture-image')})};
    current={page,win,owner};return win;
  }
  const client=new StudioClient({siteUrl:origin,executorId:'fixture-executor',sessionId:'fixture-epoch',token:'fixture-token',fetch:async(_url,request)=>{
    const body=JSON.parse(request.body);if(body.action==='wait')return new Promise(resolve=>waits.push(resolve));acks.push(...(body.acknowledgements||[]));return Response.json({ok:true});
  }});
  const adapter={accounts:{open},account:()=>({id:'local-fixture',studioEnvironment:{version:'fixture-environment'}})},runner=new StudioControl({client,adapter,decryptInput});
  async function deliver(id,commands=[]) {await until(()=>waits.length);waits.shift()(Response.json({session:id?session(id):null,commands}));await delay(10);}
  async function ack(id) {await until(()=>acks.some(item=>item.id===id));return acks.find(item=>item.id===id);}
  async function closed(window) {await until(()=>window.page.isClosed());assert.equal(sent.filter(item=>item.owner===window.owner&&['mouseReleased','keyUp'].includes(item.value?.type)).length,0);}
  try {
    running=runner.run(abort.signal);
    await deliver('first',[input('held-pointer',{kind:'pointer',phase:'down',x:0.1,y:0.1})]);await ack('held-pointer');
    const first=current;assert.equal(await first.page.evaluate(()=>state.held),true);await deliver(null);await closed(first);assert.equal(await cookie('clicks'),undefined);
    await deliver('normal',[input('new-click',{kind:'click',x:0.1,y:0.1})]);assert.equal((await ack('new-click')).ok,true);
    assert.equal(await cookie('clicks'),'1');assert.equal(await cookie('loginFixture'),'keep-session');const normal=current;
    await deliver(null);assert.equal(normal.page.isClosed(),false);

    await deliver('expiry');const expired=current,baseline=sent.length;holdMouse=true;
    await deliver('expiry',[input('expires-after-down',{kind:'click',x:0.1,y:0.1},Date.now()+150)]);await until(()=>heldResponse);await delay(180);
    const finishMouse=heldResponse;heldResponse=null;holdMouse=false;finishMouse();await until(()=>expired.page.isClosed());
    assert.equal(sent.slice(baseline).some(item=>item.value?.type==='mouseReleased'),false);assert.equal(await cookie('clicks'),'1');

    await deliver('iframe',[input('iframe-down',{kind:'pointer',phase:'down',x:0.12,y:0.7})]);await ack('iframe-down');
    const iframe=current;assert.equal(await iframe.page.frames()[1].evaluate(()=>state.held),true);await deliver(null);await closed(iframe);assert.equal(await cookie('clicks',frameOrigin),undefined);
    await deliver('iframe-normal',[input('iframe-click',{kind:'click',x:0.12,y:0.7})]);await ack('iframe-click');assert.equal(await cookie('clicks',frameOrigin),'1');
    await deliver(null);

    await deliver('key');await until(()=>runner.session?.win);await current.page.locator('input').focus();const keyWindow=current,keyBaseline=sent.length;holdKey=true;
    await deliver('key',[input('held-key',{kind:'key',key:'ArrowLeft',modifiers:['Shift']})]);await until(()=>heldResponse);assert.deepEqual(await keyWindow.page.evaluate(()=>state.keys),['ArrowLeft']);await deliver(null);
    await until(()=>keyWindow.page.isClosed());const finishKey=heldResponse;heldResponse=null;holdKey=false;finishKey();await delay(10);
    assert.deepEqual(sent.slice(keyBaseline).filter(item=>item.method==='Input.dispatchKeyEvent').map(item=>item.value.type),['keyDown']);

    await deliver('native-drag',[input('native-drag-down',{kind:'pointer',phase:'down',x:0.08,y:0.42}),input('native-drag-move',{kind:'pointer',phase:'move',x:0.36,y:0.46})]);
    await ack('native-drag-move');const dragging=current;await until(async()=>await dragging.page.evaluate(()=>state.dragStarts===1));await deliver(null);await closed(dragging);assert.equal(await cookie('drops'),undefined);
    await deliver('dispose',[input('dispose-down',{kind:'pointer',phase:'down',x:0.1,y:0.1})]);await ack('dispose-down');const disposed=current;abort.abort();await running;await closed(disposed);
    assert.equal(await cookie('clicks'),'1');assert.equal(await cookie('clicks',frameOrigin),'1');assert.equal(await cookie('loginFixture'),'keep-session');
    console.log(JSON.stringify({browser:browser.version(),capturedTopButtonNotClicked:true,capturedCrossOriginButtonNotClicked:true,newWindowInput:true,cookiePreserved:true,expiredClickNotCompleted:true,keyNotReplayed:true,nativeDragNotDropped:true,abortDiscardsHeldPage:true,syntheticPagesOnly:true}));
  } finally {heldResponse?.();abort.abort();await running;await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
