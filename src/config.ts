export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_INGEST_BATCH = 100;
export const MAX_EVENTS_PER_REQUEST = 50;
export const MAX_TAGS_PER_REQUEST = 16;
export const DEFAULT_MAX_QUEUE = 1000;
export const DEFAULT_FLUSH_INTERVAL_MS = 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
export const RETRY_DELAYS_MS = [200, 800] as const;
export const REDACTED = '[redacted]';
export const MAX_EXTRA_REDACT_KEYS = 32;
export const DEFAULT_SAMPLE_RATE = 1;
export const MAX_IN_FLIGHT = 2;

const SENSITIVE_KEYS: Record<string, true> = {
  authorization: true,
  cookie: true,
  'set-cookie': true,
  password: true,
  token: true,
  secret: true,
  api_key: true,
  apikey: true,
  accesstoken: true,
  refreshtoken: true,
  idtoken: true,
  access_token: true,
  refresh_token: true,
  id_token: true,
};

export const REDACT_HEADER_KEYS = SENSITIVE_KEYS;
export const REDACT_BODY_KEYS = SENSITIVE_KEYS;

const config = {
  maxBodyBytes: MAX_BODY_BYTES,
  maxIngestBatch: MAX_INGEST_BATCH,
  maxEventsPerRequest: MAX_EVENTS_PER_REQUEST,
  maxTagsPerRequest: MAX_TAGS_PER_REQUEST,
  defaultMaxQueue: DEFAULT_MAX_QUEUE,
  defaultFlushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
  defaultFetchTimeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
  retryDelaysMs: RETRY_DELAYS_MS,
};

export default config;
