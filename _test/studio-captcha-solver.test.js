"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const vm=require('node:vm');
let solveStudioCaptcha;
try {({solveStudioCaptcha}=require('../src/studio-captcha-solver'));} catch(error) {if(error.code!=='MODULE_NOT_FOUND')throw error;}

function widget(overrides={}) {
  return {present:true,viewport:{width:400,height:600},topic:'可以用于照明的物品',instruction:'请选择所有符合上文描述的图片，并拖拽到下方',
    widget:{x:0,y:0,width:320,height:520},candidates:Array.from({length:9},(_,i)=>({x:10+i%3*100,y:60+Math.floor(i/3)*100,width:90,height:90})),
    drop:{x:10,y:390,width:290,height:50},submit:{x:230,y:470,width:80,height:30},dirty:false,expired:false,...overrides};
}
function harness(options={}) {
  const calls=[],requests=[],controller=new AbortController(),wc=new EventEmitter();let stale=false,submitted=false,scanCount=0;
  const root={frame:{id:'main',loaderId:'loader-1',url:'https://www.doubao.com/chat/'},childFrames:[
    {frame:{id:'outer',parentId:'main',loaderId:'loader-outer',url:'about:blank'},childFrames:[
      {frame:{id:'challenge',parentId:'outer',loaderId:'loader-challenge',url:'about:srcdoc'}}]}]};
  const contexts={main:1,outer:2,challenge:3};
  Object.assign(wc,{getURL:()=>options.url||'https://www.doubao.com/chat/',isDestroyed:()=>false});
  wc.debugger={isAttached:()=>true,sendCommand:async(method,params)=>{
    calls.push({method,params});
    if(options.onCommand)await options.onCommand(method,params,{controller,setStale:()=>{stale=true;},wc,calls});
    if(method==='Page.getFrameTree')return {frameTree:root};
    if(method==='Page.createIsolatedWorld')return {executionContextId:contexts[params.frameId]};
    if(method==='Runtime.evaluate') {
      scanCount++;
      if(options.evaluate)return {result:{value:options.evaluate(params,scanCount,submitted)}};
      return {result:{value:params.contextId===3?widget({present:!submitted||options.remains===true,...options.widget}):{present:false,viewport:{width:params.contextId===1?1200:800,height:params.contextId===1?1000:600}}}};
    }
    if(method==='DOM.getFrameOwner')return {backendNodeId:params.frameId==='outer'?101:102};
    if(method==='DOM.resolveNode') {assert.equal(params.executionContextId,params.backendNodeId===101?1:2);return {object:{objectId:String(params.backendNodeId)}};}
    if(method==='Runtime.callFunctionOn') {
      const outer=params.objectId==='101';
      const owner={offsetWidth:outer?804:404,offsetHeight:604,clientLeft:2,clientTop:2,clientWidth:outer?800:400,clientHeight:600,parentElement:null,
        getBoundingClientRect:()=>outer?{x:97.5,y:47.5,width:1005,height:755}:{x:38,y:28,width:404,height:604}};
      const transform=options.rotated&&!outer?'matrix(0, 1, -1, 0, 0, 0)':outer?'matrix(1.25, 0, 0, 1.25, 0, 0)':'none';
      return {result:{value:vm.runInNewContext('('+params.functionDeclaration+').call(owner)',{owner,getComputedStyle:()=>({transform})})}};
    }
    if(method==='Runtime.releaseObject')return {};
    if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{pageX:17,pageY:23,clientWidth:1200,clientHeight:1000,scale:1}};
    if(method==='Page.captureScreenshot')return {data:Buffer.from(options.changedCapture&&requests.length?'changed-candidate':'candidate-'+params.clip.x+'-'+params.clip.y).toString('base64')};
    if(method==='Input.dispatchMouseEvent') {if(params.type==='mouseReleased'&&params.x>400&&params.y>650)submitted=true;return {};}
    throw Error('unexpected protocol method '+method);
  }};
  const driver={webContents:wc};
  const check=()=>{if(stale)throw Error('lease no longer current');};
  const fetch=async(url,request)=>{
    requests.push({url,request});
    if(options.onFetch)return options.onFetch({controller,setStale:()=>{stale=true;},wc,requests});
    return {ok:true,json:async()=>({choices:[{message:{content:options.reply===undefined?'{"indices":[1,9]}':options.reply}}]})};
  };
  return {driver,check,signal:controller.signal,key:'fixture-key-only',fetch,calls,requests,controller,wc,
    setStale:()=>{stale=true;},run(extra={}){assert.equal(typeof solveStudioCaptcha,'function','native captcha adapter must be callable');return solveStudioCaptcha({...this,...extra});}};
}
const inputs=h=>h.calls.filter(c=>c.method==='Input.dispatchMouseEvent').map(c=>c.params);

test('missing key returns to manual without checking, reading, capturing, or calling a service',async()=>{
  const h=harness();let checks=0;
  const result=await h.run({key:' ',check:()=>{checks++;}});
  assert.equal(result.manualRequired,true);assert.equal(result.reason,'missing_key');
  assert.equal(checks,0);assert.deepEqual(h.calls,[]);assert.deepEqual(h.requests,[]);
});

