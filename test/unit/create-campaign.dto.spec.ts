import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateCampaignDto } from '../../src/campaign/dto/create-campaign.dto';

function errors(subject: unknown, body: unknown): string[] {
  const dto = plainToInstance(CreateCampaignDto, { subject, body });
  return validateSync(dto).flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('CreateCampaignDto (FR-002)', () => {
  it('accepts non-whitespace subject and body', () => {
    expect(errors('Hello', 'Hi {{name}}')).toHaveLength(0);
  });

  it.each([
    ['', 'body'],
    ['   ', 'body'],
    ['\t\n', 'body'],
  ])('rejects whitespace-only subject %p', (subject, body) => {
    expect(errors(subject, body).length).toBeGreaterThan(0);
  });

  it.each([
    ['subject', ''],
    ['subject', '   '],
  ])('rejects whitespace-only body', (subject, body) => {
    expect(errors(subject, body).length).toBeGreaterThan(0);
  });

  it('rejects non-string types', () => {
    expect(errors(123, {}).length).toBeGreaterThan(0);
  });
});
