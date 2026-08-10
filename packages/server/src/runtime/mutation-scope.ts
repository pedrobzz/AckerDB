import type { Database } from "bun:sqlite";
import { isResult } from "@ackerdb/core";
import {
  checkpointWriteCollector,
  rollbackWriteCollector,
  type WriteCollector,
} from "../database/access.ts";
import { AckerDBError } from "../shared/errors.ts";
import {
  enterNestedMutationScope,
  leaveNestedMutationScope,
  type MutationAccess,
  type MutationAccessFrame,
  type MutationAccessState,
  type MutationInvocationScope,
} from "./invocation-state.ts";

/**
 * Owns automatic savepoints for registered mutations in one writer transaction.
 *
 * Children of the same mutation are serialized because SQLite savepoints are a
 * stack: concurrent sibling releases could otherwise close each other's scope.
 */
export function createMutationInvocationScope(
  connection: Database,
  writes: WriteCollector,
): MutationInvocationScope {
  const root: MutationAccessFrame = { tail: Promise.resolve() };
  const state: MutationAccessState = { current: null };
  let nextSavepoint = 0;
  let scope!: MutationInvocationScope;
  const access = (frame: MutationAccessFrame): MutationAccess => ({
    state,
    frame,
    scope,
  });

  const runNow = async <T>(
    parent: MutationAccessFrame,
    work: (access: MutationAccess) => T | Promise<T>,
  ): Promise<T> => {
    const name = `ackerdb_result_${++nextSavepoint}`;
    const before = checkpointWriteCollector(writes);
    connection.exec(`SAVEPOINT ${name}`);
    const frame: MutationAccessFrame = { tail: Promise.resolve() };
    state.current = frame;
    enterNestedMutationScope();
    try {
      const value = await work(access(frame));
      await frame.tail;
      if (isResult(value) && !value.ok) {
        connection.exec(`ROLLBACK TO ${name}`);
        rollbackWriteCollector(writes, before);
      }
      connection.exec(`RELEASE ${name}`);
      state.current = parent;
      return value;
    } catch (error) {
      try {
        // A parent continuation can fail while an un-awaited nested mutation
        // still owns the top savepoint. Drain its serialized children before
        // touching the parent's savepoint stack.
        await frame.tail;
        connection.exec(`ROLLBACK TO ${name}`);
        connection.exec(`RELEASE ${name}`);
        rollbackWriteCollector(writes, before);
        state.current = parent;
      } catch (rollbackError) {
        throw new AckerDBError("indeterminate", "mutation scope could not be rolled back", {
          cause: new AggregateError([error, rollbackError]),
        });
      }
      throw error;
    } finally {
      leaveNestedMutationScope();
    }
  };

  scope = Object.freeze({
    async runRoot<T>(
      work: (access: MutationAccess) => T | Promise<T>,
    ): Promise<T> {
        state.current = root;
        try {
          const value = await work(access(root));
          await root.tail;
          return value;
        } catch (error) {
          await root.tail;
          throw error;
      } finally {
        state.current = null;
      }
    },
    run<T>(
      parentAccess: MutationAccess,
      work: (access: MutationAccess) => T | Promise<T>,
      onError?: (error: unknown) => never,
    ): Promise<T> {
      if (
        parentAccess.scope !== scope ||
        parentAccess.state !== state
      ) {
        return Promise.reject(new AckerDBError(
          "internal",
          "nested mutation scope has no owning root transaction",
        ));
      }
      const parent = parentAccess.frame;
      const turn = parent.tail.then(() => runNow(parent, work));
      const result = onError === undefined ? turn : turn.catch(onError);
      parent.tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  });
  return scope;
}
