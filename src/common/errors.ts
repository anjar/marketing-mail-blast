/**
 * Domain errors. Kept transport-agnostic; the global exception filter maps them
 * to HTTP responses so services never depend on HTTP concerns.
 */

/** Raised when a second campaign is submitted while one is already active. */
export class CampaignActiveError extends Error {
  readonly code = 'CAMPAIGN_ACTIVE';
  constructor(message = 'Another campaign is already active') {
    super(message);
    this.name = 'CampaignActiveError';
  }
}

/** Raised when a requested campaign id does not exist. */
export class CampaignNotFoundError extends Error {
  readonly code = 'CAMPAIGN_NOT_FOUND';
  constructor(message = 'Campaign not found') {
    super(message);
    this.name = 'CampaignNotFoundError';
  }
}

/** Prisma unique-violation error code. */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';

export function isPrismaUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === PRISMA_UNIQUE_VIOLATION;
}

/**
 * True when a thrown Prisma error is the single-active-campaign violation. The
 * ONLY unique index on Campaign is `one_active_campaign` (a partial index over
 * the constant expression `(true)`), so any P2002 on a Campaign insert is that
 * violation. Prisma reports the expression-index target as `(true)`, not the
 * index name, so we do not match on the name.
 */
export function isActiveCampaignViolation(err: unknown): boolean {
  return isPrismaUniqueViolation(err);
}
