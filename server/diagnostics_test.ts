import { Diagnostics } from './diagnostics.ts';

const check = (value: boolean) => { if (!value) throw new Error('assertion failed'); };
const request = (body: unknown) => new Request('http://localhost/api/diagnostics', {method: 'POST', body: JSON.stringify(body)});

Deno.test('keeps viewers separate, bounds histories and rejects oversized reports', async () => {
  const diagnostics = new Diagnostics();
  for (let i = 0; i < 65; i++) await diagnostics.handle(request({clientId: 'headset', cameras: [], sequence: i}));
  await diagnostics.handle(request({clientId: 'laptop', cameras: []}));
  const viewers = await (await diagnostics.handle(new Request('http://localhost/api/diagnostics'))).json();
  check(viewers.clients.length === 2);
  const history = await (await diagnostics.handle(new Request('http://localhost/api/diagnostics?client=headset'))).json();
  check(history.samples.length === 60 && history.samples[0].sequence === 5);
  check((await diagnostics.handle(request({clientId: 'huge', cameras: [], padding: 'x'.repeat(65536)}))).status === 413);
  check((await diagnostics.handle(request({clientId: '../bad', cameras: []}))).status === 400);
});
