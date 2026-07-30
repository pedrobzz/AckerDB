import {
  PROTOCOL_VERSION,
  parseRealtimeCandidatesMessage,
  parseRealtimeOfferRequest,
  type RealtimeOfferRequest,
} from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
  type Principal,
} from "../auth/credentials.ts";
import type { AuthLease } from "../auth/lease.ts";
import {
  callerFairnessKey,
  type TransportSource,
} from "../runtime/caller.ts";
import { AckerDBError } from "../shared/errors.ts";
import {
  outcomeHttpStatus,
} from "../runtime/outcome.ts";
import type { Runtime } from "../runtime/runtime.ts";

export interface RealtimeHttpAdmissionLease {
  transfer(fairnessKey: string): void;
  release(): void;
}

export interface RealtimeHttpTransportOptions {
  readonly runtime: () => Runtime;
  readonly admit: (fairnessKey: string) => RealtimeHttpAdmissionLease;
  readonly authenticate: (
    request: Request,
    signal?: AbortSignal,
  ) => Promise<AuthLease>;
  readonly parseBody: <Value>(
    request: Request,
    maxBytes: number,
    timeoutMs: number,
    parser: (value: unknown) => Value,
  ) => Promise<{ readonly value: Value; readonly bytes: number }>;
  readonly json: (value: unknown, status?: number) => Response;
  readonly error: (error: unknown) => Response;
  readonly cors: Readonly<Record<string, string>>;
}

/**
 * Owns the three HTTP signaling routes. The server transport retains listener,
 * CORS, authentication, and ingress-admission ownership; this module retains
 * only the realtime protocol sequencing.
 */
export class RealtimeHttpTransport {
  constructor(private readonly options: RealtimeHttpTransportOptions) {}

  async configuration(
    request: Request,
    source: TransportSource,
  ): Promise<Response> {
    const runtime = this.options.runtime();
    let admission: RealtimeHttpAdmissionLease | undefined;
    let lease: AuthLease | undefined;
    try {
      admission = this.admitAnonymous(source);
      lease = await this.options.authenticate(request);
      admission.transfer(callerFairnessKey(lease.principal, source));
      const configuration = await runtime.realtime?.configuration(
        lease.principal,
        lease.signal,
      );
      if (configuration === undefined) {
        throw new AckerDBError(
          "not_found",
          "realtime service is not configured",
        );
      }
      return this.options.json({
        v: PROTOCOL_VERSION,
        t: "realtime_config",
        configuration,
      });
    } catch (error) {
      return this.options.error(error);
    } finally {
      lease?.release();
      admission?.release();
    }
  }

  async offer(
    request: Request,
    source: TransportSource,
  ): Promise<Response> {
    const runtime = this.options.runtime();
    let admission: RealtimeHttpAdmissionLease | undefined;
    let lease: AuthLease | undefined;
    try {
      const hub = runtime.realtime;
      if (hub === undefined) {
        throw new AckerDBError(
          "not_found",
          "realtime service is not configured",
        );
      }
      admission = this.admitAnonymous(source);
      const { value: offer, bytes } =
        await this.options.parseBody<RealtimeOfferRequest>(
          request,
          runtime.limits.maxRequestBytes,
          runtime.limits.readQueue.maxAgeMs,
          parseRealtimeOfferRequest,
        );
      // The hub owns this authentication lease for the complete generation,
      // not merely for the initiating HTTP request.
      lease = await this.options.authenticate(request, undefined);
      admission.transfer(callerFairnessKey(lease.principal, source));
      const ownedLease = lease;
      lease = undefined;
      const result = await hub.offer({
        address: offer.ref,
        args: offer.args,
        offer: offer.offer,
        principal: ownedLease.principal,
        signal: ownedLease.signal,
        releaseAuthentication: () => ownedLease.release(),
        requestBytes: bytes,
        recovery: offer.recovery === true,
      });
      if (!result.ok) {
        return this.options.json({
          v: PROTOCOL_VERSION,
          t: "realtime_rejected",
          error: result.error,
        }, result.error.status);
      }
      return this.options.json({
        v: PROTOCOL_VERSION,
        t: "realtime_answer",
        sessionId: result.sessionId,
        answer: result.answer,
        streamLimits: result.streamLimits,
        candidates: result.candidates,
        complete: result.complete,
      });
    } catch (error) {
      return this.options.error(error);
    } finally {
      lease?.release();
      admission?.release();
    }
  }

  async session(
    request: Request,
    sessionId: string,
    source: TransportSource,
  ): Promise<Response> {
    const runtime = this.options.runtime();
    let admission: RealtimeHttpAdmissionLease | undefined;
    let lease: AuthLease | undefined;
    try {
      const hub = runtime.realtime;
      if (hub === undefined) {
        throw new AckerDBError(
          "not_found",
          "realtime service is not configured",
        );
      }
      admission = this.admitAnonymous(source);
      let batch;
      if (request.method === "PATCH") {
        ({ value: batch } = await this.options.parseBody(
          request,
          runtime.limits.maxRequestBytes,
          runtime.limits.readQueue.maxAgeMs,
          parseRealtimeCandidatesMessage,
        ));
      }
      lease = await this.options.authenticate(request);
      admission.transfer(callerFairnessKey(lease.principal, source));
      if (request.method === "DELETE") {
        hub.close(sessionId, lease.principal);
        return new Response(null, {
          status: 204,
          headers: this.options.cors,
        });
      }
      const result = await hub.patch(
        sessionId,
        lease.principal,
        batch!,
      );
      if (!result.ok) {
        return this.options.json({
          v: PROTOCOL_VERSION,
          t: "realtime_ended",
          outcome: result.outcome,
        }, outcomeHttpStatus(result.outcome));
      }
      return this.options.json({
        v: PROTOCOL_VERSION,
        t: "realtime_candidates",
        candidates: result.candidates,
        complete: result.complete,
      });
    } catch (error) {
      return this.options.error(error);
    } finally {
      lease?.release();
      admission?.release();
    }
  }

  private admitAnonymous(
    source: TransportSource,
  ): RealtimeHttpAdmissionLease {
    return this.options.admit(
      callerFairnessKey(
        ANONYMOUS_PRINCIPAL,
        source,
      ),
    );
  }
}
