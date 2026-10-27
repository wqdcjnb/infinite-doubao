"use strict";
const {createHash}=require('node:crypto');

const ARK_URL='https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const DEFAULT_MODEL='doubao-seed-2-1-turbo-260628';

// Executed in an isolated world. Read only challenge descendants, never page text,
// cookies, storage, form values, or the automation API used to send video tasks.
function readWidget() {
  const viewport={width:window.innerWidth,height:window.innerHeight};
  const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
  const visible=el=>{
    if(!el.getClientRects().length)return false;
    for(let p=el;p;p=p.parentElement) {const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}
    const r=rect(el);return r.width>0&&r.height>0;
  };
  const markers='#captcha_container, .captcha_verify_container, #captcha-verify-container-main-page, .vc_captcha_box, .vc-captcha-verify, .drag-area';
  const roots=[...document.querySelectorAll(markers)].filter(visible);
  if(!roots.length)return {present:false,viewport};
  const root=roots.find(el=>el.querySelectorAll('canvas, img').length>=9)||roots[0];
  const all=[...root.querySelectorAll('*')].filter(visible);
  const texts=all.map(el=>(el.textContent||'').trim()).filter(t=>t.length<=100);
  const instruction=texts.filter(t=>/拖动|拖到|拖至|拖拽|拖放|拖下|drag/i.test(t)&&!/这里|此处|drop\s*here/i.test(t)).sort((a,b)=>a.length-b.length)[0]||'';
  const topicNodes=[...root.querySelectorAll('[class*="prompt-bar" i] *, [class*="captcha-bar" i] *, [class*="captcha_verify_bar" i] *, [class*="tip" i], [class*="title" i], [class*="desc" i]')].filter(visible);
  const topic=topicNodes.map(el=>(el.textContent||'').trim()).filter(t=>t.length>=2&&t.length<=30&&/[\u4e00-\u9fff]{2,}/.test(t)&&!/拖动|拖到|拖至|拖拽|拖放|拖下|drag|刷新|反馈|提交|重置|关闭|取消|确认|验证码/i.test(t)).sort((a,b)=>a.length-b.length)[0]||'';
  const candidates=[...root.querySelectorAll('canvas, img')].filter(visible).map(rect).filter(r=>r.width>=36&&r.height>=36&&r.width<=340&&r.height<=340);
  const unique=candidates.filter((r,i)=>!candidates.slice(0,i).some(q=>Math.abs(q.x-r.x)<2&&Math.abs(q.y-r.y)<2));
  unique.sort((a,b)=>Math.abs(a.y-b.y)>a.height/2?a.y-b.y:a.x-b.x);
  const floor=unique.length?Math.max(...unique.map(r=>r.y+r.height)):Infinity;
  const drops=[...root.querySelectorAll('[class*="drag-area" i], [class*="drop" i], [class*="target" i]')].filter(visible).filter(el=>rect(el).y>=floor-10).sort((a,b)=>rect(a).y-rect(b).y);
  const drop=drops[0];
  const byRole=[...root.querySelectorAll('button, [role="button"]')].filter(el=>/^(提交|确认|确定|验证|submit|verify|confirm)$/i.test((el.textContent||'').trim()));
  const byClass=[...root.querySelectorAll('[class*="verify-pb" i], [class*="verify-pc-button" i], [class*="verify-button" i], [class*="submit" i]')];
  const submits=[...new Set([...byRole,...byClass])].filter(visible).map(rect).filter(r=>r.width>=20&&r.height>=14&&r.height<=80).sort((a,b)=>(b.y+b.height)-(a.y+a.height));
  return {present:true,viewport,widget:rect(root),topic,instruction,candidates:unique,drop:drop?rect(drop):null,submit:submits[0]||null,
    dirty:Boolean(drop&&/^\s*[1-9]\d*\s*(?:拖|drop)/i.test(drop.textContent||'')),expired:texts.some(t=>/超时|过期|失效|expired|timeout/i.test(t))};
}

// The owner element is resolved in its PARENT frame's isolated world. Its content
// rectangle is therefore in the parent viewport, including borders and scrolling.
function readFrameOwner() {
  let axisAligned=true;
  for(let el=this;el;el=el.parentElement) {
    const t=getComputedStyle(el).transform;
    if(t&&t!=='none') {const m=t.match(/^matrix\(([^)]+)\)$/);if(!m)axisAligned=false;else {const a=m[1].split(',').map(Number);if(a.length!==6||a.some(n=>!Number.isFinite(n))||a[0]<=0||a[3]<=0||Math.abs(a[1])>0.0001||Math.abs(a[2])>0.0001)axisAligned=false;}}
  }
  const r=this.getBoundingClientRect(),sx=r.width/this.offsetWidth,sy=r.height/this.offsetHeight;
  return {x:r.x+this.clientLeft*sx,y:r.y+this.clientTop*sy,width:this.clientWidth*sx,height:this.clientHeight*sy,axisAligned};
}

