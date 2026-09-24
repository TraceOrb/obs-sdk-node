import { EventEmitter } from 'node:events';

import type { Request, Response } from 'express';
import { describe, expect, test } from 'vitest';

import createClient from '../src/client';
import { createStore, runWith } from '../src/context';
import expressMiddleware from '../src/expressMiddleware';
import type { IngestPayload, IngestRequest } from '../src/types';
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

describe('expressMiddleware', () => {
  test('emit finish returns before enqueue', async () => {
    const bodies: IngestPayload[] = [];
    const enqueued: IngestRequest[] = [];
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
      fetch: captureFetch,
    });
    const originalEnqueue = client.enqueue;
    client.enqueue = function capture(request) {
      enqueued.push(request);
      originalEnqueue(request);
    };
    const middleware = expressMiddleware(client);
    const req = createReq();
    const res = createRes();

    function noopNext(): void {
      return;
    }

    middleware(req, res, noopNext);
    res.emit('finish');
    expect(enqueued).toHaveLength(0);
    expect(bodies).toHaveLength(0);
    await waitForCapture();
    expect(enqueued).toHaveLength(1);
    await client.flush();
    expect(bodies).toHaveLength(1);
    client.close();
  });

  test('ingest down still calls next and finish does not throw', async () => {
    async function failingFetch(): Promise<{ status: number }> {
      throw new Error('down');
    }

    function ignoreDrop(): void {
      return;
    }

    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      retryDelaysMs: [0, 0],
      fetch: failingFetch,
      onDrop: ignoreDrop,
    });
    const middleware = expressMiddleware(client);
    const req = createReq();
    const res = createRes();
    let nextCalls = 0;
    function next(): void {
      nextCalls += 1;
    }

    expect(() => {
      middleware(req, res, next);
    }).not.toThrow();
    expect(nextCalls).toBe(1);

    expect(() => {
      res.emit('finish');
    }).not.toThrow();
    await waitForCapture();

    await expect(client.flush()).resolves.toBeUndefined();
    client.close();
  });

  test('authorization never appears in the posted json', async () => {
    const bodies: string[] = [];
    async function captureFetch(
      _url: string,
      init: { body: string },
    ): Promise<{ status: number }> {
      bodies.push(init.body);
      return { status: 202 };
    }

    function resolveTags(): Record<string, string> {
      return { city: '6' };
    }

    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      fetch: captureFetch,
    });
    const middleware = expressMiddleware(client, {
      resolveTags,
    });
    const req = createReq();
    const res = createRes();

    function noopNext(): void {
      return;
    }

    middleware(req, res, noopNext);
    res.json({ ok: true });
    res.emit('finish');
    await waitForCapture();
    await client.flush();

    expect(bodies).toHaveLength(1);
    const raw = bodies[0];
    expect(raw).toBeDefined();
    expect(raw?.includes('super-secret')).toBe(false);
    expect(raw?.includes('hunter2')).toBe(false);
    expect(raw?.toLowerCase().includes('bearer super-secret')).toBe(false);

    const payload = JSON.parse(raw ?? '') as IngestPayload;
    const request = payload.requests[0];
    expect(request?.service).toBe('demo');
    expect(request?.env).toBe('test');
    expect(request?.routePattern).toBe('/v1/orders');
    expect(request?.tags).toEqual({ city: '6' });
    expect(request?.requestHeadersJson).toContain('[redacted]');
    expect(request?.requestBodyJson).toContain('[redacted]');
    expect(request?.requestBodyJson).toContain('abc');
    expect(request?.responseBodyJson).toBe('{"ok":true}');
    client.close();
  });

  test('redactKeys on the client, middleware, request, and obs.redact all apply', async () => {
    const bodies: string[] = [];
    async function captureFetch(
      _url: string,
      init: { body: string },
    ): Promise<{ status: number }> {
      bodies.push(init.body);
      return { status: 202 };
    }

    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      fetch: captureFetch,
      redactKeys: ['email'],
    });
    const middleware = expressMiddleware(client, {
      redactKeys: ['cpf'],
      resolveRedactKeys(req) {
        return [String(req.headers['x-redact'] ?? '')];
      },
    });
    const req = createReq();
    req.headers['x-redact'] = 'phone';
    req.body = {
      email: 'ada@example.com',
      cpf: '123',
      phone: '999',
      ssn: '000',
      sku: 'abc',
    };
    const res = createRes();

    function next(): void {
      client.redact(['ssn']);
    }

    middleware(req, res, next);
    res.emit('finish');
    await waitForCapture();
    await client.flush();

    const payload = JSON.parse(bodies[0] ?? '') as IngestPayload;
    const requestBody = payload.requests[0]?.requestBodyJson ?? '';
    expect(requestBody.includes('ada@example.com')).toBe(false);
    expect(requestBody.includes('"123"')).toBe(false);
    expect(requestBody.includes('999')).toBe(false);
    expect(requestBody.includes('000')).toBe(false);
    expect(requestBody.includes('abc')).toBe(true);
    expect(requestBody).toContain('[redacted]');
    client.close();
  });

  test('step inside a bound store is included in the batch', async () => {
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
      fetch: captureFetch,
    });
    const middleware = expressMiddleware(client);
    const req = createReq();
    const res = createRes();

    function next(): void {
      client.step('handler');
    }

    middleware(req, res, next);
    res.emit('finish');
    await waitForCapture();
    await client.flush();

    expect(bodies[0]?.requests[0]?.events).toEqual([
      expect.objectContaining({ name: 'handler', seq: 0, level: 'info' }),
    ]);
    client.close();
  });

  test('skip does not enqueue', async () => {
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
      fetch: captureFetch,
    });
    const middleware = expressMiddleware(client, {
      skip(req) {
        return req.originalUrl === '/health';
      },
    });
    const req = createReq();
    req.originalUrl = '/health';
    req.url = '/health';
    req.route = { path: '/health' };
    const res = createRes();
    function noopNext(): void {
      return;
    }
    middleware(req, res, noopNext);
    res.emit('finish');
    await waitForCapture();
    await client.flush();
    expect(bodies).toHaveLength(0);
    client.close();
  });
});

