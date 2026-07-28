import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  IsString,
} from 'class-validator';

/**
 * Requires a string with at least one non-whitespace character (FR-002).
 * Whitespace-only subject/body must be rejected with a validation error.
 */
function IsNonWhitespace(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isNonWhitespace',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && value.trim().length > 0;
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must contain at least one non-whitespace character`;
        },
      },
    });
  };
}

export class CreateCampaignDto {
  @IsString()
  @IsNonWhitespace()
  subject!: string;

  @IsString()
  @IsNonWhitespace()
  body!: string;
}
