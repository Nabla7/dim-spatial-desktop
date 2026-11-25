// Prefer the unclaimed entrance to a velocity pipeline over a driver's raw input. Transport
// adapters can publish internally, so the absence of an advertised writer is not enough.
const TWIST = new Set(['geometry_msgs.Twist', 'geometry_msgs.TwistStamped']);

export function rankDriveTargets(targets, modules) {
  const edges = new Map();
  for (const module of modules) {
    const streams = module.streams.filter(stream => stream.key && TWIST.has(stream.type));
    const outputs = streams.filter(stream => stream.direction !== 'in');
    for (const input of streams.filter(stream => stream.direction !== 'out')) {
      const next = edges.get(input.key) || new Set();
      for (const output of outputs) if (output.key !== input.key) next.add(output.key);
      edges.set(input.key, next);
    }
  }
  const downstream = key => {
    const visited = new Set([key]), pending = [key];
    while (pending.length) for (const next of edges.get(pending.pop()) || []) {
      if (!visited.has(next)) { visited.add(next); pending.push(next); }
    }
    return visited.size - 1;
  };
  const reach = new Map(targets.map(target => [target.key, downstream(target.key)]));
  return [...targets].sort((a, b) => a.writers.length - b.writers.length || reach.get(b.key) - reach.get(a.key));
}
