import { useMutation, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { createFileRoute } from "@tanstack/react-router";
import {
  BadgeCheck,
  Check,
  CodeXml,
  Copy,
  Eye,
  KeyRound,
  Pencil,
  Plus,
  RotateCcwKey,
  Sparkles,
  Terminal,
  TriangleAlert,
  Waypoints,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useToast } from "../../components/toast.tsx";
import {
  PageHeader,
  QueryContent,
  StatePanel,
  useFocusBoundary,
} from "../../components/ui.tsx";
import { errorMessage, type OwnerToken } from "../../lib/domain.ts";

export const Route = createFileRoute("/_admin/agents")({
  component: AgentsPage,
});

/** The public MCP endpoint, from the same source the dbzz client uses. */
const MCP_ENDPOINT = `${import.meta.env.VITE_DBZZ_URL ?? "http://127.0.0.1:3212"}/mcp`;

/** The env var every install snippet reads the bearer token from. */
const TOKEN_ENV_VAR = "SAVORIA_MCP_TOKEN";

type ScopeChoice = "read" | "operate";

const scopesFor = (choice: ScopeChoice): ScopeChoice[] =>
  choice === "operate" ? ["read", "operate"] : ["read"];

const choiceOf = (scopes: readonly string[]): ScopeChoice =>
  scopes.includes("operate") ? "operate" : "read";

const scopeLabel = (choice: ScopeChoice): string =>
  choice === "operate" ? "Read + operate" : "Read only";

const claudeSnippet = `{
  "mcpServers": {
    "savoria": {
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": { "Authorization": "Bearer \${${TOKEN_ENV_VAR}}" }
    }
  }
}`;

const codexSnippet = `[mcp_servers.savoria]
url = "${MCP_ENDPOINT}"
bearer_token_env_var = "${TOKEN_ENV_VAR}"`;

const tokenDate = (ms: number): string =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(ms);

interface RevealedToken {
  readonly name: string;
  readonly choice: ScopeChoice;
  readonly token: string;
}

function AgentsPage() {
  const tokens = useQuery(api.admin.tokens.list, {});
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<OwnerToken | null>(null);
  const [revoking, setRevoking] = useState<OwnerToken | null>(null);
  const [revealed, setRevealed] = useState<RevealedToken | null>(null);

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied to your clipboard.`, "Copied");
    } catch {
      toast.error(`Copy failed — select the ${label.toLowerCase()} and copy it manually.`);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Agents"
        subtitle="Connect Claude Code and Codex to Savoria over MCP."
        action={<CreateButton onClick={() => setCreating(true)} />}
      />

      <div className="flex flex-col gap-4.5">
        <EndpointCard onCopy={() => copy(MCP_ENDPOINT, "Endpoint URL")} />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <InstallSnippet
            client="Claude Code"
            icon={Sparkles}
            filename="~/.claude.json"
            language="json"
            code={claudeSnippet}
            onCopy={() => copy(claudeSnippet, "Claude Code config")}
          />
          <InstallSnippet
            client="Codex"
            icon={CodeXml}
            filename="~/.codex/config.toml"
            language="toml"
            code={codexSnippet}
            onCopy={() => copy(codexSnippet, "Codex config")}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.55fr_0.85fr]">
          <section className="overflow-hidden rounded-[17px] border border-line bg-warm-white">
            <div className="flex items-center justify-between border-b border-line px-4 pb-3.5 pt-4">
              <div>
                <h2 className="text-[15px] font-semibold text-ink-900">Owner tokens</h2>
                <span className="text-[9px] text-ink-500">
                  {tokens.status === "success"
                    ? tokens.data.length === 0
                      ? "No tokens yet"
                      : `${tokens.data.length} active`
                    : "Owner-scoped MCP credentials"}{" "}
                  · issued by Amelia Morgan
                </span>
              </div>
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="inline-flex h-8.5 items-center gap-1.5 rounded-[10px] bg-forest-900 px-3.25 text-[10px] font-[750] text-warm-white transition-colors hover:bg-forest-800"
              >
                <Plus className="size-3" aria-hidden="true" /> New token
              </button>
            </div>

            <QueryContent state={tokens} loadingLabel="Loading owner tokens…">
              {(rows) =>
                rows.length === 0 ? (
                  <div className="grid min-h-65 place-items-center px-6 py-10">
                    <StatePanel
                      icon={KeyRound}
                      title="No owner tokens yet"
                      detail="Create a token to connect Claude Code or Codex over MCP. Its secret is shown only once."
                      action={
                        <button
                          type="button"
                          onClick={() => setCreating(true)}
                          className="mt-4 inline-flex min-h-10.5 items-center justify-center gap-2 rounded-xl bg-forest-900 px-4 text-xs font-[750] text-warm-white transition-colors hover:bg-forest-800"
                        >
                          <Plus className="size-3.5" aria-hidden="true" /> Create token
                        </button>
                      }
                    />
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-[1.5fr_1fr_0.9fr_104px] gap-3 border-b border-line px-4 py-2.25 text-[8px] font-extrabold uppercase tracking-[0.08em] text-ink-500">
                      <span>Name</span>
                      <span>Scope</span>
                      <span>Created</span>
                      <span />
                    </div>
                    {rows.map((token) => (
                      <TokenRow
                        key={token.id}
                        token={token}
                        onEdit={() => setEditing(token)}
                        onRevoke={() => setRevoking(token)}
                      />
                    ))}
                  </>
                )
              }
            </QueryContent>
          </section>

          <ScopesCard />
        </div>
      </div>

      {creating && (
        <TokenFormDialog
          onClose={() => setCreating(false)}
          onCreated={(reveal) => {
            setCreating(false);
            setRevealed(reveal);
          }}
        />
      )}
      {editing && (
        <TokenFormDialog token={editing} onClose={() => setEditing(null)} />
      )}
      {revoking && (
        <RevokeDialog token={revoking} onClose={() => setRevoking(null)} />
      )}
      {revealed && (
        <SecretRevealDialog
          reveal={revealed}
          onCopy={() => copy(revealed.token, "Secret token")}
          onCopyExport={(line) => copy(line, "Export line")}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  );
}

function CreateButton({ onClick }: Readonly<{ onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-10.5 items-center justify-center gap-2 rounded-xl bg-forest-900 px-4 text-xs font-[750] text-warm-white transition-colors hover:bg-forest-800"
    >
      <Plus className="size-3.5" aria-hidden="true" /> Create token
    </button>
  );
}

function EndpointCard({ onCopy }: Readonly<{ onCopy: () => void }>) {
  return (
    <section className="flex flex-col gap-4 rounded-[17px] border border-line bg-warm-white p-5 sm:flex-row sm:items-center">
      <span className="inline-flex size-11.5 flex-none items-center justify-center rounded-[13px] bg-forest-950 text-warm-white">
        <Waypoints className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <span className="text-[9px] font-extrabold uppercase tracking-widest text-ink-500">
          Admin MCP endpoint
        </span>
        <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
          <code className="font-mono text-[15px] font-bold text-forest-900">
            {MCP_ENDPOINT}
          </code>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-sage-100 px-2 py-0.75 text-[8px] font-extrabold uppercase tracking-[0.04em] text-forest-800">
            <i className="size-1.5 rounded-full bg-sage-500" aria-hidden="true" />
            Live
          </span>
        </div>
        <p className="mt-1.5 text-[10px] text-ink-500">
          Streamable HTTP · bearer-authenticated · least-privilege tool discovery per scope.
        </p>
      </div>
      <button
        type="button"
        onClick={onCopy}
        className="inline-flex h-9.5 flex-none items-center gap-1.5 self-start rounded-[11px] border border-line bg-warm-white px-3.5 text-[10px] font-extrabold text-forest-800 transition-colors hover:bg-cream-50 sm:self-auto"
      >
        <Copy className="size-3" aria-hidden="true" /> Copy URL
      </button>
    </section>
  );
}

function InstallSnippet({
  client,
  icon: Icon,
  filename,
  language,
  code,
  onCopy,
}: Readonly<{
  client: string;
  icon: LucideIcon;
  filename: string;
  language: string;
  code: string;
  onCopy: () => void;
}>) {
  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border border-line bg-warm-white">
      <div className="flex items-center gap-2.75 px-4 py-3.5">
        <span className="inline-flex size-8.5 flex-none items-center justify-center rounded-[10px] bg-forest-950 text-warm-white">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-xs text-ink-900">{client}</strong>
          <code className="font-mono text-[9px] text-ink-500">{filename}</code>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex h-7.5 flex-none items-center gap-1.5 rounded-[9px] border border-line bg-warm-white px-2.75 text-[9px] font-extrabold text-forest-800 transition-colors hover:bg-cream-50"
        >
          <Copy className="size-2.75" aria-hidden="true" /> Copy
        </button>
      </div>
      <div className="mx-3.5 mb-3.5 overflow-hidden rounded-xl border border-pine-border bg-forest-950">
        <div className="flex items-center justify-between border-b border-pine-border px-3 py-1.75">
          <span className="text-[8px] font-extrabold uppercase tracking-[0.12em] text-pine-dim">
            {language}
          </span>
          <span className="flex gap-1" aria-hidden="true">
            <i className="size-1.75 rounded-full bg-pine-dot" />
            <i className="size-1.75 rounded-full bg-pine-dot" />
            <i className="size-1.75 rounded-full bg-pine-dot" />
          </span>
        </div>
        <pre className="m-0 overflow-x-auto whitespace-pre-wrap wrap-break-word px-3.25 py-3 font-mono text-[10px] leading-[1.6] text-pine-bright">
          {code}
        </pre>
      </div>
    </div>
  );
}

function TokenRow({
  token,
  onEdit,
  onRevoke,
}: Readonly<{ token: OwnerToken; onEdit: () => void; onRevoke: () => void }>) {
  return (
    <div className="grid grid-cols-[1.5fr_1fr_0.9fr_104px] items-center gap-3 border-b border-line px-4 py-3.5 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2.75">
        <span className="inline-flex size-8.5 flex-none items-center justify-center rounded-[10px] bg-cream-100 text-forest-800">
          <KeyRound className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <strong className="block truncate text-[11px] text-ink-900">
            {token.name}
          </strong>
          <code className="block truncate font-mono text-[9px] text-ink-500">
            dbzz_mcp.{token.id}
          </code>
        </div>
      </div>
      <ScopeBadge scopes={token.scopes} />
      <span className="text-[10px] text-ink-700">{tokenDate(token.createdAt)}</span>
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onEdit}
          title={`Edit ${token.name}`}
          className="inline-flex size-7.5 flex-none items-center justify-center rounded-[9px] border border-line bg-warm-white text-ink-700 transition-colors hover:bg-cream-100"
        >
          <span className="sr-only">Edit {token.name}</span>
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onRevoke}
          className="inline-flex h-7.5 items-center rounded-[9px] border border-line bg-warm-white px-2.5 text-[9px] font-extrabold text-rose-500 transition-colors hover:bg-rose-100"
        >
          Revoke
        </button>
      </div>
    </div>
  );
}

function ScopeBadge({ scopes }: Readonly<{ scopes: readonly string[] }>) {
  const operate = scopes.includes("operate");
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full px-2.25 py-1.25 text-[9px] font-extrabold uppercase tracking-[0.04em] ${
        operate ? "bg-clay-100 text-clay-500" : "bg-sky-100 text-sky-500"
      }`}
    >
      {operate ? (
        <Wrench className="size-2.5" aria-hidden="true" />
      ) : (
        <Eye className="size-2.5" aria-hidden="true" />
      )}
      {operate ? "Read + operate" : "Read only"}
    </span>
  );
}

