type ProtocolMetrics = {
  startedAt: number;
  httpRequests: number;
  httpRequestBytes: number;
  httpResponseBytes: number;
  wsOpened: number;
  wsClosed: number;
  wsSentFrames: number;
  wsSentBytes: number;
  wsReceivedFrames: number;
  wsReceivedBytes: number;
  reconnects: number;
  activeChatSubscriptions: number;
  maxChatSubscriptions: number;
};

const METRICS_ENABLED =
  typeof __DEV__ !== "undefined" && Boolean(__DEV__);

const metrics: ProtocolMetrics = {
  startedAt: Date.now(),
  httpRequests: 0,
  httpRequestBytes: 0,
  httpResponseBytes: 0,
  wsOpened: 0,
  wsClosed: 0,
  wsSentFrames: 0,
  wsSentBytes: 0,
  wsReceivedFrames: 0,
  wsReceivedBytes: 0,
  reconnects: 0,
  activeChatSubscriptions: 0,
  maxChatSubscriptions: 0,
};

function byteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function recordHttp(requestBody?: string, responseBody?: string): void {
  if (!METRICS_ENABLED) return;
  metrics.httpRequests += 1;
  if (requestBody) metrics.httpRequestBytes += byteLength(requestBody);
  if (responseBody) metrics.httpResponseBytes += byteLength(responseBody);
}

export function recordWsOpen(reconnect: boolean): void {
  if (!METRICS_ENABLED) return;
  metrics.wsOpened += 1;
  if (reconnect) metrics.reconnects += 1;
}

export function recordWsClose(): void {
  if (METRICS_ENABLED) metrics.wsClosed += 1;
}

export function recordWsSent(value: string): void {
  if (!METRICS_ENABLED) return;
  metrics.wsSentFrames += 1;
  metrics.wsSentBytes += byteLength(value);
}

export function recordWsReceived(value: string): void {
  if (!METRICS_ENABLED) return;
  metrics.wsReceivedFrames += 1;
  metrics.wsReceivedBytes += byteLength(value);
}

export function recordChatSubscriptions(count: number): void {
  if (!METRICS_ENABLED) return;
  metrics.activeChatSubscriptions = count;
  metrics.maxChatSubscriptions = Math.max(metrics.maxChatSubscriptions, count);
}

export function logProtocolMetrics(reason: string): void {
  if (!METRICS_ENABLED) return;
  const seconds = Math.max(1, Math.round((Date.now() - metrics.startedAt) / 1000));
  console.debug("[protocol-metrics]", reason, { ...metrics, seconds });
}
