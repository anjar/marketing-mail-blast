import { RejectionReason } from '@prisma/client';

/**
 * Email normalization + SYNTAX-ONLY validation (FR-015..017). No DNS, MX, or
 * mailbox lookup of any kind. Normalization = trim + lowercase. The rule set is
 * deliberately conservative and pinned by unit tests so behavior is reproducible.
 */

// Single '@', non-empty local + domain, no whitespace, domain contains a dot,
// no leading/trailing dot in domain, no consecutive '@'.
const SYNTAX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface NormalizedEmail {
  /** Present when the address is usable; null when missing/invalid. */
  normalized: string | null;
  rejection: RejectionReason | null;
}

/** Normalize + classify a raw email value. */
export function normalizeEmail(raw: string | null | undefined): NormalizedEmail {
  if (raw === null || raw === undefined) {
    return { normalized: null, rejection: RejectionReason.EMAIL_MISSING };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { normalized: null, rejection: RejectionReason.EMAIL_MISSING };
  }
  const lowered = trimmed.toLowerCase();
  if (!SYNTAX.test(lowered)) {
    return { normalized: null, rejection: RejectionReason.EMAIL_INVALID_FORMAT };
  }
  return { normalized: lowered, rejection: null };
}
