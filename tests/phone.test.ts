import { describe, expect, it } from 'vitest';
import { normalizePhoneNumber, toWhatsAppId } from '../src/whatsapp/phone.js';

describe('phone normalization', () => {
  it('converts an Indonesian local number to country format', () => {
    expect(normalizePhoneNumber('0812-3456-7890')).toBe('6281234567890');
  });

  it('keeps an international number', () => {
    expect(normalizePhoneNumber('+1 (202) 555-0123')).toBe('12025550123');
  });

  it('creates a WhatsApp user ID', () => {
    expect(toWhatsAppId('+62 812 3456 789')).toBe('628123456789@c.us');
  });

  it('rejects invalid numbers', () => {
    expect(() => normalizePhoneNumber('123')).toThrow('7 to 15 digits');
  });
});
