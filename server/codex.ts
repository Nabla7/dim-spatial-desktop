// A Codex session: `codex app-server` as a child process, spoken to in its JSON-RPC protocol (one JSON
// object per line on stdin and stdout; requests carry an id, notifications do not, and the server asks
// the host for approvals with requests of its own). The login is the one `codex` already has (ChatGPT),
// and the model, sandbox and approval policy are the user's own Codex config unless the page overrides
// the model or the effort.
//
// The protocol's shapes come from `codex app-server generate-ts`; they were checked against codex 0.160.
import { AgentSession, agentEnv, type Choice, clip, findCommand, readLines, type SessionOptions } from "./session.ts";

export const findCodex = () => findCommand(["codex"], ["~/.codex/packages/standalone/current/bin/codex"]);

export const CODEX_EFFORTS: Choice[] = [{ id: "", label: "default" }, { id: "low", label: "low" }, { id: "medium", label: "medium" }, { id: "high", label: "high" }, { id: "xhigh", label: "xhigh" }];

const CLIENT = { name: "dimos-spatial-desktop", title: "DimOS Spatial Desktop", version: "0.1.0" };

// deno-lint-ignore no-explicit-any
type Json = any;

// The app server's wire, without the conversation: send a request and await its answer, hear the rest.
class Wire {
  process: Deno.ChildProcess;
  ended: number | null = null;
  #stdin: WritableStreamDefaultWriter<Uint8Array>;
  #encoder = new TextEncoder();
  #next = 0;
  #replies = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void }>();

