import { DEFAULT_SAMPLE_RATE } from './config';

export type CaptureMode = 'always' | 'errors' | 'never';

export type CaptureConfig = {
  headers: CaptureMode;
  query: CaptureMode;
  requestBody: CaptureMode;
  responseBody: CaptureMode;
};

export type RoutePolicyInput = {
  sampleRate?: number;
  capture?: Partial<CaptureConfig>;
};

export type ClientPolicy = {
  sampleRate: number;
  capture: CaptureConfig;
  routes: Record<string, RoutePolicyInput>;
};

const CAPTURE_MODES: Record<string, CaptureMode> = {
  always: 'always',
  errors: 'errors',
  never: 'never',
};

const DEFAULT_CAPTURE_MODE: CaptureMode = 'always';

const DEFAULT_CAPTURE: CaptureConfig = {
  headers: DEFAULT_CAPTURE_MODE,
  query: DEFAULT_CAPTURE_MODE,
  requestBody: DEFAULT_CAPTURE_MODE,
  responseBody: DEFAULT_CAPTURE_MODE,
};

export function parseCaptureMode(value: string): CaptureMode {
  const mode = CAPTURE_MODES[value];
  if (mode === undefined) {
    throw new Error('invalid capture mode');
  }
  return mode;
}

function parseSampleRate(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SAMPLE_RATE;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('sampleRate must be between 0 and 1');
  }
  return value;
}

function resolveCaptureMode(
  value: CaptureMode | undefined,
  fallback: CaptureMode,
): CaptureMode {
  if (value === undefined) {
    return fallback;
  }
  return parseCaptureMode(value);
}

function optionalParseCaptureMode(
  value: CaptureMode | undefined,
): CaptureMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  return parseCaptureMode(value);
}

function parseCaptureConfig(
  partial: Partial<CaptureConfig> | undefined,
): CaptureConfig {
  if (partial === undefined) {
    return { ...DEFAULT_CAPTURE };
  }
  return {
    headers: resolveCaptureMode(partial.headers, DEFAULT_CAPTURE.headers),
    query: resolveCaptureMode(partial.query, DEFAULT_CAPTURE.query),
    requestBody: resolveCaptureMode(
      partial.requestBody,
      DEFAULT_CAPTURE.requestBody,
    ),
    responseBody: resolveCaptureMode(
      partial.responseBody,
      DEFAULT_CAPTURE.responseBody,
    ),
  };
}

const CAPTURE_FIELDS: readonly (keyof CaptureConfig)[] = [
  'headers',
  'query',
  'requestBody',
  'responseBody',
];

function parseRouteCapture(
  partial: Partial<CaptureConfig> | undefined,
): Partial<CaptureConfig> | undefined {
  if (partial === undefined) {
    return undefined;
  }
  const capture: Partial<CaptureConfig> = {};
  for (const field of CAPTURE_FIELDS) {
    const mode = optionalParseCaptureMode(partial[field]);
    if (mode !== undefined) {
      capture[field] = mode;
    }
  }
  return capture;
}

function parseRoutePolicyInput(input: RoutePolicyInput): RoutePolicyInput {
  const parsed: RoutePolicyInput = {};
  if (input.sampleRate !== undefined) {
    parsed.sampleRate = parseSampleRate(input.sampleRate);
  }
  const capture = parseRouteCapture(input.capture);
  if (capture !== undefined) {
    parsed.capture = capture;
  }
  return parsed;
}

export function parseClientPolicy(input: {
  sampleRate?: number;
  capture?: Partial<CaptureConfig>;
  routes?: Record<string, RoutePolicyInput>;
}): ClientPolicy {
  const sampleRate = parseSampleRate(input.sampleRate);
  const capture = parseCaptureConfig(input.capture);
  const routes: Record<string, RoutePolicyInput> = {};
  if (input.routes !== undefined) {
    if (
      input.routes === null ||
      typeof input.routes !== 'object' ||
      Array.isArray(input.routes)
    ) {
      throw new Error('routes must be a plain object');
    }
    for (const key of Object.keys(input.routes)) {
      const routeInput = input.routes[key];
      if (routeInput === undefined) {
        throw new Error('routes must be a plain object');
      }
      routes[key] = parseRoutePolicyInput(routeInput);
    }
  }
  return { sampleRate, capture, routes };
}

function mergeCaptureField(
  global: CaptureMode,
  override: CaptureMode | undefined,
): CaptureMode {
  if (override !== undefined) {
    return override;
  }
  return global;
}

function resolveRouteSampleRate(
  routeRate: number | undefined,
  globalRate: number,
): number {
  if (routeRate !== undefined) {
    return routeRate;
  }
  return globalRate;
}

export function policyForRoute(
  policy: ClientPolicy,
  routePattern: string,
): { sampleRate: number; capture: CaptureConfig } {
  const route = policy.routes[routePattern];
  if (route === undefined) {
    return { sampleRate: policy.sampleRate, capture: policy.capture };
  }
  const sampleRate = resolveRouteSampleRate(
    route.sampleRate,
    policy.sampleRate,
  );
  const capture: CaptureConfig = {
    headers: mergeCaptureField(policy.capture.headers, route.capture?.headers),
    query: mergeCaptureField(policy.capture.query, route.capture?.query),
    requestBody: mergeCaptureField(
      policy.capture.requestBody,
      route.capture?.requestBody,
    ),
    responseBody: mergeCaptureField(
      policy.capture.responseBody,
      route.capture?.responseBody,
    ),
  };
  return { sampleRate, capture };
}

export function shouldSample(input: {
  sampleRate: number;
  statusCode: number;
  random: number;
}): boolean {
  if (input.statusCode >= 400) {
    return true;
  }
  if (input.sampleRate === 1) {
    return true;
  }
  if (input.sampleRate === 0) {
    return false;
  }
  return input.random < input.sampleRate;
}

const INCLUDE_FIELD: Record<
  CaptureMode,
  (statusCode: number) => boolean
> = {
  never: () => false,
  always: () => true,
  errors: (statusCode: number) => statusCode >= 400,
};

export function shouldIncludeField(input: {
  mode: CaptureMode;
  statusCode: number;
}): boolean {
  return INCLUDE_FIELD[input.mode](input.statusCode);
}
