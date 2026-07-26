import { useMutation, useQuery } from "@ackerdb/client-react";
import { api } from "@demo/ackerdb-codegen/api";
import { createFileRoute } from "@tanstack/react-router";
import {
  LockKeyhole,
  Pencil,
  Plus,
  TableProperties,
  Trash2,
  Users,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { useToast } from "../../components/toast.tsx";
import {
  ConfirmDialog,
  Field,
  FormShell,
  Modal,
  PageHeader,
  QueryContent,
  StatePanel,
  StatusPill,
} from "../../components/ui.tsx";
import { errorMessage, money, type RestaurantTable } from "../../lib/domain.ts";

export const Route = createFileRoute("/_admin/tables")({
  component: TablesPage,
});

function TablesPage() {
  const tables = useQuery(api.tables.list, {});
  const remove = useMutation(api.tables.remove);
  const toast = useToast();
  const [filter, setFilter] = useState<"ALL" | "AVAILABLE" | "IN_USE">("ALL");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RestaurantTable | null>(null);
  const [removing, setRemoving] = useState<RestaurantTable | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirmRemove(table: RestaurantTable) {
    setBusy(true);
    try {
      const result = await remove({ id: table.id });
      if (!result.ok) throw result.error;
      toast.success(
        `Table ${table.number} was removed from the active floor.`,
        "Table removed",
      );
      setRemoving(null);
    } catch (error) {
      toast.error(errorMessage(error, "Could not remove this table"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Tables"
        subtitle="Set floor capacity and see which tables are locked by active orders."
        action={
          <button
            className="button button--primary"
            type="button"
            onClick={() => setCreating(true)}
          >
            <Plus aria-hidden="true" /> Add table
          </button>
        }
      />
      <QueryContent state={tables} loadingLabel="Loading the dining room…">
        {(rows) => {
          const occupied = rows.filter(
            (table) => table.orderId !== null,
          ).length;
          const filtered = rows.filter(
            (table) =>
              filter === "ALL" ||
              (filter === "IN_USE"
                ? table.orderId !== null
                : table.orderId === null),
          );
          const nextNumber =
            rows.reduce(
              (highest, table) => Math.max(highest, table.number),
              0,
            ) + 1;
          return (
            <>
              <section className="surface capacity-banner">
                <span>
                  <TableProperties aria-hidden="true" />
                </span>
                <div>
                  <strong>Dining room capacity</strong>
                  <p>Occupied tables stay locked until their order closes.</p>
                </div>
                <dl>
                  <div>
                    <dt>Tables</dt>
                    <dd>{rows.length}</dd>
                  </div>
                  <div>
                    <dt>Seats</dt>
                    <dd>{rows.reduce((sum, table) => sum + table.seats, 0)}</dd>
                  </div>
                  <div>
                    <dt>Occupied</dt>
                    <dd>
                      {rows.length === 0
                        ? "0%"
                        : `${Math.round((occupied / rows.length) * 100)}%`}
                    </dd>
                  </div>
                </dl>
              </section>

              <div className="filter-row">
                <div className="segmented-control" aria-label="Filter tables">
                  <button
                    className={filter === "ALL" ? "active" : ""}
                    type="button"
                    onClick={() => setFilter("ALL")}
                  >
                    All tables · {rows.length}
                  </button>
                  <button
                    className={filter === "AVAILABLE" ? "active" : ""}
                    type="button"
                    onClick={() => setFilter("AVAILABLE")}
                  >
                    Available · {rows.length - occupied}
                  </button>
                  <button
                    className={filter === "IN_USE" ? "active" : ""}
                    type="button"
                    onClick={() => setFilter("IN_USE")}
                  >
                    In use · {occupied}
                  </button>
                </div>
                <span>{rows.length - occupied} ready for guests</span>
              </div>

              {rows.length === 0 ? (
                <section className="surface grow-state">
                  <StatePanel
                    icon={TableProperties}
                    title="No active tables"
                    detail="Add the first table to open the floor."
                    action={
                      <button
                        className="button button--primary"
                        type="button"
                        onClick={() => setCreating(true)}
                      >
                        Add table
                      </button>
                    }
                  />
                </section>
              ) : filtered.length === 0 ? (
                <section className="surface grow-state">
                  <StatePanel
                    title={`No ${filter === "IN_USE" ? "occupied" : "available"} tables`}
                    detail="Choose another floor filter."
                  />
                </section>
              ) : (
                <section
                  className="table-card-grid"
                  aria-label="Restaurant tables"
                >
                  {filtered.map((table) => {
                    const isOccupied = table.orderId !== null;
                    return (
                      <article
                        className={`table-card${isOccupied ? " table-card--occupied" : ""}`}
                        key={table.id.toString()}
                      >
                        <header>
                          <div>
                            <span>Table</span>
                            <strong>
                              {String(table.number).padStart(2, "0")}
                            </strong>
                          </div>
                          <StatusPill
                            status={isOccupied ? "IN_USE" : "AVAILABLE"}
                          />
                        </header>
                        <p>
                          <Users aria-hidden="true" /> {table.seats} seats
                        </p>
                        <footer>
                          <div>
                            <span>
                              {isOccupied
                                ? table.guestName
                                : "Ready for a guest"}
                            </span>
                            {isOccupied && (
                              <strong>
                                {table.totalCents === null
                                  ? "Open"
                                  : `${money(table.totalCents)} open`}
                              </strong>
                            )}
                          </div>
                          <div className="table-card__actions">
                            <button
                              className="icon-button"
                              type="button"
                              onClick={() => setEditing(table)}
                              disabled={isOccupied}
                              title={
                                isOccupied
                                  ? "Occupied tables are locked"
                                  : `Edit table ${table.number}`
                              }
                            >
                              <span className="sr-only">
                                Edit table {table.number}
                              </span>
                              {isOccupied ? (
                                <LockKeyhole aria-hidden="true" />
                              ) : (
                                <Pencil aria-hidden="true" />
                              )}
                            </button>
                            <button
                              className="icon-button icon-button--danger"
                              type="button"
                              onClick={() => setRemoving(table)}
                              disabled={isOccupied}
                              title={
                                isOccupied
                                  ? "Occupied tables cannot be removed"
                                  : `Remove table ${table.number}`
                              }
                            >
                              <span className="sr-only">
                                Remove table {table.number}
                              </span>
                              <Trash2 aria-hidden="true" />
                            </button>
                          </div>
                        </footer>
                      </article>
                    );
                  })}
                </section>
              )}

              {creating && (
                <TableDialog
                  nextNumber={nextNumber}
                  onClose={() => setCreating(false)}
                />
              )}
              {editing && (
                <TableDialog
                  table={editing}
                  nextNumber={nextNumber}
                  onClose={() => setEditing(null)}
                />
              )}
              {removing && (
                <ConfirmDialog
                  title={`Remove table ${removing.number}?`}
                  description="The table disappears from the active floor but its historical orders remain intact."
                  confirmLabel="Remove table"
                  busy={busy}
                  onClose={() => setRemoving(null)}
                  onConfirm={() => void confirmRemove(removing)}
                />
              )}
            </>
          );
        }}
      </QueryContent>
    </div>
  );
}

function TableDialog({
  table,
  nextNumber,
  onClose,
}: Readonly<{
  table?: RestaurantTable;
  nextNumber: number;
  onClose: () => void;
}>) {
  const create = useMutation(api.tables.create);
  const update = useMutation(api.tables.update);
  const toast = useToast();
  const [number, setNumber] = useState(String(table?.number ?? nextNumber));
  const [seats, setSeats] = useState(String(table?.seats ?? 4));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const values = { number: Number(number), seats: Number(seats) };
      const result = table
        ? await update({ id: table.id, ...values })
        : await create(values);
      if (!result.ok) throw result.error;
      toast.success(
        `Table ${values.number} ${table ? "was updated" : "is ready for guests"}.`,
        table ? "Table updated" : "Table added",
      );
      onClose();
    } catch (cause) {
      setError(
        errorMessage(
          cause,
          `Could not ${table ? "update" : "create"} this table`,
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={table ? `Edit table ${table.number}` : "Add table"}
      description="Table numbers are unique across the restaurant."
      onClose={onClose}
      size="small"
    >
      <FormShell
        onSubmit={submit}
        submitLabel={table ? "Save table" : "Add table"}
        busy={busy}
        error={error}
        onCancel={onClose}
      >
        <div className="form-grid">
          <Field label="Table number">
            <input
              type="number"
              min="1"
              max="999"
              step="1"
              value={number}
              onChange={(event) => setNumber(event.target.value)}
              required
            />
          </Field>
          <Field label="Seats">
            <input
              type="number"
              min="1"
              max="20"
              step="1"
              value={seats}
              onChange={(event) => setSeats(event.target.value)}
              required
            />
          </Field>
        </div>
      </FormShell>
    </Modal>
  );
}
