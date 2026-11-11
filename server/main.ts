// The app's server. Desktop starts it with DIMOS_APP in the environment and forwards everything under
// /apps/<name>/ to its socket. It serves the page, runs agent sessions (Claude Code, Codex) that the page
// talks to, and reads recorded episodes for the page's replay. The page reaches every route here with a
// relative URL; they are private routes (dimos.yaml x-private): nothing but this app's own pages may call them.
import { CLAUDE_EFFORTS, CLAUDE_MODELS, ClaudeSession, findClaude } from "./claude.ts";
import { CODEX_EFFORTS, codexModels, CodexSession, findCodex } from "./codex.ts";
import type { AgentSession, Choice, SessionOptions } from "./session.ts";
import { methodSource } from "./source.ts";
import { Replay } from "./replay.ts";

const app = JSON.parse(Deno.env.get("DIMOS_APP") ?? "{}");
const flag = (name: string) => { const index = Deno.args.indexOf(name); return index >= 0 ? Deno.args[index + 1] : undefined; };
const frontend = (flag("--frontend") ?? new URL("../frontend", import.meta.url).pathname).replace(/\/+$/, "");
const appName = app.name ?? "dim-spatial-desktop";
const desktopUrl = app.desktopUrl ?? "http://127.0.0.1:5555";
const replay = new Replay(app);

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", woff2: "font/woff2", txt: "text/plain; charset=utf-8", wasm: "application/wasm",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function serveFile(pathname: string): Promise<Response> {
  let relative = decodeURIComponent(pathname);
  if (relative.endsWith("/")) relative += "index.html";
  // Nothing above the page's folder, and no dotfiles.
  if (relative.split("/").some((part) => part === ".." || part.startsWith("."))) return new Response("not found", { status: 404 });
  try {
    const file = await Deno.open(frontend + relative, { read: true });
    const extension = relative.split(".").pop() ?? "";
    return new Response(file.readable, { headers: { "content-type": TYPES[extension] ?? "application/octet-stream", "cache-control": "no-cache" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

// -- which build of the page this is ------------------------------------------------------------------
// An open page asks now and then and reloads itself when the answer changes, so a page left open (in a
// Desktop window, in a headset) is never an old one. The stamp is where the page is served from and the
// newest change under it: a new build is a new folder, and a working tree served as it is (development)
// changes with every save.
let stamped = { at: 0, value: "" };
async function newest(dir: string): Promise<number> {
  let latest = 0;
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".") || entry.name === "vendor") continue;
    const path = `${dir}/${entry.name}`;
    latest = Math.max(latest, entry.isDirectory ? await newest(path) : (await Deno.stat(path)).mtime?.getTime() ?? 0);
  }
  return latest;
}
async function version(): Promise<string> {
  if (Date.now() - stamped.at > 1000) stamped = { at: Date.now(), value: `${frontend}@${await newest(frontend).catch(() => 0)}` };
  return stamped.value;
}

// -- the code behind an RPC ---------------------------------------------------------------------------
// GET api/source?class=<dotted path of the module class>&method=<name>: that method's Python source, from
// the dimos checkout Desktop runs (read as text, never imported).
async function source(url: URL): Promise<Response> {
  if (!app.dimosDir) return json({ error: "Desktop did not say where its dimos checkout is" }, 404);
  const found = await methodSource(String(app.dimosDir).replace(/\/+$/, ""), url.searchParams.get("class") ?? "", url.searchParams.get("method") ?? "").catch(() => null);
  if (!found) return json({ error: "not found in the dimos checkout" }, 404);
  const lines = found.text.split("\n");
  return json({ ...found, text: lines.slice(0, 160).join("\n"), lines: lines.length });
}

// -- agent sessions ---------------------------------------------------------------------------------
// A backend is a coding agent's own command-line program on this machine, run with the login it has.
type Backend = {
  id: string; label: string; missing: string;
  find: () => Promise<string | null>;
  models: (command: string) => Promise<Choice[]> | Choice[];
  efforts: Choice[];
  start: (command: string, cwd: string, options: SessionOptions) => AgentSession;
};
const BACKENDS: Backend[] = [
  { id: "claude", label: "Claude Code", missing: "Claude Code (the `claude` command) was not found on this machine.", find: findClaude, models: () => CLAUDE_MODELS, efforts: CLAUDE_EFFORTS,
    start: (command, cwd, options) => new ClaudeSession(command, cwd, options) },
  { id: "codex", label: "Codex", missing: "Codex (the `codex` command) was not found on this machine.", find: findCodex, models: codexModels, efforts: CODEX_EFFORTS,
    start: (command, cwd, options) => new CodexSession(command, cwd, options) },
];

const sessions = new Map<string, AgentSession>();
const stateFile = app.dataDir ? `${app.dataDir}/agent.json` : null;
type Remembered = { last?: Record<string, string> };

async function remembered(): Promise<Remembered> {
  if (!stateFile) return {};
  try { return JSON.parse(await Deno.readTextFile(stateFile)); } catch { return {}; }
}

// The conversation each backend had last, so it can be continued after the server or the machine restarts.
const noted = new Map<string, string>();
async function remember(session: AgentSession) {
  if (!stateFile || !session.sessionId || noted.get(session.backend) === session.sessionId) return;
  noted.set(session.backend, session.sessionId);
  try {
    const state = await remembered();
    state.last = { ...state.last, [session.backend]: session.sessionId };
    await Deno.mkdir(app.dataDir, { recursive: true }); await Deno.writeTextFile(stateFile, JSON.stringify(state));
  } catch { /* the folder is not writable: nothing to resume later */ }
}

// What the agent is told about where it is. It already has the user's own Claude Code setup (settings,
// CLAUDE.md, skills, MCP servers); this adds the place it was started from.
function systemPrompt(): string {
  return [
    `You were started from DimOS Spatial Desktop ("${appName}"), a 3D and WebXR view of the robot blueprint that DimOS runs on this machine. The user talks to you from inside it, often by voice in a headset.`,
    "Write for a small floating panel that shows plain text: short paragraphs, no tables, no headings, little markdown. Lead with the answer.",
    `DimOS Desktop is at ${desktopUrl}. The dimos gateway is ${desktopUrl}/gateways/dimos: GET /active (what runs), GET /active/modules (module instances, their RPCs and streams), POST /active/modules/{id}/rpcs/{name} with {"kwargs": {...}} (call an RPC; JSON values only), GET /active/log. For RPCs that take Python objects use the dimos Python API from the checkout${app.dimosPython ? ` (${app.dimosPython})` : ""}.`,
    `What the user has on screen now: GET ${desktopUrl}/gateways/desktop/views/${appName}. To point at a module in their view: POST ${desktopUrl}/gateways/desktop/views/${appName}/highlight with {"kind": "module", "id": "<module id>"}.`,
    "When that view has `replay`, the user is looking at a recorded episode instead of the live blueprint: `replay.folder` holds its metadata.json and its MCAP (one JSON frame per control step, schema dimos.learning.frame.v1: joint state, action, PNG images, time stamps), and `replay.frame` is where the playhead is.",
    "Do not move a robot, real or simulated, unless the user asked for that motion.",
  ].join("\n");
}

async function createSession(body: { backend?: string; model?: string; effort?: string; resume?: boolean | string; cwd?: string }) {
  const backend = BACKENDS.find((entry) => entry.id === (body.backend || "claude"));
  if (!backend) throw new Error(`no such agent backend: ${body.backend}`);
  const command = await backend.find();
  if (!command) throw new Error(backend.missing);
  const cwd = body.cwd || app.dimosDir || Deno.env.get("HOME") || "/";
  const resume = body.resume === true ? (await remembered()).last?.[backend.id] : typeof body.resume === "string" ? body.resume : undefined;
  // A few idle sessions may stay for their history; beyond that the oldest one that is not working goes.
  const idle = [...sessions.values()].filter((session) => !session.busy).sort((a, b) => a.startedAt - b.startedAt);
  while (sessions.size >= 4 && idle.length) { const old = idle.shift()!; old.close(); sessions.delete(old.id); }
  const session = backend.start(command, cwd, { systemPrompt: systemPrompt(), model: body.model || undefined, effort: body.effort || undefined, resume });
  sessions.set(session.id, session);
  return session;
}

const describe = (session: AgentSession) => ({ id: session.id, backend: session.backend, sessionId: session.sessionId, model: session.model, busy: session.busy, exited: session.exited, cwd: session.cwd, startedAt: session.startedAt, events: session.events.at(-1)?.seq ?? 0 });

// A slow answer about the models must not hold the status up.
const within = <T>(promise: Promise<T> | T, ms: number, fallback: T) => Promise.race([Promise.resolve(promise), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

async function agentApi(request: Request, parts: string[]): Promise<Response> {
  const method = request.method;
  const body = method === "POST" ? await request.json().catch(() => ({})) : {};
  if (parts[0] === "status" && method === "GET") {
    const last = (await remembered()).last ?? {};
    const backends = await Promise.all(BACKENDS.map(async (backend) => {
      const command = await backend.find();
      return { id: backend.id, label: backend.label, available: !!command, command, reason: command ? "" : backend.missing, lastSessionId: last[backend.id] ?? null,
        models: command ? await within(backend.models(command), 4000, [{ id: "", label: "default" }]) : [], efforts: backend.efforts };
    }));
    return json({ backends, cwd: app.dimosDir ?? null, sessions: [...sessions.values()].map(describe) });
  }
  if (parts[0] !== "sessions") return json({ error: "not found" }, 404);
  if (parts.length === 1 && method === "POST") {
    try { return json(describe(await createSession(body))); } catch (error) { return json({ error: (error as Error).message }, 500); }
  }
  const session = sessions.get(parts[1] ?? "");
  if (!session) return json({ error: "no such session (the server may have restarted)" }, 404);
  try {
    if (parts.length === 2 && method === "DELETE") { session.close(); sessions.delete(session.id); return json({ ok: true }); }
    if (parts[2] === "events" && method === "GET") {
      const url = new URL(request.url), after = Number(url.searchParams.get("after") ?? 0), wait = Math.min(25, Number(url.searchParams.get("wait") ?? 0)) * 1000;
      const found = await session.eventsAfter(after, wait);
      remember(session);
      return json({ ...found, busy: session.busy, exited: session.exited });
    }
    if (parts[2] === "message" && method === "POST") {
      const text = String(body.text ?? "").trim();
      if (!text) return json({ error: "nothing to send" }, 400);
      await session.send(text);
      return json({ ok: true });
    }
    if (parts[2] === "permission" && method === "POST") { await session.answer(String(body.requestId), !!body.allow, { message: body.message || undefined, session: !!body.session }); return json({ ok: true }); }
    if (parts[2] === "interrupt" && method === "POST") { await session.interrupt(); return json({ ok: true }); }
  } catch (error) {
    return json({ error: (error as Error).message }, 400);
  }
  return json({ error: "not found" }, 404);
}

function handler(request: Request): Response | Promise<Response> {
  const url = new URL(request.url), parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "api") {
    if (parts[1] === "agent") return agentApi(request, parts.slice(2));
    if (parts[1] === "version" && request.method === "GET") return version().then((stamp) => json({ stamp }));
    if (parts[1] === "source" && request.method === "GET") return source(url);
    if (parts[1] === "replay") return replay.handle(request, parts.slice(2), url);
    return json({ error: "not found" }, 404);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  return serveFile(url.pathname);
}

const shutDown = () => { for (const session of sessions.values()) session.close(); replay.close(); };
addEventListener("unload", shutDown);
for (const signal of ["SIGTERM", "SIGINT"] as const) Deno.addSignalListener(signal, () => { shutDown(); Deno.exit(0); });

if (app.socket) {
  try { await Deno.remove(app.socket); } catch { /* no stale socket */ }
  Deno.serve({ path: app.socket, onListen: () => console.log(`spatial desktop: page ${frontend}, socket ${app.socket}`) }, handler);
} else {
  // Run by hand (no Desktop): a local port, for trying the server alone.
  const port = Number(flag("--port") ?? 8765);
  Deno.serve({ port, hostname: "127.0.0.1", onListen: () => console.log(`spatial desktop: page ${frontend}, http://127.0.0.1:${port}/`) }, handler);
}
