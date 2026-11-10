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

// -- RPC parameters -----------------------------------------------------------------------------------
// The gateway hands an RPC its arguments as the JSON they were sent as, so a parameter is something the
// page can give exactly when its Python type has a JSON form. The annotation says which editor fits:
//   bool, int, float, str, choice   one value
//   numbers   list[float], tuple[float, float, float], ndarray: "0.1, 0.2, 0.3"
//   strings   list[str]: "a, b"
//   dict      dict[str, float]: "key=value, other=2"
//   json      untyped or mixed (list, tuple, Any): numbers, text, or JSON
//   object    a Python class (Twist, PoseStamped): the page cannot build one
const bare = type => String(type || '').replace(/\s+/g, '').replace(/^(typing\.|t\.)/, '').replace(/^Optional\[(.*)\]$/, '$1').replace(/\|None|None\|/g, '');

export function paramKind(param) {
  if (param.choices?.length) return 'choice';
  const type = bare(param.type).toLowerCase();
  if (['bool', 'int', 'float', 'str'].includes(type)) return type;
  if (/^(list|tuple|sequence|iterable|set)\[(float|int)(,(float|int|\.\.\.))*\]$/.test(type) || /(^|\.)ndarray$|^npt?\.ndarray|^ndarray\[/.test(type)) return 'numbers';
  if (/^(list|tuple|sequence|iterable|set)\[str(,(str|\.\.\.))*\]$/.test(type)) return 'strings';
  if (/^(dict|mapping)(\[|$)/.test(type)) return 'dict';
  // A list of a class (list[JointState]) is as far from JSON as the class is.
  if (/^(list|tuple|sequence)\[/.test(type) && /\b(?!Any\b)[A-Z]\w*/.test(bare(param.type).replace(/^\w+\[/, ''))) return 'object';
  if (['', 'any', 'object', 'list', 'tuple', 'sequence', 'json', 'jsonvalue'].includes(type) || /^(list|tuple|sequence)\[/.test(type) || /^(int|float|str|bool)(\|(int|float|str|bool))+$/.test(type)) return 'json';
  return 'object';
}

// How many numbers a fixed tuple wants: tuple[float, float, float] -> 3, else null.
export function paramCount(param) {
  const inner = /^tuple\[(.*)\]$/i.exec(bare(param.type))?.[1];
  return inner && !inner.includes('...') ? inner.split(',').length : null;
}

// What to type, shown in the empty box.
export function paramHint(param, kind = paramKind(param)) {
  const count = paramCount(param);
  switch (kind) {
    case 'int': return 'a whole number';
    case 'float': return 'a number';
    case 'str': return 'text';
    case 'numbers': return count ? `${count} numbers: ${Array.from({length: count}, (_, i) => (i * 0.1).toFixed(1)).join(', ')}` : 'numbers: 0.1, 0.2, 0.3';
    case 'strings': return 'names: first, second';
    case 'dict': return 'pairs: key=value, other=2';
    case 'json': return 'a number, text, or a list: 1, 2, 3';
    default: return '';
  }
}

// The Args: part of a docstring, by parameter (Google and NumPy styles), and what comes before it.
export function parseDoc(doc) {
  const out = {summary: '', params: {}, returns: ''};
  let section = 'summary', current = null;
  const summary = [];
  for (const raw of String(doc || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const head = /^(Args|Arguments|Parameters|Params|Returns?|Yields|Raises|Examples?|Notes?|Attributes)\s*:?$/i.exec(line);
    if (head) { section = /^(arg|param)/i.test(head[1]) ? 'params' : /^return/i.test(head[1]) ? 'returns' : 'other'; current = null; continue; }
    if (/^[-=]{3,}$/.test(line)) continue;
    if (section === 'summary') summary.push(line);
    else if (section === 'returns') out.returns = `${out.returns} ${line}`.trim();
    else if (section === 'params') {
      const entry = /^\*{0,2}(\w+)\s*(?:\(([^)]*)\))?\s*:\s*(.*)$/.exec(line);
      if (entry) { current = entry[1]; out.params[current] = entry[3]; }
      else if (current && line) out.params[current] = `${out.params[current]} ${line}`.trim();
    }
  }
  out.summary = summary.join('\n').replace(/\n{2,}/g, '\u0000').replace(/\n/g, ' ').replace(/\u0000/g, '\n').trim();
  return out;
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

// One typed word as the value it reads as: 2 -> 2, true -> true, none -> null, "left arm" -> left arm.
function scalar(text) {
  const word = text.trim();
  if (/^true$/i.test(word)) return true;
  if (/^false$/i.test(word)) return false;
  if (/^(null|none)$/i.test(word)) return null;
  if (word !== '' && Number.isFinite(Number(word))) return Number(word);
  return word.replace(/^(['"])(.*)\1$/s, '$2');
}

function strict(text) { try { return JSON.parse(text); } catch (error) { throw new Error(`is not valid JSON (${error.message.replace(/^JSON\.parse: |^Unexpected /, '')})`); } }

// What the user typed for a parameter -> the JSON value sent. Throws with a message fit to show after the parameter's name.
export function coerce(kind, raw, param = null) {
  if (kind === 'bool') return !!raw;
  if (kind === 'choice') return raw;
  const text = String(raw ?? '').trim();
  if (kind === 'int') { if (!/^-?\d+$/.test(text)) throw new Error('needs a whole number'); return parseInt(text, 10); }
  if (kind === 'float') { const value = Number(text); if (text === '' || !Number.isFinite(value)) throw new Error('needs a number'); return value; }
  if (kind === 'str') return text;
  if (kind === 'object') throw new Error(`is a Python object (${param?.type || 'a class'}); the page cannot build one`);
  if (kind === 'numbers') {
    const values = text.startsWith('[') ? strict(text) : text.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (!Array.isArray(values) || values.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('needs numbers separated by commas');
    const count = param ? paramCount(param) : null;
    if (count && values.length !== count) throw new Error(`needs ${count} numbers (got ${values.length})`);
    return values;
  }
  if (kind === 'strings') return text.startsWith('[') ? strict(text) : text.split(',').map(part => part.trim().replace(/^(['"])(.*)\1$/, '$2')).filter(Boolean);
  if (kind === 'dict') {
    if (text.startsWith('{')) return strict(text);
    const out = {};
    for (const pair of text.split(/[,;\n]+/).map(part => part.trim()).filter(Boolean)) {
      const match = /^([^=:]+)[=:](.*)$/.exec(pair);
      if (!match) throw new Error(`needs key=value pairs ("${pair}" has no =)`);
      out[match[1].trim().replace(/^(['"])(.*)\1$/, '$2')] = scalar(match[2]);
    }
    return out;
  }
  // json: real JSON when it looks like it, else a list of words or one word.
  if (/^[[{"]/.test(text)) return strict(text);
  return text.includes(',') ? text.split(',').map(scalar) : scalar(text);
}

// A JSON value as the text its editor would hold: [1, 2] -> "1, 2", {a: 1} -> "a=1".
export function editable(kind, value) {
  if (value === undefined || value === null) return '';
  if (kind === 'bool' || kind === 'choice') return value;
  if (['numbers', 'strings', 'json'].includes(kind) && Array.isArray(value) && value.length > 1 && value.every(item => typeof item !== 'object' && !String(item).includes(','))) return value.join(', ');
  if (kind === 'dict' && typeof value === 'object' && Object.values(value).every(item => typeof item !== 'object')) return Object.entries(value).map(([key, item]) => `${key}=${item}`).join(', ');
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// A value on one line, for a result row.
export function brief(value, max = 400) {
  let text;
  if (typeof value === 'string') text = value; else { try { text = JSON.stringify(value, null, 1); } catch { text = String(value); } }
  if (text === undefined) text = 'null';
  return text.length > max ? text.slice(0, max) + ' …' : text;
}

export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
