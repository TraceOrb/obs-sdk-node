import { describe, expect, test } from 'vitest';

import { MAX_EXTRA_REDACT_KEYS, REDACTED } from '../src/config';
import mergeRedactKeys from '../src/mergeRedactKeys';
import { redactBody, redactHeaders } from '../src/redact';

describe('redact', () => {
  test('replaces authorization in headers', () => {
    const output = redactHeaders({
      headers: {
        Authorization: 'Bearer secret-token',
        Accept: 'application/json',
      },
      extraKeys: [],
    });

    expect(output.Authorization).toBe(REDACTED);
    expect(output.Accept).toBe('application/json');
  });

  test('replaces nested body secrets', () => {
    const output = redactBody({
      value: {
        user: 'ada',
        password: 'hunter2',
        nested: { token: 'abc', ok: true },
      },
      extraKeys: [],
    });

    expect(output).toEqual({
      user: 'ada',
      password: REDACTED,
      nested: { token: REDACTED, ok: true },
    });
  });

  test('redacts accessToken refreshToken and snake_case token keys in nested body', () => {
    const body = redactBody({
      value: {
        accessToken: 'live-jwt',
        refreshToken: 'live-refresh',
        id_token: 'live-id',
        nested: { access_token: 'x', ok: true },
      },
      extraKeys: [],
    });
    expect(body).toEqual({
      accessToken: REDACTED,
      refreshToken: REDACTED,
      id_token: REDACTED,
      nested: { access_token: REDACTED, ok: true },
    });
  });

  test('replaces extra keys in headers and bodies', () => {
    const headers = redactHeaders({
      headers: {
        Accept: 'application/json',
        'X-Email': 'ada@example.com',
      },
      extraKeys: ['x-email'],
    });
    expect(headers['X-Email']).toBe(REDACTED);
    expect(headers.Accept).toBe('application/json');

    const body = redactBody({
      value: { email: 'ada@example.com', sku: 'abc' },
      extraKeys: ['Email'],
    });
    expect(body).toEqual({ email: REDACTED, sku: 'abc' });
  });

  test('redacts secrets inside arrays', () => {
    const output = redactBody({
      value: [{ password: 'hunter2' }, { sku: 'abc' }],
      extraKeys: [],
    });

    expect(output).toEqual([{ password: REDACTED }, { sku: 'abc' }]);
  });

  test('skips blank extra keys', () => {
    const output = redactHeaders({
      headers: { Accept: 'application/json' },
      extraKeys: ['', '  '],
    });

    expect(output.Accept).toBe('application/json');
  });

  test('leaves primitives unchanged', () => {
    expect(redactBody({ value: 'plain', extraKeys: [] })).toBe('plain');
    expect(redactBody({ value: null, extraKeys: [] })).toBeNull();
  });
});

describe('mergeRedactKeys', () => {
  test('lowercases, trims, dedupes, and keeps order', () => {
    expect(
      mergeRedactKeys([[' Email ', 'cpf'], ['email', 'ssn'], undefined]),
    ).toEqual(['email', 'cpf', 'ssn']);
  });

  test('skips blank names', () => {
    expect(mergeRedactKeys([['', '  ', 'email']])).toEqual(['email']);
  });

  test('stops at the extra-key cap', () => {
    const keys: string[] = [];
    for (let i = 0; i < MAX_EXTRA_REDACT_KEYS + 8; i += 1) {
      keys.push(`k${i}`);
    }

    expect(mergeRedactKeys([keys])).toHaveLength(MAX_EXTRA_REDACT_KEYS);
  });
});
