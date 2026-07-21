export class CacheStoreError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "CacheStoreError";
    this.cause = cause;
  }
}

export class CacheEntryTooLargeError extends RangeError {
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(`cache entry is ${bytes} bytes, exceeding the ${maxBytes} byte limit`);
    this.name = "CacheEntryTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export class InvalidCacheExpirationError extends RangeError {
  constructor(message = "expiresInMs must be a positive safe integer") {
    super(message);
    this.name = "InvalidCacheExpirationError";
  }
}
