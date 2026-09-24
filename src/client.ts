import {
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_QUEUE,
  MAX_BODY_BYTES,
} from './config';
import IngestBatch, {
  type DropReason,
  type FetchLike,
  defaultFlushSize,
  defaultOnDrop,
  DEFAULT_FETCH_TIMEOUT_MS,
  RETRY_DELAYS_MS,
} from './batch';
import {
  requestId as contextRequestId,
  redact as contextRedact,
  setErrorMessage as contextSetErrorMessage,
  setTags as contextSetTags,
  step as contextStep,
} from './context';
import mergeRedactKeys from './mergeRedactKeys';
import {
  parseClientPolicy,
  policyForRoute,
  shouldSample,
  type CaptureConfig,
  type RoutePolicyInput,
} from './policy';
import type { IngestRequest, StepOptions } from './types';

export type CreateClientOptions = {
  ingestUrl: string;
  writeKey: string;
  service: string;
  env: string;
  maxBodyBytes?: number;
  maxQueue?: number;
  flushIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  fetchTimeoutMs?: number;
  fetch?: FetchLike;
  onDrop?: (reason: DropReason) => void;
  redactKeys?: string[];
  sampleRate?: number;
  capture?: Partial<CaptureConfig>;
  routes?: Record<string, RoutePolicyInput>;
};

export type ObsClient = {
  service: string;
  env: string;
  maxBodyBytes: number;
  redactKeys: string[];
  step: (
    name: string,
    attrs?: Record<string, string>,
    options?: StepOptions,
  ) => void;
  requestId: () => string | undefined;
  setTags: (tags: Record<string, string>) => void;
  redact: (keys: string[]) => void;
  setErrorMessage: (message: string) => void;
  enqueue: (request: IngestRequest) => void;
  flush: () => Promise<void>;
  close: () => void;
  shouldEnqueue: (routePattern: string, statusCode: number) => boolean;
  captureFor: (routePattern: string) => CaptureConfig;
};

function resolveMaxQueue(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_QUEUE;
  }

  return value;
}

function resolveMaxBodyBytes(value: number | undefined): number {
  if (value === undefined) {
    return MAX_BODY_BYTES;
  }

  return value;
}

function resolveFlushIntervalMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_FLUSH_INTERVAL_MS;
  }

  return value;
}

function resolveRetryDelays(
  value: readonly number[] | undefined,
): readonly number[] {
  if (value === undefined) {
    return RETRY_DELAYS_MS;
  }

  return value;
}

function resolveFetchTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_FETCH_TIMEOUT_MS;
  }

  return value;
}

function resolveFetch(value: FetchLike | undefined): FetchLike {
  if (value === undefined) {
    return fetch;
  }

  return value;
}

function resolveOnDrop(
  value: ((reason: DropReason) => void) | undefined,
): (reason: DropReason) => void {
  if (value === undefined) {
    return defaultOnDrop;
  }

  return value;
}

function policyInputFromOptions(options: CreateClientOptions): {
  sampleRate?: number;
  capture?: Partial<CaptureConfig>;
  routes?: Record<string, RoutePolicyInput>;
} {
  const input: {
    sampleRate?: number;
    capture?: Partial<CaptureConfig>;
    routes?: Record<string, RoutePolicyInput>;
  } = {};
  if (options.sampleRate !== undefined) {
    input.sampleRate = options.sampleRate;
  }
  if (options.capture !== undefined) {
    input.capture = options.capture;
  }
  if (options.routes !== undefined) {
    input.routes = options.routes;
  }
  return input;
}

export default function createClient(options: CreateClientOptions): ObsClient {
  const policy = parseClientPolicy(policyInputFromOptions(options));
  const maxQueue = resolveMaxQueue(options.maxQueue);
  const batch = new IngestBatch({
    ingestUrl: options.ingestUrl,
    writeKey: options.writeKey,
    maxQueue,
    flushSize: defaultFlushSize(maxQueue),
    flushIntervalMs: resolveFlushIntervalMs(options.flushIntervalMs),
    retryDelaysMs: resolveRetryDelays(options.retryDelaysMs),
    fetchTimeoutMs: resolveFetchTimeoutMs(options.fetchTimeoutMs),
    fetch: resolveFetch(options.fetch),
    onDrop: resolveOnDrop(options.onDrop),
  });

  return {
    service: options.service,
    env: options.env,
    maxBodyBytes: resolveMaxBodyBytes(options.maxBodyBytes),
    redactKeys: mergeRedactKeys([options.redactKeys]),
    step: contextStep,
    requestId: contextRequestId,
    setTags: contextSetTags,
    redact: contextRedact,
    setErrorMessage: contextSetErrorMessage,
    enqueue(request: IngestRequest) {
      batch.enqueue(request);
    },
    flush() {
      return batch.flush();
    },
    close() {
      batch.close();
    },
    shouldEnqueue(routePattern: string, statusCode: number) {
      const routePolicy = policyForRoute(policy, routePattern);
      return shouldSample({
        sampleRate: routePolicy.sampleRate,
        statusCode,
        random: Math.random(),
      });
    },
    captureFor(routePattern: string) {
      return policyForRoute(policy, routePattern).capture;
    },
  };
}
