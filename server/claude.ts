// A Claude Code session as a child process, spoken to in its headless stream-json protocol:
// user turns go in on stdin, events come out on stdout, and a permission prompt is a request the
// host answers. The login is whatever `claude` itself is logged in with (the user's subscription);
// no API key passes through here, and one in the environment is removed so it cannot take over.
//
// The CLI's events are reduced to the few a chat panel draws, numbered, and kept so a page can ask
// for "everything after n" and wait for more.

export type AgentEvent = { seq: number; t: string; [key: string]: unknown };

type Waiter = () => void;

const LOG_LIMIT = 4000, TEXT_LIMIT = 6000;

const clip = (text: string, limit = TEXT_LIMIT) => text.length > limit ? `${text.slice(0, limit)}\n… (${text.length - limit} more characters)` : text;

// A tool result's content is a string or a list of blocks; the panel shows text.
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => typeof block === "string" ? block : block?.type === "text" ? block.text : `[${block?.type ?? "data"}]`).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

export async function findClaude(): Promise<string | null> {
  const home = Deno.env.get("HOME") ?? "";
  const candidates = [
    ...(Deno.env.get("PATH") ?? "").split(":").filter(Boolean).map((dir) => `${dir}/claude`),
    `${home}/.local/bin/claude`, `${home}/.claude/local/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude",
  ];
  for (const path of candidates) {
    try { if ((await Deno.stat(path)).isFile) return path; } catch { /* not there */ }
  }
  return null;
}

export class ClaudeSession {
  readonly id = crypto.randomUUID();
  readonly startedAt = Date.now();
  events: AgentEvent[] = [];
  sessionId: string | null = null;   // Claude Code's own id, for --resume
  model: string | null = null;
  busy = false;
  exited: number | null = null;
  #seq = 0;
  #waiters: Waiter[] = [];
  #process: Deno.ChildProcess;
  #stdin: WritableStreamDefaultWriter<Uint8Array>;
  #encoder = new TextEncoder();
  #pending = new Map<string, unknown>();  // permission request id -> the tool input asked about

  constructor(readonly command: string, readonly cwd: string, options: { systemPrompt?: string; model?: string; resume?: string } = {}) {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"];
    if (options.systemPrompt) args.push("--append-system-prompt", options.systemPrompt);
    if (options.model) args.push("--model", options.model);
    if (options.resume) args.push("--resume", options.resume);
    const env = { ...Deno.env.toObject() };
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "DIMOS_APP"]) delete env[name];
    // Desktop starts app servers with a short PATH; the tools Claude runs need the user's.
    const home = env.HOME ?? "";
    env.PATH = [env.PATH, `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(":");
    this.#process = new Deno.Command(command, { args, cwd, env, clearEnv: true, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    this.#stdin = this.#process.stdin.getWriter();
    this.#read(this.#process.stdout, (line) => this.#onLine(line));
    this.#read(this.#process.stderr, (line) => { if (line.trim()) this.#push({ t: "stderr", text: clip(line, 600) }); });
    this.#process.status.then((status) => { this.exited = status.code; this.busy = false; this.#push({ t: "exit", code: status.code }); });
  }

  async #read(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
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

  #push(event: Record<string, unknown>) {
    this.events.push({ ...event, seq: ++this.#seq } as AgentEvent);
    if (this.events.length > LOG_LIMIT) this.events.splice(0, this.events.length - LOG_LIMIT);
    for (const wake of this.#waiters.splice(0)) wake();
  }

  async #write(message: unknown) {
    if (this.exited !== null) throw new Error("the Claude process has ended");
    await this.#stdin.write(this.#encoder.encode(JSON.stringify(message) + "\n"));
  }

  // deno-lint-ignore no-explicit-any
  #onLine(line: string) {
    // deno-lint-ignore no-explicit-any
    let event: any;
    try { event = JSON.parse(line); } catch { if (line.trim()) this.#push({ t: "stderr", text: clip(line, 600) }); return; }
    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          this.sessionId = event.session_id; this.model = event.model;
          this.#push({ t: "init", sessionId: event.session_id, model: event.model, mode: event.permissionMode, cwd: event.cwd, version: event.claude_code_version });
        }
        break;
      case "stream_event": {
        const inner = event.event;
        if (inner?.type === "content_block_start" && inner.content_block?.type === "thinking") this.#push({ t: "thinking" });
        if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") this.#push({ t: "tool_start", id: inner.content_block.id, name: inner.content_block.name });
        if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") this.#push({ t: "delta", text: inner.delta.text });
        break;
      }
      case "assistant": {
        if (event.parent_tool_use_id) break;  // a subagent's own messages: its result reaches the main thread as a tool result
        // deno-lint-ignore no-explicit-any
        const blocks = (event.message?.content ?? []).map((block: any) =>
          block.type === "text" ? { type: "text", text: block.text }
            : block.type === "tool_use" ? { type: "tool", id: block.id, name: block.name, input: block.input }
            : null).filter(Boolean);
        if (blocks.length) this.#push({ t: "assistant", id: event.message?.id, blocks });
        break;
      }
      case "user": {
        if (event.parent_tool_use_id) break;
        const content = event.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) if (block?.type === "tool_result") this.#push({ t: "tool_result", id: block.tool_use_id, text: clip(resultText(block.content)), error: !!block.is_error });
        break;
      }
      case "control_request": {
        const request = event.request ?? {};
        if (request.subtype === "can_use_tool") {
          this.#pending.set(event.request_id, request.input ?? {});
          this.#push({ t: "permission", requestId: event.request_id, tool: request.tool_name, title: request.display_name ?? request.tool_name, input: request.input ?? {}, description: request.description ?? "" });
        } else {
          // Nothing else was asked for at start-up (no hooks, no SDK MCP servers): say so rather than leave it waiting.
          this.#write({ type: "control_response", response: { subtype: "error", request_id: event.request_id, error: `unsupported request ${request.subtype}` } }).catch(() => {});
        }
        break;
      }
      case "result":
        this.busy = false;
        this.#push({ t: "result", ok: !event.is_error, subtype: event.subtype, text: typeof event.result === "string" ? clip(event.result) : "", costUsd: event.total_cost_usd ?? null, ms: event.duration_ms ?? null, turns: event.num_turns ?? null });
        break;
      case "rate_limit_event": {
        const windows = event.rate_limit_info?.unifiedWindows ?? {};
        this.#push({ t: "limits", status: event.rate_limit_info?.status, fiveHour: windows.five_hour?.utilization ?? null, sevenDay: windows.seven_day?.utilization ?? null });
        break;
      }
    }
  }

  async send(text: string) {
    this.busy = true;
    this.#push({ t: "user", text });
    await this.#write({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
  }

  // The answer to a permission prompt. Allowing hands the tool its input back unchanged.
  async answer(requestId: string, allow: boolean, message = "The user declined this action.") {
    if (!this.#pending.has(requestId)) throw new Error("no such permission request (already answered?)");
    const input = this.#pending.get(requestId);
    this.#pending.delete(requestId);
    await this.#write({ type: "control_response", response: { subtype: "success", request_id: requestId, response: allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message } } });
    this.#push({ t: "permission_answer", requestId, allow });
  }

  async interrupt() {
    await this.#write({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } });
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

  close() {
    try { this.#process.kill("SIGTERM"); } catch { /* already gone */ }
  }
}
