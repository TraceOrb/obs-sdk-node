import { describe, expect, test } from 'vitest';
import {
  parseCaptureMode,
  parseClientPolicy,
  policyForRoute,
  shouldIncludeField,
  shouldSample,
} from '../src/policy';

describe('policy', () => {
  test('defaults to sample 1 and capture always', () => {
    const policy = parseClientPolicy({});
    expect(policy.sampleRate).toBe(1);
    expect(policy.capture.responseBody).toBe('always');
  });

  test('rejects sampleRate outside 0..1', () => {
    expect(() => parseClientPolicy({ sampleRate: 1.5 })).toThrow();
    expect(() => parseClientPolicy({ sampleRate: -0.1 })).toThrow();
  });

  test('rejects non-finite sampleRate', () => {
    expect(() => parseClientPolicy({ sampleRate: Number.NaN })).toThrow();
  });

  test('rejects routes that is not a plain object', () => {
    expect(() =>
      parseClientPolicy({ routes: [] as unknown as Record<string, never> }),
    ).toThrow();
  });

  test('rejects unknown capture mode', () => {
    expect(() => parseCaptureMode('only500')).toThrow();
  });

  test('route override merges field by field', () => {
    const policy = parseClientPolicy({
      sampleRate: 0.1,
      capture: { responseBody: 'errors', requestBody: 'errors' },
      routes: {
        '/webhooks': {
          sampleRate: 1,
          capture: { requestBody: 'always' },
        },
      },
    });
    const resolved = policyForRoute(policy, '/webhooks');
    expect(resolved.sampleRate).toBe(1);
    expect(resolved.capture.requestBody).toBe('always');
    expect(resolved.capture.responseBody).toBe('errors');
    const other = policyForRoute(policy, '/v1/orders');
    expect(other.sampleRate).toBe(0.1);
    expect(other.capture.requestBody).toBe('errors');
  });

  test('errors always sample even at rate 0', () => {
    expect(
      shouldSample({ sampleRate: 0, statusCode: 500, random: 1 }),
    ).toBe(true);
    expect(
      shouldSample({ sampleRate: 0, statusCode: 200, random: 0 }),
    ).toBe(false);
    expect(
      shouldSample({ sampleRate: 1, statusCode: 200, random: 1 }),
    ).toBe(true);
    expect(
      shouldSample({ sampleRate: 0.1, statusCode: 200, random: 0.05 }),
    ).toBe(true);
    expect(
      shouldSample({ sampleRate: 0.1, statusCode: 200, random: 0.2 }),
    ).toBe(false);
    expect(
      shouldSample({ sampleRate: 0.1, statusCode: 404, random: 1 }),
    ).toBe(true);
  });

  test('include field respects never errors always', () => {
    expect(
      shouldIncludeField({ mode: 'never', statusCode: 500 }),
    ).toBe(false);
    expect(
      shouldIncludeField({ mode: 'always', statusCode: 200 }),
    ).toBe(true);
    expect(
      shouldIncludeField({ mode: 'errors', statusCode: 200 }),
    ).toBe(false);
    expect(
      shouldIncludeField({ mode: 'errors', statusCode: 400 }),
    ).toBe(true);
  });
});