function ScopesCard() {
  return (
    <section className="flex flex-col gap-3.5 rounded-[17px] border border-line bg-warm-white p-4.5">
      <h3 className="text-[13px] font-semibold text-ink-900">About scopes</h3>
      <div className="rounded-xl bg-sky-100 p-3.5">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-extrabold text-sky-500">
          <Eye className="size-3" aria-hidden="true" /> Read only
        </span>
        <p className="mt-1.5 text-[9px] leading-normal text-ink-700">
          Query orders, tables, the kitchen queue, and revenue. Cannot change any state.
        </p>
      </div>
      <div className="rounded-xl bg-clay-100 p-3.5">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-extrabold text-clay-500">
          <Wrench className="size-3" aria-hidden="true" /> Read + operate
        </span>
        <p className="mt-1.5 text-[9px] leading-normal text-ink-700">
          Also advance kitchen items and cancel orders. Each write asks the host to approve.
        </p>
      </div>
      <div className="mt-auto flex gap-2 text-[9px] leading-[1.45] text-ink-500">
        <RotateCcwKey className="size-3 flex-none translate-y-px" aria-hidden="true" />
        Revoking a token fails its next call with HTTP 401. Secrets are shown once at creation.
      </div>
    </section>
  );
}

function DialogShell({
  width,
  onClose,
  children,
}: Readonly<{ width: string; onClose: () => void; children: ReactNode }>) {
  const panel = useFocusBoundary<HTMLDivElement>(true, onClose);
  return (
    <div
      className="fixed inset-0 z-80 grid place-items-center overflow-y-auto bg-[rgba(16,42,36,0.42)] p-5"
      onMouseDown={(event) =>
        event.target === event.currentTarget && onClose()
      }
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        className={`w-full ${width} rounded-[20px] bg-warm-white p-5.5 font-sans shadow-[0_30px_80px_rgba(16,42,36,0.30)]`}
      >
        {children}
      </div>
    </div>
  );
}

