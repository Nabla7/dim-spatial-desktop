// A small CBOR reader, for the streams dimos sends as plain Python values (a str, a pydantic model)
// rather than as LCM messages: the agent's chat topics. Tags are kept as {tag, value}; dimos's own tags
// (dimos/protocol/encode/cbor.py) are unwrapped where a page can use what is inside.
const TAG_TUPLE = 4040, TAG_SET = 4042, TAG_FROZENSET = 4043, TAG_ENUM = 4046, TAG_DATACLASS = 4048, TAG_PYDANTIC = 4049, TAG_DICT = 4056;

export function decodeCbor(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), text = new TextDecoder();
  let at = 0;
  const length = info => {
    if (info < 24) return info;
    if (info === 24) return view.getUint8(at++);
    if (info === 25) { at += 2; return view.getUint16(at - 2); }
    if (info === 26) { at += 4; return view.getUint32(at - 4); }
    if (info === 27) { at += 8; return Number(view.getBigUint64(at - 8)); }
    if (info === 31) return -1;
    throw new Error('bad CBOR length');
  };
  const half = () => {
    const value = view.getUint16(at); at += 2;
    const exponent = (value >> 10) & 31, fraction = value & 1023, sign = value >> 15 ? -1 : 1;
    return sign * (exponent === 0 ? fraction * 2 ** -24 : exponent === 31 ? (fraction ? NaN : Infinity) : (1 + fraction / 1024) * 2 ** (exponent - 15));
  };
  const read = () => {
    const first = view.getUint8(at++), major = first >> 5, info = first & 31;
    if (major === 7) {
      if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; if (info === 23) return undefined;
      if (info === 25) return half();
      if (info === 26) { at += 4; return view.getFloat32(at - 4); }
      if (info === 27) { at += 8; return view.getFloat64(at - 8); }
      return info;
    }
    const n = length(info);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) {
      if (n < 0) { // indefinite: chunks until the break byte
        const chunks = [];
        while (view.getUint8(at) !== 0xff) chunks.push(read());
        at++;
        return major === 3 ? chunks.join('') : Uint8Array.from(chunks.flatMap(chunk => [...chunk]));
      }
      const slice = bytes.subarray(at, at + n); at += n;
      return major === 3 ? text.decode(slice) : slice;
    }
    if (major === 4) {
      const list = [];
      if (n < 0) { while (view.getUint8(at) !== 0xff) list.push(read()); at++; } else for (let i = 0; i < n; i++) list.push(read());
      return list;
    }
    if (major === 5) {
      const map = {};
      const pair = () => { const key = read(); map[typeof key === 'object' ? JSON.stringify(key) : key] = read(); };
      if (n < 0) { while (view.getUint8(at) !== 0xff) pair(); at++; } else for (let i = 0; i < n; i++) pair();
      return map;
    }
    const value = read();
    if (n === TAG_TUPLE || n === TAG_SET || n === TAG_FROZENSET) return value;
    if (n === TAG_PYDANTIC && Array.isArray(value)) return {__class: value[0], ...(value[1] || {}), ...(value[3] || {})};
    if (n === TAG_DATACLASS && Array.isArray(value)) return {__class: value[0], ...(value[1] || {})};
    if (n === TAG_ENUM && Array.isArray(value)) return value[1];
    if (n === TAG_DICT && Array.isArray(value)) return Object.fromEntries(value.map(([key, item]) => [String(key), item]));
    return {tag: n, value};
  };
  return read();
}

// A CBOR text string: what a Python `str` stream carries.
export function encodeCborText(string) {
  const body = new TextEncoder().encode(string), n = body.length;
  const head = n < 24 ? [0x60 | n] : n < 256 ? [0x78, n] : n < 65536 ? [0x79, n >> 8, n & 255] : [0x7a, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const out = new Uint8Array(head.length + n);
  out.set(head); out.set(body, head.length);
  return out;
}
