import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';

import createClient from '../src/client';
import fastifyMiddleware from '../src/fastifyMiddleware';
import type { IngestPayload, IngestRequest } from '../src/types';
import waitForCapture from './waitForCapture';

describe('fastifyMiddleware', () => {
  test('inject returns before enqueue', async () => {
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
    const app = Fastify();
    fastifyMiddleware(app, client);
    app.get('/v1/me', async function me() {
      return { email: 'a@b.c' };
    });
    await app.inject({ method: 'GET', url: '/v1/me' });
    expect(enqueued).toHaveLength(0);
    expect(bodies).toHaveLength(0);
    await waitForCapture();
    expect(enqueued).toHaveLength(1);
    await client.flush();
    expect(bodies).toHaveLength(1);
    client.close();
    await app.close();
  });

  test('skips ingest and health and captures other routes', async () => {
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
      service: 'obs-api',
      env: 'test',
      flushIntervalMs: 0,
      fetch: captureFetch,
    });

    const app = Fastify();
    fastifyMiddleware(app, client, {
      skip(request) {
        return (
          request.url === '/health' || request.url.startsWith('/v1/ingest')
        );
      },
    });
    app.get('/health', async function health() {
      return { ok: true };
    });
    app.get('/v1/me', async function me() {
      return { email: 'a@b.c' };
    });

    await app.inject({ method: 'GET', url: '/health' });
    await app.inject({ method: 'GET', url: '/v1/me' });
    await waitForCapture();
    await client.flush();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.requests[0]?.path).toBe('/v1/me');
    expect(bodies[0]?.requests[0]?.service).toBe('obs-api');
    expect(bodies[0]?.requests[0]?.responseBodyJson).toContain('a@b.c');

    client.close();
    await app.close();
  });

  test('authorization is redacted', async () => {
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
      service: 'obs-api',
      env: 'test',
      flushIntervalMs: 0,
      fetch: captureFetch,
    });

    const app = Fastify();
    fastifyMiddleware(app, client);
    app.post('/v1/early-access', async function early() {
      return { ok: true };
    });

    await app.inject({
      method: 'POST',
      url: '/v1/early-access',
      headers: { authorization: 'Bearer super-secret' },
      payload: { email: 'a@b.c', password: 'hunter2' },
    });
    await waitForCapture();
    await client.flush();

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.includes('super-secret')).toBe(false);
    expect(bodies[0]?.includes('hunter2')).toBe(false);

    client.close();
    await app.close();
  });

  test('middleware redactKeys redacts extra body fields', async () => {
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
      service: 'obs-api',
      env: 'test',
      flushIntervalMs: 0,
      fetch: captureFetch,
    });

    const app = Fastify();
    fastifyMiddleware(app, client, {
      redactKeys: ['email'],
    });
    app.post('/v1/leads', async function lead() {
      return { ok: true };
    });

    await app.inject({
      method: 'POST',
      url: '/v1/leads',
      payload: { email: 'ada@example.com', sku: 'abc' },
    });
    await waitForCapture();
    await client.flush();

    const requestBody = bodies[0]?.requests[0]?.requestBodyJson ?? '';
    expect(requestBody.includes('ada@example.com')).toBe(false);
    expect(requestBody.includes('abc')).toBe(true);
    expect(requestBody).toContain('[redacted]');

    client.close();
    await app.close();
  });

  test('captures tags userId and route pattern', async () => {
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
      service: 'obs-api',
      env: 'test',
      flushIntervalMs: 0,
      fetch: captureFetch,
    });

    const app = Fastify();
    fastifyMiddleware(app, client, {
      resolveTags() {
        return { tenant: 'acme' };
      },
      resolveUserId() {
        return 'user-2';
      },
    });
    app.get('/v1/orders/:id', async function order() {
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/v1/orders/9' });
    await waitForCapture();
    await client.flush();

    const request = bodies[0]?.requests[0];
    expect(request?.path).toBe('/v1/orders/9');
    expect(request?.routePattern).toBe('/v1/orders/:id');
    expect(request?.tags).toEqual({ tenant: 'acme' });
    expect(request?.userId).toBe('user-2');

    client.close();
    await app.close();
  });

  test('onResponse swallows resolver errors', async () => {
    async function okFetch(): Promise<{ status: number }> {
      return { status: 202 };
    }

    const client = createClient({
      ingestUrl: 'http://obs.test/v1/ingest',
      writeKey: 'ok_write_test_secret',
      service: 'obs-api',
      env: 'test',
      flushIntervalMs: 0,
      fetch: okFetch,
    });

    const app = Fastify();
    fastifyMiddleware(app, client, {
      resolveTags() {
        throw new Error('boom');
      },
    });
    app.get('/v1/me', async function me() {
      return { ok: true };
    });

    const response = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(response.statusCode).toBe(200);
    await waitForCapture();

    client.close();
    await app.close();
  });

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
      service: 'obs-api',
      env: 'test',
      flushIntervalMs: 0,
      fetch: captureFetch,
      sampleRate: 0,
    });

    const app = Fastify();
    fastifyMiddleware(app, client);
    app.get('/v1/ok', async function ok() {
      return { ok: true };
    });
    app.get('/v1/fail', async function fail(_request, reply) {
      reply.code(500);
      return { error: true };
    });

    await app.inject({ method: 'GET', url: '/v1/ok' });
    await waitForCapture();
    await client.flush();
    expect(bodies).toHaveLength(0);

    await app.inject({ method: 'GET', url: '/v1/fail' });
    await waitForCapture();
    await client.flush();
    expect(bodies).toHaveLength(1);

    client.close();
    await app.close();
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
      service: 'obs-api',
      env: 'test',
      flushIntervalMs: 0,
      fetch: captureFetch,
      sampleRate: 0,
      routes: { '/webhooks': { sampleRate: 1 } },
    });

    const app = Fastify();
    fastifyMiddleware(app, client);
    app.get('/webhooks', async function webhooks() {
      return { ok: true };
    });
    app.get('/v1/orders', async function orders() {
      return { ok: true };
    });

    await app.inject({ method: 'GET', url: '/webhooks' });
    await waitForCapture();
    await client.flush();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.requests[0]?.routePattern).toBe('/webhooks');

    await app.inject({ method: 'GET', url: '/v1/orders' });
    await waitForCapture();
    await client.flush();
    expect(bodies).toHaveLength(1);

    client.close();
    await app.close();
  });
});
