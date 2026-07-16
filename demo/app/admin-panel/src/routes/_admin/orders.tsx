import { useMutation, useQuery } from "@dbzz/client-react";
import { api } from "@demo/dbzz-codegen/api";
import { createFileRoute } from "@tanstack/react-router";
import {
  Ban,
  ChevronRight,
  CircleDollarSign,
  Plus,
  ReceiptText,
  ShoppingBasket,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useToast } from "../../components/toast.tsx";
import {
  ConfirmDialog,
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
  shortTime,
  type MenuCatalog,
  type OrderView,
  type RestaurantTable,
  type Guest,
} from "../../lib/domain.ts";

interface OrdersSearch {
  readonly create?: boolean;
  readonly order?: string;
}

export const Route = createFileRoute("/_admin/orders")({
  validateSearch: (search: Record<string, unknown>): OrdersSearch => ({
    create:
      search.create === true || search.create === "true" ? true : undefined,
    order: typeof search.order === "string" ? search.order : undefined,
  }),
  component: OrdersPage,
});

function OrdersPage() {
  const searchParameters = Route.useSearch();
  const navigate = Route.useNavigate();
  const orders = useQuery(api.orders.list, {});
  const guests = useQuery(api.users.list, {});
  const tables = useQuery(api.tables.list, {});
  const catalog = useQuery(api.menu.catalog, {});
  const cancelOrder = useMutation(api.orders.cancel);
  const cancelItem = useMutation(api.kitchen.cancel);
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"ALL" | "OPEN" | "PAID" | "CANCELLED">(
    "ALL",
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    searchParameters.order ?? null,
  );
  const [createOpen, setCreateOpen] = useState(
    searchParameters.create === true,
  );
  const [addItemsOpen, setAddItemsOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (searchParameters.create) setCreateOpen(true);
    if (searchParameters.order) setSelectedId(searchParameters.order);
  }, [searchParameters.create, searchParameters.order]);

  function clearRouteIntent() {
    void navigate({ search: {}, replace: true });
  }

  async function confirmCancel(order: OrderView) {
    setBusy(true);
    try {
      await cancelOrder({ orderId: order.id });
      toast.success(
        `Order #${order.id.toString()} was cancelled and its table is available.`,
        "Order cancelled",
      );
      setCancelOpen(false);
    } catch (error) {
      toast.error(errorMessage(error, "Could not cancel the order"));
    } finally {
      setBusy(false);
    }
  }

  async function cancelOrderedItem(orderItemId: bigint, name: string) {
    try {
      await cancelItem({ orderItemId });
      toast.success(`${name} was cancelled.`, "Item cancelled");
    } catch (error) {
      toast.error(errorMessage(error, "Could not cancel this item"));
    }
  }

  return (
    <div className="page page--full-height">
      <PageHeader
        title="Orders"
        subtitle="Every check, guest, item, and service state in one place."
        action={
          <button
            className="button button--primary"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            <Plus aria-hidden="true" /> Create order
          </button>
        }
      />

      <QueryContent state={orders} loadingLabel="Loading live orders…">
        {(rows) => {
          const normalizedSearch = search.trim().toLowerCase();
          const filtered = rows.filter((order) => {
            if (status !== "ALL" && order.status !== status) return false;
            if (!normalizedSearch) return true;
            return (
              order.id
                .toString()
                .includes(normalizedSearch.replace(/^#/, "")) ||
              order.user.name.toLowerCase().includes(normalizedSearch) ||
              order.user.email.toLowerCase().includes(normalizedSearch) ||
              `table ${order.table.number}`.includes(normalizedSearch)
            );
          });
          const preferredId = selectedId ?? searchParameters.order;
          const selected =
            rows.find((order) => order.id.toString() === preferredId) ??
            filtered.find((order) => order.status === "OPEN") ??
            filtered[0] ??
            rows[0] ??
            null;

          return (
            <div className="orders-layout">
              <section className="surface order-list-panel">
                <div className="list-toolbar">
                  <SearchField
                    value={search}
                    onChange={setSearch}
                    placeholder="Search orders or guests"
                    label="Search orders"
                  />
                  <label className="compact-select">
                    <span className="sr-only">Filter by status</span>
                    <select
                      value={status}
                      onChange={(event) =>
                        setStatus(event.target.value as typeof status)
                      }
                    >
                      <option value="ALL">All statuses</option>
                      <option value="OPEN">Open</option>
                      <option value="PAID">Paid</option>
                      <option value="CANCELLED">Cancelled</option>
                    </select>
                  </label>
                </div>

                {rows.length === 0 ? (
                  <StatePanel
                    icon={ReceiptText}
                    title="No orders yet"
                    detail="Create the first check to begin service."
                    action={
                      <button
                        className="button button--primary"
                        type="button"
                        onClick={() => setCreateOpen(true)}
                      >
                        Create order
                      </button>
                    }
                  />
                ) : filtered.length === 0 ? (
                  <StatePanel
                    title="No matching orders"
                    detail="Try a different guest, table, or status."
                  />
                ) : (
                  <div
                    className="order-list"
                    role="listbox"
                    aria-label="Orders"
                  >
                    {filtered.map((order) => {
                      const active = selected?.id === order.id;
                      return (
                        <button
                          key={order.id.toString()}
                          className={`order-list__row${active ? " order-list__row--active" : ""}`}
                          type="button"
                          role="option"
                          aria-selected={active}
                          onClick={() => setSelectedId(order.id.toString())}
                        >
                          <span className="table-token">
                            T{order.table.number}
                          </span>
                          <span className="order-list__copy">
                            <span>
                              <strong>#{order.id.toString()}</strong>
                              <StatusPill status={order.status} />
                            </span>
                            <small>
                              {order.user.name} · {shortTime(order.openedAt)}
                            </small>
                          </span>
                          <b>{money(order.totalCents)}</b>
                          <ChevronRight aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="surface order-detail-panel">
                {selected === null ? (
                  <StatePanel
                    icon={ReceiptText}
                    title="Select an order"
                    detail="Order details will appear here."
                  />
                ) : (
                  <OrderDetail
                    order={selected}
                    onAddItems={() => setAddItemsOpen(true)}
                    onCancelOrder={() => setCancelOpen(true)}
                    onCancelItem={cancelOrderedItem}
                  />
                )}
              </section>

              {createOpen && (
                <QueryContent state={guests} loadingLabel="Loading guests…">
                  {(guestRows) => (
                    <QueryContent state={tables} loadingLabel="Loading tables…">
                      {(tableRows) => (
                        <CreateOrderDialog
                          guests={guestRows}
                          tables={tableRows}
                          onClose={() => {
                            setCreateOpen(false);
                            clearRouteIntent();
                          }}
                          onCreated={(id) => {
                            setSelectedId(id.toString());
                            setCreateOpen(false);
                            clearRouteIntent();
                          }}
                        />
                      )}
                    </QueryContent>
                  )}
                </QueryContent>
              )}

              {addItemsOpen && selected && (
                <QueryContent state={catalog} loadingLabel="Loading the menu…">
                  {(categories) => (
                    <AddItemsDialog
                      order={selected}
                      catalog={categories}
                      onClose={() => setAddItemsOpen(false)}
                    />
                  )}
                </QueryContent>
              )}

              {cancelOpen && selected && (
                <ConfirmDialog
                  title={`Cancel order #${selected.id.toString()}?`}
                  description="This closes the entire check, clears its payable total, and immediately frees the table. Item history stays intact."
                  confirmLabel="Cancel order"
                  busy={busy}
                  onClose={() => setCancelOpen(false)}
                  onConfirm={() => void confirmCancel(selected)}
                />
              )}
            </div>
          );
        }}
      </QueryContent>
    </div>
  );
}

function OrderDetail({
  order,
  onAddItems,
  onCancelOrder,
  onCancelItem,
}: Readonly<{
  order: OrderView;
  onAddItems: () => void;
  onCancelOrder: () => void;
  onCancelItem: (id: bigint, name: string) => void;
}>) {
  return (
    <div className="order-detail">
      <header className="order-detail__header">
        <div>
          <span>
            <h2>#{order.id.toString()}</h2>
            <StatusPill status={order.status} />
          </span>
          <p>
            Table {order.table.number} · opened {shortDateTime(order.openedAt)}
          </p>
        </div>
        <span className="order-detail__table">
          T{String(order.table.number).padStart(2, "0")}
        </span>
      </header>

      <div className="guest-strip">
        <span className="avatar">{initials(order.user.name)}</span>
        <div>
          <strong>{order.user.name}</strong>
          <small>{order.user.email}</small>
        </div>
        <UserRound aria-hidden="true" />
      </div>

      <div className="order-items">
        <div className="order-items__heading">
          <h3>Order items</h3>
          <span>{order.items.length} lines</span>
        </div>
        {order.items.length === 0 ? (
          <StatePanel
            icon={ShoppingBasket}
            title="This check is empty"
            detail="Add menu items to send them to the kitchen."
          />
        ) : (
          order.items.map((item) => (
            <article className="order-item-row" key={item.id.toString()}>
              <span className="quantity-token">{item.quantity}×</span>
              <div>
                <strong>{item.name}</strong>
                <small>
                  {item.note ?? `Added ${shortTime(item.orderedAt)}`}
                </small>
              </div>
              <StatusPill status={item.status} />
              <b>{money(item.unitPriceCents * item.quantity)}</b>
              {order.status === "OPEN" && item.status === "ORDERED" && (
                <button
                  className="icon-button icon-button--danger"
                  type="button"
                  onClick={() => onCancelItem(item.id, item.name)}
                >
                  <span className="sr-only">Cancel {item.name}</span>
                  <Ban aria-hidden="true" />
                </button>
              )}
            </article>
          ))
        )}
        {order.status === "OPEN" && (
          <button
            className="add-line-button"
            type="button"
            onClick={onAddItems}
          >
            <Plus aria-hidden="true" /> Add items to this order
          </button>
        )}
      </div>

      <footer className="order-detail__footer">
        <div>
          <span>
            {order.items.reduce((sum, item) => sum + item.quantity, 0)} items ·
            taxes included
          </span>
          <div>
            <small>Order total</small>
            <strong>{money(order.totalCents)}</strong>
          </div>
        </div>
        {order.status === "OPEN" ? (
          <div className="order-detail__actions">
            <button
              className="button button--danger-secondary"
              type="button"
              onClick={onCancelOrder}
            >
              Cancel order
            </button>
            <span
              className={`payment-state${order.readyToPay ? " payment-state--ready" : ""}`}
            >
              <CircleDollarSign aria-hidden="true" />
              {order.readyToPay
                ? "Ready for guest payment"
                : "Waiting for kitchen completion"}
            </span>
          </div>
        ) : (
          <p className="closed-order-note">
            Closed {order.closedAt ? shortDateTime(order.closedAt) : "—"}
          </p>
        )}
      </footer>
    </div>
  );
}

function CreateOrderDialog({
  guests,
  tables,
  onCreated,
  onClose,
}: Readonly<{
  guests: readonly Guest[];
  tables: readonly RestaurantTable[];
  onCreated: (id: bigint) => void;
  onClose: () => void;
}>) {
  const create = useMutation(api.orders.create);
  const toast = useToast();
  const availableGuests = guests.filter(
    (guest) => guest.activeOrderId === null,
  );
  const availableTables = tables.filter((table) => table.orderId === null);
  const [guestId, setGuestId] = useState(
    availableGuests[0]?.id.toString() ?? "",
  );
  const [tableId, setTableId] = useState(
    availableTables[0]?.id.toString() ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!guestId || !tableId) return;
    setBusy(true);
    setError(null);
    try {
      const id = await create({
        userId: BigInt(guestId),
        tableId: BigInt(tableId),
      });
      toast.success(
        `Order #${id.toString()} is live in the kitchen.`,
        "Order created",
      );
      onCreated(id);
    } catch (cause) {
      setError(errorMessage(cause, "Could not create the order"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create order"
      description="Pair an available guest with a free table."
      onClose={onClose}
    >
      {availableGuests.length === 0 || availableTables.length === 0 ? (
        <StatePanel
          title={
            availableGuests.length === 0
              ? "No available guests"
              : "No available tables"
          }
          detail={
            availableGuests.length === 0
              ? "Every guest already has an open order."
              : "Close an open order before seating another guest."
          }
        />
      ) : (
        <FormShell
          onSubmit={submit}
          submitLabel="Open order"
          busy={busy}
          error={error}
          onCancel={onClose}
        >
          <Field label="Guest">
            <select
              value={guestId}
              onChange={(event) => setGuestId(event.target.value)}
              required
            >
              {availableGuests.map((guest) => (
                <option key={guest.id.toString()} value={guest.id.toString()}>
                  {guest.name} · {guest.email}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Table">
            <select
              value={tableId}
              onChange={(event) => setTableId(event.target.value)}
              required
            >
              {availableTables.map((table) => (
                <option key={table.id.toString()} value={table.id.toString()}>
                  Table {table.number} · {table.seats} seats
                </option>
              ))}
            </select>
          </Field>
        </FormShell>
      )}
    </Modal>
  );
}

function AddItemsDialog({
  order,
  catalog,
  onClose,
}: Readonly<{ order: OrderView; catalog: MenuCatalog; onClose: () => void }>) {
  const addItems = useMutation(api.orders.addItemsAsStaff);
  const toast = useToast();
  const availableItems = useMemo(
    () =>
      catalog.flatMap((category) =>
        category.items.filter((item) => item.active),
      ),
    [catalog],
  );
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedCount = Object.values(quantities).reduce(
    (sum, quantity) => sum + quantity,
    0,
  );
  const selectedLines = Object.values(quantities).filter(
    (quantity) => quantity > 0,
  ).length;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const items = availableItems.flatMap((item) => {
      const quantity = quantities[item.id.toString()] ?? 0;
      return quantity > 0
        ? [{ menuItemId: item.id, quantity, note: note.trim() || null }]
        : [];
    });
    if (items.length === 0) {
      setError("Choose at least one item.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addItems({ orderId: order.id, items });
      toast.success(
        `${selectedCount} item${selectedCount === 1 ? "" : "s"} sent to the kitchen.`,
        "Order updated",
      );
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "Could not add these items"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Add items to #${order.id.toString()}`}
      description={`Table ${order.table.number} · ${order.user.name}`}
      onClose={onClose}
      size="large"
    >
      {availableItems.length === 0 ? (
        <StatePanel
          title="No active menu items"
          detail="Create or reactivate an item in Menu first."
        />
      ) : (
        <FormShell
          onSubmit={submit}
          submitLabel={`Add ${selectedCount || ""} item${selectedCount === 1 ? "" : "s"}`.trim()}
          busy={busy}
          error={error}
          onCancel={onClose}
        >
          <div className="menu-picker">
            {catalog.map((category) => {
              const items = category.items.filter((item) => item.active);
              if (items.length === 0) return null;
              return (
                <section key={category.id.toString()}>
                  <h3>{category.name}</h3>
                  {items.map((item) => {
                    const key = item.id.toString();
                    const quantity = quantities[key] ?? 0;
                    return (
                      <div className="menu-picker__row" key={key}>
                        <div>
                          <strong>{item.name}</strong>
                          <small>{money(item.priceCents)}</small>
                        </div>
                        <div className="stepper">
                          <button
                            type="button"
                            onClick={() =>
                              setQuantities((current) => ({
                                ...current,
                                [key]: Math.max(0, quantity - 1),
                              }))
                            }
                            disabled={quantity === 0}
                          >
                            −
                          </button>
                          <output aria-label={`${item.name} quantity`}>
                            {quantity}
                          </output>
                          <button
                            type="button"
                            onClick={() =>
                              setQuantities((current) => ({
                                ...current,
                                [key]: quantity + 1,
                              }))
                            }
                            disabled={
                              quantity >= FIELD_LIMITS.orderQuantity ||
                              (quantity === 0 &&
                                selectedLines >= FIELD_LIMITS.orderLines)
                            }
                          >
                            +
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>
          <Field
            label="Kitchen note"
            hint="Optional; applied to each selected line."
          >
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={FIELD_LIMITS.orderNote}
              placeholder="Allergies or preparation notes"
            />
          </Field>
        </FormShell>
      )}
    </Modal>
  );
}
