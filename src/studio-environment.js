"use strict";
const crypto=require('node:crypto');
const {buildProfile}=require('./fingerprint');
const {buildPageScript}=require('./page');
const {testProxy}=require('./proxy-diagnostics');
const fpCheck=require('./fp-check');
function decryptEnvironment(encryptedEnvironment,token) {
  try {
    const {encrypted}=encryptedEnvironment||{};
    if(!encrypted || typeof encrypted.data!=='string' || encrypted.data.length>20000)throw Error();
    const iv=Buffer.from(encrypted.iv,'base64'),tag=Buffer.from(encrypted.tag,'base64');
    if(iv.length!==12 || tag.length!==16)throw Error();
    const key=crypto.createHash('sha256').update('doubao-account-env-v1:'+token).digest();
    const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data,'base64')),decipher.final()]).toString('utf8'));
  } catch {throw Error('invalid account environment');}
}
function parseConfig(environment,token) {
  const config=decryptEnvironment(environment,token);
  let proxy;
  try {
    if(!environment.version || config.proxy?.mode!=='custom')throw Error();
    const url=new URL(config.proxy.url),protocol=url.protocol.slice(0,-1),port=Number(url.port||(protocol==='https'?443:protocol==='http'?80:0));
    if(!['http','https','socks5'].includes(protocol)||!url.hostname||!Number.isSafeInteger(port)||port<1||port>65535||url.search||url.hash||!['','/'].includes(url.pathname))throw Error();
    proxy={protocol,host:url.hostname,port,username:decodeURIComponent(url.username),password:decodeURIComponent(url.password)};
    const f=config.fingerprint;
    if(!f||typeof f.seed!=='string'||!f.seed||f.seed.length>128||typeof f.language!=='string'||!f.language||f.language.length>40||typeof f.timezone!=='string')throw Error();
    new Intl.DateTimeFormat(f.language,{timeZone:f.timezone});
    if(!Number.isSafeInteger(f.screen?.width)||f.screen.width<1280||f.screen.width>7680||!Number.isSafeInteger(f.screen?.height)||f.screen.height<900||f.screen.height>4320)throw Error();
  } catch {throw Error('invalid account environment');}
  if(proxy.protocol==='socks5'&&(proxy.username||proxy.password))throw Error('SOCKS5 authentication is unsupported by Chromium');
  return {config,proxy};
}
function authenticate(proxy,info,callback) {
  if(info.isProxy && String(info.host).replace(/^\[|\]$/g,'').toLowerCase()===proxy.host.replace(/^\[|\]$/g,'').toLowerCase() && Number(info.port)===proxy.port)callback(proxy.username,proxy.password);
  else callback();
}
class StudioEnvironment {
  constructor({app,session,net,token,enhancer={},probe=testProxy}) {
    this.session=session;this.net=net;this.token=token;this.enhancer=enhancer;this.probe=probe;
    this.configs=new Map();this.sessions=new WeakMap();this.windows=new WeakSet();
    app.on('login',(event,wc,_details,info,callback)=>{
      const state=wc?.session && this.sessions.get(wc.session);
      if(!state)return;
      event.preventDefault();authenticate(state.proxy,info,callback);
    });
  }
  configure(inst,environment) {
    if(!environment) {
      if(!inst.studioEnvironment)throw Error('account environment is required');
      return; // Old in-flight work retains its original encrypted environment.
    }
    const {config,proxy}=parseConfig(environment,this.token);
    const digest=crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
    if(inst.studioEnvironment?.version===environment.version && inst.studioEnvironment.digest!==digest)throw Error('account environment version mismatch');
    if(inst.studioEnvironment?.version!==environment.version) {
      const f=config.fingerprint,profile=buildProfile(crypto.createHash('sha256').update(f.seed).digest('hex'));
      profile.seed=f.seed;profile.language=f.language;profile.languages=[f.language,f.language.split('-')[0]].filter((v,i,a)=>a.indexOf(v)===i);profile.locale=f.language;profile.timezone=f.timezone;
      profile.screen={...profile.screen,...f.screen,availWidth:f.screen.width,availHeight:f.screen.height-40};
      // Full persisted profile stays stable across restarts; update actual Chromium identity at application time.
      inst.fingerprint=profile;inst.studioEnvironment={version:environment.version,digest,encrypted:environment.encrypted};
    }
    if(process.versions.chrome) {
      const version=process.versions.chrome,major=version.split('.')[0],fp=inst.fingerprint;
      fp.userAgent=fp.userAgent.replace(/Chrome\/[\d.]+/,`Chrome/${major}.0.0.0`);fp.appVersion=fp.userAgent.replace('Mozilla/','');
      fp.uaData.uaFullVersion=version;
      for(const brand of fp.uaData.brands)if(['Chromium','Google Chrome'].includes(brand.brand))brand.version=major;
      for(const brand of fp.uaData.fullVersionList)if(['Chromium','Google Chrome'].includes(brand.brand))brand.version=version;
    }
    this.configs.set(inst.id,{version:environment.version,proxy});
  }
  state(inst) {
    if(!this.configs.has(inst.id))this.configure(inst,{version:inst.studioEnvironment?.version,encrypted:inst.studioEnvironment?.encrypted});
    return this.configs.get(inst.id);
  }
  async prepareStudioSession(inst) {
    const state=this.state(inst),ses=this.session.fromPartition(inst.partition),previous=this.sessions.get(ses);
    if(previous?.version===state.version)return ses;
    try {
      await ses.setProxy({mode:'fixed_servers',proxyRules:`${state.proxy.protocol}://${state.proxy.host}:${state.proxy.port}`,proxyBypassRules:'<-loopback>'});
      if(previous){await ses.closeAllConnections();await ses.clearAuthCache();}
      ses.setUserAgent(inst.fingerprint.userAgent,inst.fingerprint.languages.join(','));
      ses.webRequest.onBeforeSendHeaders((details,callback)=>{
        const headers={...details.requestHeaders},fp=inst.fingerprint;
        for(const key of Object.keys(headers))if(key.toLowerCase()==='accept-language')delete headers[key];
        headers['Accept-Language']=fp.languages.join(',');callback({requestHeaders:headers});
      });
      this.sessions.set(ses,state);return ses;
    } catch {throw Error('account proxy setup failed');}
  }
  async prepareStudioWindow(win,inst) {
    if(this.windows.has(win))return;
    const wc=win.webContents;
    if(!wc.debugger.isAttached())wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Page.enable');
    const fp=inst.fingerprint;
    await wc.debugger.sendCommand('Emulation.setUserAgentOverride',{userAgent:fp.userAgent,acceptLanguage:fp.languages.join(','),platform:fp.platform,userAgentMetadata:fp.uaData});
    await wc.debugger.sendCommand('Emulation.setTimezoneOverride',{timezoneId:fp.timezone});
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:buildPageScript({cfg:{profile:fp,instanceId:inst.id,kernel:'embedded',enhancer:this.enhancer}})});
    this.windows.add(win);
  }
  // Main-process requests have no webContents in app.login. Bind authentication directly to each request.
  request(ses,proxy,url,init={}) {
    return new Promise((resolve,reject)=>{
      const req=this.net.request({url,session:ses,redirect:'error',credentials:'include'});
      let attempts=0,done=false;
      const fail=()=>{if(!done){done=true;reject(Error('account probe request failed'));}req.abort();};
      if(init.signal?.aborted)return fail();
      init.signal?.addEventListener('abort',fail,{once:true});
      const clean=()=>init.signal?.removeEventListener('abort',fail);
      req.on('login',(info,callback)=>{if(++attempts>1)callback();else authenticate(proxy,info,callback);});
      req.on('error',()=>{clean();if(!done){done=true;reject(Error('account probe request failed'));}});
      req.on('response',response=>{
        const chunks=[];let size=0;
        response.on('data',chunk=>{size+=chunk.length;if(size>65536)fail();else chunks.push(chunk);});
        response.on('error',fail);
        response.on('end',()=>{clean();if(!done){done=true;resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,text:async()=>Buffer.concat(chunks).toString('utf8')});}});
      });
      for(const [key,value]of Object.entries(init.headers||{}))req.setHeader(key,value);
      req.end();
    });
  }
  async check(inst,wc) {
    const ses=await this.prepareStudioSession(inst),state=this.state(inst);
    const proxy=await this.probe({resolveProxy:url=>ses.resolveProxy(url),fetch:(url,init)=>this.request(ses,state.proxy,url,init)},{mode:'custom'});
    let fingerprint;
    try {
      const result=fpCheck.compare(inst.fingerprint,await fpCheck.read({instance:inst,webContents:wc}));
      const unavailable=result.items.some(item=>item.key==='webgl'&&item.actual==='no webgl');
      const items=result.items.map(item=>item.key==='webgl'&&unavailable?{key:item.key,status:'unsupported'}:{key:item.key,status:item.note?'unverified':item.ok?'passed':'failed'});
      fingerprint={ok:result.items.every(item=>item.ok||(item.key==='webgl'&&unavailable)),capabilities:{webgl:!unavailable},items,
        ...(unavailable?{message:'核心环境已校验；WebGL不可用，未校验该项'}:{}),profile:{seed:inst.fingerprint.seed,language:inst.fingerprint.language,timezone:inst.fingerprint.timezone,screen:{width:inst.fingerprint.screen.width,height:inst.fingerprint.screen.height},browserVersion:process.versions.chrome||'unknown'}};
    } catch {fingerprint={ok:false,message:'fingerprint inspection failed'};}
    return {proxy,fingerprint};
  }
}
module.exports={StudioEnvironment,decryptEnvironment};
