import { skip, useMutation, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { Link, createFileRoute } from "@tanstack/react-router";
import {
  ArrowRight,
  Pencil,
  Plus,
  ReceiptText,
  UserRoundPlus,
  Users,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { useToast } from "../../components/toast.tsx";
import {
  Field,
  FormShell,
  Modal,
  PageHeader,
  QueryContent,
  SearchField,
  StatePanel,
  StatusPill,
} from "../../components/ui.tsx";
import {
  FIELD_LIMITS,
  errorMessage,
  initials,
  money,
  shortDateTime,
  type Guest,
  type GuestDetail,
} from "../../lib/domain.ts";

export const Route = createFileRoute("/_admin/guests")({
  component: GuestsPage,
});

function GuestsPage() {
  const guests = useQuery(api.users.list, {});
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const effectiveId =
    selectedId ??
    (guests.status === "success" ? (guests.data[0]?.id ?? null) : null);
  const detail = useQuery(
    api.users.detail,
    effectiveId === null ? skip : { id: effectiveId },
  );
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<GuestDetail | null>(null);

  return (
    <div className="page page--full-height">
      <PageHeader
        title="Guests"
        subtitle="Create guest profiles and understand their active and past orders."
        action={
          <button
            className="button button--primary"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            <Plus aria-hidden="true" /> New guest
          </button>
        }
      />
      <QueryContent state={guests} loadingLabel="Loading guest profiles…">
        {(rows) => {
          const normalized = search.trim().toLowerCase();
          const filtered = rows.filter(
            (guest) =>
              !normalized ||
              guest.name.toLowerCase().includes(normalized) ||
              guest.email.toLowerCase().includes(normalized),
          );
          return (
            <div className="guests-layout">
              <section className="surface guest-list-panel">
                <div className="list-toolbar">
                  <SearchField
                    value={search}
                    onChange={setSearch}
                    placeholder="Search name or email"
                    label="Search guests"
                  />
                </div>
                {rows.length === 0 ? (
                  <StatePanel
                    icon={Users}
                    title="No guest profiles"
                    detail="Create a guest to start an order history."
                    action={
                      <button
                        className="button button--primary"
                        type="button"
                        onClick={() => setCreateOpen(true)}
                      >
                        Create guest
                      </button>
                    }
                  />
                ) : filtered.length === 0 ? (
                  <StatePanel
                    title="No matching guests"
                    detail="Try another name or email address."
                  />
                ) : (
                  <div
                    className="guest-list"
                    role="listbox"
                    aria-label="Guests"
                  >
                    {filtered.map((guest) => {
                      const active = guest.id === effectiveId;
                      return (
                        <button
                          key={guest.id.toString()}
                          type="button"
                          role="option"
                          aria-selected={active}
                          className={active ? "active" : ""}
                          onClick={() => setSelectedId(guest.id)}
                        >
                          <span className="avatar">{initials(guest.name)}</span>
                          <div>
                            <strong>{guest.name}</strong>
                            <small>{guest.email}</small>
                          </div>
                          <span>{guest.orderCount} orders</span>
                          <ArrowRight aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  className="quick-create-card"
                  type="button"
                  onClick={() => setCreateOpen(true)}
                >
                  <UserRoundPlus aria-hidden="true" />
                  <span>
                    <strong>Quick create</strong>
                    <small>Add a name and email in one step</small>
                  </span>
                  <ArrowRight aria-hidden="true" />
                </button>
              </section>

              <section className="surface guest-detail-panel">
                {effectiveId === null ? (
                  <StatePanel
                    icon={Users}
                    title="Select a guest"
                    detail="Profile and order history will appear here."
                  />
                ) : (
                  <QueryContent
                    state={detail}
                    loadingLabel="Loading guest history…"
                  >
                    {(guest) => (
                      <GuestProfile
                        guest={guest}
                        onEdit={() => setEditing(guest)}
                      />
                    )}
                  </QueryContent>
                )}
              </section>

              {createOpen && (
                <GuestDialog
                  onClose={() => setCreateOpen(false)}
                  onCreated={(id) => {
                    setSelectedId(id);
                    setCreateOpen(false);
                  }}
                />
              )}
              {editing && (
                <GuestDialog
                  guest={editing}
                  onClose={() => setEditing(null)}
                  onCreated={() => setEditing(null)}
                />
              )}
            </div>
          );
        }}
      </QueryContent>
    </div>
  );
}

function GuestProfile({
  guest,
  onEdit,
}: Readonly<{ guest: GuestDetail; onEdit: () => void }>) {
  const active = guest.orders.find((order) => order.status === "OPEN") ?? null;
  const closed = guest.orders.filter((order) => order.status !== "OPEN");
  const paid = closed.filter((order) => order.status === "PAID");
  const spend = paid.reduce((sum, order) => sum + order.totalCents, 0);
  return (
    <div className="guest-profile">
      <header>
        <span className="avatar avatar--large">{initials(guest.name)}</span>
        <div>
          <h2>{guest.name}</h2>
          <p>
            {guest.email} · guest since {shortDateTime(guest.createdAt)}
          </p>
        </div>
        <button className="icon-button" type="button" onClick={onEdit}>
          <span className="sr-only">Edit {guest.name}</span>
          <Pencil aria-hidden="true" />
        </button>
      </header>
      <div className="guest-metrics">
        <div>
          <span>Lifetime orders</span>
          <strong>{guest.orders.length}</strong>
        </div>
        <div>
          <span>Total spend</span>
          <strong>{money(spend)}</strong>
        </div>
        <div>
          <span>Average check</span>
          <strong>
            {money(paid.length === 0 ? 0 : Math.round(spend / paid.length))}
          </strong>
        </div>
      </div>

      <section className="guest-orders-section">
        <div className="section-heading">
          <div>
            <h3>Active order</h3>
            <p>Current table and check</p>
          </div>
          {active && (
            <Link
              className="text-link"
              to="/orders"
              search={{ order: active.id.toString() }}
            >
              View order <ArrowRight aria-hidden="true" />
            </Link>
          )}
        </div>
        {active ? (
          <Link
            className="active-order-card"
            to="/orders"
            search={{ order: active.id.toString() }}
          >
            <span className="table-token">T{active.table.number}</span>
            <div>
              <strong>#{active.id.toString()}</strong>
              <small>
                {active.items.length} lines · opened{" "}
                {shortDateTime(active.openedAt)}
              </small>
            </div>
            <StatusPill status={active.status} />
            <b>{money(active.totalCents)}</b>
          </Link>
        ) : (
          <StatePanel
            title="No active order"
            detail="This guest is ready to be seated."
          />
        )}
      </section>

      <section className="guest-orders-section">
        <div className="section-heading">
          <div>
            <h3>Order history</h3>
            <p>{closed.length} closed checks</p>
          </div>
        </div>
        {closed.length === 0 ? (
          <StatePanel
            icon={ReceiptText}
            title="No past orders"
            detail="Paid and cancelled checks will appear here."
          />
        ) : (
          <div className="history-list">
            {closed.map((order) => (
              <Link
                key={order.id.toString()}
                to="/orders"
                search={{ order: order.id.toString() }}
              >
                <ReceiptText aria-hidden="true" />
                <div>
                  <strong>
                    #{order.id.toString()} · Table {order.table.number}
                  </strong>
                  <small>{shortDateTime(order.openedAt)}</small>
                </div>
                <StatusPill status={order.status} />
                <b>{money(order.totalCents)}</b>
                <ArrowRight aria-hidden="true" />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function GuestDialog({
  guest,
  onClose,
  onCreated,
}: Readonly<{
  guest?: Guest | GuestDetail;
  onClose: () => void;
  onCreated: (id: bigint) => void;
}>) {
  const create = useMutation(api.users.create);
  const update = useMutation(api.users.update);
  const toast = useToast();
  const [name, setName] = useState(guest?.name ?? "");
  const [email, setEmail] = useState(guest?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = guest
        ? await update({ id: guest.id, name, email })
        : await create({ name, email });
      if (!result.ok) throw result.error;
      const id = result.data;
      toast.success(
        `${name.trim()} ${guest ? "was updated" : "was added to Savoria"}.`,
        guest ? "Guest updated" : "Guest created",
      );
      onCreated(id);
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          `Could not ${guest ? "update" : "create"} this guest`,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={guest ? `Edit ${guest.name}` : "New guest"}
      description={
        guest?.identity
          ? "This profile is linked to a guest login; its email is locked."
          : "A guest needs only a name and unique email."
      }
      onClose={onClose}
      size="small"
    >
      <FormShell
        onSubmit={submit}
        submitLabel={guest ? "Save guest" : "Create guest"}
        busy={busy}
        error={error}
        onCancel={onClose}
      >
        <Field label="Full name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={FIELD_LIMITS.name}
            autoComplete="name"
            placeholder="Guest name"
          />
        </Field>
        <Field label="Email address">
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            maxLength={254}
            type="email"
            autoComplete="email"
            placeholder="guest@example.com"
            disabled={guest?.identity !== null && guest?.identity !== undefined}
          />
        </Field>
      </FormShell>
    </Modal>
  );
}
