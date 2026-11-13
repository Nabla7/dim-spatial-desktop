// Recorded episodes, for the page's replay. A dataset is a folder named `episodes` whose children each
// hold a `metadata.json` and an MCAP of frames; they are found under Desktop's app data and in folders
// the user adds. Listing is done here (the metadata files are small JSON). Reading an episode's frames,
// images and world is done by replay/worker.py, a Python process started with the runtime that wrote
// the episode (the dimos checkout its simulation record names), so its MuJoCo and its sim2 code match
// the data. Nothing here writes into a dataset: what is computed is kept under this app's own data folder.
import { type Answer, container, dirname, exists, follow, type Job, json, PythonWorker, readJson, type Runtime, shortHash } from "./worker.ts";

export type ReplayApp = { dataDir?: string; dimosDir?: string; dimosPython?: string };
type Dataset = { id: string; path: string; label: string; where: string; added: boolean; at: number };

const WORKER = new URL("./replay/worker.py", import.meta.url).pathname;
const RECOVER = new URL("./replay/recover.py", import.meta.url).pathname;
const NAME = /^[\w.-]+$/;

export class Replay {
  #app: ReplayApp;
  #workers = new Map<string, PythonWorker>();
  #datasets: Dataset[] = [];
  #scanned = 0;
  #runtimes = new Map<string, Runtime>();
  #recoveries = new Map<string, Job>();
  #audits = new Map<string, Job>();
  #children = new Set<Deno.ChildProcess>();