describe('createClient', () => {
  test('exposes step as a no-op when no store is bound', () => {
    async function okFetch(): Promise<{ status: number }> {
      return { status: 202 };
    }

    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      fetch: okFetch,
    });

    client.step('orphan');
    expect(client.requestId()).toBeUndefined();
    client.close();
  });

  test('step records when a store is active', () => {
    async function okFetch(): Promise<{ status: number }> {
      return { status: 202 };
    }

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
      client.step('inside');
    });
    expect(store.events).toHaveLength(1);
    client.close();
  });
});

describe('expressMiddleware sample and routes', () => {
  test('sampleRate 0 drops 200 and keeps 500', async () => {
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
      fetch: captureFetch,
      sampleRate: 0,
    });
    const middleware = expressMiddleware(client);
    const req = createReq();
    const res = createRes();

    function noopNext(): void {
      return;
    }

    middleware(req, res, noopNext);
    res.statusCode = 200;
    res.emit('finish');
    await waitForCapture();
    await client.flush();
    expect(bodies).toHaveLength(0);

    const resError = createRes();
    middleware(req, resError, noopNext);
    resError.statusCode = 500;
    resError.emit('finish');
    await waitForCapture();
    await client.flush();
    expect(bodies).toHaveLength(1);
    client.close();
  });

  test('route override sampleRate 1 enqueues while global 0 drops other routes', async () => {
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
      fetch: captureFetch,
      sampleRate: 0,
      routes: { '/webhooks': { sampleRate: 1 } },
    });
    const middleware = expressMiddleware(client);

    function noopNext(): void {
      return;
    }

    const webhookReq = createReq();
    webhookReq.route = { path: '/webhooks' };
    webhookReq.originalUrl = '/webhooks';
    webhookReq.url = '/webhooks';
    const webhookRes = createRes();
    middleware(webhookReq, webhookRes, noopNext);
    webhookRes.statusCode = 200;
    webhookRes.emit('finish');
    await waitForCapture();
    await client.flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.requests[0]?.routePattern).toBe('/webhooks');

    const ordersReq = createReq();
    const ordersRes = createRes();
    middleware(ordersReq, ordersRes, noopNext);
    ordersRes.statusCode = 200;
    ordersRes.emit('finish');
    await waitForCapture();
    await client.flush();
    expect(bodies).toHaveLength(1);
    client.close();
  });
});

describe('expressMiddleware fallbacks', () => {
  test('uses url and socket when originalUrl and ip are missing', async () => {
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
      fetch: captureFetch,
    });
    const middleware = expressMiddleware(client, {
      resolveUserId() {
        return 'user-9';
      },
    });
    const req = {
      method: 'GET',
      originalUrl: '',
      url: '/fallback',
      headers: {
        authorization: 'Bearer super-secret',
        'user-agent': '',
      },
      body: { password: 'hunter2', sku: 'abc' },
      query: { limit: '1' },
      ip: '',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = createRes();

    function noopNext(): void {
      return;
    }

    middleware(req, res, noopNext);
    res.send('plain');
    res.emit('finish');
    await waitForCapture();
    await client.flush();

    const request = bodies[0]?.requests[0];
    expect(request?.path).toBe('/fallback');
    expect(request?.routePattern).toBe('/fallback');
    expect(request?.ip).toBe('127.0.0.1');
    expect(request?.userAgent).toBeUndefined();
    expect(request?.userId).toBe('user-9');
    expect(request?.responseBodyJson).toBe('"plain"');
    client.close();
  });

  test('defaults path to slash when url is empty', async () => {
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
      fetch: captureFetch,
    });
    const middleware = expressMiddleware(client);
    const req = createReq();
    req.originalUrl = '';
    req.url = '';
    const res = createRes();

    function noopNext(): void {
      return;
    }

    middleware(req, res, noopNext);
    res.emit('finish');
    await waitForCapture();
    await client.flush();

    expect(bodies[0]?.requests[0]?.path).toBe('/');
    client.close();
  });

  test('finish swallows resolver errors', async () => {
    async function okFetch(): Promise<{ status: number }> {
      return { status: 202 };
    }

    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'demo',
      env: 'test',
      flushIntervalMs: 0,
      fetch: okFetch,
    });
    const middleware = expressMiddleware(client, {
      resolveTags() {
        throw new Error('boom');
      },
    });
    const req = createReq();
    const res = createRes();

    function noopNext(): void {
      return;
    }

    middleware(req, res, noopNext);
    expect(() => {
      res.emit('finish');
    }).not.toThrow();
    await waitForCapture();
    client.close();
  });
});
