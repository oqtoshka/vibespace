import assert from 'node:assert/strict';
import test from 'node:test';

import { registerTaskLedgerSource, registerAgentLaunchContributor } from '../../../shared/index.js';
import { BriefingOutputPolicy, BRIEFING_REPAIRS_PER_TURN } from '../index.js';

for (const provider of ['claude', 'opencode', 'cursor'] as const) {
  test(`${provider}: prose rejected after valid card; tools/errors/user retained; bounded repairs never fail`, () => {
    const unregister = registerTaskLedgerSource(c => c.provider === provider ? { listName:'card', guidance:'', open:[], activity:0, agentTextPolicy:'reject' } : null);
    try {
      const gate = new BriefingOutputPolicy(provider, {}); gate.begin('main', 'actual request');
      for (const kind of ['tool_use','tool_result','permission_request','error','status','thinking']) assert.equal(gate.accepts({kind,content:'retained'}),true);
      assert.equal(gate.accepts({kind:'text',role:'user',content:'human'}),true);
      assert.equal(gate.accepts({kind:'text',role:'assistant',content:'forbidden'}),false);
      assert.equal(gate.accepts({kind:'stream_delta',content:'forbidden delta'}),false);
      assert.ok(gate.complete().prompt);
      for (let i = 1; i < BRIEFING_REPAIRS_PER_TURN; i++) {
        gate.begin('main', 'repair');
        assert.equal(gate.accepts({kind:'text',role:'assistant',content:'again'}),false);
        const next = gate.complete();
        assert.ok(next.prompt); assert.doesNotMatch(next.prompt!, /ends this run|AGENT_TEXT_POLICY_VIOLATION/);
      }
      gate.begin('main', 'repair');
      assert.equal(gate.accepts({kind:'text',role:'assistant',content:'still'}),false, 'text stays dropped past the budget');
      const last = gate.complete() as Record<string, unknown>;
      assert.equal(last.failure, undefined); assert.equal(last.prompt, undefined); assert.match(String(last.exhausted), /stays open/);
      gate.resetRepairs();
      assert.equal(gate.accepts({kind:'text',role:'assistant',content:'next turn'}),false);
      assert.ok(gate.complete().prompt, 'a new turn gets a fresh repair budget');
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
      for (let i = 1; i < BRIEFING_REPAIRS_PER_TURN; i++) { gate.begin('native', 'repair ' + i); gate.accepts({ kind: 'text', content: 'x' }); assert.ok(gate.complete().prompt); }
      gate.begin('native', 'accepted steer');
      assert.equal(gate.accepts({ kind: 'text', content: 'repeat violation' }), false);
      assert.ok(gate.complete().exhausted, 'a steer does not renew the turn budget');
    } finally { unregister(); }
  });
  for(const options of [{ephemeral:true},{backgroundHelper:true},{sideSession:{id:'side'}}]) test(`${provider}: helper/side inert ${JSON.stringify(options)}`,()=> {
    const unregister=registerTaskLedgerSource(()=>({listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject',completion:{turnId:'x',prompt:'missing'}}));
    try{const gate=new BriefingOutputPolicy(provider,options);gate.begin('native','request');assert.equal(gate.accepts({kind:'text',role:'assistant',content:'allowed'}),true);assert.deepEqual(gate.complete(),{});}finally{unregister();}
  });
  test(`${provider}: missing checkpoint is repaired up to the budget, then settles without failure`,()=>{
    const unregister=registerTaskLedgerSource(()=>({listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject',completion:{turnId:'x',prompt:'reply both threads'}}));
    try{const gate=new BriefingOutputPolicy(provider,{});gate.begin('native','request');for(let i=0;i<BRIEFING_REPAIRS_PER_TURN;i++)assert.match(gate.complete().prompt!,/reply both threads/);const last=gate.complete() as Record<string,unknown>;assert.equal(last.failure,undefined);assert.ok(last.exhausted);}finally{unregister();}
  });
}

for (const provider of ['claude','opencode','cursor'] as const) {
  test(`${provider}: explicit launch rejects first prose before native ID or hook; absent ledger fails closed`, () => {
    const contexts: any[]=[];
    const unregister=registerAgentLaunchContributor(c=>{contexts.push(c);return c.launchOptions?.fixture === true && c.sessionRole==='main' ? {agentTextPolicy:'reject'} : null;});
    const stop=registerTaskLedgerSource(()=>null);
    try {
      const gate=new BriefingOutputPolicy(provider,{launchOptions:{fixture:true},appSessionId:'host-row'});
      gate.begin(null,'human');
      assert.equal(gate.accepts({kind:'text',content:'before hook'}),false);
      assert.ok(gate.complete().prompt);
      gate.begin('real-native','human');
      // Absent ledger still fails closed into repairs, never into a session failure.
      for(let i=1;i<BRIEFING_REPAIRS_PER_TURN;i++)assert.ok(gate.complete().prompt);
      assert.ok(gate.complete().exhausted);
      assert.equal(contexts[0].sessionId,'host-row');
      assert.equal(contexts[0].sessionRole,'main');
      const plain=new BriefingOutputPolicy(provider,{appSessionId:'host-row'});plain.begin(null,'human');
      assert.equal(plain.accepts({kind:'text',content:'plain'}),true);
    } finally {unregister();stop();}
  });
  test(`${provider}: late native identity retains human prompt/turn and threads exact launch context`,()=>{
    const observed:any[]=[];
    const unregister=registerTaskLedgerSource(c=>{observed.push(c);return {listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject'};});
    try {const gate=new BriefingOutputPolicy(provider,{launchOptions:{fixture:true}});gate.begin(null,'human');gate.begin('native','human');gate.accepts({kind:'text',content:'x'});
      assert.equal(observed[0].sessionId,'native');assert.equal(observed[0].prompt,'human');assert.deepEqual(observed[0].launchOptions,{fixture:true});
      const first=observed[0].turnId;gate.begin('native','human');assert.equal(observed.at(-1).turnId,first);
    }finally{unregister();}
  });
}

for (const provider of ['claude','opencode','cursor'] as const) test(`${provider}: identical explicit human steer starts distinct turn; native binding does not`,()=>{
 const ids:string[]=[];const stop=registerTaskLedgerSource(c=>{if(c.phase==='begin')ids.push(c.turnId!);return {listName:'card',guidance:'',open:[],activity:0,agentTextPolicy:'reject'};});
 try {const gate=new BriefingOutputPolicy(provider,{});gate.begin(null,'identical');gate.begin('native','identical');const first=ids.at(-1);gate.begin('native','identical',true);assert.notEqual(ids.at(-1),first);const second=ids.at(-1);gate.begin('native','identical');assert.equal(ids.at(-1),second);
 const next=new BriefingOutputPolicy(provider,{});next.begin('native','identical');assert.notEqual(ids.at(-1),second);
 } finally{stop();}
});