  constructor(app: ReplayApp) {
    this.#app = app;
    // A reader holds the last episodes it read in memory: one that nobody asked for a while is let go.
    setInterval(() => { for (const [python, worker] of this.#workers) if (worker.dead || Date.now() - worker.used > 10 * 60_000) { worker.close(); this.#workers.delete(python); } }, 60_000);
  }

  get #store() { return this.#app.dataDir ? `${this.#app.dataDir}/replay` : null; }

  // -- datasets ---------------------------------------------------------------------------------------
  async #added(): Promise<string[]> {
    const saved = this.#store ? await readJson(`${this.#store}/folders.json`) : null;
    return Array.isArray(saved?.folders) ? saved.folders.filter((path: unknown) => typeof path === "string") : [];
  }

  // Folders named "episodes" with episode folders in them, anywhere under `root`. A folder with very many
  // subfolders is a store of something else (trials, cache entries) and is not searched.
  async #search(root: string): Promise<string[]> {
    const found: string[] = [], queue: [string, number][] = [[root, 0]];
    let visited = 0;
    while (queue.length && visited++ < 6000) {
      const [dir, depth] = queue.shift()!;
      const children: string[] = [];
      try {
        for await (const entry of Deno.readDir(dir)) if (entry.isDirectory && !entry.name.startsWith(".") && entry.name !== "node_modules") children.push(entry.name);
      } catch { continue; }
      if (dir.endsWith("/episodes")) {
        for (const name of children.slice(0, 8)) if (await exists(`${dir}/${name}/metadata.json`)) { found.push(dir); break; }
        continue;
      }
      if (children.length > 64 || depth >= 8) continue;
      for (const name of children) queue.push([`${dir}/${name}`, depth + 1]);
    }
    return found;
  }

  async datasets(rescan = false): Promise<Dataset[]> {
    if (!rescan && Date.now() - this.#scanned < 30_000) return this.#datasets;
    const root = this.#app.dataDir ? dirname(this.#app.dataDir) : null;
    const added = await this.#added(), paths = new Map<string, boolean>();
    if (root) for (const path of await this.#search(root)) paths.set(path, false);
    for (const folder of added) for (const path of await this.#search(folder)) if (!paths.has(path)) paths.set(path, true);
    const datasets: Dataset[] = [];
    for (const [path, wasAdded] of paths) {
      const inside = root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
      const where = inside.replace(/\/episodes$/, ""), parts = where.split("/");
      // A folder's own time changes when an episode is added to it: the page opens on the newest dataset.
      const at = (await Deno.stat(path).catch(() => null))?.mtime?.getTime() ?? 0;
      datasets.push({ id: await shortHash(path), path, label: parts.slice(-2).join(" / "), where, added: wasAdded, at });
    }
    datasets.sort((a, b) => a.where.localeCompare(b.where));
    this.#datasets = datasets; this.#scanned = Date.now();
    return datasets;
  }

  // A folder the user names: an `episodes` folder, a folder above one, or one episode's folder.
  async add(path: string): Promise<Dataset[]> {
    let folder = path.trim().replace(/^~(?=\/|$)/, Deno.env.get("HOME") ?? "~").replace(/\/+$/, "");
    if (!folder.startsWith("/")) throw new Error("give the folder's full path, starting with /");
    if (await exists(`${folder}/metadata.json`)) folder = dirname(folder);
    if (!(await this.#search(folder)).length) throw new Error("no episodes there: a dataset is a folder named `episodes` whose subfolders each hold a metadata.json");
    if (!this.#store) throw new Error("this app has no data folder to remember the folder in");
    const folders = [...new Set([...(await this.#added()), folder])];
    await Deno.mkdir(this.#store, { recursive: true });
    await Deno.writeTextFile(`${this.#store}/folders.json`, JSON.stringify({ folders }));
    return this.datasets(true);
  }

  async #dataset(id: string): Promise<Dataset> {
    const dataset = (await this.datasets()).find((entry) => entry.id === id) ?? (await this.datasets(true)).find((entry) => entry.id === id);
    if (!dataset) throw new Error("no such dataset (the folder may have moved)");
    return dataset;
  }

  #recovered(dataset: Dataset, name: string) { return this.#store ? `${this.#store}/recovered/${dataset.id}/${name}` : null; }

  // One row per episode, from its metadata.json alone.
  async episodes(id: string) {
    const dataset = await this.#dataset(id), names: string[] = [];
    for await (const entry of Deno.readDir(dataset.path)) if (entry.isDirectory && NAME.test(entry.name)) names.push(entry.name);
    const rows = (await Promise.all(names.map(async (name) => {
      const dir = `${dataset.path}/${name}`, meta = await readJson(`${dir}/metadata.json`);
      if (!meta) return null;
      const file = (await exists(`${dir}/episode.mcap`)) ? "episode.mcap" : (await exists(`${dir}/discarded.mcap`)) ? "discarded.mcap" : null;
      const stat = file ? await Deno.stat(`${dir}/${file}`).catch(() => null) : null;
      const record = typeof meta.sim2_run_record === "string" ? meta.sim2_run_record : null, recovered = this.#recovered(dataset, name);
      const world = !record ? "none"
        : (await exists(`${dirname(record)}/world-history.npz`)) ? "recorded"
        : recovered && (await exists(`${recovered}/world-history.npz`)) ? "resimulated"
        : typeof meta.trajectory === "string" && (await exists(meta.trajectory)) ? "recoverable" : "joints";
      return {
        name, file, at: stat?.mtime?.getTime() ?? 0, size: stat?.size ?? 0, kept: meta.kept ?? null, outcome: meta.outcome ?? null, split: meta.split ?? null,
        frames: meta.frames ?? null, fps: meta.fps ?? null, seed: meta.variation?.seed ?? null, demonstrator: meta.demonstrator ?? null,
        task: meta.task ?? null, cameras: meta.camera_names ?? null, world,
      };
    }))).filter((row) => row !== null).sort((a, b) => a!.at - b!.at);
    return { dataset, episodes: rows };
  }

  // -- reading one episode ----------------------------------------------------------------------------
  // The Python that wrote an episode: the virtual environment of the dimos checkout its simulation record
  // names. Without a record, the Python of the dimos Desktop runs.
  async #runtime(dir: string): Promise<Runtime> {
    const known = this.#runtimes.get(dir);
    if (known) return known;
    let runtime: Runtime | null = null;
    const meta = await readJson(`${dir}/metadata.json`), record = typeof meta?.sim2_run_record === "string" ? await readJson(meta.sim2_run_record) : null;
    let folder = typeof record?.runtime_source?.path === "string" ? dirname(record.runtime_source.path) : "";
    while (folder && folder !== "/") {
      if (await exists(`${folder}/.venv/bin/python`)) { runtime = { python: `${folder}/.venv/bin/python`, cwd: folder }; break; }
      folder = dirname(folder);
    }
    runtime ??= this.#app.dimosPython ? { python: this.#app.dimosPython, cwd: this.#app.dimosDir ?? "/" } : { python: "python3", cwd: "/" };
    this.#runtimes.set(dir, runtime);
    return runtime;
  }

  async #worker(dir: string): Promise<PythonWorker> {
    const runtime = await this.#runtime(dir);
    let worker = this.#workers.get(runtime.python);
    if (!worker || worker.dead) { worker = new PythonWorker(WORKER, runtime, "replay reader"); this.#workers.set(runtime.python, worker); }
    return worker;
  }

  async #episode(id: string, name: string): Promise<{ dataset: Dataset; dir: string }> {
    if (!NAME.test(name)) throw new Error("no such episode");
    const dataset = await this.#dataset(id), dir = `${dataset.path}/${name}`;
    if (!await exists(`${dir}/metadata.json`)) throw new Error("no such episode");
    return { dataset, dir };
  }

  async #ask(id: string, name: string, request: Record<string, unknown>): Promise<Answer> {
    const { dir } = await this.#episode(id, name);
    return (await this.#worker(dir)).call({ ...request, path: dir });
  }

  // A world history made again for an episode that was saved without one (see recover.py).
  async #history(id: string, name: string): Promise<{ path: string; recovery: unknown } | null> {
    const { dataset } = await this.#episode(id, name), folder = this.#recovered(dataset, name);
    if (!folder || !await exists(`${folder}/world-history.npz`)) return null;
    return { path: `${folder}/world-history.npz`, recovery: await readJson(`${folder}/recovery.json`) };
  }

  async describe(id: string, name: string) {
    const { meta } = await this.#ask(id, name, { op: "episode" });
    const world = (meta.world ?? {}) as Record<string, unknown>, again = await this.#history(id, name);
    world.source = world.history ? "recorded" : again ? "resimulated" : world.model ? "joints" : "none";
    if (again) { world.recovery = again.recovery; world.recoverable = false; }
    delete world.history;
    world.job = this.#recoveries.get(`${id}/${name}`) ?? null;
    return { ...meta, dataset: id, world };
  }

  async motion(id: string, name: string): Promise<Answer> {
    const again = await this.#history(id, name);
    const answer = await this.#ask(id, name, { op: "motion", history: again?.path });
    answer.meta.source = answer.meta.source === "joints" ? "joints" : again ? "resimulated" : "recorded";
    return answer;
  }

  // -- work that takes a while: one Python process each, followed here ----------------------------------
  #spawn(runtime: Runtime, args: string[], onLine: (line: string) => void, onEnd: (code: number, log: string[]) => void) {
    const process = follow(runtime, args, onLine, (code, log) => { this.#children.delete(process); onEnd(code, log); });
    this.#children.add(process);
  }

  async recover(id: string, name: string): Promise<Job> {
    const key = `${id}/${name}`, running = [...this.#recoveries.values()].some((job) => job.state === "running");
    if (this.#recoveries.get(key)?.state === "running") return this.#recoveries.get(key)!;
    if (running) throw new Error("another episode is being re-simulated; wait for it to finish");
    const { dataset, dir } = await this.#episode(id, name), out = this.#recovered(dataset, name);
    if (!out) throw new Error("this app has no data folder to keep the result in");
    const job: Job = { state: "running", startedAt: Date.now() };
    this.#recoveries.set(key, job);
    this.#spawn(await this.#runtime(dir), [RECOVER, dir, out], () => {}, async (code, log) => {
      const result = await readJson(`${out}/recovery.json`);
      job.result = result;
      if (result?.snapshots) job.state = "done";
      else { job.state = "failed"; job.error = result?.error || log.at(-1) || `the re-simulation ended with code ${code}`; }
      // What the worker read for this episode came from the old history, if any.
      for (const worker of this.#workers.values()) worker.close();
    });
    return job;
  }

  recovery(id: string, name: string): Job | null { return this.#recoveries.get(`${id}/${name}`) ?? null; }

  // Whether an audit on disk still describes the dataset: the same number of episodes, none newer.
  async #stamp(id: string): Promise<string> {
    const { episodes } = await this.episodes(id);
    return `${episodes.length}:${Math.max(0, ...episodes.map((row) => row!.at))}`;
  }

  async audit(id: string, start: boolean) {
    const dataset = await this.#dataset(id), file = this.#store ? `${this.#store}/audit/${id}.json` : null;
    const job = this.#audits.get(id), stamp = await this.#stamp(id);
    if (start && job?.state !== "running") {
      if (!file) throw new Error("this app has no data folder to keep the result in");
      const { episodes } = await this.episodes(id), first = episodes[0]?.name;
      if (!first) throw new Error("this dataset has no episodes");
      const fresh: Job = { state: "running", startedAt: Date.now(), done: 0, total: episodes.length };
      this.#audits.set(id, fresh);
      this.#spawn(await this.#runtime(`${dataset.path}/${first}`), [WORKER, "audit", dataset.path, file], (line) => {
        try { const progress = JSON.parse(line); fresh.done = progress.done; fresh.total = progress.total; fresh.note = progress.episode; } catch { /* not a progress line */ }
      }, async (code, log) => {
        const result = await readJson(file);
        if (code === 0 && result) { result.stamp = stamp; await Deno.writeTextFile(file, JSON.stringify(result)).catch(() => {}); fresh.state = "done"; }
        else { fresh.state = "failed"; fresh.error = log.at(-1) || `the audit ended with code ${code}`; }
      });
      return { job: fresh, result: null, stale: false };
    }
    const result = file ? await readJson(file) : null;
    return { job: job ?? null, result: job?.state === "running" ? null : result, stale: !!result && result.stamp !== stamp };
  }

  // -- routes: api/replay/... ---------------------------------------------------------------------------
  async handle(request: Request, parts: string[], url: URL): Promise<Response> {
    const method = request.method;
    try {
      if (parts[0] !== "datasets") return json({ error: "not found" }, 404);
      if (parts.length === 1 && method === "GET") return json({ datasets: await this.datasets(url.searchParams.has("rescan")) });
      if (parts.length === 1 && method === "POST") { const body = await request.json().catch(() => ({})); return json({ datasets: await this.add(String(body.path ?? "")) }); }
      const id = parts[1] ?? "";
      if (parts[2] === "audit" && parts.length === 3) return json(await this.audit(id, method === "POST"));
      if (parts[2] !== "episodes") return json({ error: "not found" }, 404);
      if (parts.length === 3 && method === "GET") return json(await this.episodes(id));
      const name = parts[3] ?? "", what = parts[4];
      if (!what && method === "GET") return json(await this.describe(id, name));
      if (what === "images" && method === "GET") {
        const { meta, payload } = await this.#ask(id, name, { op: "images", camera: url.searchParams.get("camera") ?? "", start: Number(url.searchParams.get("start") ?? 0), count: Number(url.searchParams.get("count") ?? 32) });
        return container(meta, payload);
      }
      if (what === "scene" && method === "GET") { const { meta, payload } = await this.#ask(id, name, { op: "scene", have: url.searchParams.get("have") }); return container(meta, payload); }
      if (what === "motion" && method === "GET") { const { meta, payload } = await this.motion(id, name); return container(meta, payload); }
      if (what === "recover" && method === "POST") return json({ job: await this.recover(id, name) });
      if (what === "recover" && method === "GET") return json({ job: this.recovery(id, name) });
      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: (error as Error).message }, 400);
    }
  }

  close() {
    for (const worker of this.#workers.values()) worker.close();
    for (const child of this.#children) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  }
}
