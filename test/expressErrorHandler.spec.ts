import { EventEmitter } from 'node:events';

import type { Request, Response } from 'express';
import { describe, expect, test } from 'vitest';

import createClient from '../src/client';
import expressErrorHandler from '../src/expressErrorHandler';
import expressMiddleware from '../src/expressMiddleware';
import type { IngestRequest } from '../src/types';
import waitForCapture from './waitForCapture';

function createRes(): Response {
  const emitter = new EventEmitter();
  const res = emitter as unknown as Response & EventEmitter;
  res.statusCode = 200;
  res.json = ((body?: unknown) => {
    const payload = JSON.stringify(body);
    res.send(payload);
    return res;
  }) as Response['json'];
  res.send = ((body?: unknown) => {
    void body;
    return res;
  }) as Response['send'];
  return res;
}

function createReq(): Request {
  return {
    method: 'GET',
    originalUrl: '/v1/orders?limit=1',
    url: '/v1/orders?limit=1',
    route: { path: '/v1/orders' },
    headers: {
      authorization: 'Bearer super-secret',
      'user-agent': 'vitest',
    },
    body: { password: 'hunter2', sku: 'abc' },
    query: { limit: '1' },
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

function createTestClient() {
  async function okFetch(): Promise<{ status: number }> {
    return { status: 202 };
  }

  function ignoreDrop(): void {
    return;
  }

  return createClient({
    ingestUrl: 'http://obs.test/v1/ingest',
    writeKey: 'ok_write_test_secret',
    service: 'demo',
    env: 'test',
    flushIntervalMs: 0,
    fetch: okFetch,
    onDrop: ignoreDrop,
  });
}

describe('expressErrorHandler', () => {
  test('without a store still calls next with the error', () => {
    const client = createTestClient();
    const handler = expressErrorHandler(client);
    const err = new Error('boom');
    let passed: unknown;
    handler(err, {} as Request, {} as Response, function next(nextErr) {
      passed = nextErr;
    });
    expect(passed).toBe(err);
    client.close();
  });

  test('with middleware store records errorMessage and unhandled.error step', async () => {
    const enqueued: IngestRequest[] = [];
    const client = createTestClient();
    const originalEnqueue = client.enqueue;
    client.enqueue = function capture(request) {
      enqueued.push(request);
      originalEnqueue(request);
    };
    const middleware = expressMiddleware(client);
    const handler = expressErrorHandler(client);
    const req = createReq();
    const res = createRes();
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    middleware(req, res, function next() {
      handler(err, req, res, function onError(nextErr) {
        expect(nextErr).toBe(err);
      });
    });
    res.statusCode = 500;
    res.emit('finish');
    await waitForCapture();
    expect(enqueued[0]?.errorMessage).toBe('timeout');
    expect(enqueued[0]?.events?.[0]?.name).toBe('unhandled.error');
    expect(enqueued[0]?.events?.[0]?.level).toBe('error');
    expect(enqueued[0]?.events?.[0]?.attrs?.type).toBe('TimeoutError');
    client.close();
  });

  test('does not overwrite setErrorMessage', async () => {
    const enqueued: IngestRequest[] = [];
    const client = createTestClient();
    const originalEnqueue = client.enqueue;
    client.enqueue = function capture(request) {
      enqueued.push(request);
      originalEnqueue(request);
    };
    const middleware = expressMiddleware(client);
    const handler = expressErrorHandler(client);
    const req = createReq();
    const res = createRes();
    const err = new Error('other');
    middleware(req, res, function next() {
      client.setErrorMessage('from-app');
      handler(err, req, res, function onError(nextErr) {
        expect(nextErr).toBe(err);
      });
    });
    res.statusCode = 500;
    res.emit('finish');
    await waitForCapture();
    expect(enqueued[0]?.errorMessage).toBe('from-app');
    expect(enqueued[0]?.events?.[0]?.name).toBe('unhandled.error');
    client.close();
  });
});
