import { describe, expect, test } from 'vitest';

import createClient from '../src/client';
import fastifyErrorHandler from '../src/fastifyErrorHandler';
import fastifyMiddleware from '../src/fastifyMiddleware';
import type { IngestRequest } from '../src/types';
import waitForCapture from './waitForCapture';

type FakeRequest = {
  url: string;
  method: string;
  headers: Record<string, unknown>;
  body?: unknown;
  query?: unknown;
  ip?: string;
  routeOptions?: {
    url?: string;
  };
};

type OnRequestHook = (
  request: FakeRequest,
  reply: unknown,
  done: () => void,
) => void;

type OnSendHook = (
  request: FakeRequest,
  reply: unknown,
  payload: unknown,
  done: (error: Error | null, payload?: unknown) => void,
) => void;

type OnResponseHook = (
  request: FakeRequest,
  reply: { statusCode: number },
  done: () => void,
) => void;

type OnErrorHook = (
  request: FakeRequest,
  reply: unknown,
  err: unknown,
  done: () => void,
) => void;

function createFakeApp() {
  const onRequest: OnRequestHook[] = [];
  const onSend: OnSendHook[] = [];
  const onResponse: OnResponseHook[] = [];
  const onError: OnErrorHook[] = [];

  function addHook(name: 'onRequest', hook: OnRequestHook): void;
  function addHook(name: 'onSend', hook: OnSendHook): void;
  function addHook(name: 'onResponse', hook: OnResponseHook): void;
  function addHook(name: 'onError', hook: OnErrorHook): void;
  function addHook(
    name: 'onRequest' | 'onSend' | 'onResponse' | 'onError',
    hook: OnRequestHook | OnSendHook | OnResponseHook | OnErrorHook,
  ): void {
    if (name === 'onRequest') {
      onRequest.push(hook as OnRequestHook);
      return;
    }

    if (name === 'onSend') {
      onSend.push(hook as OnSendHook);
      return;
    }

    if (name === 'onResponse') {
      onResponse.push(hook as OnResponseHook);
      return;
    }

    onError.push(hook as OnErrorHook);
  }

  return {
    addHook,
    onRequest,
    onSend,
    onResponse,
    onError,
  };
}

function createFakeRequest(): FakeRequest {
  return {
    url: '/v1/orders',
    method: 'GET',
    headers: {
      'user-agent': 'vitest',
    },
    body: { sku: 'abc' },
    query: { limit: '1' },
    ip: '127.0.0.1',
    routeOptions: {
      url: '/v1/orders',
    },
  };
}

function noopDone(): void {
  return;
}

function fireOnRequest(
  app: ReturnType<typeof createFakeApp>,
  request: FakeRequest,
): void {
  for (const hook of app.onRequest) {
    hook(request, {}, noopDone);
  }
}

function fireOnError(
  app: ReturnType<typeof createFakeApp>,
  request: FakeRequest,
  err: unknown,
): { doneCalls: number } {
  let doneCalls = 0;
  function done(): void {
    doneCalls += 1;
  }

  for (const hook of app.onError) {
    hook(request, {}, err, done);
  }

  return { doneCalls };
}

function fireOnResponse(
  app: ReturnType<typeof createFakeApp>,
  request: FakeRequest,
  statusCode: number,
): void {
  for (const hook of app.onResponse) {
    hook(request, { statusCode }, noopDone);
  }
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

describe('fastifyErrorHandler', () => {
  test('without a store still calls done', () => {
    const client = createTestClient();
    const app = createFakeApp();
    fastifyErrorHandler(app, client);
    const err = new Error('boom');
    const result = fireOnError(app, createFakeRequest(), err);
    expect(result.doneCalls).toBe(1);
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
    const app = createFakeApp();
    fastifyMiddleware(app, client);
    fastifyErrorHandler(app, client);
    const request = createFakeRequest();
    fireOnRequest(app, request);
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    const result = fireOnError(app, request, err);
    expect(result.doneCalls).toBe(1);
    fireOnResponse(app, request, 500);
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
    const app = createFakeApp();
    fastifyMiddleware(app, client);
    fastifyErrorHandler(app, client);
    const request = createFakeRequest();
    fireOnRequest(app, request);
    client.setErrorMessage('from-app');
    const err = new Error('other');
    fireOnError(app, request, err);
    fireOnResponse(app, request, 500);
    await waitForCapture();
    expect(enqueued[0]?.errorMessage).toBe('from-app');
    expect(enqueued[0]?.events?.[0]?.name).toBe('unhandled.error');
    client.close();
  });
});
