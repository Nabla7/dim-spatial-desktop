// The HTTP side: the dimos gateway (what could run, what runs), Desktop's own gateway and the Launcher.
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

  // -- the Launcher: it adds the user's saved config to a launch, the gateway keeps none -------------
  launch: (blueprint, config) => request('../@launcher/launch', {method: 'POST', body: config ? {blueprint, config} : {blueprint}, timeout: 30000}),
  relaunch: () => request('../@launcher/relaunch', {method: 'POST', body: {}, timeout: 60000}),

  // -- Desktop --------------------------------------------------------------------------------------
  zenoh: () => request('../../gateways/desktop/management/gateways/zenoh'),
  rates: () => request('../../gateways/desktop/topics/rates'),
  agentStatus: () => request('../../gateways/desktop/management/gateways/agent'),
  notify: (title, body, kind = 'info') => request('../../gateways/desktop/ui/notifications', {method: 'POST', body: {title, body, kind}}),
  // What is on screen, for an agent that asks Desktop what the user is looking at.
  reportView: (app, view) => request(`../../gateways/desktop/views/${segment(app)}`, {method: 'PUT', body: view}),
};
