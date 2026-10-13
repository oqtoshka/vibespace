import assert from 'node:assert/strict';
import test from 'node:test';

import { registerTaskLedgerSource } from '../../../shared/index.js';
import { BriefingOutputPolicy } from '../index.js';

for (const provider of ['claude', 'opencode', 'cursor'] as const) {
  test(`${provider}: prose rejected after valid card; tools/errors/user retained; one repair only`, () => {
    const unregister = registerTaskLedgerSource(c => c.provider === provider ? { listName:'card', guidance:'', open:[], activity:0, agentTextPolicy:'reject' } : null);
    try {
      const gate = new BriefingOutputPolicy(provider, {}); gate.begin('main', 'actual request');
      for (const kind of ['tool_use','tool_result','permission_request','error','status','thinking']) assert.equal(gate.accepts({kind,content:'retained'}),true);
      assert.equal(gate.accepts({kind:'text',role:'user',content:'human'}),true);
      assert.equal(gate.accepts({kind:'text',role:'assistant',content:'forbidden'}),false);
      assert.equal(gate.accepts({kind:'stream_delta',content:'forbidden delta'}),false);
      assert.ok(gate.complete().prompt);
      gate.begin('main', 'repair');
      assert.equal(gate.accepts({kind:'text',role:'assistant',content:'again'}),false);
      assert.match(gate.complete().failure!, /AGENT_TEXT_POLICY_VIOLATION/);
    } finally { unregister(); }
  });
  test(`${provider}: source published after initial start admits before first output, preserving turn identity`, () => {
    let present=false; const ids: string[]=[];
    const unregister=registerTaskLedgerSource(c => { if(c.provider!==provider)return null; ids.push(c.turnId!); return present ? {listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject'} : null; });
    try { const gate=new BriefingOutputPolicy(provider,{});gate.begin('native','request'); present=true;assert.equal(gate.accepts({kind:'text',role:'assistant',content:'late'}),false);assert.equal(new Set(ids).size,1); }finally{unregister();}
  });
  test(`${provider}: steer cannot renew a used repair budget and admitted scope survives a source failure`, () => {
    let available = true;
    const unregister = registerTaskLedgerSource(() => {
      if (!available) throw new Error('fixture unavailable');
      return { listName: 'card', guidance: '', open: [], activity: 0, agentTextPolicy: 'reject' };
    });
    try {
      const gate = new BriefingOutputPolicy(provider, {});
      gate.begin('native', 'first human request');
      assert.equal(gate.accepts({ kind: 'text', content: 'first violation' }), false);
      assert.ok(gate.complete().prompt);
      available = false;
      gate.begin('native', 'accepted steer');
      assert.equal(gate.accepts({ kind: 'text', content: 'repeat violation' }), false);
      assert.match(gate.complete().failure!, /AGENT_TEXT_POLICY_VIOLATION/);
    } finally { unregister(); }
  });
  for(const options of [{ephemeral:true},{backgroundHelper:true},{sideSession:{id:'side'}}]) test(`${provider}: helper/side inert ${JSON.stringify(options)}`,()=> {
    const unregister=registerTaskLedgerSource(()=>({listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject',completion:{turnId:'x',prompt:'missing'}}));
    try{const gate=new BriefingOutputPolicy(provider,options);gate.begin('native','request');assert.equal(gate.accepts({kind:'text',role:'assistant',content:'allowed'}),true);assert.deepEqual(gate.complete(),{});}finally{unregister();}
  });
  test(`${provider}: missing checkpoint cannot end successfully after repair`,()=>{
    const unregister=registerTaskLedgerSource(()=>({listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject',completion:{turnId:'x',prompt:'reply both threads'}}));
    try{const gate=new BriefingOutputPolicy(provider,{});gate.begin('native','request');assert.match(gate.complete().prompt!,/reply both threads/);assert.match(gate.complete().failure!,/AGENT_TEXT_POLICY_VIOLATION/);}finally{unregister();}
  });
}