test('one drag attempt maps nested blank frames and sends only nine cropped images plus the topic',async()=>{
  const h=harness(),result=await h.run();
  assert.equal(result.solved,true);assert.equal(result.manualRequired,false);assert.equal(result.diagnostics.attempts,1);
  assert.equal(h.requests.length,1);
  const {url,request}=h.requests[0],body=JSON.parse(request.body);
  assert.equal(url,'https://ark.cn-beijing.volces.com/api/v3/chat/completions');assert.equal(request.redirect,'error');
  assert.equal(request.headers.Authorization,'Bearer fixture-key-only');assert.equal(body.model,'doubao-seed-2-1-turbo-260628');assert.deepEqual(body.thinking,{type:'disabled'});
  assert.equal(body.messages.length,1);assert.equal(body.messages[0].content.length,10);
  assert.match(body.messages[0].content[0].text,/可以用于照明的物品/);assert.doesNotMatch(request.body,/doubao\.com|fixture-key-only|cookie|profile/i);
  assert.equal(body.messages[0].content.slice(1).every(p=>p.type==='image_url'&&p.image_url.url.startsWith('data:image/png;base64,')),true);
  assert.deepEqual([...new Set(h.calls.filter(c=>c.method==='Page.createIsolatedWorld').map(c=>c.params.frameId))],['main','outer','challenge']);
  const firstCapture=h.calls.find(c=>c.method==='Page.captureScreenshot');
  assert.deepEqual(firstCapture.params.clip,{x:179.5,y:185.5,width:112.5,height:112.5,scale:1});
  const events=inputs(h),presses=events.filter(e=>e.type==='mousePressed');
  assert.deepEqual(presses.map(e=>({x:e.x,y:e.y})),[{x:218.75,y:218.75},{x:468.75,y:468.75},{x:487.5,y:693.75}]);
  assert.equal(events.filter(e=>e.type==='mouseReleased').length,3);
  assert.equal(events.filter(e=>e.type==='mouseMoved').some(e=>e.x===343.75&&e.y===606.25),true);
  assert.equal(h.wc.listenerCount('did-start-navigation'),0);
});

test('an unchanged challenge after submit is manual and is never refreshed or retried',async()=>{
  const h=harness({remains:true}),result=await h.run();
  assert.equal(result.solved,false);assert.equal(result.reason,'challenge_remains');assert.equal(result.diagnostics.submitted,true);
  assert.equal(h.requests.length,1);assert.equal(inputs(h).filter(e=>e.type==='mousePressed').length,3);
});

test('a stale lease or closed native page at entry prevents every protocol and HTTP side effect',async()=>{
  const h=harness();h.setStale();const result=await h.run();
  assert.equal(result.reason,'control_invalid');assert.deepEqual(h.calls,[]);assert.deepEqual(h.requests,[]);
  const closed=harness();closed.wc.getURL=()=>{throw Error('webContents was destroyed');};
  const closedResult=await closed.run();assert.equal(closedResult.manualRequired,true);assert.equal(closedResult.reason,'page_changed');
  assert.deepEqual(closed.calls,[]);assert.deepEqual(closed.requests,[]);
});

test('cancel before entry has no side effects and an unresponsive HTTP request cannot delay takeover',async()=>{
  const h=harness();h.controller.abort();const result=await h.run();
  assert.equal(result.reason,'cancelled');assert.deepEqual(h.calls,[]);assert.deepEqual(h.requests,[]);
  const waiting=harness({onFetch:async({controller})=>{controller.abort();return new Promise(()=>{});}});
  const waitingResult=await waiting.run();assert.equal(waitingResult.reason,'cancelled');assert.equal(waiting.requests.length,1);assert.deepEqual(inputs(waiting),[]);
});

test('lease loss during the model request prevents drag and submit',async()=>{
  const h=harness({onFetch:async({setStale})=>{setStale();return {ok:true,json:async()=>({choices:[{message:{content:'{"indices":[1]}'}}]})};}});
  const result=await h.run();assert.equal(result.reason,'control_invalid');assert.deepEqual(inputs(h),[]);assert.equal(h.requests.length,1);
});

test('same-URL main frame navigation during model JSON decoding invalidates the original page',async()=>{
  const h=harness({onFetch:async({wc})=>({ok:true,json:async()=>{wc.emit('did-start-navigation',{},'https://www.doubao.com/chat/',false,true);return {choices:[{message:{content:'{"indices":[1]}'}}]};}})});
  const result=await h.run();assert.equal(result.reason,'page_changed');assert.deepEqual(inputs(h),[]);
});

