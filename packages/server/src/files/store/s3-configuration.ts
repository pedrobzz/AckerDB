import type { PutObjectCommandInput } from "@aws-sdk/client-s3";
import { FileStoreError, type FileStoreOperation } from "./contract.ts";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type S3FileStoreChecksum = "disabled" | "sha256";

export type S3FileStoreEncryption =
  | { type: "disabled" }
  | { type: "AES256" }
  | { type: "aws:kms"; keyId?: string; bucketKeyEnabled?: boolean };

export interface S3FileStoreConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  credentials?: S3Credentials;
  forcePathStyle?: boolean;
  /** Defaults to SHA-256. Disable for compatible stores that reject S3 checksums. */
  checksum?: S3FileStoreChecksum;
  /** Defaults to S3-managed AES-256. Disable for compatible stores without SSE support. */
  encryption?: S3FileStoreEncryption;
}

export function s3Checksum(config: S3FileStoreConfig): S3FileStoreChecksum {
  return config.checksum ?? "sha256";
}

export function s3EncryptionInput(config: S3FileStoreConfig): Pick<
  PutObjectCommandInput,
  "ServerSideEncryption" | "SSEKMSKeyId" | "BucketKeyEnabled"
> {
  const encryption = config.encryption ?? { type: "AES256" };
  if (encryption.type === "disabled") return {};
  if (encryption.type === "AES256") return { ServerSideEncryption: "AES256" };
  return {
    ServerSideEncryption: "aws:kms",
    ...(encryption.keyId === undefined ? {} : { SSEKMSKeyId: encryption.keyId }),
    ...(encryption.bucketKeyEnabled === undefined
      ? {}
      : { BucketKeyEnabled: encryption.bucketKeyEnabled }),
  };
}

export function validateS3FileStoreConfig(
  config: S3FileStoreConfig,
  operation: FileStoreOperation,
): void {
  const invalid = (message: string): never => {
    throw new FileStoreError("invalid_configuration", operation, message);
  };
  if (typeof config.region !== "string" || config.region.trim().length === 0) {
    invalid("S3 region must be a non-empty string");
  }
  if (typeof config.bucket !== "string" || config.bucket.trim().length === 0) {
    invalid("S3 bucket must be a non-empty string");
  }
  if (config.endpoint !== undefined) {
    let endpoint: URL | undefined;
    try {
      endpoint = new URL(config.endpoint);
    } catch {
      invalid("S3 endpoint must be an absolute HTTP or HTTPS URL");
    }
    if (endpoint === undefined || (endpoint.protocol !== "http:" && endpoint.protocol !== "https:")) {
      invalid("S3 endpoint must be an absolute HTTP or HTTPS URL");
    }
  }
  if (config.forcePathStyle !== undefined && typeof config.forcePathStyle !== "boolean") {
    invalid("S3 forcePathStyle must be a boolean");
  }
  if (s3Checksum(config) !== "disabled" && s3Checksum(config) !== "sha256") {
    invalid("S3 checksum must be 'sha256' or 'disabled'");
  }
  const encryption = config.encryption ?? { type: "AES256" };
  if (
    typeof encryption !== "object" ||
    encryption === null ||
    (encryption.type !== "disabled" &&
      encryption.type !== "AES256" &&
      encryption.type !== "aws:kms")
  ) {
    invalid("S3 encryption type is unsupported");
  }
  if (encryption.type === "aws:kms") {
    if (
      encryption.keyId !== undefined &&
      (typeof encryption.keyId !== "string" || encryption.keyId.trim().length === 0)
    ) {
      invalid("S3 KMS key ID must be a non-empty string");
    }
    if (
      encryption.bucketKeyEnabled !== undefined &&
      typeof encryption.bucketKeyEnabled !== "boolean"
    ) {
      invalid("S3 KMS bucketKeyEnabled must be a boolean");
    }
  }
  const credentials = config.credentials;
  if (
    credentials !== undefined &&
    (typeof credentials.accessKeyId !== "string" ||
      credentials.accessKeyId.length === 0 ||
      typeof credentials.secretAccessKey !== "string" ||
      credentials.secretAccessKey.length === 0 ||
      (credentials.sessionToken !== undefined && typeof credentials.sessionToken !== "string"))
  ) {
    invalid("S3 credentials require an access key ID and secret access key");
  }
}