function failure(reason) {return Object.assign(new Error(reason),{captchaReason:reason});}
function box(r) {return Boolean(r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0);}
function inside(r,outer) {return box(r)&&box(outer)&&r.x>=outer.x-0.5&&r.y>=outer.y-0.5&&r.x+r.width<=outer.x+outer.width+0.5&&r.y+r.height<=outer.y+outer.height+0.5;}
function signature(s) {return JSON.stringify([s.topic,s.instruction,s.widget,s.candidates,s.drop,s.submit]);}
function supported(s) {
  if(!s?.present||!s.topic||s.topic.length>30||!/拖动|拖到|拖至|拖拽|拖放|拖下|drag/i.test(s.instruction)||/滑块|拼图|slider|puzzle|依次|按顺序|in order/i.test(s.instruction)||s.expired||s.dirty)return false;
  if(!box(s.widget)||s.widget.width>1200||s.widget.height>1500||!Array.isArray(s.candidates)||s.candidates.length!==9||![...s.candidates,s.drop,s.submit].every(r=>inside(r,s.widget)))return false;
  const c=s.candidates;
  for(let i=0;i<9;i++) {
    if(c[i].width<36||c[i].width>340||c[i].height<36||c[i].height>340||Math.abs(c[i].y-c[Math.floor(i/3)*3].y)>6||Math.abs(c[i].x-c[i%3].x)>6)return false;
    if(i%3&&c[i].x<c[i-1].x+c[i-1].width)return false;
    if(i>=3&&c[i].y<c[i-3].y+c[i-3].height)return false;
  }
  return s.drop.y>=Math.max(...c.map(r=>r.y+r.height))-10&&s.submit.y>=s.drop.y;
}

/**
 * One bounded attempt on the current native Electron page. `check` must be a
 * synchronous, throwing lease/page/control check; `signal` cancels for takeover.
 * The caller supplies the key. No environment/config/credential lookup occurs.
 * Mouse release in finally is the only cleanup input allowed after cancellation.
 */
