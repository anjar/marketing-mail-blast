/** Logical queue names. Redis/BullMQ hold reconstructible operational work only. */
export const QUEUE_PREPARATION = 'preparation';
export const QUEUE_DELIVERY = 'delivery';
export const QUEUE_MAINTENANCE = 'maintenance';

/** Injection tokens for the Queue instances. */
export const PREPARATION_QUEUE = 'PREPARATION_QUEUE';
export const DELIVERY_QUEUE = 'DELIVERY_QUEUE';
export const MAINTENANCE_QUEUE = 'MAINTENANCE_QUEUE';

/** Shared ioredis connection token (used by queues and workers). */
export const REDIS_CONNECTION = 'REDIS_CONNECTION';

/**
 * Deterministic job ids derived from stable business identifiers (Constitution
 * III). A repeated add with the same id is a BullMQ no-op — an optimization
 * against duplicate queue entries, NOT the final idempotency guarantee (the
 * persisted CampaignRecipient status is).
 */
// NOTE: BullMQ forbids ':' in custom job ids, so we join with '_'. Campaign ids
// are UUIDs and recipient ids are integers, so the joined id stays unambiguous.
export function preparationJobId(campaignId: string): string {
  return `prepare_${campaignId}`;
}

export function deliveryJobId(campaignId: string, campaignRecipientId: number): string {
  return `deliver_${campaignId}_${campaignRecipientId}`;
}

export function maintenanceJobId(campaignId: string): string {
  return `maintenance_${campaignId}`;
}

/** Job payloads carry identifiers only — never bodies, snapshots, or batches. */
export interface PreparationJobData {
  campaignId: string;
}
export interface DeliveryJobData {
  campaignId: string;
  campaignRecipientId: number;
}
export interface MaintenanceJobData {
  campaignId: string;
}