test('cancellation or subframe navigation during a held drag lifts the pointer and stops input',async()=>{
  for(const mode of ['cancel','subframe']) {
    let pressed=false;
    const h=harness({onCommand:async(method,params,{controller,wc})=>{
      if(method==='Input.dispatchMouseEvent'&&params.type==='mousePressed')pressed=true;
      else if(pressed&&params.type==='mouseMoved') {
        if(mode==='cancel')controller.abort();else wc.emit('did-start-navigation',{},'about:blank',false,false);
      }
    }});
    const result=await h.run(),events=inputs(h);
    assert.equal(result.reason,mode==='cancel'?'cancelled':'page_changed');assert.deepEqual(events.map(e=>e.type),['mouseMoved','mousePressed','mouseMoved','mouseReleased']);
    assert.equal(result.diagnostics.released,true);assert.equal(result.diagnostics.submitted,false);
  }
});

test('a rejected mouse-down still triggers a release and never starts another drag',async()=>{
  const h=harness({onCommand:async(method,params)=>{if(method==='Input.dispatchMouseEvent'&&params.type==='mousePressed')throw Error('CDP response lost');}});
  const result=await h.run();assert.equal(result.manualRequired,true);
  assert.deepEqual(inputs(h).map(e=>e.type),['mouseMoved','mousePressed','mouseReleased']);
  assert.equal(Object.hasOwn(result.diagnostics,'releasePoint'),false);
  let presses=0;
  const stuck=harness({onCommand:async(method,params)=>{if(method==='Input.dispatchMouseEvent') {
    if(params.type==='mousePressed'&&++presses===2)throw Error('second drag acknowledgement lost');
    if(params.type==='mouseReleased'&&presses===2)throw Error('release acknowledgement lost');
  }}});
  const stuckResult=await stuck.run();assert.equal(stuckResult.diagnostics.releaseFailed,true);assert.equal(stuckResult.diagnostics.released,false);
  assert.deepEqual(stuckResult.diagnostics.releasePoint,{x:468.75,y:468.75});
});

test('invalid model selections are rejected before any mouse input',async()=>{
  for(const reply of ['{"indices":[0,10]}','{"indices":[1,1]}','{"indices":["1"]}','{"indices":[]}','pick 1 and then submit','{"indices":[1],"script":"click"}']) {
    const h=harness({reply}),result=await h.run();
    assert.equal(result.reason,'invalid_model_response',reply);assert.equal(h.requests.length,1);assert.deepEqual(inputs(h),[]);
  }
});

test('a changed candidate screenshot after the model response prevents input',async()=>{
  const h=harness({changedCapture:true}),result=await h.run();
  assert.equal(result.reason,'challenge_changed');assert.deepEqual(inputs(h),[]);assert.equal(h.requests.length,1);
});

test('unsupported or already populated widgets return to manual without a model call',async()=>{
  for(const value of [{instruction:'拖动滑块完成拼图'},{candidates:widget().candidates.slice(0,8)},{dirty:true},{expired:true}]) {
    const h=harness({widget:value}),result=await h.run();assert.equal(result.manualRequired,true);assert.equal(h.requests.length,0);assert.deepEqual(inputs(h),[]);
  }
});

test('rotated iframe geometry or a widget clipped by its own frame returns to manual before capture',async()=>{
  for(const options of [{rotated:true},{widget:{widget:{x:0,y:0,width:320,height:620}}}]) {
    const h=harness(options),result=await h.run();
    assert.equal(result.reason,'geometry_unsupported');assert.equal(h.requests.length,0);assert.deepEqual(inputs(h),[]);
    assert.equal(h.calls.some(c=>c.method==='Page.captureScreenshot'),false);
  }
});

test('real read-only widget script scopes the topic and nine canvases to the visible challenge',async()=>{
  const visibleStyle={display:'block',visibility:'visible',opacity:'1',transform:'none'};
  const make=(text,box)=>({textContent:text,parentElement:null,getBoundingClientRect:()=>box,getClientRects:()=>[box]});
  const state=widget(),topic=make(state.topic,{x:10,y:10,width:290,height:30}),instruction=make(state.instruction,{x:10,y:35,width:290,height:20});
  const candidates=state.candidates.map(box=>make('',box)),drop=make('拖拽到这里',state.drop),submit=make('',state.submit);
  const root=make('',state.widget);root.contains=()=>true;
  root.querySelectorAll=selector=>selector==='canvas, img'?candidates:selector==='*'?[topic,instruction,drop,submit]:selector.includes('prompt-bar')?[topic]:selector.includes('drag-area')?[drop]:selector.includes('verify-pb')?[submit]:[];
  for(const node of [topic,instruction,...candidates,drop,submit])node.parentElement=root;
  const document={querySelectorAll:()=>[root]},context={document,window:{innerWidth:400,innerHeight:600},getComputedStyle:()=>visibleStyle};
  let decoded;
  const h=harness({evaluate:(params,scanCount,submitted)=>{
    if(params.contextId!==3)return {present:false,viewport:{width:params.contextId===1?1200:800,height:params.contextId===1?1000:600}};
    if(submitted)return {present:false,viewport:{width:400,height:600}};
    decoded=vm.runInNewContext(params.expression,context);return decoded;
  }});
  const result=await h.run();assert.equal(result.solved,true);assert.equal(decoded.topic,state.topic);assert.equal(decoded.candidates.length,9);
});
