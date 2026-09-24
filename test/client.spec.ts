import { describe, expect, test } from 'vitest';

import createClient from '../src/client';
import { DEFAULT_MAX_QUEUE, MAX_BODY_BYTES } from '../src/config';
import { createStore, runWith } from '../src/context';
import type { IngestPayload } from '../src/types';

async function okFetch(): Promise<{ status: number }> {
  return { status: 202 };
}

describe('createClient', () => {
  test('applies default maxBodyBytes and maxQueue flush size', () => {
    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'orders-api',
      env: 'production',
      flushIntervalMs: 0,
      fetch: okFetch,
    });

    expect(client.service).toBe('orders-api');
    expect(client.env).toBe('production');
    expect(client.maxBodyBytes).toBe(MAX_BODY_BYTES);
    expect(client.redactKeys).toEqual([]);
    client.close();
  });

  test('keeps custom maxBodyBytes and client redactKeys', () => {
    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      maxBodyBytes: 512,
      flushIntervalMs: 0,
      fetch: okFetch,
      redactKeys: ['Email', 'cpf'],
    });

    expect(client.maxBodyBytes).toBe(512);
    expect(client.redactKeys).toEqual(['email', 'cpf']);
    client.close();
  });

  test('enqueue flush and close send the request then stop', async () => {
    const bodies: IngestPayload[] = [];
    async function captureFetch(
      _url: string,
      init: { body: string },
    ): Promise<{ status: number }> {
      bodies.push(JSON.parse(init.body) as IngestPayload);
      return { status: 202 };
    }

    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      maxQueue: DEFAULT_MAX_QUEUE,
      fetch: captureFetch,
    });

    client.enqueue({
      requestId: 'req-1',
      timestamp: new Date().toISOString(),
      method: 'GET',
      path: '/health',
      routePattern: '/health',
      statusCode: 200,
      durationMs: 1,
      service: 'demo',
      env: 'test',
    });
    await client.flush();
    client.close();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.requests[0]?.requestId).toBe('req-1');
  });

  test('setTags setErrorMessage and redact write to the bound store', () => {
    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      fetch: okFetch,
    });
    const store = createStore();
    runWith(store, () => {
      client.setTags({ city: '4' });
      client.setErrorMessage('timeout');
      client.redact(['ssn']);
    });

    expect(store.tags).toEqual({ city: '4' });
    expect(store.errorMessage).toBe('timeout');
    expect(store.redactKeys).toEqual(['ssn']);
    client.close();
  });

  test('setTags setErrorMessage and redact are no-ops without a store', () => {
    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      fetch: okFetch,
    });

    client.setTags({ city: '4' });
    client.setErrorMessage('timeout');
    client.redact(['ssn']);
    expect(client.requestId()).toBeUndefined();
    client.close();
  });

  test('rejects sampleRate outside 0..1', () => {
    expect(() =>
      createClient({
        ingestUrl: 'http://obs.test/v1/ingest',
        writeKey: 'ok_write_test_secret',
        service: 'demo',
        env: 'test',
        flushIntervalMs: 0,
        fetch: okFetch,
        sampleRate: 1.5,
      }),
    ).toThrow();
  });
});
