// Loopback-only qualification harness, never part of the installed app.
import {TraceStore} from '../server/trace.ts';
const [root, client, capture] = Deno.args;
if (!root || !client || !capture) throw new Error('source root, compiled SDK and capture directory required');
const store = new TraceStore(capture);
Deno.serve({hostname:'127.0.0.1',port:0,onListen:({hostname,port})=>console.log(JSON.stringify({url:`http://${hostname}:${port}`}))}, async request => {
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path.endsWith('/api/diagnostics/trace')) return store.handle(request);
  if (path.includes('..')) return new Response('invalid path',{status:400});
  const file = path === '/client.js' ? client : root + path;
  try {
    const data = await Deno.readFile(file);
    return new Response(data,{headers:{'content-type':path.endsWith('.html')?'text/html':'text/javascript'}});
  } catch {return new Response('not found',{status:404});}
});
