"use strict";
const {VERSION}=require('./studio-bridge');
const {Driver}=require('./driver');
const LOGIN_URL='https://www.doubao.com/chat/';
const KEY_CODES={Enter:13,Tab:9,Backspace:8,Escape:27,Delete:46,ArrowLeft:37,ArrowRight:39,ArrowUp:38,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34};
const MODIFIERS={Alt:1,Control:2,Meta:4,Shift:8};
const BUTTONS={left:1,right:2,middle:4,none:0};

// Inspect the visible official dialog before clicking: reloading would discard a QR/OTP challenge.
const LOGIN_SCRIPT=`(() => {
  const visible=el=>{const rect=el.getBoundingClientRect(),style=getComputedStyle(el);return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0';};
  const text=el=>String(el.innerText||el.textContent||'').trim();
  const dialogs=Array.from(document.querySelectorAll('[role="dialog"],dialog,[class*="login"][class*="modal"],[class*="Login"][class*="Modal"],[data-testid*="login-modal"],iframe[src*="login"],iframe[src*="passport"]'));
  if(dialogs.some(el=>visible(el)&&(/登录|登入|扫码|验证码|手机号|sign in|log in/i.test(text(el))||el.querySelector('input[type="tel"],input[type="password"],input[autocomplete="one-time-code"]')||/login|passport/i.test(el.getAttribute('src')||''))))return {ok:true,existing:true};
  const button=Array.from(document.querySelectorAll('button,a,[role="button"]')).find(el=>visible(el)&&/^(登录|登入|登录\\s*[\\/／]\\s*注册|登录注册|注册\\s*[\\/／]\\s*登录|立即登录|去登录|登录豆包|sign in|log in)$/i.test(text(el)));
  if(!button)return {ok:false};
  button.click();return {ok:true,existing:false};
})()`;

