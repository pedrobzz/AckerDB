"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DocumentationIdentity,
  DocumentationRouteManifest,
  DocumentationVersionCatalog,
} from "@/lib/documentation/identity";
import { resolveVersionSwitch } from "@/lib/documentation/identity";

function identityKey(identity: DocumentationIdentity): string {
  return identity.kind === "stable" ? identity.version : identity.kind;
}

function manifestUrl(identity: DocumentationIdentity): string {
  return `${identity.basePath}/routes.json`;
}

function catalogIdentities(
  catalog: DocumentationVersionCatalog,
  current: DocumentationIdentity,
): DocumentationIdentity[] {
  const identities: DocumentationIdentity[] = [catalog.latest, catalog.canary, ...catalog.historical];

  if (!identities.some((identity) => identityKey(identity) === identityKey(current))) {
    identities.push(current);
  }

  return identities;
}

export function useVersionNavigation(
  current: DocumentationIdentity,
  fallbackCatalog: DocumentationVersionCatalog,
  currentAncestry: string[],
) {
  const [catalog, setCatalog] = useState(fallbackCatalog);
  const [switchingTo, setSwitchingTo] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/docs/versions.json", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Version catalog returned ${response.status}`);
        return response.json() as Promise<DocumentationVersionCatalog>;
      })
      .then(setCatalog)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // The embedded catalog keeps immutable historical pages useful while offline.
      });

    return () => controller.abort();
  }, []);

  const versions = useMemo(
    () => catalogIdentities(catalog, current),
    [catalog, current],
  );

  const switchVersion = useCallback(
    async (target: DocumentationIdentity) => {
      if (identityKey(target) === identityKey(current)) return;

      const targetKey = identityKey(target);
      setSwitchingTo(targetKey);

      try {
        const response = await fetch(manifestUrl(target), { cache: "no-store" });
        if (!response.ok) throw new Error(`Route manifest returned ${response.status}`);

        const manifest = (await response.json()) as DocumentationRouteManifest;
        const destination = resolveVersionSwitch(
          window.location.href,
          target,
          manifest,
          currentAncestry,
        );
        window.location.assign(destination.url);
      } finally {
        setSwitchingTo(undefined);
      }
    },
    [current, currentAncestry],
  );

  return {
    currentKey: identityKey(current),
    switchingTo,
    switchVersion,
    versions,
  };
}
