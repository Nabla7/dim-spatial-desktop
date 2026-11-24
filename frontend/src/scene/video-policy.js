// Adapted from dimensionalOS/dim-controller's core/video.ts and videoQuality.ts.
// A 3D preview yields to an open camera screen. Armed controls promote previews too,
// since a spatial camera surface can itself be the operator's view of the robot.
export const VIDEO_PRESETS = {
  balanced: {label: 'AUTO', hint: 'Balanced: adapt to the connection', options: {}},
  latency: {label: 'FAST', hint: 'Low latency: up to 640×360, keep the frame rate', options: {maxResolution: [640, 360], qualityToHzTradeoff: 1}},
  quality: {label: 'DETAIL', hint: 'Full detail: may drop frames; buffered only while controls are disarmed',
    options: {minResolutionScale: 1, maxBitrate: 20_000_000, minQuality: 0.3, qualityToHzTradeoff: 0, playoutDelay: [100, 400]}},
};

export function videoOptions(uses, quality = 'balanced', main = false, interactive = false) {
  const viewed = uses.view > 0 || interactive;
  const options = viewed ? (VIDEO_PRESETS[quality] || VIDEO_PRESETS.balanced).options
    : {maxResolution: [320, 240], maxHz: 3, qualityToHzTradeoff: 1};
  return {...options, ...(interactive ? {playoutDelay: [0, 0]} : {}), bandwidthPriority: main ? 2 : viewed ? 1 : 0.25};
}

export function optionChanges(before, after) {
  return {...Object.fromEntries(Object.keys(before).map(key => [key, null])), ...after};
}

// Firefox needs a fresh receiver when leaving buffered playout; otherwise update in place.
export function needsNewReceiver(before, after) {
  const lowLatency = options => { const [min, max] = options.playoutDelay || [0, 0]; return min === 0 && max <= 500; };
  return !lowLatency(before) && lowLatency(after);
}
