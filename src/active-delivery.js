"use strict";
const {randomUUID}=require('node:crypto');
const identityKeys=['accountId','operationId','batchId','environmentVersion','executorSessionId'];
const captchaKeys=new Set(['Enter','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End']);

// References are borrowed from the sender. Only the sender can close its page.
class ActiveDeliveryPages {
  constructor() {this.pages=new Map();}
  register(context) {
    if([...identityKeys,'taskId','draftId'].some(key=>typeof context[key]!=='string'||!context[key])||!context.driver?.window||!context.checkLease||!context.cancel)throw Error('invalid delivery page');
    if(this.pages.has(context.accountId))throw Error('delivery page already owned');
    const registry=this;
    const page={...context,pageId:randomUUID(),driver:context.driver,stage:'preparing',captchaSeen:false,manual:false,closed:false,captcha:null,
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
          if(this.captcha?.id!==value.id)this.manual=false;
          this.captcha={id:value.id,rect:{x:r.x,y:r.y,width:r.width,height:r.height},focused:value.focused===true};this.captchaSeen=true;
        } else {this.captcha=null;this.manual=false;}
        return {operationId:this.operationId,batchId:this.batchId,taskId:this.taskId,pageId:this.pageId,
          stage:detected?(this.manual?'manual_captcha':'captcha_required'):this.stage,captchaDetected:detected,...(this.captcha?{captcha:this.captcha}:{})};
      },
      binding(value) {
        this.check();if(!value||value.taskId!==this.taskId||value.pageId!==this.pageId)throw Error('delivery binding mismatch');
      },
      async takeover(binding) {
        this.binding(binding);await this.snapshot();
        if(!this.captcha||this.captcha.id!==binding.captchaId)throw Error('captcha binding mismatch');
        this.manual=true;
      },
      async observe(binding) {
        this.binding(binding);await this.snapshot();
        if(!this.captcha||this.captcha.id!==binding.captchaId)throw Error('captcha binding mismatch');
        this.manual=false;
      },
      async assertInput(binding,method,value) {
        this.binding(binding);if(!this.manual)throw Error('captcha observe mode');
        await this.snapshot(method==='Input.dispatchMouseEvent'?{x:value.x,y:value.y}:undefined);
        if(!this.manual||!this.captcha||binding.captchaId!==this.captcha.id)throw Error('captcha binding mismatch');
        if(method==='Input.dispatchMouseEvent') {
          const r=this.captcha.rect;
          if(!['mousePressed','mouseMoved','mouseReleased','mouseWheel'].includes(value.type)||![value.x,value.y].every(Number.isFinite)||value.x<r.x||value.y<r.y||value.x>=r.x+r.width||value.y>=r.y+r.height||(value.button&&value.button!=='left'))throw Error('outside captcha range');
        } else if(method==='Input.insertText') {
          if(!this.captcha.focused||typeof value.text!=='string'||!value.text.length||value.text.length>256||/[\0\r\n]/.test(value.text))throw Error('captcha focus or text invalid');
        } else if(method==='Input.dispatchKeyEvent') {
          if(!this.captcha.focused||!['keyDown','keyUp'].includes(value.type)||!captchaKeys.has(value.key)||(value.modifiers??0)!==0)throw Error('captcha focus or key invalid');
        } else throw Error('unsupported captcha input');
        this.check();
      },
      cancel(error) {
        if(this.closed)return;this.close();
        const reason=error instanceof Error?error:Error('captcha handoff interrupted');reason.code='CAPTCHA_HANDOFF_INTERRUPTED';context.cancel(reason);
      },
      close() {
        if(this.closed)return;this.closed=true;this.manual=false;clearInterval(this.timer);
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
