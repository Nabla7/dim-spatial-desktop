// Durable metadata only. The existing Desktop app route supplies authentication.
const safe = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const encoder = new TextEncoder();

async function bounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new Error('batch too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
  return bytes;
}

export class TraceStore {
  private pending = 0;
  constructor(private root: string | undefined, private budget = 1024 * 1024 * 1024) {}
  async handle(request: Request): Promise<Response> {
    if (!this.root) return Response.json({error:'diagnostics storage unavailable'}, {status:503});
    if (request.method !== 'POST') return Response.json({error:'method not allowed'}, {status:405});
    if (!request.body) return Response.json({error:'missing body'}, {status:400});
    if (this.pending >= 8) return Response.json({error:'diagnostics busy; retry this batch'}, {status:429});
    this.pending++;
    let validated = false;
    try {
      const compressed = await bounded(request.body,512*1024);
      const encoding = request.headers.get('content-encoding');
      if (encoding && encoding !== 'gzip') throw new Error('unsupported content encoding');
      const data = encoding === 'gzip' ? await bounded(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),1024*1024) : compressed;
      const {manifest,events,batchId} = JSON.parse(new TextDecoder().decode(data));
      if (!safe(manifest?.run_id) || !safe(manifest?.process) || !safe(batchId) || manifest.schema !== 'dimos.incident/v1'
          || !Array.isArray(events) || events.length > 512 || typeof manifest.clock_domain !== 'string') throw new Error('invalid batch');
      for (const event of events) {
        if (event.schema !== 'dimos.trace/v1' || event.process !== manifest.process || event.clock_domain !== manifest.clock_domain
            || !Number.isSafeInteger(event.mono_ns) || event.mono_ns < 0 || typeof event.event !== 'string'
            || (event.context && event.context.run_id !== manifest.run_id)) throw new Error('invalid event');
      }
      const body = encoder.encode([JSON.stringify(manifest), ...events.map((e: unknown) => JSON.stringify(e)), ''].join('\n'));
      validated = true;
      await Deno.mkdir(this.root,{recursive:true});
      using lock = await Deno.open(`${this.root}/.retention.lock`,{create:true,write:true});
      await lock.lock(true); // Same flock contract as Python and native collectors, off the control path.
      const run = `${this.root}/${manifest.run_id}`, directory = `${run}/${manifest.process}`;
      for (const path of [run,directory]) {
        await Deno.mkdir(path,{recursive:true});
        if ((await Deno.lstat(path)).isSymlink) throw new Error('symlink capture directory refused');
      }
      const destination = `${directory}/incident-${batchId}.jsonl`;
      try {
        const stat = await Deno.lstat(destination);
        if (!stat.isFile || stat.isSymlink) throw new Error('invalid capture destination');
        const saved = await Deno.readFile(destination);
        if (saved.length !== body.length || saved.some((value,index)=>value!==body[index])) {
          return Response.json({error:'batch identity reused with different content'}, {status:409});
        }
        return Response.json({stored:true,batchId});
      } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
      const files: {path:string,size:number,mtime:number}[] = [];
      for await (const run of Deno.readDir(this.root)) if (run.isDirectory && safe(run.name)) {
        for await (const process of Deno.readDir(`${this.root}/${run.name}`)) if (process.isDirectory && safe(process.name)) {
          for await (const entry of Deno.readDir(`${this.root}/${run.name}/${process.name}`)) {
            if (!entry.isFile || !/^incident-[a-zA-Z0-9_-]+\.jsonl$/.test(entry.name)) continue;
            const path = `${this.root}/${run.name}/${process.name}/${entry.name}`, stat = await Deno.lstat(path);
            files.push({path,size:stat.size,mtime:stat.mtime?.getTime()??0});
          }
        }
      }
      let total = files.reduce((n,f)=>n+f.size,body.length);
      for (const old of files.sort((a,b)=>a.mtime-b.mtime)) { if (total <= this.budget) break; await Deno.remove(old.path); total -= old.size; }
      if (total > this.budget) throw new Error('batch exceeds storage budget');
      // A previous writer may have died before rename. Under the host lock,
      // discard only this batch's incomplete temporary file before retrying.
      try { await Deno.remove(destination+'.tmp'); } catch(e) { if(!(e instanceof Deno.errors.NotFound)) throw e; }
      using output = await Deno.open(destination+'.tmp',{createNew:true,write:true});
      let written=0; while(written<body.length) written+=await output.write(body.subarray(written));
      await output.sync(); await Deno.rename(destination+'.tmp',destination);
      const status = {...manifest,at_ns:Date.now()*1e6,state:'collecting',observer_drops:manifest.health?.observer_drops??0};
      await Deno.writeTextFile(`${directory}/status.tmp`,JSON.stringify(status)); await Deno.rename(`${directory}/status.tmp`,`${directory}/status.json`);
      return Response.json({stored:true,batchId});
    } catch (error) { return Response.json({error: error instanceof Error ? error.message : 'capture failed'}, {status: validated ? 503 : 400}); }
    finally { this.pending--; }
  }
}
