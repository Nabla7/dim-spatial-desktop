// Small formatters and parsers shared by the panels.
export const hz = value => !value ? '—' : value >= 100 ? `${Math.round(value)} Hz` : value >= 10 ? `${value.toFixed(0)} Hz` : `${value.toFixed(1)} Hz`;

export function bytes(value, suffix = '') {
  if (!value) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}${suffix}`;
}

export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// "ControlCoordinator" -> "Control Coordinator"; "SimIMUModule" -> "Sim IMU Module".
export const words = name => String(name).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ');

// The kind of control an RPC parameter gets, from its Python annotation.
export function paramKind(param) {
  if (param.choices?.length) return 'choice';
  const type = String(param.type || '').replace(/\s*\|\s*None/g, '').replace(/^Optional\[(.*)\]$/, '$1').trim();
  if (type === 'bool') return 'bool';
  if (type === 'int') return 'int';
  if (type === 'float') return 'float';
  if (type === 'str') return 'str';
  return 'json';
}

// A Python default as the gateway gives it (repr text, or already a JSON value) -> a JS value, or undefined.
export function pythonValue(text) {
  if (text === null || text === undefined) return undefined;
  if (typeof text !== 'string') return text;
  const source = text.trim();
  if (source === 'None') return null;
  if (source === 'True') return true;
  if (source === 'False') return false;
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(source)) return Number(source);
  if (/^(['"]).*\1$/s.test(source)) return source.slice(1, -1);
  try { return JSON.parse(source.replace(/'/g, '"').replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null').replace(/\(/g, '[').replace(/\)/g, ']')); } catch { return undefined; }
}

// What the user typed for a parameter -> the JSON value sent. Throws with a message fit to show.
export function coerce(kind, raw) {
  if (kind === 'bool') return !!raw;
  if (kind === 'choice') return raw;
  const text = String(raw ?? '').trim();
  if (kind === 'int') { if (!/^-?\d+$/.test(text)) throw new Error('needs a whole number'); return parseInt(text, 10); }
  if (kind === 'float') { const value = Number(text); if (text === '' || !Number.isFinite(value)) throw new Error('needs a number'); return value; }
  if (kind === 'str') return text;
  try { return JSON.parse(text); } catch { return text; }
}

// A value on one line, for a result row.
export function brief(value, max = 400) {
  let text;
  if (typeof value === 'string') text = value; else { try { text = JSON.stringify(value, null, 1); } catch { text = String(value); } }
  if (text === undefined) text = 'null';
  return text.length > max ? text.slice(0, max) + ' …' : text;
}

export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
