import {
  NAME_FALLBACK,
  personalizeBody,
  resolvePersonalizedName,
} from '../../src/mail/personalization';

describe('personalization (FR-011..014)', () => {
  it('replaces every {{name}} with a present name', () => {
    expect(personalizeBody('Hi {{name}}, bye {{name}}', 'Alicia')).toBe('Hi Alicia, bye Alicia');
  });

  it.each([null, undefined, '', '   ', '\t'])(
    'uses Customer fallback for missing/blank name %p',
    (name) => {
      expect(personalizeBody('Hello {{name}}', name as string | null)).toBe('Hello Customer');
      expect(resolvePersonalizedName(name as string | null)).toBe(NAME_FALLBACK);
    },
  );

  it('leaves body untouched when no {{name}} placeholder is present', () => {
    const body = 'No placeholder here';
    expect(personalizeBody(body, 'Alicia')).toBe(body);
    expect(personalizeBody(body, null)).toBe(body);
  });

  it('trims a present name', () => {
    expect(resolvePersonalizedName('  Bob  ')).toBe('Bob');
  });

  // FR-014 (C2): the subject is never personalized and only {{name}} is a token.
  // Any other {{...}} token in the body is left verbatim.
  it('does not treat other placeholders as variables', () => {
    expect(personalizeBody('Order {{id}} for {{name}}', 'Bob')).toBe('Order {{id}} for Bob');
  });
});
