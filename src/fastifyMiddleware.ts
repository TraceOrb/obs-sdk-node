import type { ObsClient } from './client';
import { bindStore, createStore } from './context';
import ingestRequestFromCapture from './ingestRequestFromCapture';
import mergeRedactKeys from './mergeRedactKeys';
import { getMappedRequestStore, setRequestStore } from './requestStoreMap';

export type FastifyObsRequest = {
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

export type FastifyObsReply = {
  statusCode: number;
};

export type FastifyObsApp = {
  addHook(
    name: 'onRequest',
    hook: (
      request: FastifyObsRequest,
      reply: unknown,
      done: () => void,
    ) => void,
  ): unknown;
  addHook(
    name: 'onSend',
    hook: (
      request: FastifyObsRequest,
      reply: unknown,
      payload: unknown,
      done: (error: Error | null, payload?: unknown) => void,
    ) => void,
  ): unknown;
  addHook(
    name: 'onResponse',
    hook: (
      request: FastifyObsRequest,
      reply: FastifyObsReply,
      done: () => void,
    ) => void,
  ): unknown;
};

export type FastifyMiddlewareOptions = {
  skip?: (request: FastifyObsRequest) => boolean;
  resolveTags?: (
    request: FastifyObsRequest,
  ) => Record<string, string> | undefined;
  resolveUserId?: (request: FastifyObsRequest) => string | undefined;
  redactKeys?: string[];
  resolveRedactKeys?: (request: FastifyObsRequest) => string[] | undefined;
};

function shouldSkip({
  request,
  options,
}: {
  request: FastifyObsRequest;
  options: FastifyMiddlewareOptions | undefined;
}): boolean {
  if (options === undefined || options.skip === undefined) {
    return false;
  }

  return options.skip(request) === true;
}

function resolveUserAgent(request: FastifyObsRequest): string | undefined {
  const value = request.headers['user-agent'];
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }

  return value;
}

function resolveRoutePattern(request: FastifyObsRequest): string {
  const routeOptions = request.routeOptions;
  if (
    routeOptions !== undefined &&
    typeof routeOptions.url === 'string' &&
    routeOptions.url !== ''
  ) {
    return routeOptions.url;
  }

  return request.url;
}

export default function fastifyMiddleware(
  app: object,
  client: ObsClient,
  options?: FastifyMiddlewareOptions,
): void {
  const hooks = app as FastifyObsApp;
  hooks.addHook('onRequest', function bindObsStore(request, _reply, done) {
    if (shouldSkip({ request, options })) {
      done();
      return;
    }

    const store = createStore();
    setRequestStore(request, store);
    bindStore(store);
    done();
  });

  hooks.addHook(
    'onSend',
    function captureObsBody(request, _reply, payload, done) {
      const store = getMappedRequestStore(request);
      if (store === undefined) {
        done(null, payload);
        return;
      }

      store.responseBody = payload;
      done(null, payload);
    },
  );

  hooks.addHook('onResponse', function enqueueObsRequest(request, reply, done) {
    const store = getMappedRequestStore(request);
    if (store === undefined) {
      done();
      return;
    }

    done();
    setImmediate(() => {
      try {
        const routePattern = resolveRoutePattern(request);
        const statusCode = reply.statusCode;
        if (!client.shouldEnqueue(routePattern, statusCode)) {
          return;
        }

        let extraTags: Record<string, string> | undefined;
        let userId: string | undefined;
        let optionRedactKeys: string[] | undefined;
        let resolvedRedactKeys: string[] | undefined;
        if (options !== undefined && options.resolveTags !== undefined) {
          extraTags = options.resolveTags(request);
        }
        if (options !== undefined && options.resolveUserId !== undefined) {
          userId = options.resolveUserId(request);
        }
        if (options !== undefined) {
          optionRedactKeys = options.redactKeys;
        }
        if (options !== undefined && options.resolveRedactKeys !== undefined) {
          resolvedRedactKeys = options.resolveRedactKeys(request);
        }

        let ip: string | undefined;
        if (typeof request.ip === 'string' && request.ip !== '') {
          ip = request.ip;
        }

        const captured = ingestRequestFromCapture({
          http: {
            method: request.method,
            path: request.url,
            routePattern,
            statusCode,
            query: request.query,
            headers: { ...request.headers },
            body: request.body,
            ip,
            userAgent: resolveUserAgent(request),
            extraTags,
            extraRedactKeys: mergeRedactKeys([
              optionRedactKeys,
              resolvedRedactKeys,
            ]),
            userId,
          },
          store,
          client,
        });
        client.enqueue(captured);
      } catch {
        return;
      }
    });
  });
}
