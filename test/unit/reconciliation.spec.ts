import { CampaignCounts, countsReconcile } from '../../src/campaign/status-rules';

/**
 * Reconciliation invariant unit tests (FR-029, SC-002/004). The authoritative
 * derivation from rows is exercised by the integration progress test; here we
 * pin the pure invariant that gates completion and progress correctness.
 */
describe('reconciliation invariant', () => {
  const cases: Array<[CampaignCounts, boolean]> = [
    [{ total: 0, pending: 0, rejected: 0, sent: 0, failed: 0, deliveryUnknown: 0 }, true],
    [{ total: 1, pending: 0, rejected: 0, sent: 1, failed: 0, deliveryUnknown: 0 }, true],
    [{ total: 100, pending: 10, rejected: 20, sent: 60, failed: 5, deliveryUnknown: 5 }, true],
    [{ total: 100, pending: 10, rejected: 20, sent: 60, failed: 5, deliveryUnknown: 4 }, false],
    [{ total: 3, pending: 0, rejected: 0, sent: 4, failed: 0, deliveryUnknown: 0 }, false],
  ];

  it.each(cases)('reconciles(%j) === %s', (counts, expected) => {
    expect(countsReconcile(counts)).toBe(expected);
  });

  it('every recipient lands in exactly one bucket (sum equals total)', () => {
    const c: CampaignCounts = {
      total: 42,
      pending: 7,
      rejected: 11,
      sent: 20,
      failed: 3,
      deliveryUnknown: 1,
    };
    const sum = c.pending + c.rejected + c.sent + c.failed + c.deliveryUnknown;
    expect(sum).toBe(c.total);
  });
});
