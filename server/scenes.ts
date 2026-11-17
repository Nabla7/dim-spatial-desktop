// Scenes: USD stages a person walks through, checks, marks and hands to an agent (docs/SCENES.md).
// A scene is found by its manifest (`scene.json`, standard dimos.scene/...) under Desktop's app data, or
// is added by the path of a manifest, a USD file or a folder. Listing, pins, revisions and the files a
// browser draws are handled here. Reading the USD is done by scenes/worker.py, deriving what a browser
// draws by scenes/derive.py and checking by scenes/check.py: Python processes run with a dimos checkout's
// Python that has OpenUSD and MuJoCo's USD importer, so a scene is read by the loader sim2 itself uses.
// Nothing here writes into a scene's folder: what is made is kept under this app's own data folder.
// A MuJoCo scene (MJCF) is taken in as a scene of its own: Desktop's dimos converts it to a USD with no
// robot in it, kept under `scenes/imported` with a manifest. To run a robot in a scene, the same dimos
// puts the robot of a sim2 blueprint in it and the launch is given that file.
import { type Answer, container, dirname, exists, follow, home, type Job, json, PythonWorker, readJson, type Runtime, shortHash } from "./worker.ts";

export type ScenesApp = { dataDir?: string; dimosDir?: string; dimosPython?: string };
type Scene = { id: string; name: string; manifest: string | null; usd: string; project: string; where: string; added: boolean; at: number };
type Revision = { n: number; usd: string; label: string; at: number; state: "original" | "proposed" | "kept" | "rejected"; note?: string };
type Pin = { n: number; position: number[]; note: string; at: number; revision: number; state: "open" | "resolved"; seen?: string | null; solid?: string | null; gap?: number | null; camera?: unknown; snapshot?: string | null };
type Body = { radius: number; height: number; step: number };

