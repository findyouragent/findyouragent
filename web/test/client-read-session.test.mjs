import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const bundle = await build({
  absWorkingDir:fileURLToPath(new URL('../',import.meta.url)),
  entryPoints:['src/api/client.js'],bundle:true,format:'esm',platform:'node',write:false,
  define:{'import.meta.env.VITE_VERIFY_API':JSON.stringify('https://fya.test'),'import.meta.env.PROD':'true'},
});
const client = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const verdict = token => ({agentId:`56:${token}`,tier:'active',checkedAt:'2026-09-08T01:02:03.000Z'});
const sse = frames => new Response(frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
function mock(t,fetchImpl){const previous=globalThis.fetch;globalThis.fetch=fetchImpl;t.after(()=>{globalThis.fetch=previous;});}
function shortDeadline(t){
  const previous=globalThis.setTimeout;
  globalThis.setTimeout=(fn,ms,...args)=>previous(fn,ms===30_000?15:ms,...args);
  t.after(()=>{globalThis.setTimeout=previous;});
}

test('JSON verification and streamed subscriber share a request; reuse preserves date and labels cached',async t=>{
  let calls=0;const events=[];
  mock(t,async()=>{calls++;return json(verdict(1));});
  const [plain,streamed]=await Promise.all([client.getVerdict(56,1),client.verifyStreamed(56,1,e=>events.push(e))]);
  assert.equal(calls,1);assert.deepEqual(plain,verdict(1));assert.deepEqual(streamed,plain);assert.deepEqual(events,[]);
  assert.deepEqual(await client.verifyStreamed(56,1,e=>events.push(e)),{...plain,cached:true});
  assert.equal(calls,1);assert.deepEqual(events,[]);
});

test('stream started first shares future events, survives callback exceptions and serves JSON caller',async t=>{
  let calls=0;const events=[];
  mock(t,async()=>{calls++;return sse([{step:'registry'}, {step:'verdict',verdict:verdict(2)}]);});
  const first=client.verifyStreamed(56,2,()=>{throw Error('observer');});
  const second=client.verifyStreamed(56,2,e=>events.push(e));
  const plain=client.getVerdict(56,2);
  assert.deepEqual(await Promise.all([first,second,plain]),[verdict(2),verdict(2),verdict(2)]);
  assert.equal(calls,1);assert.deepEqual(events,[{step:'registry'}]);
});

test('concurrent registry detail calls share one validated read',async t=>{
  let calls=0;const data={chain_id:56,token_id:'3',name:'fixture'};
  mock(t,async()=>{calls++;return json({data});});
  const found=await Promise.all([client.getAgentDetail(56,3),client.getAgentDetail(56,3)]);
  assert.deepEqual(found,[data,data]);await client.getAgentDetail(56,3);assert.equal(calls,1);
});

test('null or invalid metadata cannot block a successful retry',async t=>{
  for(const [index,invalid] of [null,{meta:null},{meta:[]},{error:'failed',meta:{}},[]].entries()){
    const token=40+index;let calls=0;
    mock(t,async()=>json(++calls===1?invalid:{meta:{name:'valid'}}));
    assert.equal(await client.getAgentMeta(56,token),null);
    assert.deepEqual(await client.getAgentMeta(56,token),{meta:{name:'valid'}});
    await client.getAgentMeta(56,token);assert.equal(calls,2);
  }
});

test('forced metadata read bypasses cached absence and requests refresh',async t=>{
  let calls=0;const urls=[];
  mock(t,async(url)=>{urls.push(url);calls++;return json(calls===1?{meta:{name:'without menu'}}:{meta:{name:'with menu',services:[{name:'erc8183',endpoint:'eip155:56:0x1111111111111111111111111111111111111111'}]}});});
  assert.equal((await client.getAgentMeta(56,61)).meta.name,'without menu');
  assert.equal((await client.getAgentMeta(56,61)).meta.name,'without menu');
  assert.equal(calls,1);
  assert.equal((await client.getAgentMeta(56,61,{force:true})).meta.name,'with menu');
  assert.equal(calls,2);assert.match(urls[1],/\/api\/agent-meta\/56\/61\?refresh=1$/);
});

test('forced metadata read does not join an older ordinary read in flight',async t=>{
  let resolveFirst;let calls=0;const urls=[];
  mock(t,async(url)=>{urls.push(url);calls++;if(calls===1)return new Promise(resolve=>{resolveFirst=()=>resolve(json({meta:{name:'stale'}}));});return json({meta:{name:'fresh'}});});
  const ordinary=client.getAgentMeta(56,62);
  const forced=client.getAgentMeta(56,62,{refresh:true});
  assert.deepEqual(await forced,{meta:{name:'fresh'}});
  resolveFirst();assert.deepEqual(await ordinary,{meta:{name:'stale'}});
  assert.equal(calls,2);assert.equal(urls[0], 'https://fya.test/api/agent-meta/56/62');
  assert.equal(urls[1], 'https://fya.test/api/agent-meta/56/62?refresh=1');
});

test('invalid, undated and mismatched verdicts never enter the successful cache',async t=>{
  const invalids=[{},[],{tier:'active'}, {...verdict(99),agentId:'1:99'}, {...verdict(99),error:true}];
  for(const [index,invalid] of invalids.entries()){
    const token=50+index;let calls=0;
    mock(t,async()=>json(++calls===1?invalid:verdict(token)));
    await client.getVerdict(56,token);
    assert.deepEqual(await client.getVerdict(56,token),verdict(token));assert.equal(calls,2);
  }
});

test('terminal SSE identity failure is shared without a JSON retry and can recover',async t=>{
  let calls=0;
  mock(t,async()=>{calls++;return sse([{step:'error',code:'identity-unavailable',source:'agent-identity'}]);});
  const result=await Promise.allSettled([client.verifyStreamed(56,6),client.getVerdict(56,6)]);
  assert.equal(calls,1);for(const item of result){assert.equal(item.status,'rejected');assert.equal(item.reason.identityUnavailable,true);}
  globalThis.fetch=async()=>{calls++;return json(verdict(6));};
  assert.deepEqual(await client.getVerdict(56,6),verdict(6));assert.equal(calls,2);
});

test('rate-limit response is not followed by another verification request',async t=>{
  let calls=0;mock(t,async()=>{calls++;return json({error:'rate-limited'},429);});
  await assert.rejects(client.verifyStreamed(56,7),e=>e.status===429&&e.throttled===true);assert.equal(calls,1);
});

for(const kind of ['verify','metadata'])test(`${kind} deadline covers a stalled JSON body and releases the pending read`,async t=>{
  shortDeadline(t);let bodyStarted=false,aborted=false;
  mock(t,async(_url,{signal})=>({ok:true,status:200,headers:new Headers({'content-type':'application/json'}),
    json:()=>{bodyStarted=true;return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('body aborted'));},{once:true}));},
  }));
  const token=kind==='verify'?8:9;
  const read=()=>kind==='verify'?client.getVerdict(56,token):client.getAgentMeta(56,token);
  if(kind==='verify')await assert.rejects(read(),/aborted/);else assert.equal(await read(),null);
  assert.equal(bodyStarted,true);assert.equal(aborted,true);
  const recovered=kind==='verify'?verdict(token):{meta:{name:'recovered'}};
  globalThis.fetch=async()=>json(recovered);assert.deepEqual(await read(),recovered);
});

test('manual task POST calls are not shared, cached or automatically repeated',async t=>{
  const calls=[];mock(t,async(url,init)=>{calls.push({url,method:init.method});return json({status:502,error:'fixture-error',body:{error:{message:'failed'}}});});
  await Promise.all([client.runAgentTask(56,10,'fixture'),client.runAgentTask(56,10,'fixture')]);
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.method==='POST'&&c.url.endsWith('/api/try/56/10')));
});