  constructor(command: string, cwd: string, onMessage: (message: Json) => void, onStderr: (line: string) => void, onExit: (code: number) => void) {
    // An API key in the environment would be billed instead of the ChatGPT login.
    const env = agentEnv(["OPENAI_API_KEY", "CODEX_API_KEY"]);
    this.process = new Deno.Command(command, { args: ["app-server"], cwd, env, clearEnv: true, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    this.#stdin = this.process.stdin.getWriter();
    readLines(this.process.stdout, (line) => {
      let message: Json;
      try { message = JSON.parse(line); } catch { if (line.trim()) onStderr(line); return; }
      // An answer to one of ours has an id and no method; anything with a method is the server speaking first.
      if (message.method === undefined && message.id !== undefined) {
        const reply = this.#replies.get(message.id);
        this.#replies.delete(message.id);
        if (message.error) reply?.reject(new Error(message.error.message ?? "request failed")); else reply?.resolve(message.result);
      } else onMessage(message);
    });
    readLines(this.process.stderr, (line) => { if (line.trim()) onStderr(line); });
    this.process.status.then((status) => {
      this.ended = status.code;
      for (const reply of this.#replies.values()) reply.reject(new Error("Codex ended"));
      this.#replies.clear();
      onExit(status.code);
    });
  }

  async write(message: Json) {
    if (this.ended !== null) throw new Error("the Codex process has ended");
    await this.#stdin.write(this.#encoder.encode(JSON.stringify(message) + "\n"));
  }

  request(method: string, params?: Json): Promise<Json> {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#replies.set(id, { resolve, reject });
      this.write(params === undefined ? { method, id } : { method, id, params }).catch((error) => { this.#replies.delete(id); reject(error); });
    });
  }

  async open() {
    await this.request("initialize", { clientInfo: CLIENT, capabilities: null });
    await this.write({ method: "initialized" });
  }

  close() {
    try { this.process.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

// The models this login may use, asked of a short-lived app server and kept for the life of this one.
let models: Promise<Choice[]> | null = null;
export function codexModels(command: string): Promise<Choice[]> {
  return models ??= (async () => {
    const wire = new Wire(command, Deno.env.get("HOME") ?? "/", () => {}, () => {}, () => {});
    try {
      await wire.open();
      const listed = await wire.request("model/list", {});
      // deno-lint-ignore no-explicit-any
      return [{ id: "", label: "default" }, ...listed.data.filter((model: any) => !model.hidden).map((model: any) => ({ id: model.id, label: String(model.displayName || model.id).replace(/^GPT-/i, "") }))];
    } finally { wire.close(); }
  })().catch(() => { models = null; return [{ id: "", label: "default" }]; });
}

// "/bin/zsh -lc '…'" is how Codex runs a command; the panel shows the command.
function shown(item: Json): string {
  const actions = Array.isArray(item.commandActions) ? item.commandActions.map((action: Json) => action?.command).filter(Boolean) : [];
  return actions.length ? actions.join(" && ") : String(item.command ?? "");
}

const windowLabel = (minutes: number | null) => minutes == null ? "usage" : minutes >= 1440 ? `${Math.round(minutes / 1440)} d` : `${Math.round(minutes / 60)} h`;

export class CodexSession extends AgentSession {
  readonly backend = "codex";
  #wire: Wire;
  #ready: Promise<void>;
  #threadId: string | null = null;
  #turnId: string | null = null;
  #effort: string | undefined;
  #answerText = "";
  #tokens: number | null = null;
  #items = new Map<string, Json>();                                              // started items, for an approval that names one
  #pending = new Map<string, { rpcId: number | string; method: string; params: Json }>();  // our prompt id -> the server's request

  constructor(command: string, cwd: string, options: SessionOptions = {}) {
    super(command, cwd);
    this.#effort = options.effort || undefined;
    this.#wire = new Wire(command, cwd, (message) => this.#onMessage(message), (line) => this.push({ t: "stderr", text: clip(line, 600) }),
      (code) => { this.exited = code; this.busy = false; this.push({ t: "exit", code }); });
    this.#ready = this.#open(options);
    this.#ready.catch((error) => { this.push({ t: "note", text: `Codex did not start a conversation: ${error.message}` }); this.#wire.close(); });
  }

  async #open(options: SessionOptions) {
    await this.#wire.open();
    const params = { cwd: this.cwd, model: options.model || null, developerInstructions: options.systemPrompt || null };
    const started = options.resume ? await this.#wire.request("thread/resume", { threadId: options.resume, ...params }) : await this.#wire.request("thread/start", params);
    this.#threadId = started.thread.id; this.sessionId = started.thread.id; this.model = started.model;
    this.push({ t: "init", sessionId: this.sessionId, model: started.model, mode: typeof started.approvalPolicy === "string" ? started.approvalPolicy : "granular", sandbox: started.sandbox?.type ?? null,
      effort: this.#effort ?? started.reasoningEffort ?? null, cwd: started.cwd, version: started.thread.cliVersion });
    // A resumed conversation comes with what was said in it.
    for (const turn of started.thread.turns ?? []) for (const item of turn.items ?? []) {
      if (item.type === "userMessage") this.push({ t: "user", text: (item.content ?? []).map((part: Json) => part.text ?? "").join(""), past: true });
      if (item.type === "agentMessage" && item.text) this.push({ t: "assistant", id: item.id, blocks: [{ type: "text", text: item.text }] });
    }
    if (options.resume) this.push({ t: "result", ok: true, subtype: "resumed", text: "", costUsd: null, ms: null, turns: null, past: true });
    this.#wire.request("account/rateLimits/read").then((answer) => this.#limits(answer.rateLimits)).catch(() => {});
  }

  #limits(snapshot: Json) {
    const windows = [snapshot?.primary, snapshot?.secondary].filter(Boolean).map((window: Json) => ({ label: windowLabel(window.windowDurationMins), used: window.usedPercent / 100, resetsAt: window.resetsAt ?? null }));
    if (windows.length) this.push({ t: "limits", status: snapshot.rateLimitReachedType ?? null, windows });
  }

  #onMessage(message: Json) {
    if (message.id !== undefined) this.#onRequest(message); else this.#onNotification(message.method, message.params ?? {});
  }

  // The server asks; the page answers through answer().
  #onRequest(message: Json) {
    const { method, params = {} } = message;
    const ask = (event: Record<string, unknown>) => {
      const requestId = crypto.randomUUID();
      this.#pending.set(requestId, { rpcId: message.id, method, params });
      this.push({ t: "permission", requestId, ...event });
    };
    const item = this.#items.get(params.itemId) ?? {};
    switch (method) {
      case "item/commandExecution/requestApproval":
        ask({ tool: "Shell", title: "run a command outside its sandbox", input: { command: shown({ ...item, ...params }), cwd: params.cwd ?? item.cwd }, description: params.reason ?? "", session: true });
        break;
      case "item/fileChange/requestApproval":
        ask({ tool: "Edit", title: "change files", input: { files: (item.changes ?? []).map((change: Json) => change.path), root: params.grantRoot ?? undefined }, description: params.reason ?? "", session: true });
        break;
      case "item/permissions/requestApproval":
        ask({ tool: "Permissions", title: "have more access", input: params.permissions ?? {}, description: params.reason ?? "", session: true });
        break;
      case "item/tool/requestUserInput":
        // Questions with options are a terminal form; here the question is shown and the agent told to ask in the chat.
        this.push({ t: "note", text: `Codex asked: ${(params.questions ?? []).map((question: Json) => question.question).join(" / ")}  (answer in the chat)` });
        this.#wire.write({ id: message.id, result: { answers: {} } }).catch(() => {});
        break;
      case "mcpServer/elicitation/request":
        this.#wire.write({ id: message.id, result: { action: "decline", content: null, _meta: null } }).catch(() => {});
        break;
      default:
        this.#wire.write({ id: message.id, error: { code: -32601, message: `this host does not answer ${method}` } }).catch(() => {});
    }
  }

  #onNotification(method: string, params: Json) {
    const item = params.item ?? {};
    switch (method) {
      case "turn/started": this.#turnId = params.turn?.id ?? this.#turnId; this.busy = true; break;
      case "item/started": {
        if (item.id) this.#items.set(item.id, item);
        const tool = (name: string, input: Json) => this.push({ t: "assistant", id: item.id, blocks: [{ type: "tool", id: item.id, name, input }] });
        if (item.type === "reasoning") this.push({ t: "thinking" });
        else if (item.type === "commandExecution") tool("Shell", { command: shown(item), cwd: item.cwd });
        else if (item.type === "fileChange") tool("Edit", { files: (item.changes ?? []).map((change: Json) => change.path) });
        else if (item.type === "mcpToolCall") tool(`${item.server}.${item.tool}`, item.arguments ?? {});
        else if (item.type === "dynamicToolCall") tool(item.tool, item.arguments ?? {});
        else if (item.type === "collabAgentToolCall") tool(`Agent.${item.tool}`, { description: item.prompt ?? "" });
        else if (item.type === "webSearch") tool("WebSearch", { query: item.query ?? "" });
        else if (item.type === "imageView") tool("ViewImage", { file_path: item.path });
        break;
      }
      case "item/agentMessage/delta": this.push({ t: "delta", text: params.delta ?? "" }); break;
      case "item/completed": {
        this.#items.delete(item.id);
        const result = (text: string, error: boolean) => this.push({ t: "tool_result", id: item.id, text: clip(text), error });
        if (item.type === "agentMessage") { this.#answerText = item.text ?? ""; this.push({ t: "assistant", id: item.id, blocks: [{ type: "text", text: item.text ?? "" }] }); }
        else if (item.type === "commandExecution") result(item.aggregatedOutput || (item.status === "declined" ? "not run (declined)" : `exit ${item.exitCode ?? "?"}`), item.status !== "completed" || (item.exitCode ?? 0) !== 0);
        else if (item.type === "fileChange") result(item.status === "completed" ? (item.changes ?? []).map((change: Json) => `${change.kind?.type ?? change.kind ?? "changed"} ${change.path}`).join("\n") : String(item.status), item.status !== "completed");
        else if (item.type === "mcpToolCall") result(item.error?.message ?? (item.result?.content ?? []).map((part: Json) => part?.text ?? JSON.stringify(part)).join("\n"), !!item.error);
        else if (item.type === "dynamicToolCall") result((item.contentItems ?? []).map((part: Json) => part?.text ?? JSON.stringify(part)).join("\n"), item.success === false);
        else if (["collabAgentToolCall", "webSearch", "imageView"].includes(item.type)) result("", false);
        break;
      }
      case "serverRequest/resolved":
        // A prompt that was settled without the page (the turn was interrupted, a rule answered it).
        for (const [requestId, asked] of this.#pending) if (asked.rpcId === params.requestId) { this.#pending.delete(requestId); this.push({ t: "permission_answer", requestId, allow: false, withdrawn: true }); }
        break;
      case "thread/tokenUsage/updated": this.#tokens = params.tokenUsage?.total?.totalTokens ?? this.#tokens; break;
      case "account/rateLimits/updated": this.#limits(params.rateLimits); break;
      case "model/rerouted": this.model = params.toModel ?? this.model; this.push({ t: "note", text: `Codex answered with ${params.toModel} instead of ${params.fromModel}.` }); break;
      case "error": if (!params.willRetry) this.push({ t: "note", text: params.error?.message ?? "Codex reported an error." }); break;
      case "turn/completed": {
        const turn = params.turn ?? {}, ok = turn.status === "completed";
        this.busy = false; this.#turnId = null;
        this.push({ t: "result", ok, subtype: turn.status, text: clip(turn.status === "failed" ? turn.error?.message ?? "" : this.#answerText), costUsd: null, ms: turn.durationMs ?? null, turns: null, tokens: this.#tokens });
        this.#answerText = "";
        break;
      }
    }
  }

  async send(text: string) {
    await this.#ready;
    const input = [{ type: "text", text, text_elements: [] }];
    this.push({ t: "user", text });
    // A message sent while a turn runs joins that turn.
    if (this.busy && this.#turnId) { await this.#wire.request("turn/steer", { threadId: this.#threadId, expectedTurnId: this.#turnId, input }); return; }
    this.busy = true;
    try {
      const started = await this.#wire.request("turn/start", { threadId: this.#threadId, input, ...(this.#effort ? { effort: this.#effort } : {}) });
      this.#turnId = started.turn?.id ?? this.#turnId;
    } catch (error) { this.busy = false; throw error; }
  }

  async answer(requestId: string, allow: boolean, options: { session?: boolean } = {}) {
    const asked = this.#pending.get(requestId);
    if (!asked) throw new Error("no such permission request (already answered?)");
    this.#pending.delete(requestId);
    const result = asked.method === "item/permissions/requestApproval"
      ? { permissions: allow ? Object.fromEntries(Object.entries(asked.params.permissions ?? {}).filter(([, value]) => value != null)) : {}, scope: options.session ? "session" : "turn" }
      : { decision: allow ? (options.session ? "acceptForSession" : "accept") : "decline" };
    await this.#wire.write({ id: asked.rpcId, result });
    this.push({ t: "permission_answer", requestId, allow });
  }

  async interrupt() {
    if (this.#threadId && this.#turnId) await this.#wire.request("turn/interrupt", { threadId: this.#threadId, turnId: this.#turnId });
  }

  close() { this.#wire.close(); }
}