function TokenFormDialog({
  token,
  onClose,
  onCreated,
}: Readonly<{
  token?: OwnerToken;
  onClose: () => void;
  onCreated?: (reveal: RevealedToken) => void;
}>) {
  const create = useMutation(api.admin.tokens.create);
  const update = useMutation(api.admin.tokens.update);
  const toast = useToast();
  const editing = token !== undefined;
  const [name, setName] = useState(token?.name ?? "");
  const [choice, setChoice] = useState<ScopeChoice>(
    token ? choiceOf(token.scopes) : "operate",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const scopes = scopesFor(choice);
    try {
      if (editing) {
        const result = await update({ id: token.id, name, scopes });
        if (!result.ok) throw result.error;
        toast.success(`"${name}" was updated.`, "Token updated");
        onClose();
      } else {
        const result = await create({ name, scopes });
        if (!result.ok) throw result.error;
        const created = result.data;
        toast.success(`"${created.name}" is ready to connect.`, "Token created");
        onCreated?.({ name: created.name, choice, token: created.token });
      }
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          `Could not ${editing ? "update" : "create"} this token`,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogShell width="max-w-[452px]" onClose={onClose}>
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-display text-[22px] text-ink-900">
            {editing ? "Edit owner token" : "Create owner token"}
          </h2>
          <p className="mt-1.25 text-[10px] text-ink-500">
            Name it and choose what an agent may do with it.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex size-8 flex-none items-center justify-center rounded-[10px] border border-line bg-warm-white text-ink-700 transition-colors hover:bg-cream-50"
        >
          <span className="sr-only">Close dialog</span>
          <X className="size-3.25" aria-hidden="true" />
        </button>
      </div>

      <form onSubmit={submit}>
        <label className="mb-1.75 mt-4.5 block text-[9px] font-extrabold uppercase tracking-wider text-ink-700">
          Token name
        </label>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Kitchen automation"
          required
          autoFocus
          maxLength={120}
          className="h-11 w-full rounded-xl border border-forest-900 bg-warm-white px-3.25 text-xs text-ink-900 outline-none placeholder:text-ink-300 focus:ring-2 focus:ring-sage-500/25"
        />

        <span className="mb-2 mt-4.5 block text-[9px] font-extrabold uppercase tracking-wider text-ink-700">
          What can it do?
        </span>
        <div className="flex flex-col gap-2.25">
          <ScopeOption
            selected={choice === "read"}
            onSelect={() => setChoice("read")}
            icon={Eye}
            iconWrap="bg-sky-100 text-sky-500"
            title="Read only"
            detail="Query live data. No writes."
          />
          <ScopeOption
            selected={choice === "operate"}
            onSelect={() => setChoice("operate")}
            icon={Wrench}
            iconWrap="bg-clay-100 text-clay-500"
            title="Read + operate"
            detail="Advance kitchen items and cancel orders, with per-action approval."
          />
        </div>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-[10px] bg-rose-100 px-3 py-2.5 text-[10px] leading-[1.45] text-rose-500"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-11 flex-1 rounded-xl border border-line bg-warm-white text-[11px] font-[750] text-ink-700 transition-colors hover:bg-cream-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || name.trim() === ""}
            className="inline-flex h-11 flex-[1.6] items-center justify-center gap-2 rounded-xl bg-forest-900 text-[11px] font-[750] text-warm-white transition-colors hover:bg-forest-800 disabled:opacity-50"
          >
            <KeyRound className="size-3.25" aria-hidden="true" />
            {busy
              ? editing
                ? "Saving…"
                : "Creating…"
              : editing
                ? "Save changes"
                : "Create token"}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

function ScopeOption({
  selected,
  onSelect,
  icon: Icon,
  iconWrap,
  title,
  detail,
}: Readonly<{
  selected: boolean;
  onSelect: () => void;
  icon: LucideIcon;
  iconWrap: string;
  title: string;
  detail: string;
}>) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex items-center gap-2.75 rounded-[13px] p-3.25 text-left transition-colors ${
        selected
          ? "border-[1.5px] border-forest-900 bg-sage-100"
          : "border border-line bg-warm-white hover:bg-cream-50"
      }`}
    >
      <span
        className={`inline-flex size-8.5 flex-none items-center justify-center rounded-[10px] ${iconWrap}`}
      >
        <Icon className="size-3.5" aria-hidden="true" />
      </span>
      <span className="flex-1">
        <strong className="block text-[11px] text-ink-900">{title}</strong>
        <span
          className={`text-[9px] ${selected ? "text-ink-700" : "text-ink-500"}`}
        >
          {detail}
        </span>
      </span>
      <span
        className={`inline-flex size-5 flex-none items-center justify-center rounded-full ${
          selected ? "bg-forest-900" : "border-2 border-line"
        }`}
      >
        {selected && <Check className="size-2.75 text-warm-white" aria-hidden="true" />}
      </span>
    </button>
  );
}

function SecretRevealDialog({
  reveal,
  onCopy,
  onCopyExport,
  onClose,
}: Readonly<{
  reveal: RevealedToken;
  onCopy: () => void;
  onCopyExport: (line: string) => void;
  onClose: () => void;
}>) {
  return (
    <DialogShell width="max-w-[476px]" onClose={onClose}>
      <div className="flex items-center gap-3.25">
        <span className="inline-flex size-11 flex-none items-center justify-center rounded-[13px] bg-sage-100 text-forest-800">
          <BadgeCheck className="size-5" aria-hidden="true" />
        </span>
        <div className="flex-1">
          <h2 className="font-display text-[21px] text-ink-900">Owner token created</h2>
          <p className="mt-1 text-[10px] text-ink-500">
            “{reveal.name}” · {scopeLabel(reveal.choice)}
          </p>
        </div>
      </div>

      <div className="mt-4.5 flex gap-2.5 rounded-[13px] bg-amber-100 px-3.25 py-3">
        <TriangleAlert className="size-3.75 flex-none text-amber-500" aria-hidden="true" />
        <div>
          <strong className="block text-[10px] text-amber-500">
            Copy this secret now
          </strong>
          <span className="mt-0.75 block text-[9px] leading-normal text-ink-700">
            Savoria stores only a hash. It cannot be shown again — if you lose it, revoke this token and create a new one.
          </span>
        </div>
      </div>

      <span className="mb-1.75 mt-4 block text-[9px] font-extrabold uppercase tracking-wider text-ink-700">
        Secret token
      </span>
      <div className="flex items-center gap-3 rounded-[13px] border border-pine-border bg-forest-950 px-3.5 py-3.25">
        <code className="min-w-0 flex-1 break-all font-mono text-xs text-pine-bright">
          {reveal.token}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex h-9 flex-none items-center gap-1.5 rounded-[10px] bg-clay-500 px-3.25 text-[10px] font-extrabold text-warm-white transition-opacity hover:opacity-90"
        >
          <Copy className="size-3" aria-hidden="true" /> Copy
        </button>
      </div>
      <div className="mt-2.25 flex flex-wrap items-center gap-1.5 text-[9px] text-ink-500">
        <Terminal className="size-3 flex-none" aria-hidden="true" />
        Set it as{" "}
        <code className="font-mono text-[9px] text-forest-800">{TOKEN_ENV_VAR}</code>{" "}
        for the install snippet above.
        <button
          type="button"
          onClick={() => onCopyExport(`export ${TOKEN_ENV_VAR}="${reveal.token}"`)}
          className="ml-auto inline-flex h-6 flex-none items-center gap-1 rounded-md border border-line px-2 text-[9px] font-extrabold text-forest-800 transition-colors hover:bg-sage-100"
        >
          <Copy className="size-2.5" aria-hidden="true" /> Copy export line
        </button>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="mt-5 h-11 w-full rounded-xl bg-forest-900 text-[11px] font-[750] text-warm-white transition-colors hover:bg-forest-800"
      >
        I’ve stored it — done
      </button>
    </DialogShell>
  );
}

function RevokeDialog({
  token,
  onClose,
}: Readonly<{ token: OwnerToken; onClose: () => void }>) {
  const revoke = useMutation(api.admin.tokens.revoke);
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      const result = await revoke({ id: token.id });
      if (!result.ok) throw result.error;
      toast.success(
        `"${token.name}" can no longer reach the MCP endpoint.`,
        "Token revoked",
      );
      onClose();
    } catch (cause) {
      toast.error(errorMessage(cause, "Could not revoke this token"));
      setBusy(false);
    }
  }

  return (
    <DialogShell width="max-w-[430px]" onClose={onClose}>
      <h2 className="font-display text-[22px] text-ink-900">
        Revoke “{token.name}”?
      </h2>
      <p className="mt-1.25 text-[10px] leading-normal text-ink-500">
        The next call made with this token fails with HTTP 401. This cannot be undone — issue a new token to reconnect.
      </p>
      <div className="mt-5 flex justify-end gap-2.5">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="h-11 rounded-xl border border-line bg-warm-white px-4 text-[11px] font-[750] text-ink-700 transition-colors hover:bg-cream-50 disabled:opacity-50"
        >
          Keep it
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={busy}
          className="h-11 rounded-xl bg-rose-500 px-4 text-[11px] font-[750] text-warm-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Revoking…" : "Revoke token"}
        </button>
      </div>
    </DialogShell>
  );
}
