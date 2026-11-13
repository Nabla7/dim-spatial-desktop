// The HTTP side: the dimos gateway (what could run, what runs), Desktop's own gateway, the Launcher and
// this app's own server.
// Every URL is relative to the page (/apps/<name>/) and every call here is declared in dimos.yaml.
const url = path => new URL(path, location.href);

export class GatewayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(path, {method = 'GET', body, timeout = 15000} = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url(path), {
      method, signal: controller.signal, cache: 'no-store',
      headers: body === undefined ? {} : {'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) throw new GatewayError(response.status, data?.error || data?.detail || (typeof data === 'string' && data) || `HTTP ${response.status}`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new GatewayError(0, 'no answer (timed out)');
    throw error;
  } finally { clearTimeout(timer); }
}

const segment = encodeURIComponent;

// An answer of this app's server that carries bytes: [uint32 length of a JSON header][header][bytes].
// The header is padded so the bytes start on a multiple of four and can be viewed as typed arrays.
async function binary(path, {timeout = 120000} = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url(path), {signal: controller.signal, cache: 'no-store'});
    if (!response.ok || (response.headers.get('content-type') || '').includes('json')) {
      const data = await response.json().catch(() => null);
      throw new GatewayError(response.status, data?.error || `HTTP ${response.status}`);
    }
    const buffer = await response.arrayBuffer(), length = new DataView(buffer).getUint32(0, true);
    return {meta: JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))), buffer, offset: 4 + length};
  } catch (error) {
    if (error.name === 'AbortError') throw new GatewayError(0, 'no answer (timed out)');
    throw error;
  } finally { clearTimeout(timer); }
}

