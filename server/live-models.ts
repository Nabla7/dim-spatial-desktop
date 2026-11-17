// USD files and assets received from a running model, converted with the scene renderer.
import { exists, json, readJson, type Runtime } from "./worker.ts";

const SCRIPT = new URL("./scenes/live.py", import.meta.url).pathname;
const TYPES: Record<string, string> = { glb: "model/gltf-binary", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

export class LiveModels {
  #jobs = new Map<string, Promise<unknown>>();
  constructor(private store: string, private runtime: () => Promise<Runtime>) {}

  async #build(id: string): Promise<unknown> {
    let job = this.#jobs.get(id);
    if (!job) {
      job = (async () => {
        const folder = `${this.store}/${id}`, known = await readJson(`${folder}/model.json`);
        const converterTime = Math.max(...await Promise.all([SCRIPT, new URL("./scenes/derive.py", import.meta.url).pathname].map(async path => (await Deno.stat(path)).mtime?.getTime() ?? 0)));
        const built = await Deno.stat(`${folder}/model.json`).catch(() => null);
        if (known?.ready && (built?.mtime?.getTime() ?? 0) >= converterTime) return { id, ...known };
        const runtime = await this.runtime();
        const result = await new Deno.Command(runtime.python, { args: [SCRIPT, folder], cwd: runtime.cwd,
          stdin: "null", stdout: "null", stderr: "piped", signal: AbortSignal.timeout(120_000) }).output();
        if (result.code) throw new Error(new TextDecoder().decode(result.stderr).slice(-2000));
        return { id, ...await readJson(`${folder}/model.json`) };
      })();
      this.#jobs.set(id, job);
    }
    try { return await job; } finally { this.#jobs.delete(id); }
  }

  async handle(request: Request, parts: string[]): Promise<Response> {
    if (!parts.length && request.method === "POST") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const id = [...hash].map(value => value.toString(16).padStart(2, "0")).join("");
      const folder = `${this.store}/${id}`;
      await Deno.mkdir(`${folder}/assets`, { recursive: true });
      if (!await exists(`${folder}/source.usda`)) await Deno.writeFile(`${folder}/source.usda`, bytes);
      return json(await this.#build(id));
    }
    const [id, action, key] = parts;
    if (!/^[a-f0-9]{64}$/.test(id ?? "")) return json({ error: "unknown model" }, 404);
    const folder = `${this.store}/${id}`;
    if (action === "assets" && request.method === "POST") {
      const assets = await readJson(`${folder}/assets.json`);
      if (!assets || !Object.values(assets).includes(key)) return json({ error: "unknown model asset" }, 404);
      await Deno.writeFile(`${folder}/assets/${key}`, new Uint8Array(await request.arrayBuffer()));
      return json({ ok: true });
    }
    if (action === "build" && request.method === "POST") return json(await this.#build(id));
    if (action === "file" && request.method === "GET") {
      const relative = parts.slice(2);
      if (!relative.length || relative.some(part => !part || part.startsWith(".") || part.includes("/") || part.includes("\\"))) return json({ error: "invalid file" }, 400);
      const path = relative.join("/");
      if (path !== "model.glb" && !(relative.length === 2 && relative[0] === "textures")) return json({ error: "unknown model file" }, 404);
      try {
        const file = await Deno.open(`${folder}/${path}`, { read: true });
        return new Response(file.readable, { headers: { "content-type": TYPES[path.split(".").pop()!] ?? "application/octet-stream", "cache-control": "private, max-age=3600" } });
      } catch { return json({ error: "model file not found" }, 404); }
    }
    return json({ error: "not found" }, 404);
  }
}
