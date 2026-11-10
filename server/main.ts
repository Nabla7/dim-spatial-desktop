// The app's server. Desktop starts it with DIMOS_APP in the environment and forwards everything under
// /apps/<name>/ to its socket. It does two things: serve the page, and run agent sessions (Claude Code)
// that the page talks to. The page reaches every route here with a relative URL; they are private
// routes (dimos.yaml x-private): nothing but this app's own pages may call them.
import { ClaudeSession, findClaude } from "./claude.ts";

const app = JSON.parse(Deno.env.get("DIMOS_APP") ?? "{}");
const flag = (name: string) => { const index = Deno.args.indexOf(name); return index >= 0 ? Deno.args[index + 1] : undefined; };
const frontend = (flag("--frontend") ?? new URL("../frontend", import.meta.url).pathname).replace(/\/+$/, "");
const appName = app.name ?? "dim-spatial-desktop";
const desktopUrl = app.desktopUrl ?? "http://127.0.0.1:5555";

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

// -- agent sessions ---------------------------------------------------------------------------------
const sessions = new Map<string, ClaudeSession>();
const stateFile = app.dataDir ? `${app.dataDir}/agent.json` : null;

async function remembered(): Promise<{ lastSessionId?: string }> {
  if (!stateFile) return {};
  try { return JSON.parse(await Deno.readTextFile(stateFile)); } catch { return {}; }
}

async function remember(state: { lastSessionId?: string }) {
  if (!stateFile) return;
  try { await Deno.mkdir(app.dataDir, { recursive: true }); await Deno.writeTextFile(stateFile, JSON.stringify(state)); } catch { /* the folder is not writable: nothing to resume later */ }
}

// What the agent is told about where it is. It already has the user's own Claude Code setup (settings,
// CLAUDE.md, skills, MCP servers); this adds the place it was started from.
function systemPrompt(): string {
  return [
    `You were started from DimOS Spatial Desktop ("${appName}"), a 3D and WebXR view of the robot blueprint that DimOS runs on this machine. The user talks to you from inside it, often by voice in a headset.`,
    "Write for a small floating panel that shows plain text: short paragraphs, no tables, no headings, little markdown. Lead with the answer.",
    `DimOS Desktop is at ${desktopUrl}. The dimos gateway is ${desktopUrl}/gateways/dimos: GET /active (what runs), GET /active/modules (module instances, their RPCs and streams), POST /active/modules/{id}/rpcs/{name} with {"kwargs": {...}} (call an RPC; JSON values only), GET /active/log. For RPCs that take Python objects use the dimos Python API from the checkout${app.dimosPython ? ` (${app.dimosPython})` : ""}.`,
    `What the user has on screen now: GET ${desktopUrl}/gateways/desktop/views/${appName}. To point at a module in their view: POST ${desktopUrl}/gateways/desktop/views/${appName}/highlight with {"kind": "module", "id": "<module id>"}.`,
    "Do not move a robot, real or simulated, unless the user asked for that motion.",
  ].join("\n");
}

async function createSession(body: { model?: string; resume?: boolean | string; cwd?: string }) {
  const command = await findClaude();
  if (!command) throw new Error("Claude Code (the `claude` command) was not found on this machine");
  const cwd = body.cwd || app.dimosDir || Deno.env.get("HOME") || "/";
  const resume = body.resume === true ? (await remembered()).lastSessionId : typeof body.resume === "string" ? body.resume : undefined;
  // A few idle sessions may stay for their history; beyond that the oldest one that is not working goes.
  const idle = [...sessions.values()].filter((session) => !session.busy).sort((a, b) => a.startedAt - b.startedAt);
  while (sessions.size >= 3 && idle.length) { const old = idle.shift()!; old.close(); sessions.delete(old.id); }
  const session = new ClaudeSession(command, cwd, { systemPrompt: systemPrompt(), model: body.model || undefined, resume });
  sessions.set(session.id, session);
  return session;
}

const describe = (session: ClaudeSession) => ({ id: session.id, sessionId: session.sessionId, model: session.model, busy: session.busy, exited: session.exited, cwd: session.cwd, startedAt: session.startedAt, events: session.events.at(-1)?.seq ?? 0 });

async function agentApi(request: Request, parts: string[]): Promise<Response> {
  const method = request.method;
  const body = method === "POST" ? await request.json().catch(() => ({})) : {};
  if (parts[0] === "status" && method === "GET") {
    const command = await findClaude();
    return json({ available: !!command, command, cwd: app.dimosDir ?? null, lastSessionId: (await remembered()).lastSessionId ?? null, sessions: [...sessions.values()].map(describe) });
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
      if (session.sessionId) remember({ lastSessionId: session.sessionId });
      return json({ ...found, busy: session.busy, exited: session.exited });
    }
    if (parts[2] === "message" && method === "POST") {
      const text = String(body.text ?? "").trim();
      if (!text) return json({ error: "nothing to send" }, 400);
      await session.send(text);
      return json({ ok: true });
    }
    if (parts[2] === "permission" && method === "POST") { await session.answer(String(body.requestId), !!body.allow, body.message || undefined); return json({ ok: true }); }
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
    return json({ error: "not found" }, 404);
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  return serveFile(url.pathname);
}

addEventListener("unload", () => { for (const session of sessions.values()) session.close(); });
for (const signal of ["SIGTERM", "SIGINT"] as const) Deno.addSignalListener(signal, () => { for (const session of sessions.values()) session.close(); Deno.exit(0); });

if (app.socket) {
  try { await Deno.remove(app.socket); } catch { /* no stale socket */ }
  Deno.serve({ path: app.socket, onListen: () => console.log(`spatial desktop: page ${frontend}, socket ${app.socket}`) }, handler);
} else {
  // Run by hand (no Desktop): a local port, for trying the server alone.
  const port = Number(flag("--port") ?? 8765);
  Deno.serve({ port, hostname: "127.0.0.1", onListen: () => console.log(`spatial desktop: page ${frontend}, http://127.0.0.1:${port}/`) }, handler);
}
