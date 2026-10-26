"use strict";
// Synthetic, ephemeral localhost proxy only. Run with Electron, never a real account/config.
const {app,BrowserWindow,session,net}=require('electron');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {StudioEnvironment}=require('../src/studio-environment');
const root=process.env.STUDIO_ENV_SMOKE_DIR;
if(!root||!['/smoke/account-environments-20261026','/smoke/account-defaults-20261026'].some(suffix=>root.endsWith(suffix)))throw Error('dedicated smoke directory required');
app.setPath('userData',path.join(root,'browser-state'));app.setPath('sessionData',path.join(root,'browser-state'));
const token='synthetic-smoke-token';
function environment(label,port,version='v1') {
 const value={proxy:{mode:'custom',url:`http://${label}:synthetic-only@127.0.0.1:${port}`},fingerprint:{seed:label==='alpha'?'abc123':'def456',language:label==='alpha'?'zh-CN':'en-US',timezone:label==='alpha'?'Asia/Shanghai':'America/New_York',screen:{width:label==='alpha'?1920:1600,height:label==='alpha'?1080:900}}};
 const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update('doubao-account-env-v1:'+token).digest(),iv),data=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);
 return {version,encrypted:{iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')}};
}
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const summary={runtime:process.versions,uid:process.getuid(),checks:{}};
const servers=[],windows=[];
(async()=>{
 await app.whenReady();
 let directHits=0;
 const direct=http.createServer((_req,res)=>{directHits++;res.end('direct fallback must not happen');});servers.push(direct);const directPort=await listen(direct);
 const requests=[];
 const proxy=http.createServer((req,res)=>{
  const auth=req.headers['proxy-authorization'];
  const label=['alpha','beta'].find(user=>auth==='Basic '+Buffer.from(user+':synthetic-only').toString('base64'));
  if(!label){res.writeHead(407,{'Proxy-Authenticate':'Basic realm="isolated-smoke"','Connection':'close'});res.end();return;}
  requests.push({account:label,url:req.url,cookie:req.headers.cookie||''});
  if(req.url.startsWith('https://')||req.url.includes('myip.ipip.net')){res.end(`当前 IP：192.0.2.${label==='alpha'?10:20} 来自于：测试 地区 城市`);return;}
  res.writeHead(200,{'content-type':'text/html','Set-Cookie':`account_marker=${label}; Path=/; SameSite=Lax`});
  res.end(`<script>window.firstScript={language:navigator.language,languages:navigator.languages,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,screen:[screen.width,screen.height],ua:navigator.userAgent,cpu:navigator.hardwareConcurrency,cookie:document.cookie,identity:'${label}'};</script><body style="height:3000px">Controlled ${label}<input id="text"></body>`);
 });servers.push(proxy);const port=await listen(proxy);
 const manager=new StudioEnvironment({app,session,net,token,probe:async facade=>{
  const response=await facade.fetch('http://myip.ipip.net/',{signal:AbortSignal.timeout(5000)});
  const text=await response.text();return {ok:response.ok,ip:text.match(/192\.0\.2\.\d+/)?.[0],source:'controlled-localhost-proxy',location:'synthetic',latency:0};
 }});
 const profilesFile=path.join(root,'persisted-profiles.json'),previousProfiles=fs.existsSync(profilesFile)?JSON.parse(fs.readFileSync(profilesFile,'utf8')):null,profiles={};
 const accounts=[];
 for(const label of ['alpha','beta']) {
  const inst={id:label,partition:'persist:smoke-account-'+label};manager.configure(inst,environment(label,port));
  profiles[label]=inst.fingerprint;if(previousProfiles){assert.deepEqual(inst.fingerprint,previousProfiles[label]);summary.checks.profileAcrossProcessRestart=true;}
  const ses=await manager.prepareStudioSession(inst);
  const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{partition:inst.partition,sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(win);
  await win.loadURL('about:blank');await manager.prepareStudioWindow(win,inst);
  await win.loadURL('http://127.0.0.1:'+directPort+'/first');
  const actual=await win.webContents.executeJavaScript('window.firstScript');
  assert.equal(actual.language,inst.fingerprint.language);assert.equal(actual.timezone,inst.fingerprint.timezone);assert.deepEqual(actual.screen,[inst.fingerprint.screen.width,inst.fingerprint.screen.height]);assert.equal(actual.identity,label);assert.equal(actual.ua,inst.fingerprint.userAgent);
  const cookies=await ses.cookies.get({url:'http://127.0.0.1:'+directPort+'/'});assert.equal(cookies.find(c=>c.name==='account_marker').value,label);
  await win.loadURL('http://127.0.0.1:'+directPort+'/second');const second=await win.webContents.executeJavaScript('window.firstScript');assert.equal(second.cookie,'account_marker='+label);
  const check=await manager.check(inst,win.webContents);assert.equal(check.fingerprint.ok,true);assert.equal(check.fingerprint.capabilities.webgl,false);assert.equal(check.proxy.ok,true);assert.equal(check.proxy.ip,label==='alpha'?'192.0.2.10':'192.0.2.20');
  // Fingerprint probe includes WebGL; software rendering may expose unavailable fields. Record exact result.
  summary[label]={firstScript:actual,proxy:check.proxy,fingerprint:check.fingerprint,comparison:require('../src/fp-check').compare(inst.fingerprint,await require('../src/fp-check').read({webContents:win.webContents}))};
  fs.writeFileSync(path.join(root,label+'.jpg'),(await win.webContents.capturePage()).toJPEG(70));
  accounts.push({inst,ses,win});
 }
 assert.notEqual(accounts[0].ses,accounts[1].ses);
 assert.equal(requests.some(r=>r.account==='alpha'&&r.cookie.includes('beta')),false);assert.equal(requests.some(r=>r.account==='beta'&&r.cookie.includes('alpha')),false);
 summary.checks.distinctSessionsAndCookies=true;summary.checks.sameGatewayDifferentCredentials=true;summary.checks.firstTargetScriptFingerprint=true;
 const persisted=JSON.parse(JSON.stringify(accounts[0].inst));const restored=new StudioEnvironment({app,session,net,token});restored.configure(persisted,environment('alpha',port));assert.deepEqual(persisted.fingerprint,accounts[0].inst.fingerprint);summary.checks.profileSerializationStable=true;
 const unused=http.createServer();const badPort=await listen(unused);await new Promise(resolve=>unused.close(resolve));
 const bad={id:'bad',partition:'persist:smoke-bad'};manager.configure(bad,environment('alpha',badPort));await manager.prepareStudioSession(bad);
 const badWin=new BrowserWindow({show:false,webPreferences:{partition:bad.partition,sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(badWin);await badWin.loadURL('about:blank');await manager.prepareStudioWindow(badWin,bad);
 await assert.rejects(badWin.loadURL('http://127.0.0.1:'+directPort+'/must-fail'));
 await assert.rejects(manager.request(session.fromPartition(bad.partition),manager.state(bad).proxy,'http://127.0.0.1:'+directPort+'/must-fail'));
 assert.equal(directHits,0);summary.checks.failedProxyNoDirectFallback=true;summary.checks.directHits=directHits;
 const tlsProxy=require('node:https').createServer({key:fs.readFileSync(path.join(root,'proxy-key.pem')),cert:fs.readFileSync(path.join(root,'proxy-cert.pem'))},proxy.listeners('request')[0]);servers.push(tlsProxy);
 const tlsPort=await listen(tlsProxy),tlsInst={id:'tls',partition:'persist:smoke-tls'};
 const tlsEnv=environment('alpha',tlsPort,'tls-v1');
 const decrypted=require('../src/studio-environment').decryptEnvironment(tlsEnv,token);decrypted.proxy.url=decrypted.proxy.url.replace('http:','https:');
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update('doubao-account-env-v1:'+token).digest(),iv);
 const encryptedData=Buffer.concat([cipher.update(JSON.stringify(decrypted)),cipher.final()]);tlsEnv.encrypted={iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encryptedData.toString('base64')};
 manager.configure(tlsInst,tlsEnv);const tlsSession=await manager.prepareStudioSession(tlsInst);
 // Test untrusted TLS rejection without changing host or session certificate trust.
 // Keep certificate verification intact: the untrusted synthetic proxy must fail.
 const tlsWin=new BrowserWindow({show:false,webPreferences:{partition:tlsInst.partition,sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(tlsWin);await tlsWin.loadURL('about:blank');await manager.prepareStudioWindow(tlsWin,tlsInst);
 try {await tlsWin.loadURL('http://account-env.test/tls');assert.equal((await tlsWin.webContents.executeJavaScript('window.firstScript')).identity,'alpha');summary.checks.httpsProxyAuthentication=true;} catch(error){assert.match(error.message,/ERR_PROXY_CERTIFICATE_INVALID/);summary.checks.httpsUntrustedCertificateRejected=true;summary.checks.httpsProxyAuthentication=false;summary.httpsError=error.message;}
 const socks=require('node:net').createServer(socket=>{
  let stage=0,buffer=Buffer.alloc(0);
  socket.on('error',()=>{});socket.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   if(stage===0){if(buffer.length<2||buffer.length<2+buffer[1])return;socket.write(Buffer.from([5,0]));buffer=buffer.subarray(2+buffer[1]);stage=1;}
   if(stage===1){if(buffer.length<5)return;const length=buffer[3]===1?10:buffer[3]===3?7+buffer[4]:22;if(buffer.length<length)return;buffer=buffer.subarray(length);socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));stage=2;}
   if(stage===2&&buffer.includes(Buffer.from('\r\n\r\n'))){const body='<script>window.socksOk=true;</script>';socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: '+Buffer.byteLength(body)+'\r\nConnection: close\r\n\r\n'+body);stage=3;}
  });
 });servers.push(socks);const socksPort=await listen(socks),socksInst={id:'socks',partition:'persist:smoke-socks'};
 const socksValue={proxy:{mode:'custom',url:'socks5://127.0.0.1:'+socksPort},fingerprint:decrypted.fingerprint};const siv=crypto.randomBytes(12),sc=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update('doubao-account-env-v1:'+token).digest(),siv),sd=Buffer.concat([sc.update(JSON.stringify(socksValue)),sc.final()]);manager.configure(socksInst,{version:'socks-v1',encrypted:{iv:siv.toString('base64'),tag:sc.getAuthTag().toString('base64'),data:sd.toString('base64')}});await manager.prepareStudioSession(socksInst);
 const socksWin=new BrowserWindow({show:false,webPreferences:{partition:socksInst.partition,sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(socksWin);await socksWin.loadURL('about:blank');await manager.prepareStudioWindow(socksWin,socksInst);await socksWin.loadURL('http://account-env.test/socks');assert.equal(await socksWin.webContents.executeJavaScript('window.socksOk'),true);summary.checks.socks5Anonymous=true;
 let explicitDirectHits=0;
 const serverExit=http.createServer((req,res)=>{explicitDirectHits++;if(req.url==='/ip'){res.end('192.0.2.30');return;}res.writeHead(200,{'Content-Type':'text/html','Set-Cookie':'direct_marker=server; Path=/; SameSite=Lax'});res.end('<script>window.serverExit={language:navigator.language,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,cookie:document.cookie};</script>');});servers.push(serverExit);
 const exitPort=await listen(serverExit),exitUrl='http://127.0.0.1:'+exitPort;
 for(const [index,account] of accounts.entries())await account.ses.cookies.set({url:exitUrl+'/page',name:'other_account_only',value:String(index),path:'/page'});
 const directEnvironment=version=>{const value={proxy:{mode:'direct'},fingerprint:decrypted.fingerprint},iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update('doubao-account-env-v1:'+token).digest(),iv),data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return {version,encrypted:{iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}};};
 const directManager=new StudioEnvironment({app,session,net,token,probe:async(facade,options)=>{assert.equal(options.mode,'direct');assert.equal(await facade.resolveProxy(exitUrl+'/ip'),'DIRECT');const response=await facade.fetch(exitUrl+'/ip',{signal:AbortSignal.timeout(5000)});return {ok:response.ok,ip:await response.text()};}});
 const directInst={id:'explicit-direct',partition:'persist:smoke-explicit-direct'};directManager.configure(directInst,directEnvironment('direct-v1'));const directSession=await directManager.prepareStudioSession(directInst);
 const directWin=new BrowserWindow({show:false,webPreferences:{partition:directInst.partition,sandbox:true,contextIsolation:true,nodeIntegration:false}});windows.push(directWin);await directWin.loadURL('about:blank');await directManager.prepareStudioWindow(directWin,directInst);await directWin.loadURL(exitUrl+'/page');
 const directActual=await directWin.webContents.executeJavaScript('window.serverExit');assert.equal(directActual.language,directInst.fingerprint.language);assert.equal(directActual.timezone,directInst.fingerprint.timezone);assert.match(directActual.cookie,/direct_marker=server/);assert.equal(directActual.cookie.includes('other_account_only'),false);
 const directCheck=await directManager.check(directInst,directWin.webContents);assert.equal(directCheck.proxy.ip,'192.0.2.30');assert.equal(directCheck.fingerprint.ok,true);
 directManager.configure(directInst,environment('alpha',port,'direct-custom-v2'));await directManager.prepareStudioSession(directInst);await directWin.loadURL(exitUrl+'/proxied');assert.equal((await directWin.webContents.executeJavaScript('window.firstScript')).identity,'alpha');
 const proxiedRequests=requests.length;directManager.configure(directInst,directEnvironment('direct-v3'));await directManager.prepareStudioSession(directInst);await directWin.loadURL(exitUrl+'/returned');assert.equal(await directSession.resolveProxy(exitUrl),'DIRECT');assert.equal(requests.length,proxiedRequests);assert.ok(explicitDirectHits>=3);
 summary.checks.explicitServerEgress=true;summary.checks.directCustomRoundtrip=true;summary.checks.directFirstScriptFingerprint=true;summary.checks.directAccountCookieIsolation=true;
 fs.writeFileSync(profilesFile,JSON.stringify(profiles,null,2));
 summary.ok=true;fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
})().catch(error=>{summary.ok=false;summary.error=String(error.stack);fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(summary,null,2));console.error(error);process.exitCode=1;}).finally(()=>{for(const win of windows)if(!win.isDestroyed())win.destroy();for(const server of servers)server.close();app.quit();});
