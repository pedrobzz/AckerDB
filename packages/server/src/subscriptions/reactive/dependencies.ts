import type { QueryEntry } from "./entry.ts";

/** One owner is stored inline; a shared read key promotes to a set. */
type DependencyOwners<C> = QueryEntry<C> | Set<QueryEntry<C>>;

/**
 * Reverse index from read key to the entries that observed it. A commit's write
 * keys resolve to exactly the entries that must revalidate, so invalidation
 * costs the size of the write set rather than a scan of every subscription.
 */
export class DependencyIndex<C> {
  private readonly owners = new Map<string, DependencyOwners<C>>();
  private edgeCount = 0;
  private multiOwnerKeyCount = 0;

  get keys(): number {
    return this.owners.size;
  }

  get edges(): number {
    return this.edgeCount;
  }

  get multiOwnerKeys(): number {
    return this.multiOwnerKeyCount;
  }

  affected(writeKeys: ReadonlySet<string>): Set<QueryEntry<C>> {
    const affected = new Set<QueryEntry<C>>();
    for (const key of writeKeys) {
      const owners = this.owners.get(key);
      if (owners instanceof Set) {
        for (const entry of owners) affected.add(entry);
      } else if (owners) {
        affected.add(owners);
      }
    }
    return affected;
  }

  /** Moves the entry onto its newly observed read set, keeping edge counts exact. */
  replace(entry: QueryEntry<C>, next: ReadonlySet<string>): void {
    for (const key of entry.readSet) {
      if (next.has(key)) continue;
      this.remove(key, entry);
    }
    for (const key of next) {
      if (entry.readSet.has(key)) continue;
      this.add(key, entry);
    }
    entry.readSet = new Set(next);
  }

  /** Drops every edge the entry owns. The entry's own read set is left intact. */
  detach(entry: QueryEntry<C>): void {
    for (const key of entry.readSet) this.remove(key, entry);
  }

  private add(key: string, entry: QueryEntry<C>): void {
    const owners = this.owners.get(key);
    if (!owners) {
      this.owners.set(key, entry);
      this.edgeCount++;
      return;
    }
    if (owners === entry) return;
    if (owners instanceof Set) {
      if (owners.has(entry)) return;
      owners.add(entry);
      this.edgeCount++;
      return;
    }
    this.owners.set(key, new Set([owners, entry]));
    this.edgeCount++;
    this.multiOwnerKeyCount++;
  }

  private remove(key: string, entry: QueryEntry<C>): void {
    const owners = this.owners.get(key);
    if (owners === entry) {
      this.owners.delete(key);
      this.edgeCount--;
      return;
    }
    if (!(owners instanceof Set) || !owners.delete(entry)) return;
    this.edgeCount--;
    if (owners.size !== 1) return;
    this.owners.set(key, owners.values().next().value!);
    this.multiOwnerKeyCount--;
  }
}
