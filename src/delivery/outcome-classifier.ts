import { DeliveryFailureReason } from '@prisma/client';

/**
 * Classifies a Nodemailer send error into one of three delivery dispositions
 * (FR-021..023b). The transient/non-retryable/uncertain code sets are
 * CONFIGURABLE (FR-023b) — passed in from AppConfig.
 *
 * - RETRYABLE   : failure known to have occurred BEFORE SMTP acceptance -> retry
 *                 up to the max, then terminal FAILED (RETRIES_EXHAUSTED).
 * - NON_RETRYABLE: definitive pre-acceptance rejection -> terminal FAILED now,
 *                 without consuming unnecessary retries.
 * - UNCERTAIN   : acceptance MAY have occurred -> DELIVERY_UNKNOWN, never
 *                 auto-retried, never silently SENT/FAILED.
 *
 * When in doubt the classifier is conservative and returns UNCERTAIN rather than
 * risk a false SENT (Constitution I, FR-023).
 */
export type OutcomeClass = 'RETRYABLE' | 'NON_RETRYABLE' | 'UNCERTAIN';

export interface ClassifierConfig {
  nonRetryableCodes: string[];
  uncertainCodes: string[];
}

interface SmtpErrorLike {
  code?: string;
  responseCode?: number;
  message?: string;
}

export interface Classification {
  outcome: OutcomeClass;
  failureReason: DeliveryFailureReason;
  definitive: boolean; // true only when acceptance/rejection is certain
}

export function classifyError(err: unknown, config: ClassifierConfig): Classification {
  const e = (err ?? {}) as SmtpErrorLike;
  const code = (e.code ?? '').toUpperCase();
  const responseCode = e.responseCode;

  const nonRetryable = config.nonRetryableCodes.map((c) => c.toUpperCase());
  const uncertain = config.uncertainCodes.map((c) => c.toUpperCase());

  // Explicitly-configured uncertain codes: acceptance may have happened.
  if (code && uncertain.includes(code)) {
    return {
      outcome: 'UNCERTAIN',
      failureReason: DeliveryFailureReason.SMTP_TIMEOUT,
      definitive: false,
    };
  }

  // Explicitly-configured non-retryable pre-acceptance codes.
  if (code && nonRetryable.includes(code)) {
    return {
      outcome: 'NON_RETRYABLE',
      failureReason: DeliveryFailureReason.SMTP_REJECTED,
      definitive: true,
    };
  }

  // SMTP response codes: 5xx = permanent rejection (definitive, before acceptance).
  if (typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600) {
    return {
      outcome: 'NON_RETRYABLE',
      failureReason: DeliveryFailureReason.SMTP_REJECTED,
      definitive: true,
    };
  }

  // 4xx = transient; safe to retry (server asked to try later, pre-acceptance).
  if (typeof responseCode === 'number' && responseCode >= 400 && responseCode < 500) {
    return {
      outcome: 'RETRYABLE',
      failureReason: DeliveryFailureReason.SMTP_REJECTED,
      definitive: true,
    };
  }

  // Connection-level errors without a response are pre-acceptance -> retryable.
  if (code === 'ECONNECTION' || code === 'ECONNREFUSED' || code === 'EDNS' || code === 'EAUTH') {
    return {
      outcome: 'RETRYABLE',
      failureReason: DeliveryFailureReason.CONNECTION_ERROR,
      definitive: true,
    };
  }

  // Unknown/ambiguous: be conservative -> uncertain (do not risk a false SENT).
  return {
    outcome: 'UNCERTAIN',
    failureReason: DeliveryFailureReason.OTHER,
    definitive: false,
  };
}
