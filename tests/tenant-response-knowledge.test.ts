import { describe, expect, it } from 'vitest';
import { redactSensitiveWebhookData } from '../src/tenant/response-knowledge.js';

describe('redactSensitiveWebhookData', () => {
  it('redacts sensitive fields recursively without changing business data', () => {
    expect(redactSensitiveWebhookData({
      status: 'ok',
      data: {
        employee: 'Ayu',
        salary: 900000,
        api_key: 'secret-value',
        nested: [{ accessToken: 'token-value', total: 12 }],
      },
    })).toEqual({
      status: 'ok',
      data: {
        employee: 'Ayu',
        salary: 900000,
        api_key: '[REDACTED]',
        nested: [{ accessToken: '[REDACTED]', total: 12 }],
      },
    });
  });
});
