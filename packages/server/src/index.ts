export {
  defineApp,
  isApp,
  type App,
  type AppSchema,
  type AppScope,
} from "./app/definition.ts";
export {
  boot,
  MigrationsHeldError,
  type BootFiles,
  type BootLoaders,
  type BootOptions,
  type BootReporter,
  type BootStorage,
  type LoadedApp,
  type LoadedRuntime,
  type RunningApp,
} from "./boot.ts";
export {
  expandScopeGrant,
  isScopeGrant,
  isScopePattern,
  principalScopes,
  SCOPE_WILDCARD,
  validateScopeVocabulary,
  type NormalizedScopeRequirement,
  type ScopeRequirement,
  type ScopeValues,
} from "./auth/scopes.ts";
export {
  effectiveChildScopes,
  issueChildScopes,
} from "./credentials/delegation.ts";
export {
  CREDENTIAL_ISSUER,
  CREDENTIAL_TOKEN_PREFIX,
  hasCredentialTokenPrefix,
  parseCredentialToken,
  type ParsedCredentialToken,
} from "./auth/credential-token.ts";
export type {
  Credential,
  CredentialMutationCapability,
  CredentialQuery,
  CredentialQueryCapability,
  CredentialReadCapability,
  IssueCredentialInput,
  IssuedCredential,
  ManageCredentialCapability,
  OrderedCredentialQuery,
  UpdateCredentialInput,
} from "./credentials/api.ts";
export type { CredentialLimits } from "./credentials/module.ts";
export {
  type FileGrantId,
  type FileId,
  type FileMetadata,
  type FileState,
  type FileUploadSession,
  type Identity,
} from "@ackerdb/core";
export {
  type CreateFileUploadSessionOptions,
  type CreateFileUrlOptions,
  type FileDuration,
  type FileGrant,
  type FileGrantAccess,
  type FileGrantLifetime,
  type FileGrantMetadata,
  type FileGrantMetadataQuery,
  type FileMetadataQuery,
  type FileMutationCapability,
  type FileProcedureCapability,
  type FileQueryCapability,
  type FileRange,
  type OpenedFile,
  type OrderedFileMetadataQuery,
  type StoreFileOptions,
} from "./files/api.ts";
export { type RuntimeFilesOptions } from "./files/namespace.ts";
export {
  FileStoreError,
  type FileStore,
  type FileStoreAttributes,
  type FileStoreErrorCode,
  type FileStoreOpenOptions,
  type FileStoreOpenResult,
  type FileStoreOptions,
  type FileStorePutOptions,
  type FileStorePutResult,
  type FileStoreRange,
} from "./files/store/contract.ts";
export {
  LocalFileStore,
  type LocalFileStoreConfig,
} from "./files/store/local.ts";
export {
  type S3Credentials,
  type S3FileStoreChecksum,
  type S3FileStoreConfig,
  type S3FileStoreEncryption,
} from "./files/store/s3-configuration.ts";
export {
  type Descriptor,
  type Expand,
  type InferValidator,
  type InferValidatorInput,
  type StandardValidator,
  type ChainableValidator,
  type BoundedValidator,
  type Validator,
  type NullableValidator,
  type OptionalValidator,
  type NullishValidator,
} from "./validation/validator.ts";
export {
  type FileValidator,
  type StringValidator,
  type VectorValidator,
} from "./validation/primitives.ts";
export {
  type InferInputShape,
  type LiteralValidator,
  type ObjectShape,
  type ObjectValidator,
  type InferShape,
  type ArrayValidator,
  type EnumValidator,
  type DiscriminatedUnionValidator,
} from "./validation/composites.ts";
export { v } from "./validation/v.ts";
export { ValidationError, isValidationError } from "./validation/error.ts";
export {
  CorruptDatabaseError,
  Engine,
  IncompatibleDatabaseError,
  indexSqlName,
  type BackupManifest,
  type CheckpointReport,
  type ColumnPlan,
  type EngineCloseDisposition,
  type EngineOptions,
  type EngineStatus,
  type IntegrityReport,
  type RestorePublicationHook,
  schemaFingerprintFor,
  type TablePlan,
} from "./database/engine.ts";
export { restoreVerifiedDatabase } from "./database/restore.ts";
export { resetDatabase, type DatabaseResetResult } from "./database/reset.ts";
export { DatabaseAlreadyOpenError } from "./database/ownership.ts";
export {
  job,
  DEFAULT_JOB_RETENTION_MS,
  type JobDefinition,
  type JobBuilder,
  type JobCtx,
  type JobStep,
  type JobStepOptions,
  type JobStepQueryCtx,
  type JobDedupe,
  type JobRepeat,
  type JobRepeatConfig,
  type JobRetry,
  type JobRetryConfig,
  type JobRunState,
  type JobRunTrigger,
  type JobState,
  type JobTrigger,
  type JobTxCtx,
  type JobWindow,
} from "./jobs/definition.ts";
export {
  type AnyJobsNamespace,
  type JobControlSurface,
  type JobMutationSurface,
  type JobQuerySurface,
  type MutationJobsOf,
  type ProcedureJobsOf,
  type QueryJobsOf,
} from "./jobs/api.ts";
export { JOB_RUNS_TABLE, JOBS_TABLE } from "./jobs/table.ts";
export {
  type JobRunOutcome,
  type JobEnqueueOptions,
  type JobHandle,
} from "./runtime/jobs/runtime.ts";
export { type JobRow, type JobRunRow } from "./runtime/jobs/store.ts";
export type { DurabilityPolicy } from "@ackerdb/core";
export type { TransportSource } from "./runtime/caller.ts";
export {
  makeDbReader,
  makeDbWriter,
  newWriteCollector,
  UniqueConstraintError,
  isUniqueConstraintError,
  type ReadRecorder,
  type WriteCollector,
  type EventEmit,
} from "./database/access.ts";
export {
  emitFullTextWriteKeys,
  emitWriteKeys,
  ftsCorpusKey,
  idKey,
  ixKey,
  scanKey,
} from "./database/keys.ts";
export { VectorRuntimeUnavailableError } from "./database/query/vector-runtime.ts";
export type {
  DbReader,
  DbWriter,
  TableReader,
  TableWriter,
  EventWriter,
  PredicateExpression,
  OrderExpression,
  QueryRow,
  QueryMaterializers,
  TableQuery,
  OrderedTableQuery,
  VectorMetric,
  NearestMatch,
  NearestQuery,
  FullTextQuery,
  WriteResult,
} from "./database/query/types.ts";
export {
  filterableFields,
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  MAX_FILTER_VALUES,
  type FilterableFields,
  type FilterInvalid,
  type TableFilter,
} from "./database/query/filter.ts";
// The read contract itself belongs to core, where the client shares it.
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_BYTES,
  MAX_PAGE_SIZE,
  type FilterExpression,
  type FilterIssue,
  type FilterValue,
  type QueryPage,
} from "@ackerdb/core";
export { snapshotOf, type SchemaSnapshot, type TableSnapshot } from "./schema/snapshot.ts";
export {
  probeOptimisticChanges,
  probeUniqueIndex,
  UnsafeSchemaChange,
  type OptimisticProbeOptions,
  type PhysicalProbeRoute,
  type RoutedOptimisticChange,
  type StoredTagNames,
} from "./schema/planner.ts";
export { reconcile } from "./schema/reconcile.ts";
export {
  defineMigration,
  migrationFingerprint,
  migrationIdentity,
  MigrationError,
  stepLabel,
  type BeforeTable,
  type Migration,
  type MigrationContext,
  type MigrationRow,
  type MigrationStep,
  type Renames,
  type RowTransform,
} from "./schema/migrations/types.ts";
export { validateChain, validateHistoryPrefix, type AppliedMigrationRow } from "./schema/migrations/chain.ts";
export { readStoredState, type StoredState } from "./schema/migrations/stored.ts";
export {
  applyRenames,
  renameRoutes,
  type NormalizedRenames,
  type RenameRoutes,
} from "./schema/migrations/rename.ts";
export {
  diffSnapshots,
  type ColumnChange,
  type FullTextChange,
  type IndexChange,
  type SchemaDiff,
  type TableChange,
  type VariantChange,
} from "./schema/diff.ts";
export {
  classifySchemaDiff,
  refusalSite,
  type Classification,
  type OptimisticChange,
  type RefusalReason,
  type SafeChange,
  type SchemaRefusal,
} from "./schema/classify.ts";
export {
  ANONYMOUS_PRINCIPAL,
  credentialFromAuthorization,
  createOidcVerifier,
  isPrincipal,
  isVerifiedCredential,
  SYSTEM_PRINCIPAL,
  unauthenticated,
  verifyClientCredential,
  type AuthenticatedPrincipal,
  type AnonymousPrincipal,
  type ClientPrincipal,
  type CredentialVerifier,
  type ExternalAccount,
  type IdentityResolver,
  type JwtAlgorithm,
  resolveOidcProvider,
  type OidcProviderConfig,
  type OidcProviderEntry,
  type OidcProviderPreset,
  type OidcVerifierOptions,
  type Principal,
  type PrincipalInvalidation,
  type RevocationBound,
  type ScopeResolver,
  type SystemPrincipal,
  type UserPrincipal,
  type VerifiedCredential,
  type VerifiedUserCredential,
  type WorkloadPrincipal,
} from "./auth/credentials.ts";
export { assertCredentialVerifier } from "./auth/lease.ts";
export { SYSTEM_CLOCK, type Clock } from "./shared/clock.ts";
export {
  AckerDBError,
  isAckerDBError,
  type AckerDBErrorCode,
  type AckerDBErrorOptions,
  type ResourceClass,
} from "./shared/errors.ts";
export {
  PRODUCTION_LIMITS,
  defineServiceLimits,
  type CapacityLimits,
  type QueueLimits,
  type ServiceLimits,
} from "./runtime/limits.ts";
export { invokeFunction } from "./app/invocation.ts";
export type { AccessPolicy, InvocationContext } from "./app/access.ts";
export type {
  AppSystemCtx,
  SystemCtx,
  SystemRunner,
  SystemRunOptions,
  SystemTxCtx,
} from "./app/system.ts";
export {
  query,
  mutation,
  procedure,
  sseProcedure,
  type AnyRegistered,
  type AnyInvocable,
  type ArgsInput,
  type AuthCtx,
  type HttpExposure,
  type Invocable,
  type MutationBuilder,
  type MutationCtx,
  type ProcedureBuilder,
  type ProcedureCtx,
  type QueryBuilder,
  type QueryCtx,
  type Registered,
  type RegisteredMutation,
  type RegisteredProcedure,
  type RegisteredQuery,
  type RegisteredSse,
  type SseBuilder,
  type SseCtx,
  type SseSource,
  type TxCtx,
} from "./app/functions.ts";
// The route-authoring surface, and only that: the registry, the route
// context it builds, and the shapes it holds are transport-owned, so they are
// not part of what an application may import.
export {
  type HttpMethod,
  type HttpParams,
  type ValidHttpPath,
} from "./transport/routing/path.ts";
export {
  http,
  type Http,
  type HttpBuilder,
  type HttpHandler,
  type HttpHandlerCtx,
  type HttpHandlerDELETE,
  type HttpHandlerGET,
  type HttpHandlerHEAD,
  type HttpHandlerOPTIONS,
  type HttpHandlerPATCH,
  type HttpHandlerPOST,
  type HttpHandlerPUT,
} from "./transport/routing/route.ts";
export {
  channel,
  type AnyRegisteredChannel,
  type ChannelAuthorizationCtx,
  type ChannelBuilder,
  type ChannelCtx,
  type ChannelDisconnectReason,
  type ChannelEventDeclarations,
  type ChannelHandlers,
  type ChannelPublish,
  type ChannelPublisher,
  type ChannelSend,
  type RegisteredChannel,
} from "./channels/definition.ts";
export {
  collectDefinitions,
  type CollectedDefinition,
  type Definition,
  type ImportedDefinitionModule,
} from "./definitions.ts";
export {
  type StandardJsonInput,
  type StandardJsonOutput,
  type StandardJsonSchemaOptions,
  type StandardSchemaIssue,
  type StandardSchemaOptions,
  type StandardSchemaProperties,
  type StandardSchemaResult,
} from "./validation/standard-schema.ts";
export {
  type JsonSchema,
  type JsonSchemaMode,
  type JsonSchemaOptions,
  type JsonSchemaTarget,
} from "./validation/json-schema.ts";
export { Registry } from "./app/registry.ts";
export {
  OutboundBudget,
  type OutboundBudgetSnapshot,
  type OutboundLane,
  type OutboundReservation,
} from "./subscriptions/delivery/budget.ts";
export {
  WebSocketSessionSink,
  type WebSocketDeliverySnapshot,
  type WebSocketDeliverySocket,
  type WebSocketSessionSinkOptions,
} from "./subscriptions/delivery/websocket.ts";
export {
  BoundedSseProducer,
  type BoundedSseProducerOptions,
  type SseDeliverySnapshot,
} from "./subscriptions/delivery/sse.ts";
export {
  ReactiveCommit,
  type AuthRotationResult,
  type DeliveryFailure,
  type EventSubscriptionOptions,
  type OrderedReactiveOptions,
  type QueryEvaluation,
  type QueryEvaluationInput,
  type QueryEvaluator,
  type QuerySubscriptionOptions,
  type ReactiveCommitResult,
  type ReactiveEvent,
  type ReactiveSnapshot,
  type Subscriber,
} from "./subscriptions/reactive/contract.ts";
export { OrderedReactive } from "./subscriptions/reactive/ordered.ts";
export {
  prepareRuntimePublication,
  type RuntimeAuthTransition,
  type RuntimeMutationResult,
  type RuntimePort,
  type RuntimePublication,
  type RuntimeRequest,
  type SessionApplicationMessage,
  type SessionControlMessage,
  type SessionOptions,
  type SessionPhase,
  type SessionRuntimeContext,
  type SessionSink,
  type SessionSnapshot,
  type SubscriptionServerMessage,
} from "./subscriptions/session/contract.ts";
export { type SessionWireFrame } from "./subscriptions/session/frame.ts";
export { Session } from "./subscriptions/session/session.ts";
export {
  Runtime,
} from "./runtime/runtime.ts";
export {
  type RuntimeHookContext,
  type RuntimeHooks,
  type RuntimeHookStage,
  type RuntimeLifecycleState,
} from "./runtime/contracts/lifecycle.ts";
export {
  type RuntimeOptions,
} from "./runtime/contracts/options.ts";
export {
  type HttpMutationReceipt,
  type RuntimeHttpRouteRequest,
  type RuntimeHttpMutationRequest,
  type RuntimeHttpRequest,
  type RuntimeHttpResponder,
  type RuntimeHttpResponse,
  type RuntimeSseRequest,
  type RuntimeSseResponse,
} from "./runtime/contracts/requests.ts";
export {
  type RuntimeStatus,
} from "./runtime/contracts/status.ts";
export {
  openApiBytes,
  openApiDocument,
  type OpenApiDocument,
  type OpenApiInfo,
} from "./transport/openapi.ts";
export {
  AckerDBServer,
  type AckerDBServerOptions,
  type AckerDBServerState,
  type AckerDBServerStatus,
  type AckerDBStartupPhase,
} from "./transport/server.ts";
export {
  defineTable,
  defineEventTable,
  defineSchema,
  isSchema,
  isTableDef,
  rowTypeName,
  eventArgsTypeName,
  Schema,
  TableDef,
  type IndexDef,
  type IndexOptions,
  type TableColumns,
  type TableFullTextColumns,
  type TableIndexes,
  type RowShape,
  type InsertShape,
  type PatchShape,
  type SchemaTables,
  type RowOf,
  type EventArgsOf,
  type EventSubscriptionDefinition,
} from "./schema/definition.ts";
