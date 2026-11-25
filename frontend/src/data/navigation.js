// Navigation inputs are discovered from typed ports, including remapped topics. Never offer an
// arm's Cartesian target as a floor goal. Prefer the operator click input over a planner's internal goal.
const TYPES = new Set(['geometry_msgs.PointStamped', 'geometry_msgs.PoseStamped']);
const PORT = /^(clicked_point|goal|goal_request|navigation_goal|nav_goal|way_?point|destination)$/i;
const TOPIC = /(?:^|[/_-])(clicked_point|goal|way_?point|destination)(?:$|[/_-])/i;
const ARM = /(?:^|[/_-])(arm|wrist|gripper|end_effector|cartesian)(?:$|[/_-])/i;

export function navigationTargets(commands) {
  return commands.filter(target => TYPES.has(target.type) && !ARM.test(target.topic)
    && (target.ports.some(name => PORT.test(name)) || TOPIC.test(target.topic)))
    .sort((a, b) => a.writers.length - b.writers.length
      || Number(b.ports.includes('clicked_point')) - Number(a.ports.includes('clicked_point'))
      || a.topic.localeCompare(b.topic));
}

export function navigationFrame(layers) {
  if (layers.tf.root) return layers.tf.root;
  // Without TF, a single visible map frame is unambiguous. Never invent a frame called "world".
  const frames = new Set([...layers.layers.values()]
    .filter(layer => layer.visible && ['cloud', 'grid'].includes(layer.kind) && layer.frameId)
    .map(layer => layer.frameId));
  return frames.size === 1 ? [...frames][0] : null;
}
