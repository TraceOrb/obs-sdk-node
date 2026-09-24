# traceorb-node

Node.js SDK for [Traceorb](https://traceorb.com). Send request traces from your API to your Traceorb workspace.

## Install

```bash
npm install traceorb-node
```

## Configure

Create a write key after you have a workspace. Sign up at [traceorb.com](https://traceorb.com). Set these in your app:

```
OBS_INGEST_URL=https://api.traceorb.com/v1/ingest
OBS_WRITE_KEY=
```

The SDK does not read the environment by itself. Pass the values into `createClient`.

## Usage

```js
import express from 'express';
import { createClient, expressMiddleware } from 'traceorb-node';

const ingestUrl = process.env.OBS_INGEST_URL;
const writeKey = process.env.OBS_WRITE_KEY;
if (ingestUrl === undefined || ingestUrl === '') {
  throw new Error('OBS_INGEST_URL is required');
}
if (writeKey === undefined || writeKey === '') {
  throw new Error('OBS_WRITE_KEY is required');
}

const app = express();
const obs = createClient({
  ingestUrl,
  writeKey,
  service: 'orders-api',
  env: process.env.NODE_ENV ?? 'production',
});

app.use(express.json());
app.use(
  expressMiddleware(obs, {
    resolveTags(req) {
      return { tenant: String(req.headers['x-tenant'] ?? '') };
    },
  }),
);
```

CommonJS: `require('traceorb-node')`.

If Traceorb is unreachable, your HTTP request still completes. Headers and body fields named `authorization`, `cookie`, `set-cookie`, `password`, `token`, `secret`, `api_key`, and `apikey` are replaced with `[redacted]`.

Fastify:

```js
import Fastify from 'fastify';
import { createClient, fastifyMiddleware } from 'traceorb-node';

const ingestUrl = process.env.OBS_INGEST_URL;
const writeKey = process.env.OBS_WRITE_KEY;
if (ingestUrl === undefined || ingestUrl === '') {
  throw new Error('OBS_INGEST_URL is required');
}
if (writeKey === undefined || writeKey === '') {
  throw new Error('OBS_WRITE_KEY is required');
}

const app = Fastify();
const obs = createClient({
  ingestUrl,
  writeKey,
  service: 'orders-api',
  env: process.env.NODE_ENV ?? 'production',
});

fastifyMiddleware(app, obs, {
  skip(request) {
    return request.url === '/health';
  },
});
```

## Sample and capture (optional)

Omit `sampleRate` and `capture` to keep today's defaults (100% of requests; headers, query, and both bodies always). Status 4xx/5xx always ingest. `skip` skips the store entirely; `sampleRate: 0` still keeps errors.

Sample 10% of successful traffic:

```js
const obs = createClient({
  ingestUrl,
  writeKey,
  service: 'orders-api',
  env: process.env.NODE_ENV ?? 'production',
  sampleRate: 0.1,
});
```

Capture request and response bodies only on errors:

```js
const obs = createClient({
  ingestUrl,
  writeKey,
  service: 'orders-api',
  env: process.env.NODE_ENV ?? 'production',
  capture: {
    requestBody: 'errors',
    responseBody: 'errors',
  },
});
```

Skip health and metrics on Express (no store, no ingest):

```js
app.use(
  expressMiddleware(obs, {
    skip(req) {
      return req.path === '/health' || req.path === '/metrics';
    },
  }),
);
```

## Capture the request error (optional)

The middleware does not record thrown exceptions. Mount the error handler **after your routes**. The 500 then gets `errorMessage` and an `unhandled.error` step on the timeline. Skip this and 4xx/5xx still ingest; you just will not get the exception unless the app already called `obs.setErrorMessage`.

```js
import { createClient, expressMiddleware, expressErrorHandler, fastifyMiddleware, fastifyErrorHandler } from 'traceorb-node';

app.use(expressErrorHandler(obs));

fastifyErrorHandler(app, obs);
```

Express: `app.use(expressErrorHandler(obs))` last. Fastify: `fastifyErrorHandler(app, obs)` after `fastifyMiddleware`. The helper always calls `next(err)` / `done()` — your 500 stays a 500. If a route catches the error and responds itself, the handler never runs; call `obs.setErrorMessage` in that path.

CommonJS: `require('traceorb-node')` also exports `expressErrorHandler` and `fastifyErrorHandler`.

Inside a request:

```js
obs.step('db.query', { table: 'orders' });
obs.setTags({ city: '4' });
obs.redact(['ssn']);
```

## Extra redaction

The built-in names always apply. Add more field names in any of these places. Names are case-insensitive. They apply to headers, query, and bodies.

On the client, for every request:

```js
const obs = createClient({
  ingestUrl,
  writeKey,
  service: 'orders-api',
  env: process.env.NODE_ENV ?? 'production',
  redactKeys: ['email', 'cpf'],
});
```

On the middleware:

```js
app.use(
  expressMiddleware(obs, {
    redactKeys: ['email', 'cpf'],
    resolveRedactKeys(req) {
      return [String(req.headers['x-redact'] ?? '')];
    },
  }),
);
```

Fastify takes the same `redactKeys` and `resolveRedactKeys` options.

Inside a handler, for that request only:

```js
obs.redact(['ssn']);
```
