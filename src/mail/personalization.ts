/**
 * Personalization (FR-011..014). The ONLY supported placeholder is the exact
 * token `{{name}}`. Subject is never personalized.
 *
 * - Name with >=1 non-whitespace char -> every `{{name}}` replaced with the name.
 * - Missing / empty / whitespace-only name -> every `{{name}}` replaced with
 *   the fallback `Customer`.
 * - Body without `{{name}}` -> name has no effect.
 */
export const NAME_FALLBACK = 'Customer';
const NAME_PLACEHOLDER = /\{\{name\}\}/g;

/** Resolve the value used for `{{name}}`: the trimmed name, or `Customer`. */
export function resolvePersonalizedName(name: string | null | undefined): string {
  if (name === null || name === undefined) return NAME_FALLBACK;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : NAME_FALLBACK;
}

/** Replace every `{{name}}` occurrence in the body with the resolved name. */
export function personalizeBody(body: string, name: string | null | undefined): string {
  const value = resolvePersonalizedName(name);
  return body.replace(NAME_PLACEHOLDER, value);
}
