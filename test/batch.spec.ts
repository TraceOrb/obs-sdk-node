import { randomUUID } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import IngestBatch, {
  defaultFlushSize,
  defaultOnDrop,
  type FetchLike,
} from '../src/batch';
import { MAX_INGEST_BATCH } from '../src/config';
import type { IngestPayload, IngestRequest } from '../src/types';

function makeRequest(path: string): IngestRequest {
  return {
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    method: 'GET',
    path,
    routePattern: path,
    statusCode: 200,
    durationMs: 3,
    service: 'demo',
    env: 'test',
  };
}

function createBatch({
  fetch,
  maxQueue = 8,
  flushSize = 100,
  onDrop = function noopDrop(_reason: string): void {
    return;
  },
}: {
  fetch: FetchLike;
  maxQueue?: number;
  flushSize?: number;
  onDrop?: (reason: string) => void;
}): IngestBatch {
  return new IngestBatch({
    ingestUrl: 'http://obs.test/v1/ingest',
    writeKey: 'ok_write_test_secret',
    maxQueue,
    flushSize,
    flushIntervalMs: 0,
    retryDelaysMs: [0, 0],
    fetchTimeoutMs: 50,
    fetch,
    onDrop,
  });
}

describe('IngestBatch', () => {
  test('flush posts the ingest contract shape', async () => {
    const bodies: IngestPayload[] = [];
    async function captureFetch(
      _url: string,
      init: { body: string },
    ): Promise<{ status: number }> {
      bodies.push(JSON.parse(init.body) as IngestPayload);
      return { status: 202 };
    }

    const batch = createBatch({ fetch: captureFetch });
    const request = makeRequest('/health');
    batch.enqueue(request);
    await batch.flush();

    expect(bodies).toHaveLength(1);
    const payload = bodies[0];
    expect(payload).toEqual({
      requests: [request],
    });
    expect(payload?.requests[0]?.requestId).toEqual(expect.any(String));
  });

  test('queue never grows past maxQueue', async () => {
    const bodies: IngestPayload[] = [];
    async function captureFetch(
      _url: string,
      init: { body: string },
    ): Promise<{ status: number }> {
      bodies.push(JSON.parse(init.body) as IngestPayload);
      return { status: 202 };
    }

    const batch = createBatch({
      fetch: captureFetch,
      maxQueue: 2,
      flushSize: 100,
    });
    batch.enqueue(makeRequest('/a'));
    batch.enqueue(makeRequest('/b'));
    batch.enqueue(makeRequest('/c'));
    batch.enqueue(makeRequest('/d'));

    expect(batch.size()).toBe(2);

    await batch.flush();
    const sent = bodies[0]?.requests.map(item => item.path);
    expect(sent).toEqual(['/c', '/d']);
  });

  test('network errors drop after retries without throwing', async () => {
    const drops: string[] = [];
    async function failingFetch(): Promise<{ status: number }> {
      throw new Error('down');
    }

    function captureDrop(reason: string): void {
      drops.push(reason);
    }

    const batch = createBatch({
      fetch: failingFetch,
      onDrop: captureDrop,
    });
    batch.enqueue(makeRequest('/x'));
    await expect(batch.flush()).resolves.toBeUndefined();
    expect(drops).toEqual(['retry_exhausted']);
  });

  test('401 drops without retrying', async () => {
    let calls = 0;
    const drops: string[] = [];
    async function unauthorizedFetch(): Promise<{ status: number }> {
      calls += 1;
      return { status: 401 };
    }

    function captureDrop(reason: string): void {
      drops.push(reason);
    }

    const batch = createBatch({
      fetch: unauthorizedFetch,
      onDrop: captureDrop,
    });
    batch.enqueue(makeRequest('/x'));
    await batch.flush();
    expect(calls).toBe(1);
    expect(drops).toEqual(['invalid_response']);
  });

  test('200 is success', async () => {
    async function okFetch(): Promise<{ status: number }> {
      return { status: 200 };
    }

    const batch = createBatch({ fetch: okFetch });
    batch.enqueue(makeRequest('/x'));
    await expect(batch.flush()).resolves.toBeUndefined();
  });

  test('429 retries then succeeds', async () => {
    let calls = 0;
    async function rateLimitedThenOk(): Promise<{ status: number }> {
      calls += 1;
      if (calls === 1) {
        return { status: 429 };
      }

      return { status: 202 };
    }

    const batch = createBatch({ fetch: rateLimitedThenOk });
    batch.enqueue(makeRequest('/x'));
    await batch.flush();
    expect(calls).toBe(2);
  });

  test('unknown 4xx drops without retrying', async () => {
    let calls = 0;
    const drops: string[] = [];
    async function teapotFetch(): Promise<{ status: number }> {
      calls += 1;
      return { status: 418 };
    }

    function captureDrop(reason: string): void {
      drops.push(reason);
    }

    const batch = createBatch({
      fetch: teapotFetch,
      onDrop: captureDrop,
    });
    batch.enqueue(makeRequest('/x'));
    await batch.flush();
    expect(calls).toBe(1);
    expect(drops).toEqual(['invalid_response']);
  });

  test('500 retries until exhausted', async () => {
    let calls = 0;
    const drops: string[] = [];
    async function serverErrorFetch(): Promise<{ status: number }> {
      calls += 1;
      return { status: 500 };
    }

    function captureDrop(reason: string): void {
      drops.push(reason);
    }

    const batch = createBatch({
      fetch: serverErrorFetch,
      onDrop: captureDrop,
    });
    batch.enqueue(makeRequest('/x'));
    await batch.flush();
    expect(calls).toBe(3);
    expect(drops).toEqual(['retry_exhausted']);
  });

  test('flush of an empty queue does not post', async () => {
    let calls = 0;
    async function countingFetch(): Promise<{ status: number }> {
      calls += 1;
      return { status: 202 };
    }

    const batch = createBatch({ fetch: countingFetch });
    await batch.flush();
    expect(calls).toBe(0);
  });

  test('second batch posts while the first is in flight', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const started: number[] = [];
    async function gatedFetch(): Promise<{ status: number }> {
      const n = started.length + 1;
      started.push(n);
      if (n === 1) {
        await firstGate;
      }
      return { status: 202 };
    }

    const batch = createBatch({
      fetch: gatedFetch,
      maxQueue: 8,
      flushSize: 1,
    });
    batch.enqueue(makeRequest('/a'));
    await Promise.resolve();
    batch.enqueue(makeRequest('/b'));
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    releaseFirst();
    await batch.flush();
  });

  test('close is safe before a timer exists', () => {
    async function okFetch(): Promise<{ status: number }> {
      return { status: 202 };
    }

    const batch = createBatch({ fetch: okFetch });
    expect(() => {
      batch.close();
      batch.close();
    }).not.toThrow();
  });

  test('close starts drain of queued requests', async () => {
    const bodies: IngestPayload[] = [];
    async function captureFetch(
      _input: string,
      init: { body: string },
    ): Promise<{ status: number }> {
      bodies.push(JSON.parse(init.body) as IngestPayload);
      return { status: 202 };
    }

    const batch = createBatch({ fetch: captureFetch, flushSize: 100 });
    batch.enqueue(makeRequest('/drain-on-close'));
    batch.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.requests[0]?.path).toBe('/drain-on-close');
  });

  test('defaultFlushSize never exceeds the ingest batch cap', () => {
    expect(defaultFlushSize(8)).toBe(8);
    expect(defaultFlushSize(10_000)).toBe(MAX_INGEST_BATCH);
  });

  test('defaultOnDrop writes to console.error', () => {
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = function captureError(...args: unknown[]) {
      lines.push(args);
    };

    try {
      defaultOnDrop('network');
    } finally {
      console.error = original;
    }

    expect(lines).toEqual([['[obs]', 'network']]);
  });
});
