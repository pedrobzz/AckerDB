import {
  PROTOCOL_VERSION,
  parseRealtimeCandidatesMessage,
  parseRealtimeOfferRequest,
  parseRealtimePrepareRequest,
  type RealtimeOfferRequest,
  type RealtimePrepareRequest,
} from "@ackerdb/core";
import {
  ANONYMOUS_PRINCIPAL,
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

  async prepare(
    request: Request,
    source: TransportSource,
  ): Promise<Response> {
    const runtime = this.options.runtime();
    let admission: RealtimeHttpAdmissionLease | undefined;
    let lease: AuthLease | undefined;
    let preparedTicket: string | undefined;
    let preparedOwner: string | undefined;
    const hub = runtime.realtime;
    try {
      if (hub === undefined) {
        throw new AckerDBError(
          "not_found",
          "realtime service is not configured",
        );
      }
      admission = this.admitAnonymous(source);
      const { value: preparation, bytes } =
        await this.options.parseBody<RealtimePrepareRequest>(
          request,
          runtime.limits.maxRequestBytes,
          runtime.limits.readQueue.maxAgeMs,
          parseRealtimePrepareRequest,
        );
      // A prepared ticket retains revocation, not the short HTTP request.
      lease = await this.options.authenticate(request, undefined);
      const owner = callerFairnessKey(lease.principal, source);
      admission.transfer(owner);
      const ownedLease = lease;
      lease = undefined;
      const result = await hub.prepare({
        address: preparation.ref,
        args: preparation.args,
        principal: ownedLease.principal,
        owner,
        signal: ownedLease.signal,
        setupSignal: request.signal,
        releaseAuthentication: () => ownedLease.release(),
        requestBytes: bytes,
        recovery: preparation.recovery === true,
      });
      if (!result.ok) {
        return this.options.json({
          v: PROTOCOL_VERSION,
          t: "realtime_rejected",
          error: result.error,
        }, result.error.status);
      }
      preparedTicket = result.ticket;
      preparedOwner = owner;
      const response = this.options.json({
        v: PROTOCOL_VERSION,
        t: "realtime_prepared",
        ticket: result.ticket,
        configuration: result.configuration,
      });
      response.headers.set("cache-control", "no-store");
      preparedTicket = undefined;
      return response;
    } catch (error) {
      if (preparedTicket !== undefined && preparedOwner !== undefined) {
        hub?.cancelPrepared(preparedTicket, preparedOwner);
      }
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
      const { value: offer } =
        await this.options.parseBody<RealtimeOfferRequest>(
          request,
          runtime.limits.maxRequestBytes,
          runtime.limits.readQueue.maxAgeMs,
          parseRealtimeOfferRequest,
        );
      // This short lease proves ticket ownership; the prepared ticket owns the
      // generation's revocation lease and reservation.
      lease = await this.options.authenticate(request);
      const owner = callerFairnessKey(lease.principal, source);
      admission.transfer(owner);
      const result = await hub.offer({
        ticket: offer.ticket,
        offer: offer.offer,
        owner,
        setupSignal: request.signal,
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
      const owner = callerFairnessKey(lease.principal, source);
      admission.transfer(owner);
      if (request.method === "DELETE") {
        hub.close(sessionId, owner);
        return new Response(null, {
          status: 204,
          headers: this.options.cors,
        });
      }
      const result = await hub.patch(
        sessionId,
        owner,
        batch!,
        request.signal,
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
