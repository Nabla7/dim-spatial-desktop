// What every agent session is to the page, whichever coding agent is behind it: a numbered log of a
// few kinds of event (text as it is written, tool calls and their results, permission prompts, the end
// of a turn), kept so a page can ask for "everything after n" and wait for more.
//
// Each backend (claude.ts, codex.ts) runs that agent's own command-line program as a child process, with
// the login that program already has on this machine. No API key passes through here.

export type AgentEvent = { seq: number; t: string; [key: string]: unknown };
export type SessionOptions = { systemPrompt?: string; model?: string; effort?: string; resume?: string };
export type Choice = { id: string; label: string };

const LOG_LIMIT = 4000, TEXT_LIMIT = 6000;

export const clip = (text: string, limit = TEXT_LIMIT) => text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;

// The first of `names` found on PATH or in the places a user install puts it.
export async function findCommand(names: string[], extra: string[] = []): Promise<string | null> {
  const home = Deno.env.get("HOME") ?? "";
  const dirs = [...(Deno.env.get("PATH") ?? "").split(":").filter(Boolean), `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"];
  for (const path of [...dirs.flatMap((dir) => names.map((name) => `${dir}/${name}`)), ...extra.map((path) => path.replace(/^~/, home))]) {
    try { if ((await Deno.stat(path)).isFile) return path; } catch { /* not there */ }
  }
  return null;
}

// The environment an agent's process gets: the server's own, without `remove` (an API key in the
// environment would take over from the program's own login), and with the user's usual PATH, because
// Desktop starts app servers with a short one and the tools an agent runs need the rest.
export function agentEnv(remove: string[]): Record<string, string> {
  const env = { ...Deno.env.toObject() };
  for (const name of [...remove, "DIMOS_APP"]) delete env[name];
  const home = env.HOME ?? "";
  env.PATH = [env.PATH, `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(":");
  return env;
}

export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += value;
    let end: number;
    while ((end = rest.indexOf("\n")) >= 0) { onLine(rest.slice(0, end)); rest = rest.slice(end + 1); }
  }
  if (rest) onLine(rest);
}

export abstract class AgentSession {
  readonly id = crypto.randomUUID();
  readonly startedAt = Date.now();
  abstract readonly backend: string;
  events: AgentEvent[] = [];
  sessionId: string | null = null;   // the agent program's own id for the conversation, for resuming it
  model: string | null = null;
  busy = false;
  exited: number | null = null;
  #seq = 0;
  #waiters: (() => void)[] = [];

  constructor(readonly command: string, readonly cwd: string) {}

  protected push(event: Record<string, unknown>) {
    this.events.push({ ...event, seq: ++this.#seq } as AgentEvent);
    if (this.events.length > LOG_LIMIT) this.events.splice(0, this.events.length - LOG_LIMIT);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  // Events after `after`; waits up to `waitMs` when there are none yet.
  async eventsAfter(after: number, waitMs: number): Promise<{ events: AgentEvent[]; reset: boolean }> {
    const reset = this.events.length > 0 && after < this.events[0].seq - 1;
    let found = this.events.filter((event) => event.seq > after);
    if (!found.length && waitMs > 0 && this.exited === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        this.#waiters.push(() => { clearTimeout(timer); resolve(); });
      });
      found = this.events.filter((event) => event.seq > after);
    }
    return { events: found, reset };
  }

  abstract send(text: string): Promise<void>;
  // The answer to a permission prompt. `session` extends an allow to the rest of the session where the agent can.
  abstract answer(requestId: string, allow: boolean, options?: { message?: string; session?: boolean }): Promise<void>;
  abstract interrupt(): Promise<void>;
  abstract close(): void;
}
