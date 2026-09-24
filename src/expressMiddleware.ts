import type { IncomingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';

import type { ObsClient } from './client';
import { createStore, runWith, type RequestStore } from './context';
import ingestRequestFromCapture from './ingestRequestFromCapture';
import mergeRedactKeys from './mergeRedactKeys';

export type ExpressMiddlewareOptions = {
  skip?: (req: Request) => boolean;
  resolveTags?: (req: Request) => Record<string, string> | undefined;
  resolveUserId?: (req: Request) => string | undefined;
  redactKeys?: string[];
  resolveRedactKeys?: (req: Request) => string[] | undefined;
};

function shouldSkip({
  req,
  options,
}: {
  req: Request;
  options: ExpressMiddlewareOptions | undefined;
}): boolean {
  if (options === undefined || options.skip === undefined) {
    return false;
  }

  return options.skip(req) === true;
}

function headersAsRecord(
  headers: IncomingHttpHeaders,
): Record<string, unknown> {
  return { ...headers };
}

function resolvePath(req: Request): string {
  if (typeof req.originalUrl === 'string' && req.originalUrl !== '') {
    return req.originalUrl;
  }

  if (typeof req.url === 'string' && req.url !== '') {
    return req.url;
  }

  return '/';
}

function resolveRoutePattern(req: Request): string {
  const route = req.route as { path?: unknown } | undefined;
  if (
    route !== undefined &&
    typeof route.path === 'string' &&
    route.path !== ''
  ) {
    return route.path;
  }

  return resolvePath(req);
}

function resolveIp(req: Request): string | undefined {
  if (typeof req.ip === 'string' && req.ip !== '') {
    return req.ip;
  }

  const remote = req.socket.remoteAddress;
  if (typeof remote === 'string' && remote !== '') {
    return remote;
  }

  return undefined;
}

function resolveUserAgent(req: Request): string | undefined {
  const value = req.headers['user-agent'];
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }

  return value;
}

function wrapResponse({
  res,
  store,
}: {
  res: Response;
  store: RequestStore;
}): void {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = ((body?: unknown) => {
    if (body !== undefined) {
      store.responseBody = body;
    }
    return originalJson(body);
  }) as Response['json'];

  res.send = ((body?: unknown) => {
    if (body !== undefined && store.responseBody === undefined) {
      store.responseBody = body;
    }
    return originalSend(body);
  }) as Response['send'];
}

export default function expressMiddleware(
  client: ObsClient,
  options?: ExpressMiddlewareOptions,
) {
  return function obsExpressMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (shouldSkip({ req, options })) {
      next();
      return;
    }

    const store = createStore();
    wrapResponse({ res, store });

    res.on('finish', () => {
      setImmediate(() => {
        try {
          const routePattern = resolveRoutePattern(req);
          const statusCode = res.statusCode;
          if (!client.shouldEnqueue(routePattern, statusCode)) {
            return;
          }

          let extraTags: Record<string, string> | undefined;
          let userId: string | undefined;
          let optionRedactKeys: string[] | undefined;
          let resolvedRedactKeys: string[] | undefined;
          if (options !== undefined && options.resolveTags !== undefined) {
            extraTags = options.resolveTags(req);
          }
          if (options !== undefined && options.resolveUserId !== undefined) {
            userId = options.resolveUserId(req);
          }
          if (options !== undefined) {
            optionRedactKeys = options.redactKeys;
          }
          if (options !== undefined && options.resolveRedactKeys !== undefined) {
            resolvedRedactKeys = options.resolveRedactKeys(req);
          }

          const request = ingestRequestFromCapture({
            http: {
              method: req.method,
              path: resolvePath(req),
              routePattern,
              statusCode,
              query: req.query,
              headers: headersAsRecord(req.headers),
              body: req.body,
              ip: resolveIp(req),
              userAgent: resolveUserAgent(req),
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
          client.enqueue(request);
        } catch {
          return;
        }
      });
    });

    runWith(store, function withStore() {
      next();
    });
  };
}
