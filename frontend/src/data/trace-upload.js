// One acknowledged batch at a time. Compression and network IO run outside XR callbacks.
export class TraceUpload {
  constructor(send, now = () => performance.now()) {
    this.send = send; this.now = now; this.credit = 0; this.last = now(); this.pending = null;
    this.bytesSent = 0; this.failures = 0; this.busy = false;
  }
  async flush(trace) {
    if (!trace || this.busy) return;
    this.busy = true;
    try {
      if (!this.pending) {
        // Leave room for the manifest and framing below the token bucket's
        // maximum credit, including browsers without streaming compression.
        const events = trace.drain(128 * 1024, 512);
        if (!events.length) return;
        const batch = {batchId: crypto.randomUUID(), manifest: trace.manifest(), events};
        const bytes = new TextEncoder().encode(JSON.stringify(batch));
        // Retain the drained batch before any asynchronous operation. A
        // compression failure must not erase evidence already removed from
        // the recorder. The uncompressed batch is a valid fallback.
        this.pending = {body: bytes, gzip: false};
        if (typeof CompressionStream !== 'undefined') {
          try {
            const body = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
            if (body.length < bytes.length) this.pending = {body, gzip: true};
          } catch { /* Send the retained uncompressed batch. */ }
        }
      }
      const at = this.now();
      // Reserve 20 KiB/s for existing peer/RTC metrics and HTTP headers.
      this.credit = Math.min(256 * 1024, this.credit + Math.max(0, at - this.last) * 80 * 1024 / 1000);
      this.last = at;
      if (this.pending.body.length > this.credit) return;
      this.credit -= this.pending.body.length;
      this.bytesSent += this.pending.body.length;
      await this.send(this.pending.body, this.pending.gzip);
      this.pending = null;
    } catch (error) { this.failures++; throw error; }
    finally { this.busy = false; }
  }
}
