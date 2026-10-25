"use strict";

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const VERSION = 'doubao-workbench/1';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function privateSnapshot(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => ['downloadUrl', 'text', 'input'].includes(key) ? undefined : item));
}
function identity(op) {
  // Signed download URLs rotate; login input must never be written to disk.
  return hash(JSON.stringify(privateSnapshot({id:op.id,kind:op.kind,accountId:op.accountId,taskId:op.taskId,batchId:op.batchId,payload:op.payload})));
}
function validateOperation(op) {
  if (!op || !op.id || !op.accountId || !op.leaseToken || !['import','send','track','account'].includes(op.kind)) throw new Error('invalid operation');
  if (op.payload?.account?.id !== op.accountId) throw new Error('account identity mismatch');
}
class Journal {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), {recursive:true, mode:0o700});
    this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {operations:{},tasks:{}};
    if (!this.data.operations || !this.data.tasks) throw new Error('invalid journal; recovery requires original journal');
  }
  save() {
    const tmp = this.file + '.tmp', fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    if (process.platform !== 'win32') { const dir=fs.openSync(path.dirname(this.file),'r'); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);} }
  }
  get(id) { return this.data.operations[id]; }
  begin(op) {
    validateOperation(op);
    const existing=this.get(op.id), fingerprint=identity(op);
    if(existing && existing.fingerprint!==fingerprint) throw new Error('operation identity mismatch');
    if(existing) {
      // A fresh read-only lease permits another check of the original task,
      // including when the old lease's response was rejected after an outage.
      if(op.kind==='track' && existing.operation.leaseToken!==op.leaseToken) {
        (existing.priorLeases ||= []).push({leaseToken:existing.operation.leaseToken,result:existing.result,reported:existing.reported,quarantined:existing.quarantined});
        delete existing.result;delete existing.quarantined;existing.state='started';existing.reported=false;
      }
      existing.operation.leaseToken=op.leaseToken;existing.operation.leaseUntil=op.leaseUntil;this.save();return existing;
    }
    this.data.operations[op.id]={state:'started', fingerprint, operation:privateSnapshot(op), reported:false}; this.save(); return this.get(op.id);
  }
  finish(id,result) { const entry=this.get(id); entry.result=result;entry.state='done';this.save(); }
  reported(id) { this.get(id).reported=true;this.save(); }
  task(id) { return this.data.tasks[id]; }
  bindTask(id,patch) { this.data.tasks[id]={...this.task(id),...patch};this.save();return this.task(id); }
  pending() { return Object.values(this.data.operations).filter(e=>!e.reported && !e.quarantined); }
}
class StudioClient {
  constructor(opts) {
    this.site=new URL(opts.siteUrl);
    if(this.site.username || this.site.password || this.site.search || this.site.hash || this.site.pathname!=='/') throw new Error('siteUrl must be a clean origin');
    const host=this.site.hostname.replace(/^\[|\]$/g,''),interfaces=opts.networkInterfaces||require('node:os').networkInterfaces;
    const assignedLocalHttp=opts.allowLocalHttp===true && require('node:net').isIP(host) && Object.values(interfaces()).flat().some(item=>item?.address===host);
    if(this.site.protocol!=='https:' && !(this.site.protocol==='http:' && (['localhost','127.0.0.1','::1'].includes(host)||assignedLocalHttp))) throw new Error('HTTPS site required');
    if(!opts.executorId || !opts.token || /[\r\n]/.test(opts.token)) throw new Error('executor credentials required');
    this.sessionId=opts.sessionId||crypto.randomUUID();
    this.executorId=opts.executorId;this.token=opts.token;this.fetch=opts.fetch||globalThis.fetch;
    this.maxResultBytes=Math.min(opts.maxResultBytes||128*1024*1024,128*1024*1024);
  }
  headers(extra={}) { return {authorization:`Bearer ${this.token}`,...extra}; }
  async json(action,body={}) {
    const response=await this.fetch(new URL('/api/studio/doubao/executor',this.site),{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:this.headers({'content-type':'application/json'}),body:JSON.stringify({action,executorId:this.executorId,version:VERSION,...body})});
    if(!response.ok) {const error=new Error(`studio ${action} HTTP ${response.status}`);error.status=response.status;throw error;}
    return response.json();
  }
  heartbeat(leases) { return this.json('heartbeat',{leases,sessionId:this.sessionId}); }
  claim() { return this.json('claim'); }
  report(op,result) { return this.json('report',{operationId:op.id,leaseToken:op.leaseToken,...result}); }
  async upload(taskId,op,file) {
    const stat=fs.statSync(file);
    const invalid=message=>{const error=new Error(message);error.permanent=true;return error;};
    if(!stat.isFile() || stat.size<12 || stat.size>this.maxResultBytes) throw invalid('invalid MP4 size');
    const body=fs.readFileSync(file);if(body.toString('ascii',4,8)!=='ftyp') throw invalid('invalid MP4 signature');
    const url=new URL('/api/studio/doubao/executor/result',this.site);url.searchParams.set('taskId',taskId);
    const response=await this.fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(120000),headers:this.headers({'content-type':'video/mp4','x-doubao-executor-id':this.executorId,'x-doubao-operation-id':op.id,'x-doubao-lease-token':op.leaseToken,'x-doubao-sha256':hash(body)}),body});
    if(!response.ok) {const error=new Error(`studio upload HTTP ${response.status}`);error.status=response.status;throw error;}
    return response.json();
  }
}
const imageExtensions={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif'};
function validImage(data,mime) {
  if(mime==='image/png') return data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if(mime==='image/jpeg') return data[0]===255 && data[1]===216 && data[2]===255;
  if(mime==='image/webp') return data.toString('ascii',0,4)==='RIFF' && data.toString('ascii',8,12)==='WEBP';
  return /^GIF8[79]a$/.test(data.toString('ascii',0,6));
}
async function downloadReferences(refs,directory,client) {
  if(!Array.isArray(refs) || refs.length>20) throw new Error('invalid image references');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});const files=[];
  for(const ref of refs) {
    const extension=imageExtensions[ref.contentType];
    if(!extension) throw new Error('unsupported image content type');
    if(!Number.isSafeInteger(ref.byteSize) || ref.byteSize<1 || ref.byteSize>20*1024*1024 || !/^[a-f0-9]{64}$/i.test(ref.sha256)) throw new Error('invalid image size or hash');
    const url=new URL(ref.downloadUrl,client.site);
    if(url.origin!==client.site.origin || url.username || url.password) throw new Error('reference origin mismatch');
    const target=path.join(directory,`${files.length}-${ref.sha256}${extension}`);
    let data=fs.existsSync(target)?fs.readFileSync(target):null;
    if(!data) {
      const response=await client.fetch(url,{redirect:'error',signal:AbortSignal.timeout(60000),headers:client.headers()});
      if(!response.ok) throw new Error(`reference HTTP ${response.status}`);
      if(response.headers.get('content-type')?.split(';')[0]!==ref.contentType) throw new Error('image content type mismatch');
      const declared=Number(response.headers.get('content-length'));
      if(declared>ref.byteSize) throw new Error('image size mismatch');
      const chunks=[];let size=0;
      for await(const chunk of response.body) {size+=chunk.length;if(size>ref.byteSize) throw new Error('image size mismatch');chunks.push(chunk);}
      data=Buffer.concat(chunks);
    }
    if(data.length!==ref.byteSize) throw new Error('image size mismatch');
    if(hash(data)!==ref.sha256.toLowerCase()) throw new Error('image hash mismatch');
    if(!validImage(data,ref.contentType)) throw new Error('invalid image signature');
    fs.writeFileSync(target,data,{mode:0o600});
    files.push({id:ref.id,name:String(ref.filename||ref.id),path:target,mime:ref.contentType,size:data.length});
  }
  return files;
}
class StudioBridge {
  constructor({journal,api,adapter,operationConcurrency=2,pollMs=2000,onError=()=>{},now=()=>performance.now()}) {
    this.journal=journal;this.api=api;this.adapter=adapter;this.active=new Map();this.progressReports=new Map();
    this.operationConcurrency=Math.max(1,Math.min(4,operationConcurrency));this.pollMs=pollMs;this.onError=onError;this.now=now;this.leaseDeadlines=new Map();this.leaseTokens=new Map();
  }
  observeLease(op,serverTime,requestStarted=this.now(),until=op.leaseUntil) {
    const deadline=typeof until==='number'?until:Date.parse(until);
    const remaining=Number.isFinite(serverTime)?deadline-serverTime:deadline-Date.now();
    this.leaseDeadlines.set(op.id,requestStarted+Math.max(0,remaining));
    this.leaseTokens.set(op.id,op.leaseToken);
  }
  checkLease(id) {
    if(!Number.isFinite(this.leaseDeadlines.get(id)) || this.now()>=this.leaseDeadlines.get(id))throw new Error('studio operation lease expired; no new side effects allowed');
  }
  async heartbeat() {
    const started=this.now();
    const response=await this.api.heartbeat(this.journal.pending().map(e=>({operationId:e.operation.id,leaseToken:e.operation.leaseToken})));
    if(Number.isFinite(response.serverTime))for(const renewed of response.leases||[]) {
      const entry=this.journal.get(renewed.operationId);
      if(entry && !entry.quarantined)this.observeLease(entry.operation,response.serverTime,started,renewed.leaseUntil);
    }
    for(const id of this.active.keys()) {
      const entry=this.journal.get(id),previous=this.progressReports.get(id);
      if(entry?.state!=='started' || previous?.inFlight)continue;
      const result=this.adapter.progress?.(entry.operation);
      if(!result)continue;
      const fingerprint=JSON.stringify(result);
      if(previous?.fingerprint===fingerprint)continue;
      const state={fingerprint,inFlight:true};
      state.promise=this.api.report(entry.operation,result).catch(()=>{this.progressReports.delete(id);this.onError('progress_report_pending');}).finally(()=>{state.inFlight=false;});
      this.progressReports.set(id,state);await state.promise;
    }
    return response;
  }
  async processOperation(op) {
    if(this.leaseTokens.get(op.id)!==op.leaseToken)this.observeLease(op);
    const previous=this.journal.get(op.id), entry=this.journal.begin(op);
    if(entry.quarantined)return entry.result;
    if(!entry.result) {
      let result;
      try {
        const context={checkLease:()=>this.checkLease(op.id)};
        result=previous ? await this.adapter.recover?.(op,context) : await this.adapter.execute(op,context);
        result ||= {outcome:'uncertain',receipt:{error:'interrupted operation requires manual review'}};
      } catch (error) {
        if(error.retryable) throw error;
        result={outcome:'uncertain',receipt:{error:'executor operation interrupted; inspect original task'}};
      }
      this.journal.finish(op.id,result);
    }
    await this.progressReports.get(op.id)?.promise;
    try {await this.api.report(op,entry.result);} catch(error) {
      if(error.status===409){entry.quarantined=true;this.journal.save();}
      throw error;
    }
    this.journal.reported(op.id);this.progressReports.delete(op.id);
    return entry.result;
  }
  async flushReports() {
    for(const entry of this.journal.pending()) {
      if(this.active.has(entry.operation.id)) continue;
      // On restart, only inspect durable bindings; never replay a browser action.
      try {await this.processOperation(entry.operation);} catch {this.onError('operation_report_pending');}
    }
  }
  async run(signal) {
    const heartbeat=setInterval(()=>this.heartbeat().catch(()=>this.onError('heartbeat_failed')),15000);
    try {
      while(!signal.aborted) {
        try {
          await this.heartbeat();await this.flushReports();
          if(this.active.size<this.operationConcurrency) {
            const started=this.now(),{operation,serverTime}=await this.api.claim();
            if(operation && !this.active.has(operation.id)) {
              this.observeLease(operation,serverTime,started);
              const pending=this.processOperation(operation).catch(()=>this.onError('operation_report_pending')).finally(()=>this.active.delete(operation.id));
              this.active.set(operation.id,pending);
            }
          }
        } catch { this.onError('poll_failed'); }
        await delay(this.pollMs,undefined,{signal}).catch(()=>{});
      }
    } finally { clearInterval(heartbeat);await Promise.allSettled(this.active.values()); }
  }
}
module.exports={VERSION,Journal,StudioClient,StudioBridge,downloadReferences};
