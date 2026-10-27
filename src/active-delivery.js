"use strict";
const {randomUUID}=require('node:crypto');
const identityKeys=['accountId','operationId','batchId','environmentVersion','executorSessionId'];

// References are borrowed from the sender. Only the sender can close its page.
class ActiveDeliveryPages {
  constructor() {this.pages=new Map();this.retained=new Map();}
  register(context) {
    if([...identityKeys,'taskId','draftId'].some(key=>typeof context[key]!=='string'||!context[key])||!context.driver?.window||!context.checkLease||!context.cancel)throw Error('invalid delivery page');
    if(this.pages.has(context.accountId))throw Error('delivery page already owned');
    const registry=this;
    const page={...context,pageId:randomUUID(),driver:context.driver,stage:'preparing',captchaSeen:false,manual:false,pauseRequested:false,activeSteps:0,inputHeld:false,inputInFlight:0,keepOpen:false,closed:false,captcha:null,
      check() {
        if(this.closed||registry.pages.get(this.accountId)!==this||this.driver.window.isDestroyed?.()||this.driver.webContents?.isDestroyed?.())throw Error('delivery page closed');
        context.checkLease();
      },
      setStage(stage) {this.check();this.stage=stage;},
      async snapshot(point) {
        this.check();let state;
        try {state=await this.driver.call('readNativeDeliveryState',point);} catch {state=null;}
        this.check();const value=state?.captcha,r=value?.rect,detected=state?.captchaDetected===true||Boolean(value);
        if(detected)this.captchaSeen=true;
        if(value&&typeof value.id==='string'&&value.id.length<=100&&r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=4096&&r.y+r.height<=4096) {
          this.captcha={id:value.id,rect:{x:r.x,y:r.y,width:r.width,height:r.height},focused:value.focused===true};this.captchaSeen=true;
        } else {this.captcha=null;}
        return {operationId:this.operationId,batchId:this.batchId,taskId:this.taskId,pageId:this.pageId,
          stage:this.manual?'manual_captcha':detected?'captcha_required':this.stage,captchaDetected:detected,captchaStateKnown:typeof state?.captchaDetected==='boolean',...(this.captcha?{captcha:this.captcha}:{})};
      },
      binding(value) {
        this.check();if(!value||value.taskId!==this.taskId||value.pageId!==this.pageId)throw Error('delivery binding mismatch');
      },
      async takeover(binding) {
        this.binding(binding);this.pauseRequested=true;this.keepOpen=true;this.driver.preserve?.();
        while(this.activeSteps){this.check();await new Promise(resolve=>setTimeout(resolve,25));}
        this.check();this.manual=true;this.pauseRequested=false;await this.snapshot();
      },
      async observe(binding,{automatic=false}={}) {
        this.binding(binding);const frame=await this.snapshot();
        if(automatic&&(!frame.captchaStateKnown||frame.captchaDetected||this.inputHeld||this.inputInFlight))return false;
        if(this.driver.resumeAutoClose?.()===false)throw Error('自动任务已停止，原页面保留供人工核对');
        this.manual=false;this.keepOpen=false;return true;
      },
      async waitForResume({receiptAccepted=false}={}) {while(this.manual||this.pauseRequested){this.check();if(receiptAccepted&&await this.observe({taskId:this.taskId,pageId:this.pageId},{automatic:true}))break;await new Promise(resolve=>setTimeout(resolve,100));}this.check();},
      async runAutomation(run) {while(this.manual||this.pauseRequested)await this.waitForResume();this.check();this.activeSteps++;try{return await run();}finally{this.activeSteps--;}},
      async assertInput(binding,method,value) {
        this.binding(binding);if(!this.manual)throw Error('captcha observe mode');
        if(method==='Input.dispatchMouseEvent') {
          const [width,height]=this.driver.window.getContentSize?.()||[4096,4096];
          if(!['mousePressed','mouseMoved','mouseReleased','mouseWheel'].includes(value.type)||![value.x,value.y].every(Number.isFinite)||value.x<0||value.y<0||value.x>=width||value.y>=height||(value.button&&!['left','right','middle','none'].includes(value.button)))throw Error('outside page range');
        } else if(method==='Input.insertText') {
          if(typeof value.text!=='string'||!value.text.length||value.text.length>10000||/\0/.test(value.text))throw Error('page text invalid');
        } else if(method==='Input.dispatchKeyEvent') {
          if(!['keyDown','keyUp'].includes(value.type))throw Error('page key invalid');
        } else throw Error('unsupported captcha input');
        this.check();
      },
      cancel(error) {
        if(this.closed)return;this.close();
        const reason=error instanceof Error?error:Error('captcha handoff interrupted');reason.code='CAPTCHA_HANDOFF_INTERRUPTED';context.cancel(reason);
      },
      close() {
        if(this.closed)return;this.closed=true;this.manual=false;clearInterval(this.timer);
        if(this.keepOpen&&!this.driver.window.isDestroyed?.())registry.retained.set(this.accountId,this);
        this.driver.window.removeListener?.('closed',this.onClosed);
        if(registry.pages.get(this.accountId)===this)registry.pages.delete(this.accountId);
      }
    };
    page.onClosed=()=>page.close();this.pages.set(context.accountId,page);
    try {page.check();} catch(error) {page.close();throw error;}
    page.driver.window.once?.('closed',page.onClosed);
    page.timer=setInterval(()=>{if(!page.inspecting) {page.inspecting=true;page.snapshot().catch(()=>{}).finally(()=>{page.inspecting=false;});}},500);page.timer.unref?.();
    return page;
  }
  borrow(target) {
    const page=this.pages.get(target?.accountId);if(!page)throw Error('delivery page missing');
    if(identityKeys.some(key=>target[key]!==page[key])||(target.taskId!==undefined&&target.taskId!==page.taskId)||(target.pageId!==undefined&&target.pageId!==page.pageId))throw Error('delivery identity mismatch');
    page.check();return page;
  }
  closeAll() {for(const page of [...this.pages.values()])page.close();}
}
module.exports={ActiveDeliveryPages};
