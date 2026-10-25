"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const executor=require('../src/server-executor');
const electronWithoutAppSwitch={commandLine:{getSwitchValue:()=>''}};
test('studio startup reads app arguments when Electron commandLine omits switches after application path',()=>{
  assert.equal(typeof executor.studioConfigFile,'function','missing application argument compatibility');
  const argv=['electron','/opt/doubao/current','--studio-executor','--studio-config','/private/executor.json'];
  assert.equal(executor.studioConfigFile(electronWithoutAppSwitch,argv,{DOUBAO_STUDIO_CONFIG:'/fallback/env.json'}),'/private/executor.json');
});
test('studio config keeps native switch and environment compatibility and accepts equals syntax',()=>{
  assert.equal(typeof executor.studioConfigFile,'function','missing application argument compatibility');
  assert.equal(executor.studioConfigFile({commandLine:{getSwitchValue:()=>'/native/config.json'}},['electron','--studio-config','/argv/config.json'],{DOUBAO_STUDIO_CONFIG:'/env/config.json'}),'/native/config.json');
  assert.equal(executor.studioConfigFile(electronWithoutAppSwitch,['electron','app','--studio-config=/private/equals.json'],{}),'/private/equals.json');
  assert.equal(executor.studioConfigFile(electronWithoutAppSwitch,['electron','app'],{DOUBAO_STUDIO_CONFIG:'/env/config.json'}),'/env/config.json');
});
test('studio startup rejects explicit config switch without a file rather than treating another switch as its path',()=>{
  assert.equal(typeof executor.studioConfigFile,'function','missing application argument compatibility');
  for(const argv of [['electron','app','--studio-config'],['electron','app','--studio-config','--studio-executor'],['electron','app','--studio-config=']])assert.throws(()=>executor.studioConfigFile(electronWithoutAppSwitch,argv,{DOUBAO_STUDIO_CONFIG:'/env/config.json'}),/private --studio-config file required/);
});
