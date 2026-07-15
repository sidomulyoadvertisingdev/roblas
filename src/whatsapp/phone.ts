import { AppError } from '../errors/app-error.js';

export const normalizePhoneNumber = (input: string): string => {
  let digits = input.trim().replace(/[^\d+]/g, '');

  if (digits.startsWith('+')) digits = digits.slice(1);
  digits = digits.replace(/\D/g, '');

  if (digits.startsWith('0')) {
    digits = `62${digits.slice(1)}`;
  }

  if (!/^\d{7,15}$/.test(digits)) {
    throw new AppError(400, 'Phone number must contain 7 to 15 digits', 'INVALID_PHONE_NUMBER');
  }

  return digits;
};

export const toWhatsAppId = (phone: string): string => `${normalizePhoneNumber(phone)}@c.us`;
