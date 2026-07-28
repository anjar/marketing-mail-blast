/**
 * BigInt is not JSON-serializable by default. Recipient ids are BIGINT, so we
 * register a global toJSON that renders BigInt as a string. Called once at
 * bootstrap. Kept in one place so the behavior is explicit and testable.
 */
export function enableBigIntJson(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}
