// Bounded recent telemetry from the actual viewers, including headsets. No camera pixels or controls.
export class Diagnostics {
  private clients = new Map<string, {seen: number; samples: Record<string, unknown>[]} >();

  async handle(request: Request): Promise<Response> {
    const now = Date.now(), url = new URL(request.url);
    for (const [id, client] of this.clients) if (now - client.seen > 10 * 60_000) this.clients.delete(id);
    const json = (body: unknown, status = 200) => Response.json(body, {status, headers: {'cache-control': 'no-store'}});
    if (request.method === 'POST') {
      if (!request.body) return json({error: 'missing report'}, 400);
      const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const {value, done} = await reader.read(); if (done) break;
        size += value.length;
        if (size > 65536) { await reader.cancel(); return json({error: 'report too large'}, 413); }
        chunks.push(value);
      }
      let report: Record<string, unknown>;
      try {
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        report = JSON.parse(new TextDecoder().decode(bytes));
      } catch { return json({error: 'invalid report'}, 400); }
      if (!report || typeof report.clientId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(report.clientId) || !Array.isArray(report.cameras)) return json({error: 'invalid report'}, 400);
      const previous = this.clients.get(report.clientId);
      this.clients.delete(report.clientId);
      this.clients.set(report.clientId, {seen: now, samples: [...(previous?.samples ?? []).slice(-59), {...report, receivedAt: now}]});
      while (this.clients.size > 16) this.clients.delete(this.clients.keys().next().value!);
    } else if (request.method !== 'GET') return json({error: 'method not allowed'}, 405);
    const id = url.searchParams.get('client');
    if (id) return json({samples: this.clients.get(id)?.samples ?? []});
    return json({clients: [...this.clients.values()].map(client => ({...client.samples.at(-1), stale: now - client.seen > 10_000}))});
  }
}
