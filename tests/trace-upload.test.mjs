import test from 'node:test';
import assert from 'node:assert/strict';
import {TraceUpload} from '../frontend/src/data/trace-upload.js';

test('failed upload retries identical batch and never drains another until acknowledged', async () => {
  let now = 0, drains = 0; const sent = [];
  const trace = {drain() { drains++; return [{event:'test'}]; }, manifest() { return {run_id:'test'}; }};
  const upload = new TraceUpload(async bytes => { sent.push(bytes); if(sent.length === 1) throw new Error('offline'); }, () => now);
  await upload.flush(trace); assert.equal(sent.length,0);
  now = 1000; await assert.rejects(upload.flush(trace),/offline/);
  now = 2000; await upload.flush(trace);
  assert.equal(drains,1); assert.deepEqual(sent[0],sent[1]); assert.equal(upload.pending,null);
});

test('concurrent timer calls cannot duplicate upload or drain', async () => {
  let release, now = 1000, calls = 0;
  const upload = new TraceUpload(() => { calls++; return new Promise(resolve => {release=resolve;}); }, () => now);
  const trace = {drain:()=>[{event:'test'}],manifest:()=>({run_id:'test'})};
  now=2000; const first=upload.flush(trace);
  while (!release) await new Promise(resolve=>setImmediate(resolve));
  await upload.flush(trace); assert.equal(calls,1);
  release(); await first;
});

test('steady diagnostic payload egress stays below its configured allocation', async () => {
  let now=0, bytes=0;
  const upload = new TraceUpload(async body => {bytes+=body.length;},()=>now);
  const noise = Array.from({length:30000},(_,i)=>String.fromCharCode(32+(i*17%90))).join('');
  const trace={drain:()=>[{event:'load',noise}],manifest:()=>({run_id:'test'})};
  for(let i=0;i<40;i++){now+=250;await upload.flush(trace);}
  assert.ok(bytes/(now/1000)<=80*1024);
});

test('compression failure retains the drained batch and sends uncompressed', async t => {
  t.mock.method(globalThis, 'CompressionStream', function () { throw new Error('compression unavailable'); });
  let now=0, drains=0; const sent=[];
  const upload=new TraceUpload(async(body,gzip)=>sent.push({body,gzip}),()=>now);
  const trace={drain:()=>{drains++;return [{event:'retained'}];},manifest:()=>({run_id:'test'})};
  await upload.flush(trace); now=1000; await upload.flush(trace);
  assert.equal(drains,1); assert.equal(sent.length,1); assert.equal(sent[0].gzip,false);
  assert.equal(JSON.parse(new TextDecoder().decode(sent[0].body)).events[0].event,'retained');
});

test('an uncompressed full batch fits the token bucket and eventually sends', async t => {
  t.mock.method(globalThis, 'CompressionStream', function () { throw new Error('unavailable'); });
  let now=0, sent=0;
  const upload=new TraceUpload(async()=>{sent++;},()=>now);
  const trace={drain:limit=>[{event:'load',text:'x'.repeat(limit-100)}],manifest:()=>({run_id:'test'})};
  await upload.flush(trace); now=4000; await upload.flush(trace);
  assert.equal(sent,1);
});