const WORKER = new URL("./scenes/worker.py", import.meta.url).pathname;
const DERIVE = new URL("./scenes/derive.py", import.meta.url).pathname;
const CHECK = new URL("./scenes/check.py", import.meta.url).pathname;
const GUIDE = new URL("../docs/SCENES.md", import.meta.url).pathname;
const USD = /\.usd[acz]?$/i;
const TYPES: Record<string, string> = { glb: "model/gltf-binary", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", json: "application/json" };
// Asked of a Python once, to learn whether it can read a scene and whether it has dimos's own loader.
const PROBE = "import importlib, pxr, mujoco\nimportlib.import_module('mujoco._usd')\ntry:\n    import dimos.sim2.geometry.mujoco, dimos.robot.assets.model\n    print('dimos')\nexcept Exception:\n    print('usd')";

// What is derived from a scene's revisions is kept for this many of them, the ones used last.
const KEPT = 6;
// The body an imported scene promises room for at its start place: a wheeled robot with two arms.
const IMPORT_BODY: Body = { radius: 0.45, height: 1.7, step: 0.05 };

const bodyKey = (body: Body) => `r${body.radius}-h${body.height}-s${body.step}`;

async function file(path: string): Promise<Response> {
  try {
    const handle = await Deno.open(path, { read: true }), stat = await handle.stat();
    if (!stat.isFile) { handle.close(); return json({ error: "not found" }, 404); }
    const type = TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
    return new Response(handle.readable, { headers: { "content-type": type, "content-length": String(stat.size), "cache-control": "private, max-age=3600" } });
  } catch { return json({ error: "not found" }, 404); }
}

export class Scenes {
  #app: ScenesApp;
  #scenes: Scene[] = [];
  #scanned = 0;
  #runtime: Promise<Runtime> | null = null;
  #worker: PythonWorker | null = null;
  #described = new Map<string, { at: number; meta: Record<string, unknown> }>();
  #jobs = new Map<string, Job>();
  #diffs = new Map<string, unknown>();
  #children = new Set<Deno.ChildProcess>();

  constructor(app: ScenesApp) {
    this.#app = app;
    // The reader holds a compiled scene in memory: one that nobody asked for a while is let go.
    setInterval(() => { if (this.#worker && (this.#worker.dead || Date.now() - this.#worker.used > 15 * 60_000)) { this.#worker.close(); this.#worker = null; } }, 60_000);
  }

  get #store() {
    if (!this.#app.dataDir) throw new Error("this app has no data folder, so it cannot keep what it makes for a scene");
    return `${this.#app.dataDir}/scenes`;
  }

  // -- the library --------------------------------------------------------------------------------------
  async #added(): Promise<string[]> {
    const saved = this.#app.dataDir ? await readJson(`${this.#store}/added.json`) : null;
    return Array.isArray(saved?.paths) ? saved.paths.filter((path: unknown) => typeof path === "string") : [];
  }

  // Manifests anywhere under `root`. A folder with very many subfolders is a store of something else.
  async #search(root: string): Promise<string[]> {
    const found: string[] = [], queue: [string, number][] = [[root, 0]];
    let visited = 0;
    while (queue.length && visited++ < 6000) {
      const [dir, depth] = queue.shift()!;
      const children: string[] = [];
      let manifest = false;
      try {
        for await (const entry of Deno.readDir(dir)) {
          if (entry.isFile && entry.name === "scene.json") manifest = true;
          if (entry.isDirectory && !entry.name.startsWith(".") && entry.name !== "node_modules") children.push(entry.name);
        }
      } catch { continue; }
      if (manifest && String((await readJson(`${dir}/scene.json`))?.standard ?? "").startsWith("dimos.scene/")) found.push(`${dir}/scene.json`);
      // This app's own caches and state hold no scenes.
      if (children.length > 64 || depth >= 7 || /\/scenes\/(cache|state)$/.test(dir)) continue;
      for (const name of children) queue.push([`${dir}/${name}`, depth + 1]);
    }
    return found;
  }

  // The USD a folder holds when it holds exactly one.
  async #onlyUsd(dir: string): Promise<string | null> {
    const found: string[] = [];
    try { for await (const entry of Deno.readDir(dir)) if (entry.isFile && USD.test(entry.name)) found.push(entry.name); } catch { return null; }
    const preferred = found.find((name) => /^(scene|world)\./i.test(name));
    return preferred ? `${dir}/${preferred}` : found.length === 1 ? `${dir}/${found[0]}` : null;
  }

  async #scene(path: string, added: boolean, root: string | null): Promise<Scene | null> {
    let manifest: string | null = null, usd: string | null = null;
    if (path.endsWith("/scene.json")) manifest = path;
    else if (USD.test(path)) { usd = path; if (await exists(`${dirname(path)}/scene.json`)) manifest = `${dirname(path)}/scene.json`; }
    else if (await exists(`${path}/scene.json`)) manifest = `${path}/scene.json`;
    else usd = await this.#onlyUsd(path);
    const record = manifest ? await readJson(manifest) : null;
    if (manifest && !record) return null;
    if (record) {
      const named = typeof record.scene === "string" ? record.scene : null;
      usd = named ? (named.startsWith("/") ? named : `${dirname(manifest!)}/${named}`) : usd ?? await this.#onlyUsd(dirname(manifest!));
    }
    if (!usd || !await exists(usd)) return null;
    const anchor = manifest ?? usd, folder = dirname(anchor);
    const at = (await Deno.stat(usd).catch(() => null))?.mtime?.getTime() ?? 0;
    return {
      id: await shortHash(anchor), name: String(record?.name ?? folder.split("/").pop()), manifest, usd,
      project: typeof record?.project === "string" ? home(record.project) : folder,
      where: root && folder.startsWith(root + "/") ? folder.slice(root.length + 1) : folder, added, at,
    };
  }

  async list(rescan = false): Promise<Scene[]> {
    if (!rescan && Date.now() - this.#scanned < 30_000) return this.#scenes;
    const root = this.#app.dataDir ? dirname(this.#app.dataDir) : null, scenes = new Map<string, Scene>();
    if (root) for (const manifest of [...await this.#search(root), ...await this.#imported()]) { const scene = await this.#scene(manifest, false, root); if (scene) scenes.set(scene.id, scene); }
    for (const path of await this.#added()) { const scene = await this.#scene(path, true, root); if (scene && !scenes.has(scene.id)) scenes.set(scene.id, scene); }
    this.#scenes = [...scenes.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.#scanned = Date.now();
    return this.#scenes;
  }

  // What the user names: a manifest, a USD file, or a folder that holds one of them.
  async add(given: string): Promise<{ scenes: Scene[]; added: string }> {
    const path = home(given);
    if (!path.startsWith("/")) throw new Error("give the full path, starting with /");
    const mujoco = /\.xml$/i.test(path) ? path : await exists(`${path}/scene.xml`) && !await exists(`${path}/scene.usda`) ? `${path}/scene.xml` : null;
    if (mujoco) {
      const scene = await this.#scene(await this.#import(mujoco), false, this.#app.dataDir ? dirname(this.#app.dataDir) : null);
      if (!scene) throw new Error("the scene was converted, but what was written cannot be read as a scene");
      return { scenes: await this.list(true), added: scene.id };
    }
    const scene = await this.#scene(path, true, null);
    if (!scene) throw new Error("no scene there: name a scene.json, a USD file, or a folder that holds a scene.json or one USD file");
    const paths = [...new Set([...(await this.#added()), path])];
    await Deno.mkdir(this.#store, { recursive: true });
    await Deno.writeTextFile(`${this.#store}/added.json`, JSON.stringify({ paths }));
    return { scenes: await this.list(true), added: scene.id };
  }

  // -- scenes taken in from MuJoCo, and a robot put in a scene ----------------------------------------------
  // The manifests of the scenes this app converted. Listed by name: a store of many is not searched.
  async #imported(): Promise<string[]> {
    const found: string[] = [];
    if (!this.#app.dataDir) return found;
    try { for await (const entry of Deno.readDir(`${this.#store}/imported`)) if (entry.isDirectory && await exists(`${this.#store}/imported/${entry.name}/scene.json`)) found.push(`${this.#store}/imported/${entry.name}/scene.json`); } catch { /* none yet */ }
    return found;
  }

  // Desktop's own dimos: it is the one that launches, so what it converts and composes is what it runs.
  async #dimos(module: string, args: string[]): Promise<string> {
    // Desktop names its dimos checkout; the Python is the one in that checkout's environment unless named.
    const python = this.#app.dimosPython ?? (this.#app.dimosDir && await exists(`${this.#app.dimosDir}/.venv/bin/python`) ? `${this.#app.dimosDir}/.venv/bin/python` : null);
    if (!python) throw new Error("Desktop did not say where its dimos is, so a scene cannot be converted or given a robot");
    const run = await new Deno.Command(python, { args: ["-m", module, ...args], cwd: this.#app.dimosDir ?? "/", stdin: "null", stdout: "piped", stderr: "piped", signal: AbortSignal.timeout(900_000) }).output();
    const out = new TextDecoder().decode(run.stdout).trim().split("\n"), err = new TextDecoder().decode(run.stderr).trim().split("\n");
    if (!run.success) throw new Error(err.filter((line) => /Error|error:/.test(line)).pop() ?? err.pop() ?? `${module} failed`);
    return out.pop() ?? "";
  }

  // An MJCF file becomes a scene of this library: a USD with no robot in it, and a manifest whose first
  // place is free floor for IMPORT_BODY near where the source says a robot starts. Naming the same file
  // again converts it again, with the converter dimos has now.
  async #import(xml: string): Promise<string> {
    if (!await exists(xml)) throw new Error(`no file at ${xml}`);
    const name = (/\/scene\.xml$/i.test(xml) ? dirname(xml) : xml.replace(/\.xml$/i, "")).split("/").pop()!.replace(/[^A-Za-z0-9._-]/g, "_");
    const folder = `${this.#store}/imported/${name}`, manifest = `${folder}/scene.json`;
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(xml)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    // A scene directory may say where a robot starts (PimSim's sidecar): look for free floor from there.
    const spawn = Object.values((await readJson(`${dirname(xml)}/scene.json`))?.spawns ?? {})[0] as { position?: number[]; quaternion_xyzw?: number[] } | undefined;
    const [x, y] = spawn?.position ?? [0, 0], [qx, qy, qz, qw] = spawn?.quaternion_xyzw ?? [0, 0, 0, 1];
    const heading = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz)) * 180 / Math.PI;
    await Deno.remove(folder, { recursive: true }).catch(() => {});
    await Deno.mkdir(folder, { recursive: true });
    const report = JSON.parse(await this.#dimos("dimos.sim2.scenes.mjcf", [xml, "--output", folder, "--near", String(x), String(y), "--radius", String(IMPORT_BODY.radius), "--height", String(IMPORT_BODY.height)]));
    await Deno.writeTextFile(manifest, JSON.stringify({
      standard: "dimos.scene/0", name, scene: "scene.usda",
      source: { file: xml, sha256: sha },
      places: report.place ? [{ name: "start", position: report.place, heading: Math.round(heading) }] : [],
      body: IMPORT_BODY,
      // What the conversion could not carry over, for whoever reads the manifest.
      ...(report.welded?.length || report.skipped?.length ? { conversion: { welded: report.welded, skipped: report.skipped } } : {}),
    }, null, 2));
    return manifest;
  }

  // The scene with the robot of a sim2 blueprint standing at its first place: a file a launch is given.
  async compose(scene: Scene, blueprint: string): Promise<{ usd: string; place: unknown }> {
    if (!/^[A-Za-z0-9_-]+$/.test(blueprint)) throw new Error("name a blueprint");
    const record = scene.manifest ? await readJson(scene.manifest) : null, place = record?.places?.[0] ?? null;
    const [x, y, floor] = Array.isArray(place?.position) ? place.position : [0, 0, 0];
    const usd = `${this.#store}/cache/composed/${scene.id}-${blueprint}.usda`;
    const made = (await Deno.stat(usd).catch(() => null))?.mtime?.getTime() ?? 0;
    const changed = Math.max(scene.at, (scene.manifest ? await Deno.stat(scene.manifest).catch(() => null) : null)?.mtime?.getTime() ?? 0);
    if (made <= changed) {
      await Deno.mkdir(dirname(usd), { recursive: true });
      await this.#dimos("dimos.sim2.scenes.compose", ["--blueprint", blueprint, "--environment", scene.usd, "--place", String(x), String(y), String(Number(place?.heading) || 0), "--floor", String(floor ?? 0), "--output", usd]);
    }
    return { usd, place };
  }

  async #find(id: string): Promise<Scene> {
    const scene = (await this.list()).find((entry) => entry.id === id) ?? (await this.list(true)).find((entry) => entry.id === id);
    if (!scene) throw new Error("no such scene (its files may have moved)");
    return scene;
  }

  #state(scene: Scene) { return `${this.#store}/state/${scene.id}`; }

  // -- the Python that reads scenes -----------------------------------------------------------------------
  // A scene is read with OpenUSD and compiled with MuJoCo's USD importer. Desktop's own dimos may have
  // neither, so the checkouts beside it are asked too, and one that also has sim2's loader is preferred.
  #python(): Promise<Runtime> {
    this.#runtime ??= (async () => {
      const probe = async (runtime: Runtime): Promise<string | null> => {
        try {
          const run = new Deno.Command(runtime.python, { args: ["-c", PROBE], cwd: runtime.cwd, stdin: "null", stdout: "piped", stderr: "null", signal: AbortSignal.timeout(40_000) });
          const { code, stdout } = await run.output();
          return code === 0 ? new TextDecoder().decode(stdout).trim() : null;
        } catch { return null; }
      };
      const named = Deno.env.get("DIMOS_SCENES_PYTHON");
      if (named) return { python: named, cwd: dirname(dirname(dirname(named))) };
      const kept = this.#app.dataDir ? await readJson(`${this.#store}/runtime.json`) : null;
      if (kept?.python && await exists(kept.python)) return { python: kept.python, cwd: kept.cwd };
      const candidates: Runtime[] = [];
      if (this.#app.dimosPython) candidates.push({ python: this.#app.dimosPython, cwd: this.#app.dimosDir ?? "/" });
      const beside = this.#app.dimosDir ? dirname(this.#app.dimosDir) : null;
      if (beside) {
        try {
          for await (const entry of Deno.readDir(beside)) if (entry.isDirectory && await exists(`${beside}/${entry.name}/.venv/bin/python`)) candidates.push({ python: `${beside}/${entry.name}/.venv/bin/python`, cwd: `${beside}/${entry.name}` });
        } catch { /* nothing beside it */ }
      }
      let fallback: Runtime | null = null, chosen: Runtime | null = null;
      for (let at = 0; at < candidates.length && !chosen; at += 8) {
        const batch = candidates.slice(at, at + 8), answers = await Promise.all(batch.map(probe));
        chosen = batch.find((_, index) => answers[index] === "dimos") ?? null;
        fallback ??= batch.find((_, index) => answers[index] === "usd") ?? null;
      }
      chosen ??= fallback;
      if (!chosen) throw new Error("no Python here can read a scene: it needs OpenUSD (pxr) and MuJoCo with its USD importer. Name one with DIMOS_SCENES_PYTHON");
      if (this.#app.dataDir) { await Deno.mkdir(this.#store, { recursive: true }); await Deno.writeTextFile(`${this.#store}/runtime.json`, JSON.stringify(chosen)); }
      return chosen;
    })();
    this.#runtime.catch(() => { this.#runtime = null; });
    return this.#runtime;
  }

  async #ask(request: Record<string, unknown>): Promise<Answer> {
    if (!this.#worker || this.#worker.dead) this.#worker = new PythonWorker(WORKER, await this.#python(), "scene reader", 240_000);
    return this.#worker.call(request);
  }

  #run(key: string, args: string[], onLine: (job: Job, line: string) => void, finish: (job: Job, code: number, log: string[]) => Promise<void>): Job {
    const job: Job = { state: "running", startedAt: Date.now() };
    this.#jobs.set(key, job);
    this.#python().then((runtime) => {
      const process = follow(runtime, args, (line) => onLine(job, line), async (code, log) => {
        this.#children.delete(process);
        try { await finish(job, code, log); } catch (error) { job.state = "failed"; job.error = (error as Error).message; }
      });
      this.#children.add(process);
    }).catch((error) => { job.state = "failed"; job.error = error.message; });
    return job;
  }

  // What the stage holds, from the reader. Asked again when the root file has changed.
  async #usd(path: string): Promise<Record<string, unknown>> {
    const at = (await Deno.stat(path).catch(() => null))?.mtime?.getTime() ?? 0, known = this.#described.get(path);
    if (known && known.at === at) return known.meta;
    const { meta } = await this.#ask({ op: "describe", path });
    this.#described.set(path, { at, meta });
    return meta;
  }

  // -- revisions ----------------------------------------------------------------------------------------
  // Revision 0 is the scene as its manifest names it. An agent announces another by dropping a JSON file
  // `{"usd": "/full/path", "label": "what changed"}` into the scene's inbox; the user keeps or rejects it.
  async revisions(scene: Scene): Promise<Revision[]> {
    const folder = this.#state(scene), saved = await readJson(`${folder}/revisions.json`);
    const later: Revision[] = Array.isArray(saved?.revisions) ? saved.revisions : [];
    let changed = false;
    try {
      const drops: string[] = [];
      for await (const entry of Deno.readDir(`${folder}/inbox`)) if (entry.isFile && entry.name.endsWith(".json")) drops.push(entry.name);
      for (const name of drops.sort()) {
        const drop = await readJson(`${folder}/inbox/${name}`), usd = typeof drop?.usd === "string" ? home(drop.usd) : "";
        await Deno.mkdir(`${folder}/inbox/done`, { recursive: true });
        await Deno.rename(`${folder}/inbox/${name}`, `${folder}/inbox/done/${name}`).catch(() => {});
        if (!usd.startsWith("/") || !USD.test(usd) || !await exists(usd) || later.some((revision) => revision.usd === usd)) continue;
        later.push({ n: later.length + 1, usd, label: String(drop.label ?? "a new revision").slice(0, 120), note: drop.note ? String(drop.note).slice(0, 600) : undefined, at: Date.now(), state: "proposed" });
        changed = true;
      }
    } catch { /* no inbox yet */ }
    if (changed) await this.#saveRevisions(scene, later);
    const original = (scene.manifest ? await readJson(scene.manifest) : null)?.revision;
    return [{ n: 0, usd: scene.usd, label: typeof original === "string" ? original : "as its manifest names it", at: scene.at, state: "original" }, ...later];
  }

  async #saveRevisions(scene: Scene, later: Revision[]) {
    await Deno.mkdir(this.#state(scene), { recursive: true });
    await Deno.writeTextFile(`${this.#state(scene)}/revisions.json`, JSON.stringify({ revisions: later }, null, 1));
  }

  async #revision(scene: Scene, n: number): Promise<Revision> {
    const revision = (await this.revisions(scene)).find((entry) => entry.n === n);
    if (!revision) throw new Error("no such revision");
    return revision;
  }

  async publish(scene: Scene, usd: string, label: string): Promise<Revision[]> {
    const path = home(usd);
    if (!path.startsWith("/") || !USD.test(path) || !await exists(path)) throw new Error("a revision is a USD file, named by its full path");
    await Deno.mkdir(`${this.#state(scene)}/inbox`, { recursive: true });
    await Deno.writeTextFile(`${this.#state(scene)}/inbox/${Date.now()}.json`, JSON.stringify({ usd: path, label }));
    return this.revisions(scene);
  }

  async mark(scene: Scene, n: number, state: string): Promise<Revision[]> {
    if (!["kept", "rejected", "proposed"].includes(state) || n < 1) throw new Error("a revision is kept, rejected, or left proposed");
    const later = (await this.revisions(scene)).slice(1), revision = later.find((entry) => entry.n === n);
    if (!revision) throw new Error("no such revision");
    revision.state = state as Revision["state"];
    await this.#saveRevisions(scene, later);
    return this.revisions(scene);
  }

  // -- pins: points the user marked, each with a note ---------------------------------------------------
  async pins(scene: Scene): Promise<Pin[]> {
    const saved = await readJson(`${this.#state(scene)}/pins.json`);
    return Array.isArray(saved?.pins) ? saved.pins : [];
  }

  async #savePins(scene: Scene, pins: Pin[]): Promise<Pin[]> {
    await Deno.mkdir(this.#state(scene), { recursive: true });
    await Deno.writeTextFile(`${this.#state(scene)}/pins.json`, JSON.stringify({ scene: scene.name, frame: "the scene's own: metres, z up", pins }, null, 1));
    return pins;
  }

  async pin(scene: Scene, body: Record<string, unknown>): Promise<Pin[]> {
    const position = Array.isArray(body.position) ? body.position.map(Number) : [];
    if (position.length !== 3 || position.some((value) => !Number.isFinite(value))) throw new Error("a pin needs a point");
    const pins = await this.pins(scene);
    pins.push({
      n: Math.max(0, ...pins.map((pin) => pin.n)) + 1, position, note: String(body.note ?? "").slice(0, 2000), at: Date.now(), revision: Number(body.revision ?? 0), state: "open",
      seen: typeof body.seen === "string" ? body.seen : null, solid: typeof body.solid === "string" ? body.solid : null, gap: Number.isFinite(body.gap) ? Number(body.gap) : null,
      camera: body.camera ?? null, snapshot: typeof body.snapshot === "string" ? body.snapshot : null,
    });
    return this.#savePins(scene, pins);
  }

  async editPin(scene: Scene, n: number, body: Record<string, unknown> | null): Promise<Pin[]> {
    const pins = await this.pins(scene), pin = pins.find((entry) => entry.n === n);
    if (!pin) throw new Error("no such pin");
    if (body === null) return this.#savePins(scene, pins.filter((entry) => entry.n !== n));
    if (typeof body.note === "string") pin.note = body.note.slice(0, 2000);
    if (body.state === "open" || body.state === "resolved") pin.state = body.state;
    if (typeof body.snapshot === "string") pin.snapshot = body.snapshot;
    return this.#savePins(scene, pins);
  }

  // A picture of what the user sees, kept as a file an agent can open.
  async snapshot(scene: Scene, request: Request): Promise<{ path: string }> {
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length < 100 || bytes.length > 12_000_000) throw new Error("that is not a picture");
    const folder = `${this.#state(scene)}/snapshots`, png = bytes[0] === 0x89;
    await Deno.mkdir(folder, { recursive: true });
    const path = `${folder}/${new Date().toISOString().replace(/[:.]/g, "-")}.${png ? "png" : "jpg"}`;
    await Deno.writeFile(path, bytes);
    return { path };
  }

  // -- what one scene is --------------------------------------------------------------------------------
  async #evidence(scene: Scene): Promise<{ camera: unknown; views: Record<string, unknown>[] } | null> {
    const manifest = scene.manifest ? await readJson(scene.manifest) : null, named = manifest?.evidence;
    const record = typeof named === "string" ? await readJson(named.startsWith("/") ? named : `${dirname(scene.manifest!)}/${named}`) : named;
    if (!record || !Array.isArray(record.views)) return null;
    const base = typeof named === "string" ? dirname(named.startsWith("/") ? named : `${dirname(scene.manifest!)}/${named}`) : dirname(scene.manifest!);
    const full = (path: unknown) => typeof path === "string" && path ? (path.startsWith("/") ? path : `${base}/${path}`) : null;
    return { camera: record.camera ?? null, views: record.views.map((view: Record<string, unknown>) => ({ ...view, image: full(view.image), thumbnail: full(view.thumbnail) })) };
  }

  #cache(stamp: string) { return `${this.#store}/cache/${stamp}`; }

  // A revision's view is some hundred megabytes. Before another is made, the ones not used for longest go.
  async #prune(keep: string) {
    const folders: { path: string; at: number }[] = [];
    try {
      for await (const entry of Deno.readDir(`${this.#store}/cache`)) {
        if (!entry.isDirectory || entry.name === keep) continue;
        const path = `${this.#store}/cache/${entry.name}`;
        folders.push({ path, at: (await Deno.stat(path).catch(() => null))?.mtime?.getTime() ?? 0 });
      }
    } catch { return; }
    folders.sort((a, b) => b.at - a.at);
    for (const old of folders.slice(KEPT - 1)) await Deno.remove(old.path, { recursive: true }).catch(() => {});
  }

  async #checkFile(scene: Scene, stamp: string, body: Body) {
    const manifest = scene.manifest ? await shortHash(await Deno.readTextFile(scene.manifest).catch(() => "")) : "none";
    return `${this.#cache(stamp)}/check-${bodyKey(body)}-${manifest}`;
  }

  async #body(scene: Scene, given?: string | null): Promise<Body> {
    const numbers = (given ?? "").split(",").map(Number);
    if (numbers.length === 3 && numbers.every((value) => Number.isFinite(value) && value > 0)) return { radius: numbers[0], height: numbers[1], step: numbers[2] };
    const manifest = scene.manifest ? await readJson(scene.manifest) : null;
    return { radius: 0.3, height: 1.4, step: 0.03, ...(manifest?.body ?? {}) };
  }

  async describe(id: string, wanted: number | null) {
    const scene = await this.#find(id), revisions = await this.revisions(scene);
    // The revision on screen: the one asked for, else the newest that was not rejected.
    const revision = revisions.find((entry) => entry.n === wanted) ?? [...revisions].reverse().find((entry) => entry.state !== "rejected")!;
    const usd = await this.#usd(revision.usd), stamp = String(usd.stamp), manifest = scene.manifest ? await readJson(scene.manifest) : null;
    const evidence = await this.#evidence(scene), body = await this.#body(scene);
    const view = await readJson(`${this.#cache(stamp)}/view/view.json`), check = await readJson(`${await this.#checkFile(scene, stamp, body)}.json`);
    const runtime = await this.#python();
    return {
      scene, revision: revision.n, revisions, usd, manifest, body, pins: await this.pins(scene),
      evidence: evidence && { camera: evidence.camera, views: evidence.views.map((entry, index) => ({ k: index, name: entry.name ?? null, time: entry.time ?? null, pose: entry.camera_to_scene, camera: entry.camera ?? null, picture: !!entry.image, thumbnail: !!entry.thumbnail })) },
      view: { ready: !!view, report: view, job: this.#jobs.get(`view:${stamp}`) ?? null },
      check: { report: check, job: this.#jobs.get(`check:${stamp}:${bodyKey(body)}`) ?? null },
      // What an agent needs to work on this scene: where to work, where the marks are, how to test, how to answer.
      agent: {
        cwd: scene.project, pins: `${this.#state(scene)}/pins.json`, inbox: `${this.#state(scene)}/inbox`, guide: GUIDE,
        check: `${runtime.python} ${CHECK} <scene.usda>${scene.manifest ? ` --manifest ${scene.manifest}` : ""}`,
      },
      runtime: runtime.python,
    };
  }

  // -- what a browser draws: derived from the USD once, then served as files ------------------------------
  async view(scene: Scene, n: number, start: boolean) {
    const revision = await this.#revision(scene, n), stamp = String((await this.#usd(revision.usd)).stamp), folder = `${this.#cache(stamp)}/view`, key = `view:${stamp}`;
    const report = await readJson(`${folder}/view.json`), running = this.#jobs.get(key);
    // A view that is asked for was used now: that is what keeps it when older ones are let go.
    if (report && start) await Deno.utime(this.#cache(stamp), new Date(), new Date()).catch(() => {});
    if (!report && start && running?.state !== "running") {
      await this.#prune(stamp);
      await Deno.mkdir(this.#cache(stamp), { recursive: true });
      // Made in a folder of its own and moved into place when whole, so a half-made view is never served.
      const making = `${folder}.making`;
      await Deno.remove(making, { recursive: true }).catch(() => {});
      this.#run(key, [DERIVE, revision.usd, making], (job, line) => {
        try { const progress = JSON.parse(line); job.done = progress.done; job.total = progress.total; job.note = progress.note; } catch { /* not a progress line */ }
      }, async (job, code, log) => {
        if (code === 0 && await exists(`${making}/view.json`)) { await Deno.remove(folder, { recursive: true }).catch(() => {}); await Deno.rename(making, folder); job.state = "done"; }
        else { job.state = "failed"; job.error = log.at(-1) || `making the view ended with code ${code}`; }
      });
    }
    return { ready: !!report, report, job: this.#jobs.get(key) ?? null, stamp };
  }

  async viewFile(scene: Scene, n: number, parts: string[]): Promise<Response> {
    const revision = await this.#revision(scene, n), stamp = String((await this.#usd(revision.usd)).stamp);
    if (!parts.length || parts.some((part) => part === ".." || part.includes("/") || !part)) return json({ error: "not found" }, 404);
    return file(`${this.#cache(stamp)}/view/${parts.join("/")}`);
  }

  // -- the check ----------------------------------------------------------------------------------------
  async check(scene: Scene, n: number, given: string | null, start: boolean) {
    const revision = await this.#revision(scene, n), stamp = String((await this.#usd(revision.usd)).stamp);
    const body = await this.#body(scene, given), base = await this.#checkFile(scene, stamp, body), key = `check:${stamp}:${bodyKey(body)}`;
    if (start && this.#jobs.get(key)?.state !== "running") {
      await Deno.mkdir(this.#cache(stamp), { recursive: true });
      const args = [CHECK, revision.usd, "--out", `${base}.json`, "--floor", `${base}.bin`, "--body", `${body.radius},${body.height},${body.step}`, "--progress"];
      if (scene.manifest) args.push("--manifest", scene.manifest);
      await Deno.remove(`${base}.json`).catch(() => {});
      this.#run(key, args, (job, line) => {
        try { const progress = JSON.parse(line); job.note = progress.note; job.done = progress.done ?? undefined; } catch { /* not a progress line */ }
      }, async (job, code, log) => {
        // The check ends with 1 when the scene is not at the level asked: that is an answer, not a failure.
        if (await exists(`${base}.json`)) job.state = "done";
        else { job.state = "failed"; job.error = log.at(-1) || `the check ended with code ${code}`; }
      });
    }
    return { body, report: await readJson(`${base}.json`), job: this.#jobs.get(key) ?? null };
  }

  async floor(scene: Scene, n: number, given: string | null): Promise<Response> {
    const revision = await this.#revision(scene, n), stamp = String((await this.#usd(revision.usd)).stamp);
    const body = await this.#body(scene, given), base = await this.#checkFile(scene, stamp, body);
    try {
      const bytes = await Deno.readFile(`${base}.bin`);
      return container({ cells: bytes.length / 12, body }, bytes);
    } catch { return json({ error: "this scene's floor has not been walked: run the check" }, 404); }
  }

  async diff(scene: Scene, a: number, b: number) {
    const before = await this.#revision(scene, a), after = await this.#revision(scene, b);
    const key = `${(await this.#usd(before.usd)).stamp}:${(await this.#usd(after.usd)).stamp}`;
    if (!this.#diffs.has(key)) this.#diffs.set(key, (await this.#ask({ op: "diff", before: before.usd, after: after.usd })).meta);
    return { a, b, ...(this.#diffs.get(key) as Record<string, unknown>) };
  }

  // -- routes: api/scenes/library/... -------------------------------------------------------------------
  async handle(request: Request, parts: string[], url: URL): Promise<Response> {
    const method = request.method;
    try {
      if (parts[0] !== "library") return json({ error: "not found" }, 404);
      if (parts.length === 1 && method === "GET") {
        const scenes = await this.list(url.searchParams.has("rescan"));
        return json({ scenes, runtime: await this.#python().then((runtime) => ({ python: runtime.python }), (error) => ({ error: error.message })) });
      }
      const body = method === "POST" && !request.headers.get("content-type")?.startsWith("image/") ? await request.json().catch(() => ({})) : {};
      if (parts.length === 1 && method === "POST") return json(await this.add(String(body.path ?? "")));
      const id = parts[1] ?? "", what = parts[2];
      if (!what && method === "GET") { const wanted = url.searchParams.get("revision"); return json(await this.describe(id, wanted === null ? null : Number(wanted))); }
      const scene = await this.#find(id);
      if (what === "compose" && method === "POST") return json(await this.compose(scene, String(body.blueprint ?? "")));
      if (what === "pins") {
        if (parts.length === 3 && method === "GET") return json({ pins: await this.pins(scene) });
        if (parts.length === 3 && method === "POST") return json({ pins: await this.pin(scene, body) });
        if (parts.length === 4 && (method === "POST" || method === "DELETE")) return json({ pins: await this.editPin(scene, Number(parts[3]), method === "DELETE" ? null : body) });
      }
      if (what === "snapshots" && method === "POST") return json(await this.snapshot(scene, request));
      if (what === "evidence" && method === "GET") {
        const view = (await this.#evidence(scene))?.views[Number(parts[3])], path = view?.[parts[4] === "thumbnail" ? "thumbnail" : "image"] ?? view?.image;
        return typeof path === "string" ? file(path) : json({ error: "not found" }, 404);
      }
      if (what === "diff" && method === "GET") return json(await this.diff(scene, Number(url.searchParams.get("a")), Number(url.searchParams.get("b"))));
      if (what === "revisions") {
        if (parts.length === 3 && method === "GET") return json({ revisions: await this.revisions(scene) });
        if (parts.length === 3 && method === "POST") return json({ revisions: await this.publish(scene, String(body.usd ?? ""), String(body.label ?? "a new revision")) });
        const n = Number(parts[3]), part = parts[4];
        if (!Number.isInteger(n)) return json({ error: "not found" }, 404);
        if (!part && method === "POST") return json({ revisions: await this.mark(scene, n, String(body.state ?? "")) });
        if (part === "view" && parts.length === 5) return json(await this.view(scene, n, method === "POST"));
        if (part === "view" && parts[5] === "file" && method === "GET") return this.viewFile(scene, n, parts.slice(6).map(decodeURIComponent));
        if (part === "check" && parts.length === 5) return json(await this.check(scene, n, url.searchParams.get("body") ?? (body.body ? String(body.body) : null), method === "POST"));
        if (part === "check" && parts[5] === "floor" && method === "GET") return this.floor(scene, n, url.searchParams.get("body"));
        if (part === "ray" && method === "POST") return json((await this.#ask({ op: "ray", path: (await this.#revision(scene, n)).usd, origin: body.origin, direction: body.direction })).meta);
        if (part === "warm" && method === "POST") return json((await this.#ask({ op: "warm", path: (await this.#revision(scene, n)).usd })).meta);
      }
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: (error as Error).message }, 400);
    }
  }

  close() {
    this.#worker?.close();
    for (const child of this.#children) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  }
}
