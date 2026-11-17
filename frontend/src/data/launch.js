// What a launch has to be told before it can start, read from the blueprint's own config
// (GET catalog/blueprints/{name}/config: every module's fields, with the values the blueprint gives).
//
// - A field a module requires and the blueprint gives no value for: without it the launch fails.
// - For a blueprint that records episodes (data/episodes.js): the text its episode control is set up
//   with is what the episodes are of, and the path a recorder is set up with is where they go. Those
//   are a person's to give for each session, so they are asked for too, with the blueprint's own value
//   as the fallback.
// Fields every module has, secrets and values that are not JSON are left to Desktop's Launcher.
import {findEpisodes} from './episodes.js';

const two = number => String(number).padStart(2, '0');
// A time that sorts, for the name of a new folder.
export const stamp = (date = new Date()) => `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;

const isPath = field => /(^|\.)Path$/.test(field.type || '');
const isText = field => field.type === 'str';
const given = field => 'value' in field || (field.default !== null && field.default !== undefined);

// config: the answer of catalog/blueprints/{name}/config. modules: the catalog entry's modules.
// Returns [{key, module, field, type, required, role (task | folder | null), was (the blueprint's own value)}].
export function launchAsks(config, modules) {
  const asks = new Map(), episodes = findEpisodes(modules);
  const roleOf = (module, field) => {
    if (episodes?.control.name === module && isText(field)) return 'task';
    if (episodes?.recorders.some(recorder => recorder.module.name === module) && isPath(field)) return 'folder';
    return null;
  };
  for (const [module, described] of Object.entries(config?.modules || {})) for (const [name, field] of Object.entries(described.args || {})) {
    if (field.base || field.secret || field.json_compatible === false) continue;
    const required = !!field.required && !given(field), role = roleOf(module, field);
    if (!required && !role) continue;
    asks.set(`${module}.${name}`, {key: `${module}.${name}`, module, field: name, type: field.type, required, role, was: field.value ?? field.default ?? null});
  }
  // What must be given comes first, then the task before the folder.
  const rank = ask => (ask.required ? 0 : 2) + (ask.role === 'folder' ? 1 : 0);
  return [...asks.values()].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

// The launch's own config for the Launcher: {modules: {module: {field: value}}} with what was filled in.
export function launchConfig(asks, values) {
  const modules = {};
  for (const ask of asks) {
    const value = String(values[ask.key] ?? '').trim();
    if (value) (modules[ask.module] ||= {})[ask.field] = value;
  }
  return Object.keys(modules).length ? {modules} : undefined;
}

// What is still missing: the required fields with nothing in them.
export const missing = (asks, values) => asks.filter(ask => ask.required && !String(values[ask.key] ?? '').trim());

// The module that serves the scene of a sim2 blueprint, or null. Such a blueprint can stand its robot
// in another scene: the launch gives that module the file to serve in place of its own.
export function sceneModule(config) {
  const modules = Object.entries(config?.modules || {});
  if (!modules.some(([, described]) => /\.SimModule$/.test(described.class || ''))) return null;
  return modules.find(([, described]) => /\.UsdManager$/.test(described.class || '') && described.args?.model)?.[0] ?? null;
}
