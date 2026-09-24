import { MAX_TAGS_PER_REQUEST } from './config';
import type { ObsClient } from './client';
import type { RequestStore } from './context';
import mergeRedactKeys from './mergeRedactKeys';
import { shouldIncludeField, type CaptureMode } from './policy';
import { toBodyJson, toHeadersJson } from './toJsonField';
import type { IngestRequest } from './types';

export type CapturedHttp = {
  method: string;
  path: string;
  routePattern: string;
  statusCode: number;
  query: unknown;
  headers: Record<string, unknown>;
  body: unknown;
  ip: string | undefined;
  userAgent: string | undefined;
  extraTags: Record<string, string> | undefined;
  extraRedactKeys: string[] | undefined;
  userId: string | undefined;
};

function capTags(
  tags: Record<string, string>,
): Record<string, string> | undefined {
  const entries = Object.entries(tags);
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries.slice(0, MAX_TAGS_PER_REQUEST));
}

function mergeTags({
  store,
  extra,
}: {
  store: RequestStore;
  extra: Record<string, string> | undefined;
}): Record<string, string> | undefined {
  const merged: Record<string, string> = {
    ...store.tags,
  };

  if (extra !== undefined) {
    Object.assign(merged, extra);
  }

  return capTags(merged);
}

function assignOptionalString({
  target,
  key,
  value,
}: {
  target: IngestRequest;
  key:
    | 'userId'
    | 'ip'
    | 'userAgent'
    | 'errorMessage'
    | 'queryJson'
    | 'requestHeadersJson'
    | 'requestBodyJson'
    | 'responseBodyJson';
  value: string | undefined;
}): void {
  if (value === undefined || value === '') {
    return;
  }

  target[key] = value;
}

function assignCapturedBody({
  target,
  key,
  mode,
  statusCode,
  value,
  maxBytes,
  extraKeys,
}: {
  target: IngestRequest;
  key: 'queryJson' | 'requestBodyJson' | 'responseBodyJson';
  mode: CaptureMode;
  statusCode: number;
  value: unknown;
  maxBytes: number;
  extraKeys: string[];
}): void {
  if (!shouldIncludeField({ mode, statusCode })) {
    return;
  }

  assignOptionalString({
    target,
    key,
    value: toBodyJson({ value, maxBytes, extraKeys }),
  });
}

function assignCapturedHeaders({
  target,
  mode,
  statusCode,
  headers,
  maxBytes,
  extraKeys,
}: {
  target: IngestRequest;
  mode: CaptureMode;
  statusCode: number;
  headers: Record<string, unknown>;
  maxBytes: number;
  extraKeys: string[];
}): void {
  if (!shouldIncludeField({ mode, statusCode })) {
    return;
  }

  assignOptionalString({
    target,
    key: 'requestHeadersJson',
    value: toHeadersJson({
      headers,
      maxBytes,
      extraKeys,
    }),
  });
}

export default function ingestRequestFromCapture({
  http,
  store,
  client,
}: {
  http: CapturedHttp;
  store: RequestStore;
  client: ObsClient;
}): IngestRequest {
  const finishedAt = Date.now();
  const durationMs = Math.max(0, finishedAt - store.startedAt.getTime());
  const extraKeys = mergeRedactKeys([
    client.redactKeys,
    http.extraRedactKeys,
    store.redactKeys,
  ]);
  const maxBytes = client.maxBodyBytes;
  const capture = client.captureFor(http.routePattern);

  const request: IngestRequest = {
    requestId: store.requestId,
    timestamp: store.startedAt.toISOString(),
    method: http.method,
    path: http.path,
    routePattern: http.routePattern,
    statusCode: http.statusCode,
    durationMs,
    service: client.service,
    env: client.env,
  };

  const tags = mergeTags({ store, extra: http.extraTags });
  if (tags !== undefined) {
    request.tags = tags;
  }

  assignOptionalString({ target: request, key: 'userId', value: http.userId });
  assignOptionalString({ target: request, key: 'ip', value: http.ip });
  assignOptionalString({
    target: request,
    key: 'userAgent',
    value: http.userAgent,
  });
  assignOptionalString({
    target: request,
    key: 'errorMessage',
    value: store.errorMessage,
  });
  assignCapturedBody({
    target: request,
    key: 'queryJson',
    mode: capture.query,
    statusCode: http.statusCode,
    value: http.query,
    maxBytes,
    extraKeys,
  });
  assignCapturedHeaders({
    target: request,
    mode: capture.headers,
    statusCode: http.statusCode,
    headers: http.headers,
    maxBytes,
    extraKeys,
  });
  assignCapturedBody({
    target: request,
    key: 'requestBodyJson',
    mode: capture.requestBody,
    statusCode: http.statusCode,
    value: http.body,
    maxBytes,
    extraKeys,
  });
  assignCapturedBody({
    target: request,
    key: 'responseBodyJson',
    mode: capture.responseBody,
    statusCode: http.statusCode,
    value: store.responseBody,
    maxBytes,
    extraKeys,
  });

  if (store.events.length > 0) {
    request.events = store.events;
  }

  return request;
}
