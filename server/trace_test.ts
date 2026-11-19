import {TraceStore} from './trace.ts';
const batch = (id:string) => ({batchId:id,manifest:{schema:'dimos.incident/v1',run_id:'run',process:'browser',clock_domain:'browser/performance'},
  events:[{schema:'dimos.trace/v1',event:'video.presented',process:'browser',clock_domain:'browser/performance',mono_ns:100,context:null}]});
async function request(data: unknown, gzip=false) {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  const body = gzip ? await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer() : bytes;
  return new Request('http://localhost/trace',{method:'POST',body,headers:gzip?{'content-encoding':'gzip'}:{}});
}
Deno.test('compressed uploads are durable and retries are idempotent',async()=>{
  const root=await Deno.makeTempDir();
  try {
    const store=new TraceStore(root);
    for(let i=0;i<2;i++) {const r=await store.handle(await request(batch('same'),true));if(r.status!==200)throw new Error(await r.text());}
    const rows=(await Deno.readTextFile(`${root}/run/browser/incident-same.jsonl`)).trim().split('\n');
    if(rows.length!==2 || JSON.parse(rows[1]).event!=='video.presented')throw new Error('capture mismatch');
    const files=[];for await(const f of Deno.readDir(`${root}/run/browser`))if(f.name.endsWith('.jsonl'))files.push(f.name);
    if(files.length!==1)throw new Error('duplicate batch');
  } finally {await Deno.remove(root,{recursive:true});}
});
Deno.test('foreign run identities and directory traversal are rejected',async()=>{
  const root=await Deno.makeTempDir();
  try {
    const store=new TraceStore(root);const data=batch('id');data.manifest.run_id='../outside';
    if((await store.handle(await request(data))).status!==400)throw new Error('traversal accepted');
  } finally {await Deno.remove(root,{recursive:true});}
});
Deno.test('storage rotates captures under one shared budget',async()=>{
  const root=await Deno.makeTempDir();
  try {
    const store=new TraceStore(root,800);
    for(let i=0;i<8;i++){const r=await store.handle(await request(batch(`batch-${i}`)));if(r.status!==200)throw new Error(await r.text());}
    let bytes=0;for await(const f of Deno.readDir(`${root}/run/browser`))if(f.name.endsWith('.jsonl'))bytes+=(await Deno.stat(`${root}/run/browser/${f.name}`)).size;
    if(bytes>800)throw new Error('unbounded disk');
    await Deno.stat(`${root}/run/browser/incident-batch-7.jsonl`);
  } finally {await Deno.remove(root,{recursive:true});}
});

Deno.test('a crash before rename does not prevent an upload retry',async()=>{
  const root=await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/run/browser`,{recursive:true});
    await Deno.writeTextFile(`${root}/run/browser/incident-retry.jsonl.tmp`,'partial');
    const response=await new TraceStore(root).handle(await request(batch('retry')));
    if(response.status!==200)throw new Error(await response.text());
    const rows=(await Deno.readTextFile(`${root}/run/browser/incident-retry.jsonl`)).trim().split('\n');
    if(JSON.parse(rows[1]).event!=='video.presented')throw new Error('retry lost data');
  } finally {await Deno.remove(root,{recursive:true});}
});

Deno.test('reusing an acknowledged batch identity cannot silently replace evidence',async()=>{
  const root=await Deno.makeTempDir();
  try {
    const store=new TraceStore(root);
    if((await store.handle(await request(batch('same')))).status!==200)throw new Error('first upload failed');
    const changed=batch('same'); changed.events[0].mono_ns=200;
    if((await store.handle(await request(changed))).status!==409)throw new Error('conflicting retry accepted');
  } finally {await Deno.remove(root,{recursive:true});}
});
