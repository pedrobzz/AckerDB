/**
 * The connected-application header: which application this is, on which
 * version, served by which AckerDB.
 *
 * **It reads `admin.system.info` through the ordinary client, and there is no
 * other way it could.** Nothing on the wire names the application — the welcome
 * frame describes authentication — and Studio shares an origin with the thing
 * it proxies, so `window.location` names the proxy. Baking the name into the
 * bundle would make one published Studio describe one application, which is the
 * opposite of what a shipped package is.
 *
 * It is a live query rather than the connect probe's answer, though the probe
 * already fetched exactly this. The probe's copy is a snapshot from the moment
 * before the session existed and it stops being refreshed once Studio is
 * connected; a header that keeps claiming `2.1.0` after a deploy is a header an
 * operator learns to distrust. Subscribing costs one query and is what makes
 * the shell's chrome tell the truth on its own.
 */
import { useQuery } from "@ackerdb/client-react";
import { ACKERDB_VERSION, adminApi, type AdminSystemInfo } from "@ackerdb/core";
import type { ReactNode } from "react";
import { Badge } from "../ui/badge.tsx";
import { Skeleton } from "../ui/skeleton.tsx";

const NO_ARGUMENTS = Object.freeze({});

/** One labelled fact, small caps over a monospace value. */
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[0.625rem] font-medium tracking-widest text-muted-foreground uppercase">
        {label}
      </span>
      <span className="font-mono text-sm leading-none text-foreground">{children}</span>
    </div>
  );
}

export function ApplicationIdentity() {
  const info = useQuery(adminApi.system.info, NO_ARGUMENTS);
  if (info.data === undefined) {
    return info.status === "pending" ? <PendingIdentity /> : <UnreadableIdentity />;
  }
  return <KnownIdentity application={info.data} stale={info.status === "unavailable"} />;
}

function PendingIdentity() {
  return (
    <div className="flex items-center gap-6" data-studio-application="pending">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-7 w-24" />
    </div>
  );
}

/**
 * The query failed and no earlier answer survives. The header says so instead
 * of emptying: chrome that silently loses a fact reads as a fact that changed.
 */
function UnreadableIdentity() {
  return (
    <span className="text-sm text-muted-foreground" data-studio-application="unreadable">
      the application is not answering
    </span>
  );
}

function KnownIdentity({
  application,
  stale,
}: {
  readonly application: AdminSystemInfo;
  readonly stale: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-8 gap-y-3"
      data-studio-application={stale ? "stale" : "live"}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-base font-semibold text-foreground">{application.name}</span>
        <span className="font-mono text-sm text-muted-foreground">{application.version}</span>
      </div>
      <Fact label="AckerDB">{application.ackerdb}</Fact>
      {/*
        A Studio on a different AckerDB version never reaches this header — the
        connect gate holds that case and names the package to install. The badge
        marks the ordinary agreement, so the disagreement is legible as its
        absence.
      */}
      {application.ackerdb === ACKERDB_VERSION && (
        <Badge variant="signal" className="text-signal-green">
          connected
        </Badge>
      )}
      {stale && (
        <Badge variant="signal" className="text-signal-orange">
          not refreshing
        </Badge>
      )}
    </div>
  );
}
