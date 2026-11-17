// A publishing topic need not be delivered at its source rate: the gateway can deliberately
// slow or pause a low-priority mesh. Recovery must not repeatedly restart its healthy camera.
export function deliveryRate(key, sourceHz, subscriptions) {
  const stream = subscriptions.map(subscription => subscription.gatewayStats).find(stats => stats?.key === key);
  const granted = stream?.allocation?.hz;
  return Number.isFinite(granted) ? Math.max(0, Math.min(sourceHz, granted)) : sourceHz;
}
