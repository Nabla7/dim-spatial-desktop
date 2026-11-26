// Loopback-only qualification harness, never part of the installed app.
const [root, client, diagnostics] = Deno.args;
if (!root || !client || !diagnostics) throw new Error('source root, compiled SDK and capture directory required');
Deno.serve({hostname:'127.0.0.1',port:0,onListen:({hostname,port})=>console.log(JSON.stringify({url:`http://${hostname}:${port}`}))}, async request => {
  const path = decodeURIComponent(new URL(request.url).pathname);
  if (path.startsWith('/diagnostics/')) return fetch(diagnostics + path, {method:request.method, headers:request.headers, body:request.body});
  if (path.includes('..')) return new Response('invalid path',{status:400});
  const file = path === '/client.js' ? client : root + path;
  try {
    const data = await Deno.readFile(file);
    return new Response(data,{headers:{'content-type':path.endsWith('.html')?'text/html':'text/javascript'}});
  } catch {return new Response('not found',{status:404});}
});