class StudioControl {
  constructor({client,adapter,accounts=adapter.accounts,decryptInput,onError=()=>{}}) {
    this.client=client;this.adapter=adapter;this.accounts=accounts;this.decryptInput=decryptInput;this.onError=onError;
    this.session=null;this.closedSessions=new Set();this.framePublishing=false;this.ackPublishing=false;this.inputReleases=new WeakMap();
  }
  async run(signal) {
    if(this.controller)throw Error('control runner already started');
    this.controller=new AbortController();this.executorSessionId=this.client.sessionId;
    const stop=()=>this.controller.abort();
    signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
    const ticker=setInterval(()=>{const ctx=this.session;if(ctx)this.capture(ctx);},200);
    try {await this.waitLoop();} finally {
      this.controller.abort();clearInterval(ticker);this.closeSession(this.session);
      signal?.removeEventListener('abort',stop);
    }
  }
  async request(action,body={},ctx=null) {
    const abort=new AbortController(),signal=this.controller.signal;
    let timeout,onAbort,onSessionAbort;
    const cancelled=new Promise((_,reject)=>{
      onAbort=()=>{abort.abort();reject(Error('control stopped'));};
      onSessionAbort=()=>{abort.abort();reject(Error('control session closed'));};
      signal.addEventListener('abort',onAbort,{once:true});
      ctx?.abort.signal.addEventListener('abort',onSessionAbort,{once:true});
      timeout=setTimeout(()=>{abort.abort();reject(Error('control request timed out'));},action==='wait'&&!this.session?25000:4500);
      if(signal.aborted)onAbort();else if(ctx?.abort.signal.aborted)onSessionAbort();
    });
    const response=Promise.resolve().then(async()=>{
      if(abort.signal.aborted)throw Error('control stopped');
      const result=await this.client.fetch(new URL('/api/studio/doubao/executor/control',this.client.site),{
        method:'POST',redirect:'error',signal:abort.signal,headers:this.client.headers({'content-type':'application/json'}),
        body:JSON.stringify({action,executorId:this.client.executorId,version:VERSION,executorSessionId:this.executorSessionId,...body})
      });
      if(!result.ok) {const error=Error('control HTTP failure');error.status=result.status;throw error;}
      return result.json();
    });
    try {return await Promise.race([response,cancelled]);} finally {
      clearTimeout(timeout);signal.removeEventListener('abort',onAbort);ctx?.abort.signal.removeEventListener('abort',onSessionAbort);
    }
  }
  async waitLoop() {
    while(!this.controller.signal.aborted) {
      try {
        const result=await this.request('wait');
        if(this.controller.signal.aborted)break;
        if(this.client.sessionId!==this.executorSessionId) {this.closeSession(this.session);break;}
        this.accept(result);this.unavailable=false;
      } catch(error) {
        if(this.controller.signal.aborted)break;
        this.closeSession(this.session);if(!this.unavailable) {this.unavailable=true;this.onError('control-unavailable');}
        await new Promise(resolve=>{
          const signal=this.controller.signal,done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
          const timer=setTimeout(done,500);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();
        });
      }
    }
  }
  accept(result) {
    const descriptor=result?.session;
    if(!descriptor) {this.closeSession(this.session);return;}
    if(this.closedSessions.has(descriptor.id))return;
    if(typeof descriptor.id!=='string'||!descriptor.id||typeof descriptor.accountId!=='string'||descriptor.account?.id!==descriptor.accountId||!descriptor.account.environment?.version||!Number.isFinite(descriptor.expiresAt)||descriptor.expiresAt<=Date.now()||!Array.isArray(result.commands)||result.commands.length>32)throw Error('invalid control session');
    const target=descriptor.target;
    if(target!==undefined&&(target?.kind!=='delivery'||typeof target.operationId!=='string'||!target.operationId||typeof target.batchId!=='string'||!target.batchId))throw Error('invalid delivery target');
    const targetKey=target?JSON.stringify({kind:'delivery',operationId:target.operationId,batchId:target.batchId}):'account';
    let ctx=this.session;
    if(ctx?.id===descriptor.id&&(ctx.accountId!==descriptor.accountId||ctx.version!==descriptor.account.environment.version||ctx.targetKey!==targetKey)) {this.closeSession(ctx);return;}
    if(ctx?.id!==descriptor.id) {
      this.closeSession(ctx);
      ctx={id:descriptor.id,accountId:descriptor.accountId,version:descriptor.account.environment.version,expiresAt:descriptor.expiresAt,
        target:target?{kind:'delivery',operationId:target.operationId,batchId:target.batchId}:null,targetKey,
        abort:new AbortController(),queue:[],seen:new Map(),acknowledgements:[],connected:true,loginState:'unknown',buttons:0,keys:new Set(),keyEvents:new Map(),lastProbe:0,captureFailures:0};
      this.session=ctx;
      if(ctx.target) {
        ctx.ready=Promise.resolve().then(()=>{this.check(ctx);this.capture(ctx);return ctx.win;}).catch(()=>{if(this.session===ctx)this.reportError(ctx,'当前没有可用的原发送页，请核对发送状态');return null;});
      } else {
        try {ctx.inst=this.adapter.account({kind:'account',accountId:ctx.accountId,payload:{account:descriptor.account}});} catch(error) {this.closeSession(ctx);throw error;}
        ctx.ready=Promise.resolve().then(()=>{this.check(ctx);const retained=this.adapter.observationWindow?.(ctx.accountId);if(retained?.interactive){if(retained.instance.id!==ctx.inst.id)throw Error('human page account mismatch');retained.check?.();return retained.window;}return this.accounts.open(ctx.inst.id);}).then(win=>{
          this.check(ctx);ctx.accountWin=win;ctx.win=win;ctx.closed=()=>this.closeSession(ctx);win.on('closed',ctx.closed);
          this.capture(ctx);return win;
        }).catch(()=>{if(this.session===ctx)this.reportError(ctx,'账号页面打开失败，请检查账号环境后重新连接');return null;});
      }
    }
    ctx.expiresAt=descriptor.expiresAt;ctx.lastContact=Date.now();ctx.connected=true;
    clearTimeout(ctx.watchdog);ctx.watchdog=setTimeout(()=>this.closeSession(ctx),Math.max(0,Math.min(5000,ctx.expiresAt-Date.now())));
    for(const [id,expiresAt]of ctx.seen)if(expiresAt<=Date.now())ctx.seen.delete(id);
    for(const command of result.commands) {
      if(typeof command?.id!=='string'||!command.id||!Number.isFinite(command.expiresAt)||ctx.seen.has(command.id))continue;
      // Mark delivery before awaiting any browser work; no retry path replays an input.
      ctx.seen.set(command.id,command.expiresAt);
      if(command.expiresAt<=Date.now()) {if(!ctx.target||this.matchesDeliveryBinding(ctx,command))this.resetHeld(ctx);if(this.session!==ctx)return;this.ack(ctx,{id:command.id,ok:false,error:'操作已过期，请重新操作'});continue;}
      if(ctx.queue.length>=128) {this.ack(ctx,{id:command.id,ok:false,error:'输入队列繁忙'});continue;}
      ctx.queue.push(command);
    }
    this.drain(ctx);
  }
  check(ctx,command) {
    if(this.controller.signal.aborted||this.session!==ctx||!ctx.connected||this.client.sessionId!==this.executorSessionId||ctx.expiresAt<=Date.now()||Date.now()-ctx.lastContact>=5000)throw Error('控制会话已断开或过期，请重新连接');
    if(ctx.target)this.bindDelivery(ctx);
    else if(ctx.accountWin) {
      const page=this.adapter.observationWindow?.(ctx.accountId);
      if(page&&(page.instance.id!==ctx.inst.id||!page.interactive&&(ctx.buttons||ctx.keys.size)))throw Error('自动处理页不能接收人工输入');
      ctx.observingImport=Boolean(page&&!page.interactive);
      ctx.win=page?.window||ctx.accountWin;
    }
    if(ctx.inst?.studioEnvironment?.version!==ctx.version||ctx.win?.isDestroyed?.()||ctx.win?.webContents.isDestroyed?.())throw Error('控制会话已断开或过期，请重新连接');
    if(command&&command.expiresAt<=Date.now())throw Error('操作已过期，请重新操作');
  }
  bindDelivery(ctx) {
    const entry=this.adapter.deliveryPages.borrow({accountId:ctx.accountId,...ctx.target,environmentVersion:ctx.version,executorSessionId:this.executorSessionId});
    if(ctx.entry===entry)return;
    this.resetHeld(ctx);
    if(ctx.closed&&ctx.win)ctx.win.removeListener('closed',ctx.closed);
    for(const command of ctx.queue)this.ack(ctx,{id:command.id,ok:false,error:'原处理页已变化，旧操作未执行'});
    ctx.queue=[];ctx.entry=entry;ctx.inst=entry.instance;ctx.win=entry.driver.window;ctx.loginState='unknown';
    ctx.closed=()=>{
      this.resetHeld(ctx);entry.manual=false;
      if(ctx.win)ctx.win.removeListener('closed',ctx.closed);
      ctx.win=null;ctx.entry=null;ctx.pendingFrame=null;
    };
    ctx.win.on('closed',ctx.closed);
  }
  closeSession(ctx) {
    if(!ctx)return;
    this.closedSessions.add(ctx.id);ctx.connected=false;ctx.abort.abort();clearTimeout(ctx.watchdog);
    ctx.queue.length=0;ctx.acknowledgements.length=0;ctx.pendingFrame=null;
    if(ctx.closed&&(ctx.accountWin||ctx.win))(ctx.accountWin||ctx.win).removeListener('closed',ctx.closed);
    if(this.session===ctx)this.session=null;
    this.resetHeld(ctx);
    if(ctx.entry?.manual)ctx.entry.keepOpen=true;
  }
  resetHeld(ctx) {
    if((ctx.buttons||ctx.keys.size)&&ctx.win&&!ctx.win.isDestroyed?.()) {
      const win=ctx.win,buttons=ctx.buttons,pointer=ctx.pointer,keys=[...ctx.keys].map(code=>ctx.keyEvents.get(code)||{code,key:code});
      const state=this.inputReleases.get(win)||{win,pending:[],running:false};if(ctx.entry)state.entry=ctx.entry;
      if(buttons&&pointer)for(const [button,bit] of Object.entries(BUTTONS))if(buttons&bit)state.pending.push(['Input.dispatchMouseEvent',{...pointer,type:'mouseReleased',button,buttons:0,clickCount:0}]);
      for(const value of keys)state.pending.push(['Input.dispatchKeyEvent',{key:value.key,code:value.code,...(Number.isFinite(value.windowsVirtualKeyCode)?{windowsVirtualKeyCode:value.windowsVirtualKeyCode}:{}),type:'keyUp',modifiers:0}]);
      this.inputReleases.set(win,state);this.flushHeld(state);
      if(ctx.entry){ctx.entry.manual=true;ctx.entry.keepOpen=true;}
    }
    ctx.buttons=0;ctx.keys.clear();ctx.keyEvents.clear();ctx.heldBinding=null;
  }
  flushHeld(state) {
    if(state.running)return state.promise;
    state.running=true;
    state.promise=(async()=>{
      try {while(state.pending.length&&!state.win.isDestroyed?.()&&!state.win.webContents.isDestroyed?.()){await state.win.webContents.debugger.sendCommand(...state.pending[0]);state.pending.shift();}}
      catch {this.onError('control-input-release-failed');}
      finally {state.running=false;if(!state.pending.length&&state.entry)state.entry.inputHeld=false;}
    })();
    return state.promise;
  }
  async releaseHeld(ctx,command) {
    this.check(ctx,command);const state=this.inputReleases.get(ctx.win);if(!state)return;
    await this.flushHeld(state);this.check(ctx,command);if(state.pending.length)throw Error('remote input release pending');
  }
  async drain(ctx) {
    if(ctx.draining)return;ctx.draining=true;
    try {
      await ctx.ready;
      while(this.session===ctx&&ctx.queue.length) {
        const command=ctx.queue.shift();let acknowledgement={id:command.id,ok:true};
        try {this.check(ctx,command);await this.releaseHeld(ctx,command);await this.execute(ctx,command);this.check(ctx,command);} catch(error) {
          if(error.code!=='STALE_DELIVERY_COMMAND')this.resetHeld(ctx);
          acknowledgement={id:command.id,ok:false,error:/登录|过期|断开/.test(error.message)?error.message:'操作失败，请检查当前画面后手动重试'};
        }
        if(this.session===ctx) {this.ack(ctx,acknowledgement);this.capture(ctx);}
      }
    } finally {ctx.draining=false;}
  }
  matchesDeliveryBinding(ctx,command) {
    const binding=command.binding;
    return Boolean(ctx.entry&&binding&&binding.taskId===ctx.entry.taskId&&binding.pageId===ctx.entry.pageId);
  }
  checkHeldDelivery(ctx) {
    if(ctx.target&&(ctx.buttons||ctx.keys.size)&&ctx.heldBinding&&!this.matchesDeliveryBinding(ctx,{binding:ctx.heldBinding})) {
      this.resetHeld(ctx);throw Error('held captcha target changed');
    }
  }
  async execute(ctx,command) {
    if(ctx.target) {
      this.check(ctx,command);this.checkHeldDelivery(ctx);
      if(['captcha_takeover','observe','input','release_input'].includes(command.action)) {
        if(!this.matchesDeliveryBinding(ctx,command)) {
          const error=Error('stale delivery command');error.code='STALE_DELIVERY_COMMAND';throw error;
        }
      }
      if(command.action==='captcha_takeover') {
        if(ctx.buttons||ctx.keys.size) {this.resetHeld(ctx);throw Error('unsafe captcha input state');}
        return ctx.entry.takeover(command.binding);
      }
      if(command.action==='observe') {this.resetHeld(ctx);await this.releaseHeld(ctx,command);return ctx.entry.observe(command.binding);}
      if(command.action==='release_input'){if(!ctx.entry.manual)throw Error('human takeover required');this.resetHeld(ctx);return this.releaseHeld(ctx,command);}
      if(!['open','frame','input'].includes(command.action))throw Error('active delivery navigation is not allowed');
    }
    if(command.action==='release_input'){this.resetHeld(ctx);return this.releaseHeld(ctx,command);}
    if(command.action==='input')return this.input(ctx,command,this.decryptInput(command.inputEncrypted,this.client.token));
    if(command.action==='navigate')return this.openLogin(ctx,command);
    if(!['open','frame'].includes(command.action))throw Error('unsupported control action');
  }
  async send(ctx,command,method,value) {
    this.check(ctx,command);const wc=ctx.win.webContents;
    const observation=!ctx.target&&this.adapter.observationWindow?.(ctx.accountId);
    if(observation&&!observation.interactive)throw Error('自动处理页不能接收人工输入');
    const activeEntry=ctx.target?ctx.entry:null;if(activeEntry)activeEntry.inputInFlight++;
    try {
    if(ctx.target) {
      const entry=ctx.entry;await entry.assertInput(command.binding,method,value);this.check(ctx,command);
      if(ctx.entry!==entry||ctx.win.webContents!==wc)throw Error('delivery page identity changed');
    }
    if(method==='Input.dispatchMouseEvent'){ctx.pointer={x:value.x,y:value.y};if(value.type==='mousePressed')ctx.buttons|=BUTTONS[value.button]||0;}
    if(method==='Input.dispatchKeyEvent'&&value.type==='keyDown'){ctx.keys.add(value.code);ctx.keyEvents.set(value.code,value);}
    if(ctx.target&&(ctx.buttons||ctx.keys.size))ctx.heldBinding={...command.binding};
    if(ctx.entry)ctx.entry.inputHeld=Boolean(ctx.buttons||ctx.keys.size);
    await wc.debugger.sendCommand(method,value);
    if(method==='Input.dispatchMouseEvent'&&value.type==='mouseReleased')ctx.buttons&=~(BUTTONS[value.button]||0);
    if(method==='Input.dispatchKeyEvent'&&value.type==='keyUp'){ctx.keys.delete(value.code);ctx.keyEvents.delete(value.code);}
    if(!ctx.buttons&&!ctx.keys.size)ctx.heldBinding=null;
    if(ctx.entry)ctx.entry.inputHeld=Boolean(ctx.buttons||ctx.keys.size);
    } finally {if(activeEntry)activeEntry.inputInFlight--;}
  }
  coordinates(ctx,input) {
    if(![input.x,input.y].every(value=>Number.isFinite(value)&&value>=0&&value<=1))throw Error('invalid pointer coordinates');
    const [width,height]=ctx.win.getContentSize();return {x:Math.min(width-1,Math.round(input.x*width)),y:Math.min(height-1,Math.round(input.y*height))};
  }
  async input(ctx,command,input) {
    if(!input||typeof input!=='object')throw Error('invalid control input');
    if(input.kind==='text') {
      if(typeof input.text!=='string'||input.text.length>10000)throw Error('invalid control text');
      return this.send(ctx,command,'Input.insertText',{text:input.text});
    }
    if(input.kind==='click'||input.kind==='pointer') {
      const point=this.coordinates(ctx,input),button=input.button||'left',modifiers=input.modifiers||[],value={...point,button,clickCount:input.clickCount===2?2:1,modifiers:modifiers.reduce((bits,key)=>bits|(MODIFIERS[key]||0),0)};
      if(!Object.hasOwn(BUTTONS,button))throw Error('invalid pointer button');
      if(input.kind==='click') {
        await this.send(ctx,command,'Input.dispatchMouseEvent',{...value,type:'mousePressed',buttons:1});
        await this.send(ctx,command,'Input.dispatchMouseEvent',{...value,type:'mouseReleased',buttons:0});return;
      }
      if(!['down','move','up'].includes(input.phase))throw Error('invalid pointer phase');
      const type={down:'mousePressed',move:'mouseMoved',up:'mouseReleased'}[input.phase];
      return this.send(ctx,command,'Input.dispatchMouseEvent',{...value,type,buttons:input.phase==='down'?ctx.buttons|BUTTONS[button]:input.phase==='up'?ctx.buttons&~BUTTONS[button]:ctx.buttons});
    }
    if(input.kind==='scroll') {
      if(![input.deltaX,input.deltaY].every(value=>Number.isSafeInteger(value)&&Math.abs(value)<=4000))throw Error('invalid scroll delta');
      const point=this.coordinates(ctx,{x:input.x??0.5,y:input.y??0.5});
      return this.send(ctx,command,'Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:input.deltaX,deltaY:input.deltaY,buttons:ctx.buttons});
    }
    if(input.kind==='key') {
      const modifiers=input.modifiers??[];
      if(!Array.isArray(modifiers)||modifiers.length>4||new Set(modifiers).size!==modifiers.length||modifiers.some(value=>!Object.hasOwn(MODIFIERS,value)))throw Error('invalid key modifiers');
      const physical=['down','up'].includes(input.phase)&&typeof input.code==='string'&&/^[A-Za-z0-9]{1,40}$/.test(input.code)&&Number.isInteger(input.keyCode)&&input.keyCode>=0&&input.keyCode<=255;
      const letter=typeof input.key==='string'&&/^[a-z]$/i.test(input.key),keyCode=physical?input.keyCode:Object.hasOwn(KEY_CODES,input.key)?KEY_CODES[input.key]:(letter&&modifiers.length?input.key.toUpperCase().charCodeAt(0):0);
      if(!keyCode)throw Error('unsupported control key');
      const value={key:input.key,code:physical?input.code:letter?'Key'+input.key.toUpperCase():input.key,windowsVirtualKeyCode:keyCode,modifiers:modifiers.reduce((bits,value)=>bits|MODIFIERS[value],0)};
      if(physical)return this.send(ctx,command,'Input.dispatchKeyEvent',{...value,type:input.phase==='down'?'keyDown':'keyUp',...(input.phase==='down'&&input.key==='Enter'&&!modifiers.length?{text:'\r',unmodifiedText:'\r'}:{})});
      await this.send(ctx,command,'Input.dispatchKeyEvent',{...value,type:'keyDown',...(input.key==='Enter'&&!modifiers.length?{text:'\r',unmodifiedText:'\r'}:{})});
      await this.send(ctx,command,'Input.dispatchKeyEvent',{...value,type:'keyUp'});return;
    }
    throw Error('unsupported control input');
  }
  async openLogin(ctx,command) {
    const wc=ctx.win.webContents;
    this.check(ctx,command);
    let current=new URL(wc.getURL());
    if(current.origin!=='https://www.doubao.com') {await wc.loadURL(LOGIN_URL);this.check(ctx,command);current=new URL(LOGIN_URL);}
    let result=await wc.executeJavaScript(LOGIN_SCRIPT,true);this.check(ctx,command);
    if(!result?.ok&&current.pathname!=='/chat/') {
      await wc.loadURL(LOGIN_URL);this.check(ctx,command);result=await wc.executeJavaScript(LOGIN_SCRIPT,true);this.check(ctx,command);
    }
    if(!result?.ok)throw Error('未找到可见的官方登录入口，请检查画面后手动重试');
  }
  async capture(ctx) {
    try {this.check(ctx);} catch {this.resetHeld(ctx);return;}
    if(!ctx.win)return;
    if(ctx.capturing) {ctx.captureAgain=true;return;}
    ctx.capturing=true;
    if(!ctx.observingImport)this.probeLogin(ctx);
    try {
      const entry=ctx.entry,win=ctx.win,importBusy=!ctx.target&&Boolean(ctx.observingImport),delivery=ctx.target?await entry.snapshot():undefined;
      this.check(ctx);if(ctx.win!==win||ctx.entry!==entry)throw Error('delivery capture changed');
      this.checkHeldDelivery(ctx);
      const image=await ctx.win.webContents.capturePage(undefined,{stayHidden:true});this.check(ctx);
      if(ctx.win!==win||ctx.entry!==entry)throw Error('delivery capture changed');
      const jpeg=image.toJPEG(70);if(jpeg.length>1024*1024)throw Error('control frame too large');
      const [width,height]=ctx.win.getContentSize();
      ctx.pendingFrame={imageBase64:jpeg.toString('base64'),contentType:'image/jpeg',width,height,capturedAt:Date.now(),loginState:ctx.loginState,...(!ctx.target?{busy:importBusy}:{}),...(delivery?{delivery}:{})};
      ctx.captureFailures=0;
      this.flushFrames();
    } catch {
      if(this.session===ctx&&ctx.captureFailures<5) {
        ctx.captureFailures++;
        if(ctx.captureFailures===5)this.reportError(ctx,'账号画面读取失败，请手动刷新或重新连接');
      }
    } finally {
      ctx.capturing=false;if(ctx.captureAgain) {ctx.captureAgain=false;this.capture(ctx);}
    }
  }
  async probeLogin(ctx) {
    if(ctx.probing||Date.now()-ctx.lastProbe<2000)return;ctx.probing=true;ctx.lastProbe=Date.now();
    try {
      const result=await new Driver({instance:ctx.inst,webContents:ctx.win.webContents}).isLoggedIn();this.check(ctx);
      ctx.loginState=result?.loggedIn===true?'logged_in':result?.loggedIn===false?'logged_out':'unknown';
    } catch {} finally {ctx.probing=false;}
  }
  async flushFrames() {
    const ctx=this.session;if(!ctx?.pendingFrame||this.framePublishing)return;
    const frame=ctx.pendingFrame;ctx.pendingFrame=null;this.framePublishing=true;
    try {await this.request('publish',{sessionId:ctx.id,frame},ctx);} catch {if(this.session===ctx)this.closeSession(ctx);} finally {
      this.framePublishing=false;this.flushFrames();
    }
  }
  ack(ctx,value) {
    if(ctx.acknowledgements.length>=128) {this.reportError(ctx,'操作回执积压');return;}
    ctx.acknowledgements.push(value);this.flushAcknowledgements();
  }
  reportError(ctx,error) {if(this.session===ctx) {ctx.error=error;this.flushAcknowledgements();}}
  async flushAcknowledgements() {
    const ctx=this.session;if(!ctx||this.ackPublishing||(!ctx.acknowledgements.length&&!ctx.error))return;
    const acknowledgements=ctx.acknowledgements.splice(0,32),error=ctx.error;delete ctx.error;this.ackPublishing=true;
    try {await this.request('publish',{sessionId:ctx.id,acknowledgements,...(error?{error}:{})},ctx);} catch {if(this.session===ctx)this.closeSession(ctx);} finally {
      this.ackPublishing=false;this.flushAcknowledgements();
    }
  }
}
module.exports={StudioControl};
