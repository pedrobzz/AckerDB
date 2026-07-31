import {
  isApplicationError,
  type ApplicationError,
} from "@ackerdb/core";
import type { Principal } from "../auth/credentials.ts";
import {
  invokeFunction,
  invokeRegisteredHandler,
} from "../app/invocation.ts";
import type {
  OwnedProcedureContext,
  ProcedureCtx,
} from "../app/functions.ts";
import { AckerDBError } from "../shared/errors.ts";
import {
  callerFairnessKey,
  transportSource,
} from "../runtime/caller.ts";
import { settleOnAbort } from "../runtime/abort.ts";
import { invokeSideEffectingHandler } from "../runtime/side-effecting-handler.ts";
import {
  realtimeAuthorization,
  realtimeAuthorizationResult,
  type AnyRegisteredRealtime,
} from "./definition.ts";
import type {
  AuthorizedRealtimeApplication,
  RealtimeHubApplication,
  RealtimeOfferInput,
  RejectedRealtimeApplication,
} from "./hub.ts";
import type {
  RealtimeServerSessionAdapter,
} from "./session.ts";

export interface RealtimeRuntimeApplicationPort {
  addressOf(definition: AnyRegisteredRealtime): string | undefined;
  createAuthorizationContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
  ): OwnedProcedureContext;
  createSessionContext(
    principal: Principal,
    fairnessKey: string,
    signal: AbortSignal,
  ): OwnedProcedureContext;
  run<Value>(
    address: string,
    fairnessKey: string,
    signal: AbortSignal,
    requestBytes: number,
    work: () => Value | Promise<Value>,
  ): Promise<Value>;
}

const RUNTIME_SOURCE = transportSource({
  family: "runtime",
  address: "local",
});

export function createRealtimeRuntimeApplication(
  port: RealtimeRuntimeApplicationPort,
): RealtimeHubApplication {
  return Object.freeze({
    authorize: (
      definition: AnyRegisteredRealtime,
      input: RealtimeOfferInput,
    ) => authorize(port, definition, input),
  });
}

async function authorize(
  port: RealtimeRuntimeApplicationPort,
  definition: AnyRegisteredRealtime,
  input: RealtimeOfferInput,
): Promise<AuthorizedRealtimeApplication | RejectedRealtimeApplication> {
  const address = port.addressOf(definition);
  if (address === undefined) {
    throw new AckerDBError(
      "internal",
      "realtime definition is not registered",
    );
  }
  const fairnessKey = callerFairnessKey(input.principal, RUNTIME_SOURCE);
  return port.run(
    address,
    fairnessKey,
    input.signal,
    input.requestBytes,
    async () => {
      const authorizationContext = port.createAuthorizationContext(
        input.principal,
        fairnessKey,
        input.signal,
        input.requestBytes,
      );
      let args: unknown;
      try {
        const result = await settleOnAbort(
          invokeSideEffectingHandler(
            input.signal,
            "realtime handler",
            (onAuthorized) =>
              invokeFunction(
                realtimeAuthorization(definition),
                authorizationContext.value,
                input.args,
                {
                  onAuthorized: (_ctx, validatedArgs) => {
                    args = validatedArgs;
                    onAuthorized();
                  },
                },
              ),
          ),
          input.signal,
        );
        const authorization = realtimeAuthorizationResult(result);
        if (!authorization.ok) {
          if (!isApplicationError(authorization.error)) {
            throw new AckerDBError(
              "internal",
              "realtime authorization returned an invalid application error",
            );
          }
          return Object.freeze({
            ok: false,
            error: authorization.error as ApplicationError,
          });
        }
        const adapter: RealtimeServerSessionAdapter = Object.freeze({
          createContext: (signal: AbortSignal) =>
            port.createSessionContext(
              input.principal,
              fairnessKey,
              signal,
            ),
          invoke: <Value>(
            owner: AnyRegisteredRealtime,
            context: ProcedureCtx,
            work: () => Value | Promise<Value>,
          ): Promise<Value> =>
            port.run(
              address,
              fairnessKey,
              context.abortSignal,
              1,
              () =>
                invokeSideEffectingHandler(
                  context.abortSignal,
                  "realtime handler",
                  (onAuthorized) => {
                    onAuthorized();
                    return invokeRegisteredHandler(
                      owner,
                      context as never,
                      work,
                    ).then((value) => value as Value);
                  },
                ),
            ),
          failed: () => {},
        });
        return Object.freeze({
          ok: true,
          args,
          state: authorization.state,
          adapter,
        });
      } finally {
        authorizationContext.release();
      }
    },
  );
}
