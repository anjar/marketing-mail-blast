import { CampaignStatus, RecipientStatus } from '@prisma/client';

/** Terminal recipient outcomes are absorbing (FR-021, FR-024). */
export const TERMINAL_RECIPIENT_STATUSES: RecipientStatus[] = [
  RecipientStatus.REJECTED,
  RecipientStatus.SENT,
  RecipientStatus.FAILED,
  RecipientStatus.DELIVERY_UNKNOWN,
];

/** Non-terminal states roll up into the single "pending" count (FR-022). */
export const PENDING_RECIPIENT_STATUSES: RecipientStatus[] = [
  RecipientStatus.PENDING,
  RecipientStatus.IN_PROGRESS,
];

export function isTerminalRecipient(status: RecipientStatus): boolean {
  return TERMINAL_RECIPIENT_STATUSES.includes(status);
}

export const ACTIVE_CAMPAIGN_STATUSES: CampaignStatus[] = [
  CampaignStatus.PREPARING,
  CampaignStatus.RUNNING,
];

export function isActiveCampaign(status: CampaignStatus): boolean {
  return ACTIVE_CAMPAIGN_STATUSES.includes(status);
}

export interface CampaignCounts {
  total: number;
  pending: number;
  rejected: number;
  sent: number;
  failed: number;
  deliveryUnknown: number;
}

/** Reconciliation invariant (FR-029, SC-004). */
export function countsReconcile(c: CampaignCounts): boolean {
  return c.total === c.pending + c.rejected + c.sent + c.failed + c.deliveryUnknown;
}

/**
 * Terminal campaign status given reconciled, fully-processed counts.
 * COMPLETED only when nothing was rejected/failed/unknown; otherwise
 * COMPLETED_WITH_ISSUES (FR-031, FR-032). Returns null if still active
 * (any pending) — the caller must NOT complete then (FR-030).
 */
export function terminalCampaignStatus(c: CampaignCounts): CampaignStatus | null {
  if (c.pending > 0) return null;
  const hasIssues = c.rejected > 0 || c.failed > 0 || c.deliveryUnknown > 0;
  return hasIssues ? CampaignStatus.COMPLETED_WITH_ISSUES : CampaignStatus.COMPLETED;
}