async function solveStudioCaptcha({driver,check,signal,key,model=DEFAULT_MODEL,fetch:request=globalThis.fetch}={}) {
  const diagnostics={attempts:0,candidates:0,selected:0,submitted:false,released:false};
  const result=(solved,reason)=>({solved,manualRequired:!solved,reason,diagnostics});
  if(typeof key!=='string'||!key.trim())return result(false,'missing_key');
  if(typeof check!=='function'||typeof request!=='function')return result(false,'invalid_context');
  if(typeof model!=='string'||!model.trim()||model.length>120||/[\x00-\x20]/.test(model))return result(false,'invalid_model');
  const wc=driver?.webContents,api=wc?.debugger;
  let originalURL;
  try {
    if(!api?.sendCommand||api.isAttached?.()===false||typeof wc.getURL!=='function')return result(false,'invalid_driver');
    originalURL=wc.getURL();
  } catch {return result(false,'page_changed');}
  const controller=new AbortController();
  let stopReason='',rejectStopped,held=false,pointer={x:0,y:0},rootIdentity;
  const stopped=new Promise((_,reject)=>{rejectStopped=reject;});stopped.catch(()=>{});
  const stop=reason=>{if(!stopReason){stopReason=reason;controller.abort();rejectStopped(failure(reason));}};
  const assertCurrent=()=>{
    if(signal?.aborted)throw failure('cancelled');
    if(stopReason)throw failure(stopReason);
    if(driver.webContents!==wc||wc.isDestroyed?.()||driver.window?.isDestroyed?.()||wc.getURL()!==originalURL)throw failure('page_changed');
    try {if(check()===false)throw Error('invalid');} catch {throw failure('control_invalid');}
  };
  async function step(action) {
    assertCurrent();
    try {const value=await Promise.race([action(),stopped]);assertCurrent();return value;}
    catch(error) {assertCurrent();throw error;}
  }
  const command=(method,params={})=>step(()=>api.sendCommand(method,params));
  const onAbort=()=>stop('cancelled');
  // Even a child-frame navigation invalidates the captured challenge geometry.
  const onNavigate=()=>stop('page_changed');
  let timer;
  try {
    assertCurrent();
    signal?.addEventListener('abort',onAbort,{once:true});wc.on?.('did-start-navigation',onNavigate);
    timer=setTimeout(()=>stop('deadline'),65000);
    async function inspect(frame) {
      const value=await command('Runtime.evaluate',{expression:'('+readWidget.toString()+')()',contextId:frame.contextId,returnByValue:true});
      if(value.exceptionDetails||typeof value.result?.value?.present!=='boolean')throw failure('inspection_failed');
      return value.result.value;
    }
    async function discover() {
      const {frameTree}=await command('Page.getFrameTree');
      if(!frameTree?.frame?.id)throw failure('inspection_failed');
      const identity=JSON.stringify([frameTree.frame.id,frameTree.frame.loaderId]);
      if(rootIdentity&&rootIdentity!==identity)throw failure('page_changed');
      rootIdentity=identity;
      const frames=[];
      function visit(tree,parent=null,depth=0) {
        if(depth>8||frames.length>=16)throw failure('unsupported_frames');
        const frame={id:tree.frame.id,parent,contextId:null,state:null};frames.push(frame);
        for(const child of tree.childFrames||[])visit(child,frame,depth+1);
      }
      visit(frameTree);
      for(const frame of frames) {
        const world=await command('Page.createIsolatedWorld',{frameId:frame.id,worldName:'studio-captcha-readonly'});
        if(!Number.isInteger(world.executionContextId))throw failure('inspection_failed');
        frame.contextId=world.executionContextId;frame.state=await inspect(frame);
      }
      return frames;
    }
    async function coordinates(frame) {
      const v=frame.state.viewport;
      if(!v||!Number.isFinite(v.width)||!Number.isFinite(v.height)||v.width<=0||v.height<=0)throw failure('geometry_unsupported');
      if(!frame.parent)return {x:0,y:0,sx:1,sy:1,bounds:[{x:0,y:0,width:v.width,height:v.height}]};
      const parent=await coordinates(frame.parent);
      const owner=await command('DOM.getFrameOwner',{frameId:frame.id});
      if(!owner.backendNodeId)throw failure('geometry_unsupported');
      const remote=await command('DOM.resolveNode',{backendNodeId:owner.backendNodeId,executionContextId:frame.parent.contextId});
      if(!remote.object?.objectId)throw failure('geometry_unsupported');
      let value;
      try {value=await command('Runtime.callFunctionOn',{objectId:remote.object.objectId,functionDeclaration:readFrameOwner.toString(),returnByValue:true});}
      finally {await command('Runtime.releaseObject',{objectId:remote.object.objectId});}
      const r=value.result?.value;
      if(value.exceptionDetails||r?.axisAligned!==true||!box(r))throw failure('geometry_unsupported');
      const x=parent.x+r.x*parent.sx,y=parent.y+r.y*parent.sy;
      return {x,y,sx:parent.sx*r.width/v.width,sy:parent.sy*r.height/v.height,bounds:[...parent.bounds,{x,y,width:r.width*parent.sx,height:r.height*parent.sy}]};
    }
    async function layout(frame) {
      const transform=await coordinates(frame),value=await command('Page.getLayoutMetrics');
      const view=value.cssVisualViewport;
      if(!view||![view.pageX,view.pageY,view.clientWidth,view.clientHeight].every(Number.isFinite)||view.pageX<0||view.pageY<0||(view.scale!==undefined&&view.scale!==1)||view.offsetX||view.offsetY)throw failure('geometry_unsupported');
      const map=r=>({x:transform.x+r.x*transform.sx,y:transform.y+r.y*transform.sy,width:r.width*transform.sx,height:r.height*transform.sy});
      const state=frame.state,mapped={widget:map(state.widget),candidates:state.candidates.map(map),drop:map(state.drop),submit:map(state.submit)};
      const viewport={x:0,y:0,width:view.clientWidth,height:view.clientHeight};
      if(!transform.bounds.every(bound=>inside(mapped.widget,bound))||!Object.values(mapped).flat().every(r=>inside(r,mapped.widget)&&inside(r,viewport)))throw failure('geometry_unsupported');
      return {...mapped,view};
    }
    async function captures(geometry) {
      const images=[];let bytes=0;
      for(const r of geometry.candidates) {
        const {data}=await command('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:false,clip:{x:r.x+geometry.view.pageX,y:r.y+geometry.view.pageY,width:r.width,height:r.height,scale:1}});
        if(typeof data!=='string'||!data.length||data.length>700000||!/^[A-Za-z0-9+/]+={0,2}$/.test(data)||(bytes+=data.length)>5000000)throw failure('capture_failed');
        images.push(data);
      }
      return images;
    }
    function same(state,original) {if(!state.present||state.expired||signature(state)!==signature(original))throw failure('challenge_changed');}
    const frames=await discover(),matches=frames.filter(f=>supported(f.state));
    if(matches.length!==1)return result(false,frames.some(f=>f.state.present)?'unsupported_challenge':'challenge_missing');
    const frame=matches[0],original=frame.state,originalSignature=signature(original);
    diagnostics.candidates=9;
    let geometry=await layout(frame);
    const images=await captures(geometry),hashes=images.map(data=>createHash('sha256').update(data).digest('hex'));
    same(await inspect(frame),original);
    const body={model,messages:[{role:'user',content:[{type:'text',text:'验证码题目：请选择所有符合「'+original.topic+'」的图片，并拖拽到下方。下面依次提供9张候选图片，编号1至9。只返回JSON：{"indices":[编号,...]}，不要返回其他内容。'},...images.map(data=>({type:'image_url',image_url:{url:'data:image/png;base64,'+data}}))]}],max_tokens:200,thinking:{type:'disabled'}};
    diagnostics.attempts=1;
    const response=await step(()=>request(ARK_URL,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key.trim(),'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal}));
    if(!response?.ok)throw failure('vision_failed');
    const reply=await step(()=>response.json());
    let content=reply?.choices?.[0]?.message?.content;
    if(Array.isArray(content)&&content.every(p=>p?.type==='text'&&typeof p.text==='string'))content=content.map(p=>p.text).join('');
    let parsed;
    try {if(typeof content!=='string'||content.length>1000)throw Error();parsed=JSON.parse(content);} catch {throw failure('invalid_model_response');}
    const indices=parsed?.indices;
    if(!parsed||Object.keys(parsed).length!==1||!Array.isArray(indices)||!indices.length||indices.length>9||new Set(indices).size!==indices.length||indices.some(i=>!Number.isInteger(i)||i<1||i>9))throw failure('invalid_model_response');
    diagnostics.selected=indices.length;
    const currentFrames=await discover(),current=currentFrames.find(f=>f.id===frame.id);
    if(!current)throw failure('challenge_changed');
    same(current.state,original);if(current.state.dirty)throw failure('challenge_changed');
    geometry=await layout(current);
    const currentImages=await captures(geometry);
    if(currentImages.some((data,i)=>createHash('sha256').update(data).digest('hex')!==hashes[i]))throw failure('challenge_changed');
    async function ensureChallenge() {const state=await inspect(current);if(!state.present||state.expired||signature(state)!==originalSignature)throw failure('challenge_changed');}
    async function mouse(type,point) {
      assertCurrent();pointer=point;
      if(type==='mousePressed'){held=true;diagnostics.released=false;}
      await command('Input.dispatchMouseEvent',{type,x:point.x,y:point.y,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:held?1:0,clickCount:type==='mouseMoved'?0:1});
      if(type==='mouseReleased'){held=false;diagnostics.released=true;}
    }
    const center=r=>({x:r.x+r.width/2,y:r.y+r.height/2}),target=center(geometry.drop);
    for(const index of indices) {
      await ensureChallenge();
      const start=center(geometry.candidates[index-1]);
      await mouse('mouseMoved',start);await mouse('mousePressed',start);
      for(let i=1;i<=8;i++)await mouse('mouseMoved',{x:start.x+(target.x-start.x)*i/8,y:start.y+(target.y-start.y)*i/8});
      await mouse('mouseReleased',target);
    }
    await ensureChallenge();
    const submit=center(geometry.submit);
    await mouse('mouseMoved',submit);await mouse('mousePressed',submit);await mouse('mouseReleased',submit);diagnostics.submitted=true;
    await step(()=>new Promise(resolve=>setTimeout(resolve,800)));
    const after=await discover();
    if(after.some(f=>f.state.present))return result(false,'challenge_remains');
    assertCurrent();return result(true,'challenge_gone');
  } catch(error) {return result(false,error.captchaReason||'operation_failed');}
  finally {
    if(held) {
      // A lost CDP acknowledgement may still have pressed the button. Release
      // only on the captured original webContents, even after lease cancellation.
      try {check();} catch {}
      let cleanupTimer;
      try {
        if(!wc.isDestroyed?.()) {
          await Promise.race([api.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...pointer,button:'left',buttons:0,clickCount:1}),new Promise((_,reject)=>{cleanupTimer=setTimeout(()=>reject(failure('release_failed')),1000);})]);
          diagnostics.released=true;
        }
      } catch {diagnostics.releaseFailed=true;diagnostics.releasePoint={x:pointer.x,y:pointer.y};}
      finally {clearTimeout(cleanupTimer);try {check();} catch {}}
    }
    clearTimeout(timer);signal?.removeEventListener('abort',onAbort);wc.removeListener?.('did-start-navigation',onNavigate);
  }
}

module.exports={solveStudioCaptcha};
