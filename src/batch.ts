import {
  DEFAULT_FETCH_TIMEOUT_MS,
  MAX_INGEST_BATCH,
  MAX_IN_FLIGHT,
  RETRY_DELAYS_MS,
} from './config';
import type { IngestPayload, IngestRequest } from './types';

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ status: number }>;

export type DropReason = 'invalid_response' | 'retry_exhausted' | 'network';

type SendAction = 'ok' | 'drop' | 'retry';

const ACTION_BY_STATUS: Record<number, SendAction> = {
  200: 'ok',
  202: 'ok',
  400: 'drop',
  401: 'drop',
  402: 'drop',
  413: 'drop',
  429: 'retry',
  503: 'retry',
};

export type IngestBatchOptions = {
  ingestUrl: string;
  writeKey: string;
  maxQueue: number;
  flushSize: number;
  flushIntervalMs: number;
  retryDelaysMs: readonly number[];
  fetchTimeoutMs: number;
  fetch: FetchLike;
  onDrop: (reason: DropReason) => void;
};

function actionForStatus(status: number): SendAction {
  const mapped = ACTION_BY_STATUS[status];
  if (mapped !== undefined) {
    return mapped;
  }

  if (status >= 500) {
    return 'retry';
  }

  return 'drop';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

export default class IngestBatch {
  private readonly options: IngestBatchOptions;

  private readonly queue: IngestRequest[] = [];

  private timer: ReturnType<typeof setInterval> | undefined;

  private readonly inFlight = new Set<Promise<void>>();

  constructor(options: IngestBatchOptions) {
    this.options = options;
  }

  size(): number {
    return this.queue.length;
  }

  enqueue(request: IngestRequest): void {
    if (this.queue.length >= this.options.maxQueue) {
      this.queue.shift();
    }

    this.queue.push(request);
    this.ensureTimer();

    if (this.queue.length < this.options.flushSize) {
      return;
    }

    this.launch();
  }

  async flush(): Promise<void> {
    while (true) {
      this.launchAvailable();
      if (this.inFlight.size === 0) {
        return;
      }

      await Promise.race(this.inFlight);
    }
  }

  private launchAvailable(): void {
    while (this.inFlight.size < MAX_IN_FLIGHT && this.queue.length > 0) {
      this.launch();
    }
  }

  private launch(): void {
    if (this.inFlight.size >= MAX_IN_FLIGHT) {
      return;
    }

    const batch = this.takeBatch();
    if (batch.length === 0) {
      return;
    }

    const promise: Promise<void> = this.sendWithRetry(batch).finally(() => {
      this.inFlight.delete(promise);
    });
    this.inFlight.add(promise);
  }

  close(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    void this.flush();
  }

  private takeBatch(): IngestRequest[] {
    const size = Math.min(this.options.flushSize, this.queue.length);
    return this.queue.splice(0, size);
  }

  private ensureTimer(): void {
    if (this.options.flushIntervalMs === 0) {
      return;
    }

    if (this.timer !== undefined) {
      return;
    }

    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs);
    this.timer.unref();
  }

  private async sendWithRetry(requests: IngestRequest[]): Promise<void> {
    const delays = this.options.retryDelaysMs;
    let attempt = 0;

    while (true) {
      const action = await this.sendOnce(requests);
      if (action === 'ok') {
        return;
      }

      if (action === 'drop') {
        this.options.onDrop('invalid_response');
        return;
      }

      const delay = delays[attempt];
      if (delay === undefined) {
        this.options.onDrop('retry_exhausted');
        return;
      }

      await sleep(delay);
      attempt += 1;
    }
  }

  private async sendOnce(requests: IngestRequest[]): Promise<SendAction> {
    const payload: IngestPayload = { requests };

    try {
      const response = await this.options.fetch(this.options.ingestUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.writeKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.options.fetchTimeoutMs),
      });

      return actionForStatus(response.status);
    } catch {
      return 'retry';
    }
  }
}

export function defaultOnDrop(reason: DropReason): void {
  console.error('[obs]', reason);
}

export function defaultFlushSize(maxQueue: number): number {
  return Math.min(MAX_INGEST_BATCH, maxQueue);
}

export { DEFAULT_FETCH_TIMEOUT_MS, RETRY_DELAYS_MS };
