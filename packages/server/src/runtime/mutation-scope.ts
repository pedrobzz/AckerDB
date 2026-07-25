import type { Database } from "bun:sqlite";
import { isResult } from "@dbzz/core";
import {
  checkpointWriteCollector,
  rollbackWriteCollector,
  type WriteCollector,
} from "../database/access.ts";
import { DbzzError } from "../shared/errors.ts";
import {
  currentMutationAccessFrame,
  withMutationAccessFrame,
  type MutationAccessFrame,
  type MutationAccessState,
  type MutationInvocationScope,
} from "./mutation-access.ts";

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

  const runNow = async <T>(
    parent: MutationAccessFrame,
    work: () => T | Promise<T>,
  ): Promise<T> => {
    const name = `dbzz_result_${++nextSavepoint}`;
    const before = checkpointWriteCollector(writes);
    connection.exec(`SAVEPOINT ${name}`);
    const frame: MutationAccessFrame = { tail: Promise.resolve() };
    state.current = frame;
    try {
      const value = await withMutationAccessFrame(state, frame, scope, work);
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
        throw new DbzzError("indeterminate", "mutation scope could not be rolled back", {
          cause: new AggregateError([error, rollbackError]),
        });
      }
      throw error;
    }
  };

  scope = Object.freeze({
    async runRoot<T>(work: () => T | Promise<T>): Promise<T> {
      state.current = root;
      try {
        const value = await withMutationAccessFrame(state, root, scope, work);
        await root.tail;
        return value;
      } catch (error) {
        await root.tail;
        throw error;
      } finally {
        state.current = null;
      }
    },
    run<T>(work: () => T | Promise<T>): Promise<T> {
      const parent = currentMutationAccessFrame();
      if (parent === undefined) {
        return Promise.reject(new DbzzError(
          "internal",
          "nested mutation scope has no owning root transaction",
        ));
      }
      const turn = parent.tail.then(() => runNow(parent, work));
      parent.tail = turn.then(
        () => undefined,
        () => undefined,
      );
      return turn;
    },
  });
  return scope;
}
