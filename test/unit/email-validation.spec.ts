import { RejectionReason } from '@prisma/client';
import { normalizeEmail } from '../../src/preparation/email-validator';

describe('normalizeEmail (FR-015..017)', () => {
  it('normalizes by trimming and lowercasing', () => {
    expect(normalizeEmail('  User@Example.COM ')).toEqual({
      normalized: 'user@example.com',
      rejection: null,
    });
  });

  it('rejects null/empty/whitespace as EMAIL_MISSING', () => {
    for (const raw of [null, undefined, '', '   ', '\t\n']) {
      expect(normalizeEmail(raw as string | null)).toEqual({
        normalized: null,
        rejection: RejectionReason.EMAIL_MISSING,
      });
    }
  });

  it.each([
    'no-at-sign',
    'spaces in@ex.com',
    'double@@ex.com',
    'nodot@examplecom',
    'trailingdot@ex.',
    '@ex.com',
    'user@',
  ])('rejects invalid syntax %s as EMAIL_INVALID_FORMAT', (raw) => {
    expect(normalizeEmail(raw)).toEqual({
      normalized: null,
      rejection: RejectionReason.EMAIL_INVALID_FORMAT,
    });
  });

  it.each(['a@b.co', 'first.last@sub.example.com', 'x+tag@example.io'])(
    'accepts valid syntax %s',
    (raw) => {
      const r = normalizeEmail(raw);
      expect(r.rejection).toBeNull();
      expect(r.normalized).toBe(raw.toLowerCase());
    },
  );
});
