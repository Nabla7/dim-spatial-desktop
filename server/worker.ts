// What the readers of files on disk share (replay.ts, scenes.ts): small helpers, the answer that carries
// bytes, a long-lived Python process that answers one request at a time, and a Python process that is
// followed line by line. Which Python runs is the caller's choice: the one that matches the data.
import { agentEnv } from "./session.ts";

export type Runtime = { python: string; cwd: string };
export type Answer = { meta: Record<string, unknown>; payload: Uint8Array };
export type Job = { state: "running" | "done" | "failed"; startedAt: number; done?: number; total?: number; error?: string; result?: unknown; note?: string };

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const exists = (path: string) => Deno.stat(path).then(() => true, () => false);
export const readJson = async (path: string) => { try { return JSON.parse(await Deno.readTextFile(path)); } catch { return null; } };
export const dirname = (path: string) => path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
export const home = (path: string) => path.trim().replace(/^~(?=\/|$)/, Deno.env.get("HOME") ?? "~").replace(/\/+$/, "");

export async function shortHash(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text)));
  return [...bytes.slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// JSON meta and raw bytes in one response: [uint32 length of the JSON, little endian][JSON, padded with
// spaces so the bytes start on a multiple of four][bytes]. The page views the bytes as typed arrays.
export function container(meta: unknown, payload: Uint8Array): Response {
  const head = new TextEncoder().encode(JSON.stringify(meta)), pad = (4 - (head.length % 4)) % 4;
  const out = new Uint8Array(4 + head.length + pad + payload.length);
  new DataView(out.buffer).setUint32(0, head.length + pad, true);
  out.set(head, 4); out.fill(32, 4 + head.length, 4 + head.length + pad); out.set(payload, 4 + head.length + pad);
  return new Response(out, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
}

const environment = () => ({ ...agentEnv([]), PYTHONUNBUFFERED: "1" });

// One long-lived process. A request is a JSON line; the answer is a JSON line and then the number of raw
// bytes that line names. Requests go one at a time. `what` names the process in what the user reads.
export class PythonWorker {
  #process: Deno.ChildProcess;
  #stdin: WritableStreamDefaultWriter<Uint8Array>;
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #held = new Uint8Array(0);
  #chain: Promise<unknown> = Promise.resolve();
  #seq = 0;
  dead = false;
  used = Date.now();
  log: string[] = [];

  constructor(script: string, readonly runtime: Runtime, readonly what: string, readonly patience = 120_000) {
    this.#process = new Deno.Command(runtime.python, { args: [script], cwd: runtime.cwd, env: environment(), clearEnv: true, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    this.#stdin = this.#process.stdin.getWriter();
    this.#reader = this.#process.stdout.getReader();
    this.#drain(this.#process.stderr);
    this.#process.status.then(() => { this.dead = true; });
  }

  async #drain(stream: ReadableStream<Uint8Array>) {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of value.split("\n")) if (line.trim()) { this.log.push(line); if (this.log.length > 40) this.log.shift(); }
    }
  }

  async #fill(): Promise<boolean> {
    const { value, done } = await this.#reader.read();
    if (done || !value) return false;
    const joined = new Uint8Array(this.#held.length + value.length);
    joined.set(this.#held); joined.set(value, this.#held.length); this.#held = joined;
    return true;
  }

  async #line(): Promise<string> {
    for (;;) {
      const end = this.#held.indexOf(10);
      if (end >= 0) { const line = new TextDecoder().decode(this.#held.subarray(0, end)); this.#held = this.#held.slice(end + 1); return line; }
      if (!await this.#fill()) throw new Error(`the ${this.what} stopped${this.log.length ? `: ${this.log.at(-1)}` : ""}`);
    }
  }

  async #bytes(count: number): Promise<Uint8Array> {
    while (this.#held.length < count) if (!await this.#fill()) throw new Error(`the ${this.what} stopped in the middle of an answer`);
    const out = this.#held.slice(0, count);
    this.#held = this.#held.slice(count);
    return out;
  }

  call(request: Record<string, unknown>): Promise<Answer> {
    const run = this.#chain.then(async () => {
      if (this.dead) throw new Error(`the ${this.what} is not running`);
      const id = ++this.#seq;
      await this.#stdin.write(new TextEncoder().encode(JSON.stringify({ ...request, id }) + "\n"));
      const head = JSON.parse(await this.#line());
      const payload = head.bytes ? await this.#bytes(head.bytes) : new Uint8Array(0);
      if (!head.ok) throw new Error(head.error || `the ${this.what} could not answer`);
      return { meta: head.meta ?? {}, payload };
    });
    this.#chain = run.catch(() => {});
    this.used = Date.now();
    // A reader that hangs (a file on a disk that went away) must not hold every later request.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<Answer>((_, reject) => { timer = setTimeout(() => reject(new Error(`the ${this.what} did not answer in time`)), this.patience); });
    return Promise.race([run, late])
      .catch((error) => { if (/in time|stopped/.test(error.message)) this.close(); throw error; })
      .finally(() => clearTimeout(timer));
  }

  close() { this.dead = true; try { this.#process.kill("SIGTERM"); } catch { /* already gone */ } }
}

// A Python process for work that takes a while: each line it prints goes to `onLine`, and `onEnd` gets its
// exit code with the last lines of what it wrote to stderr.
export function follow(runtime: Runtime, args: string[], onLine: (line: string) => void, onEnd: (code: number, log: string[]) => void): Deno.ChildProcess {
  const process = new Deno.Command(runtime.python, { args, cwd: runtime.cwd, env: environment(), clearEnv: true, stdin: "null", stdout: "piped", stderr: "piped" }).spawn();
  const log: string[] = [];
  const lines = async (stream: ReadableStream<Uint8Array>, each: (line: string) => void) => {
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += value;
      let end: number;
      while ((end = rest.indexOf("\n")) >= 0) { each(rest.slice(0, end)); rest = rest.slice(end + 1); }
    }
  };
  const out = lines(process.stdout, onLine);
  const err = lines(process.stderr, (line) => { if (line.trim()) { log.push(line); if (log.length > 30) log.shift(); } });
  Promise.all([process.status, out, err]).then(([status]) => onEnd(status.code, log));
  return process;
}
