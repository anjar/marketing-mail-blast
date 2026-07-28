import { PRISMA_UNIQUE_VIOLATION } from './errors';

/**
 * True when `err` is a Prisma unique-constraint violation whose target mentions
 * `token` (a column name or index name). Used by preparation to distinguish the
 * (campaignId, sourceRecipientId) resume-skip case from the accepted-normalized-
 * email duplicate case.
 */
export function isUniqueViolationOn(err: unknown, token: string): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; meta?: { target?: unknown } };
  if (e.code !== PRISMA_UNIQUE_VIOLATION) return false;
  const target = e.meta?.target;
  const asText = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return asText.includes(token);
}
