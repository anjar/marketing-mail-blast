import { CampaignStatus, RecipientStatus } from '@prisma/client';
import {
  countsReconcile,
  isActiveCampaign,
  isTerminalRecipient,
  terminalCampaignStatus,
} from '../../src/campaign/status-rules';

describe('recipient terminal states (FR-021/024)', () => {
  it('treats REJECTED/SENT/FAILED/DELIVERY_UNKNOWN as terminal (absorbing)', () => {
    for (const s of [
      RecipientStatus.REJECTED,
      RecipientStatus.SENT,
      RecipientStatus.FAILED,
      RecipientStatus.DELIVERY_UNKNOWN,
    ]) {
      expect(isTerminalRecipient(s)).toBe(true);
    }
  });

  it('treats PENDING/IN_PROGRESS as non-terminal', () => {
    expect(isTerminalRecipient(RecipientStatus.PENDING)).toBe(false);
    expect(isTerminalRecipient(RecipientStatus.IN_PROGRESS)).toBe(false);
  });
});

describe('active campaign states (FR-006)', () => {
  it('PREPARING and RUNNING are active', () => {
    expect(isActiveCampaign(CampaignStatus.PREPARING)).toBe(true);
    expect(isActiveCampaign(CampaignStatus.RUNNING)).toBe(true);
    expect(isActiveCampaign(CampaignStatus.COMPLETED)).toBe(false);
    expect(isActiveCampaign(CampaignStatus.COMPLETED_WITH_ISSUES)).toBe(false);
  });
});

describe('terminalCampaignStatus (FR-030..032)', () => {
  it('returns null while any recipient is pending', () => {
    expect(
      terminalCampaignStatus({ total: 5, pending: 1, rejected: 0, sent: 4, failed: 0, deliveryUnknown: 0 }),
    ).toBeNull();
  });

  it('COMPLETED when all sent, none rejected/failed/unknown', () => {
    expect(
      terminalCampaignStatus({ total: 5, pending: 0, rejected: 0, sent: 5, failed: 0, deliveryUnknown: 0 }),
    ).toBe(CampaignStatus.COMPLETED);
  });

  it('COMPLETED_WITH_ISSUES when any rejected/failed/unknown', () => {
    expect(
      terminalCampaignStatus({ total: 5, pending: 0, rejected: 1, sent: 4, failed: 0, deliveryUnknown: 0 }),
    ).toBe(CampaignStatus.COMPLETED_WITH_ISSUES);
    expect(
      terminalCampaignStatus({ total: 5, pending: 0, rejected: 0, sent: 3, failed: 1, deliveryUnknown: 1 }),
    ).toBe(CampaignStatus.COMPLETED_WITH_ISSUES);
  });
});

describe('countsReconcile (FR-029/SC-004)', () => {
  it('holds when total = pending + rejected + sent + failed + deliveryUnknown', () => {
    expect(
      countsReconcile({ total: 10, pending: 2, rejected: 3, sent: 4, failed: 1, deliveryUnknown: 0 }),
    ).toBe(true);
  });
  it('fails on mismatch', () => {
    expect(
      countsReconcile({ total: 10, pending: 2, rejected: 3, sent: 4, failed: 0, deliveryUnknown: 0 }),
    ).toBe(false);
  });
});
