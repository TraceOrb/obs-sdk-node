import { describe, expect, test } from 'vitest';

import createClient from '../src/client';
import { MAX_TAGS_PER_REQUEST } from '../src/config';
import { createStore, type RequestStore } from '../src/context';
import ingestRequestFromCapture, {
  type CapturedHttp,
} from '../src/ingestRequestFromCapture';

async function okFetch(): Promise<{ status: number }> {
  return { status: 202 };
}

function makeClient() {
  return createClient({
    ingestUrl: 'http://obs.test/v1/ingest',
    writeKey: 'ok_write_test_secret',
    service: 'demo',
    env: 'test',
    flushIntervalMs: 0,
    fetch: okFetch,
  });
}

function makeHttp(overrides: Partial<CapturedHttp> = {}): CapturedHttp {
  return {
    method: 'POST',
    path: '/v1/orders?limit=1',
    routePattern: '/v1/orders',
    statusCode: 201,
    query: { limit: '1' },
    headers: { Accept: 'application/json' },
    body: { sku: 'abc' },
    ip: '127.0.0.1',
    userAgent: 'vitest',
    extraTags: undefined,
    extraRedactKeys: undefined,
    userId: 'u-1',
    ...overrides,
  };
}

function pastStore(): RequestStore {
  const store = createStore();
  store.startedAt = new Date(Date.now() - 40);
  return store;
}

describe('ingestRequestFromCapture', () => {
  test('maps http and store onto the ingest request', () => {
    const client = makeClient();
    const store = pastStore();
    store.events.push({
      seq: 0,
      timestamp: new Date().toISOString(),
      name: 'handler',
      level: 'info',
    });
    store.errorMessage = 'boom';
    store.responseBody = { ok: true };
    store.tags = { city: '6' };

    const request = ingestRequestFromCapture({
      http: makeHttp({ extraTags: { tenant: 'acme' } }),
      store,
      client,
    });

    expect(request.requestId).toBe(store.requestId);
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/orders?limit=1');
    expect(request.routePattern).toBe('/v1/orders');
    expect(request.statusCode).toBe(201);
    expect(request.durationMs).toBeGreaterThanOrEqual(40);
    expect(request.service).toBe('demo');
    expect(request.env).toBe('test');
    expect(request.tags).toEqual({ city: '6', tenant: 'acme' });
    expect(request.userId).toBe('u-1');
    expect(request.ip).toBe('127.0.0.1');
    expect(request.userAgent).toBe('vitest');
    expect(request.errorMessage).toBe('boom');
    expect(request.queryJson).toContain('limit');
    expect(request.requestHeadersJson).toContain('Accept');
    expect(request.requestBodyJson).toContain('abc');
    expect(request.responseBodyJson).toBe('{"ok":true}');
    expect(request.events).toHaveLength(1);
    client.close();
  });

  test('omits empty optional strings and empty tags', () => {
    const client = makeClient();
    const store = createStore();
    const request = ingestRequestFromCapture({
      http: makeHttp({
        ip: '',
        userAgent: undefined,
        userId: '',
        extraTags: {},
        query: undefined,
        body: undefined,
      }),
      store,
      client,
    });

    expect(request.ip).toBeUndefined();
    expect(request.userAgent).toBeUndefined();
    expect(request.userId).toBeUndefined();
    expect(request.tags).toBeUndefined();
    expect(request.queryJson).toBeUndefined();
    expect(request.requestBodyJson).toBeUndefined();
    expect(request.events).toBeUndefined();
    expect(request.errorMessage).toBeUndefined();
    client.close();
  });

  test('caps tags at the configured maximum', () => {
    const client = makeClient();
    const store = createStore();
    const extraTags: Record<string, string> = {};
    for (let i = 0; i < MAX_TAGS_PER_REQUEST + 4; i += 1) {
      extraTags[`k${i}`] = 'v';
    }

    const request = ingestRequestFromCapture({
      http: makeHttp({ extraTags }),
      store,
      client,
    });

    expect(Object.keys(request.tags ?? {})).toHaveLength(MAX_TAGS_PER_REQUEST);
    client.close();
  });

  test('future startedAt yields zero duration', () => {
    const client = makeClient();
    const store = createStore();
    store.startedAt = new Date(Date.now() + 60_000);
    const request = ingestRequestFromCapture({
      http: makeHttp(),
      store,
      client,
    });

    expect(request.durationMs).toBe(0);
    client.close();
  });

  test('omits responseBodyJson when capture is errors and status is 200', () => {
    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      fetch: okFetch,
      capture: { responseBody: 'errors' },
    });
    const store = pastStore();
    store.responseBody = { ok: true };
    const request = ingestRequestFromCapture({
      http: makeHttp({ statusCode: 200 }),
      store,
      client,
    });
    expect(request.responseBodyJson).toBeUndefined();
    expect(request.requestBodyJson).toBeDefined();
    client.close();
  });

  test('keeps responseBodyJson on 400 when capture is errors', () => {
    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      fetch: okFetch,
      capture: { responseBody: 'errors' },
    });
    const store = pastStore();
    store.responseBody = { error: true };
    const request = ingestRequestFromCapture({
      http: makeHttp({ statusCode: 400 }),
      store,
      client,
    });
    expect(request.responseBodyJson).toBeDefined();
    client.close();
  });

  test('omits requestBodyJson when capture is never', () => {
    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      fetch: okFetch,
      capture: { requestBody: 'never' },
    });
    const request = ingestRequestFromCapture({
      http: makeHttp(),
      store: pastStore(),
      client,
    });
    expect(request.requestBodyJson).toBeUndefined();
    client.close();
  });
});
