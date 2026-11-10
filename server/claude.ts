// A Claude Code session as a child process, spoken to in its headless stream-json protocol:
// user turns go in on stdin, events come out on stdout, and a permission prompt is a request the
// host answers. The login is whatever `claude` itself is logged in with (the user's subscription).
import { AgentSession, agentEnv, type Choice, clip, findCommand, readLines, type SessionOptions } from "./session.ts";

export const findClaude = () => findCommand(["claude"], ["~/.claude/local/claude"]);

export const CLAUDE_MODELS: Choice[] = [{ id: "", label: "default" }, { id: "fable", label: "fable" }, { id: "opus", label: "opus" }, { id: "sonnet", label: "sonnet" }, { id: "haiku", label: "haiku" }];
export const CLAUDE_EFFORTS: Choice[] = [{ id: "", label: "default" }, { id: "low", label: "low" }, { id: "medium", label: "medium" }, { id: "high", label: "high" }, { id: "xhigh", label: "xhigh" }];

// A tool result's content is a string or a list of blocks; the panel shows text.
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => typeof block === "string" ? block : block?.type === "text" ? block.text : `[${block?.type ?? "data"}]`).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

export class ClaudeSession extends AgentSession {
  readonly backend = "claude";
  #process: Deno.ChildProcess;
  #stdin: WritableStreamDefaultWriter<Uint8Array>;
  #encoder = new TextEncoder();
  #pending = new Map<string, unknown>();  // permission request id -> the tool input asked about
  #stopping = false;                      // the user asked for the turn that runs to stop

  constructor(command: string, cwd: string, options: SessionOptions = {}) {
    super(command, cwd);
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"];
    if (options.systemPrompt) args.push("--append-system-prompt", options.systemPrompt);
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.resume) args.push("--resume", options.resume);
    // In -p mode an API key in the environment is always used when present; without one Claude Code uses its
    // own login. CLAUDECODE marks a process as running inside Claude Code, which this child is not.
    const env = agentEnv(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"]);
    this.#process = new Deno.Command(command, { args, cwd, env, clearEnv: true, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    this.#stdin = this.#process.stdin.getWriter();
    readLines(this.#process.stdout, (line) => this.#onLine(line));
    readLines(this.#process.stderr, (line) => { if (line.trim()) this.push({ t: "stderr", text: clip(line, 600) }); });
    this.#process.status.then((status) => { this.exited = status.code; this.busy = false; this.push({ t: "exit", code: status.code }); });
  }

  async #write(message: unknown) {
    if (this.exited !== null) throw new Error("the Claude process has ended");
    await this.#stdin.write(this.#encoder.encode(JSON.stringify(message) + "\n"));
  }

  #onLine(line: string) {
    // deno-lint-ignore no-explicit-any
    let event: any;
    try { event = JSON.parse(line); } catch { if (line.trim()) this.push({ t: "stderr", text: clip(line, 600) }); return; }
    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          this.sessionId = event.session_id; this.model = event.model;
          this.push({ t: "init", sessionId: event.session_id, model: event.model, mode: event.permissionMode, cwd: event.cwd, version: event.claude_code_version });
        }
        break;
      case "stream_event": {
        const inner = event.event;
        if (inner?.type === "content_block_start" && inner.content_block?.type === "thinking") this.push({ t: "thinking" });
        if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") this.push({ t: "tool_start", id: inner.content_block.id, name: inner.content_block.name });
        if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") this.push({ t: "delta", text: inner.delta.text });
        break;
      }
      case "assistant": {
        if (event.parent_tool_use_id) break;  // a subagent's own messages: its result reaches the main thread as a tool result
        // deno-lint-ignore no-explicit-any
        const blocks = (event.message?.content ?? []).map((block: any) =>
          block.type === "text" ? { type: "text", text: block.text }
            : block.type === "tool_use" ? { type: "tool", id: block.id, name: block.name, input: block.input }
            : null).filter(Boolean);
        if (blocks.length) this.push({ t: "assistant", id: event.message?.id, blocks });
        break;
      }
      case "user": {
        if (event.parent_tool_use_id) break;
        const content = event.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) if (block?.type === "tool_result") this.push({ t: "tool_result", id: block.tool_use_id, text: clip(resultText(block.content)), error: !!block.is_error });
        break;
      }
      case "control_request": {
        const request = event.request ?? {};
        if (request.subtype === "can_use_tool") {
          this.#pending.set(event.request_id, request.input ?? {});
          this.push({ t: "permission", requestId: event.request_id, tool: request.tool_name, title: `use ${request.display_name ?? request.tool_name}`, input: request.input ?? {}, description: request.description ?? "" });
        } else {
          // Nothing else was asked for at start-up (no hooks, no SDK MCP servers): say so rather than leave it waiting.
          this.#write({ type: "control_response", response: { subtype: "error", request_id: event.request_id, error: `unsupported request ${request.subtype}` } }).catch(() => {});
        }
        break;
      }
      case "control_cancel_request":
        // The CLI withdrew a prompt it had asked (the turn was interrupted, a rule answered it).
        if (this.#pending.delete(event.request_id)) this.push({ t: "permission_answer", requestId: event.request_id, allow: false, withdrawn: true });
        break;
      case "result": {
        // A turn the user stopped ends as an error of the CLI's; to the page it was stopped.
        const subtype = this.#stopping ? "interrupted" : event.subtype;
        this.busy = false; this.#stopping = false;
        this.push({ t: "result", ok: !event.is_error, subtype, text: typeof event.result === "string" ? clip(event.result) : "", costUsd: event.total_cost_usd ?? null, ms: event.duration_ms ?? null, turns: event.num_turns ?? null });
        break;
      }
      case "rate_limit_event": {
        const windows = event.rate_limit_info?.unifiedWindows ?? {};
        const list = [["5 h", windows.five_hour], ["7 d", windows.seven_day]].filter(([, window]) => window?.utilization != null).map(([label, window]) => ({ label, used: window.utilization, resetsAt: window.resets_at ?? null }));
        if (list.length) this.push({ t: "limits", status: event.rate_limit_info?.status, windows: list });
        break;
      }
    }
  }

  async send(text: string) {
    this.busy = true;
    this.push({ t: "user", text });
    await this.#write({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } });
  }

  // Allowing hands the tool its input back unchanged. Claude Code has no "for the session" answer on this channel.
  async answer(requestId: string, allow: boolean, options: { message?: string } = {}) {
    if (!this.#pending.has(requestId)) throw new Error("no such permission request (already answered?)");
    const input = this.#pending.get(requestId);
    this.#pending.delete(requestId);
    await this.#write({ type: "control_response", response: { subtype: "success", request_id: requestId, response: allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: options.message || "The user declined this action." } } });
    this.push({ t: "permission_answer", requestId, allow });
  }

  async interrupt() {
    if (!this.busy) return;
    this.#stopping = true;
    await this.#write({ type: "control_request", request_id: crypto.randomUUID(), request: { subtype: "interrupt" } });
  }

  close() {
    try { this.#process.kill("SIGTERM"); } catch { /* already gone */ }
  }
}