export const gateway = {
  // -- the running blueprint ------------------------------------------------------------------------
  active: () => request('../../gateways/dimos/active'),
  modules: () => request('../../gateways/dimos/active/modules'),
  stats: () => request('../../gateways/dimos/active/stats'),
  log: (after, level = 'info') => request(`../../gateways/dimos/active/log?limit=200&level=${segment(level)}${after == null ? '' : `&after=${after}`}`),
  // A direct call on a module instance. Only ever from a user's press: this is what a button does.
  callRpc: (id, name, kwargs = {}) => request(`../../gateways/dimos/active/modules/${segment(id)}/rpcs/${segment(name)}`, {method: 'POST', body: {kwargs}, timeout: 120000}),
  restartModule: id => request(`../../gateways/dimos/active/modules/${segment(id)}/restart`, {method: 'POST', body: {}, timeout: 60000}),
  stopModule: id => request(`../../gateways/dimos/active/modules/${segment(id)}/stop`, {method: 'POST', body: {}, timeout: 60000}),
  stop: () => request('../../gateways/dimos/active/stop', {method: 'POST', body: {}, timeout: 30000}),

  // -- what could run -------------------------------------------------------------------------------
  blueprints: () => request('../../gateways/dimos/catalog/blueprints', {timeout: 30000}),
  blueprint: name => request(`../../gateways/dimos/catalog/blueprints/${segment(name)}`, {timeout: 60000}),
  // The blueprint's config as launched: each module's fields with the values this blueprint gave them.
  blueprintConfig: name => request(`../../gateways/dimos/catalog/blueprints/${segment(name)}/config`, {timeout: 90000}),

  // -- the Launcher: it adds the user's saved config to a launch, the gateway keeps none -------------
  launch: (blueprint, config) => request('../@launcher/launch', {method: 'POST', body: config ? {blueprint, config} : {blueprint}, timeout: 30000}),
  relaunch: () => request('../@launcher/relaunch', {method: 'POST', body: {}, timeout: 60000}),

  // -- this app's own server: the code behind an RPC, and agent sessions (Claude Code, Codex) --------
  source: (cls, method) => request(`api/source?class=${segment(cls)}&method=${segment(method)}`),
  agent: {
    status: () => request('api/agent/status'),
    create: options => request('api/agent/sessions', {method: 'POST', body: options, timeout: 30000}),
    events: (id, after, wait = 20) => request(`api/agent/sessions/${segment(id)}/events?after=${after}&wait=${wait}`, {timeout: (wait + 10) * 1000}),
    send: (id, text) => request(`api/agent/sessions/${segment(id)}/message`, {method: 'POST', body: {text}}),
    permission: (id, requestId, allow, session = false) => request(`api/agent/sessions/${segment(id)}/permission`, {method: 'POST', body: {requestId, allow, session}}),
    interrupt: id => request(`api/agent/sessions/${segment(id)}/interrupt`, {method: 'POST', body: {}}),
    close: id => request(`api/agent/sessions/${segment(id)}`, {method: 'DELETE'}),
  },

  // -- this app's own server: recorded episodes, for the replay ----------------------------------------
  replay: {
    datasets: (rescan = false) => request(`api/replay/datasets${rescan ? '?rescan=1' : ''}`, {timeout: 30000}),
    add: path => request('api/replay/datasets', {method: 'POST', body: {path}, timeout: 30000}),
    episodes: id => request(`api/replay/datasets/${segment(id)}/episodes`, {timeout: 30000}),
    episode: (id, name) => request(`api/replay/datasets/${segment(id)}/episodes/${segment(name)}`, {timeout: 120000}),
    images: (id, name, camera, start, count) => binary(`api/replay/datasets/${segment(id)}/episodes/${segment(name)}/images?camera=${segment(camera)}&start=${start}&count=${count}`),
    scene: (id, name, have) => binary(`api/replay/datasets/${segment(id)}/episodes/${segment(name)}/scene${have ? `?have=${segment(have)}` : ''}`),
    motion: (id, name) => binary(`api/replay/datasets/${segment(id)}/episodes/${segment(name)}/motion`),
    recover: (id, name) => request(`api/replay/datasets/${segment(id)}/episodes/${segment(name)}/recover`, {method: 'POST', body: {}}),
    recovery: (id, name) => request(`api/replay/datasets/${segment(id)}/episodes/${segment(name)}/recover`),
    audit: (id, start = false) => request(`api/replay/datasets/${segment(id)}/audit`, start ? {method: 'POST', body: {}} : {}),
  },

  // -- this app's own server: USD scenes to walk through, check, mark and hand to an agent ---------------
  scenes: {
    list: (rescan = false) => request(`api/scenes/library${rescan ? '?rescan=1' : ''}`, {timeout: 90000}),
    add: path => request('api/scenes/library', {method: 'POST', body: {path}, timeout: 90000}),
    scene: (id, revision = null) => request(`api/scenes/library/${segment(id)}${revision == null ? '' : `?revision=${revision}`}`, {timeout: 120000}),
    view: (id, revision, start = false) => request(`api/scenes/library/${segment(id)}/revisions/${revision}/view`, start ? {method: 'POST', body: {}} : {}),
    // Where a file of the derived view is served from (the GLB names its images relative to itself).
    viewUrl: (id, revision, file) => url(`api/scenes/library/${segment(id)}/revisions/${revision}/view/file/${file}`).href,
    check: (id, revision, body, start = false) => request(`api/scenes/library/${segment(id)}/revisions/${revision}/check?body=${segment(body)}`, start ? {method: 'POST', body: {}} : {}),
    floor: (id, revision, body) => binary(`api/scenes/library/${segment(id)}/revisions/${revision}/check/floor?body=${segment(body)}`),
    ray: (id, revision, origin, direction) => request(`api/scenes/library/${segment(id)}/revisions/${revision}/ray`, {method: 'POST', body: {origin, direction}, timeout: 240000}),
    warm: (id, revision) => request(`api/scenes/library/${segment(id)}/revisions/${revision}/warm`, {method: 'POST', body: {}, timeout: 240000}),
    revisions: id => request(`api/scenes/library/${segment(id)}/revisions`),
    mark: (id, revision, state) => request(`api/scenes/library/${segment(id)}/revisions/${revision}`, {method: 'POST', body: {state}}),
    diff: (id, a, b) => request(`api/scenes/library/${segment(id)}/diff?a=${a}&b=${b}`, {timeout: 240000}),
    pin: (id, pin) => request(`api/scenes/library/${segment(id)}/pins`, {method: 'POST', body: pin}),
    editPin: (id, n, changes) => request(`api/scenes/library/${segment(id)}/pins/${n}`, {method: 'POST', body: changes}),
    removePin: (id, n) => request(`api/scenes/library/${segment(id)}/pins/${n}`, {method: 'DELETE'}),
    snapshot: (id, blob) => fetch(url(`api/scenes/library/${segment(id)}/snapshots`), {method: 'POST', headers: {'content-type': blob.type}, body: blob}).then(response => response.json()),
    evidenceUrl: (id, k, thumbnail = false) => url(`api/scenes/library/${segment(id)}/evidence/${k}/${thumbnail ? 'thumbnail' : 'image'}`).href,
  },

  // -- Desktop --------------------------------------------------------------------------------------
  zenoh: () => request('../../gateways/desktop/management/gateways/zenoh'),
  rates: () => request('../../gateways/desktop/topics/rates'),
  agentStatus: () => request('../../gateways/desktop/management/gateways/agent'),
  notify: (title, body, kind = 'info') => request('../../gateways/desktop/ui/notifications', {method: 'POST', body: {title, body, kind}}),
  // What is on screen, for an agent that asks Desktop what the user is looking at.
  reportView: (app, view) => request(`../../gateways/desktop/views/${segment(app)}`, {method: 'PUT', body: view}),
};
