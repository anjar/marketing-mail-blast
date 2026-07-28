import { classifyError, ClassifierConfig } from '../../src/delivery/outcome-classifier';

const config: ClassifierConfig = {
  nonRetryableCodes: ['EENVELOPE', 'EMESSAGE'],
  uncertainCodes: ['ETIMEDOUT', 'ESOCKET'],
};

describe('classifyError (FR-021..023b)', () => {
  it('classifies configured uncertain codes as UNCERTAIN', () => {
    expect(classifyError({ code: 'ETIMEDOUT' }, config).outcome).toBe('UNCERTAIN');
    expect(classifyError({ code: 'ESOCKET' }, config).definitive).toBe(false);
  });

  it('classifies configured non-retryable codes as NON_RETRYABLE', () => {
    expect(classifyError({ code: 'EENVELOPE' }, config).outcome).toBe('NON_RETRYABLE');
  });

  it('classifies 5xx SMTP responses as NON_RETRYABLE (definitive)', () => {
    const c = classifyError({ responseCode: 550 }, config);
    expect(c.outcome).toBe('NON_RETRYABLE');
    expect(c.definitive).toBe(true);
  });

  it('classifies 4xx SMTP responses as RETRYABLE', () => {
    expect(classifyError({ responseCode: 421 }, config).outcome).toBe('RETRYABLE');
  });

  it('classifies connection errors as RETRYABLE', () => {
    expect(classifyError({ code: 'ECONNREFUSED' }, config).outcome).toBe('RETRYABLE');
  });

  it('is conservative: unknown errors are UNCERTAIN, never a false SENT', () => {
    expect(classifyError({ code: 'WEIRD' }, config).outcome).toBe('UNCERTAIN');
    expect(classifyError({}, config).outcome).toBe('UNCERTAIN');
  });

  it('honors configurability (FR-023b): a code moved to uncertain wins', () => {
    const custom: ClassifierConfig = { nonRetryableCodes: [], uncertainCodes: ['EENVELOPE'] };
    expect(classifyError({ code: 'EENVELOPE' }, custom).outcome).toBe('UNCERTAIN');
  });
});
