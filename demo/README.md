# dbzz Demo

A restaurant ordering system that puts **one live dbzz backend** behind two clients: an **Admin Panel** for staff and a **Customer App** for guests. Both share the same users, tables, menu, and orders — so the floor, the kitchen, and the guest phone stay in sync in realtime.

UI is designed in Canvazz under `app/design`. Runnable apps and the server live under `app/admin-panel`, `app/server`, and related packages.

---

## The application

A guest sits at a table, opens an order, picks dishes from the menu, and watches each item move through the kitchen. Staff run tables, the menu, and a kitchen queue from the Admin Panel. When every item is finished (served or cancelled), the guest pays and the order closes.

### Domain model

| Entity | Role |
| --- | --- |
| **User** | Guest identity (name + email). Can create an account, view past orders, and see the active one. |
| **Table** | Physical seating. One table hosts many orders over time. Sitting at a free table opens an order; a table with an open order is locked. |
| **Menu** | Orderable items in categories (e.g. Small Plates, From the Fire, Desserts, Drinks). Each item has a photo, name, description, and price. |
| **Order** | Living document for a sitting. Created when a guest sits; closed when paid (or cancelled). Line items are relations with their own kitchen status. |

### Order & item lifecycle

**Order status:** `OPEN` → `PAID` or `CANCELLED`

**Item status (per line on an order):**

```
ORDERED → PREPARING → PREPARED → SERVED
   ↘ CANCELLED (only while ORDERED)
```

Rules:

- Adding an item starts it at `ORDERED`. While `ORDERED`, it can be cancelled.
- An order can be paid only when every item is `SERVED` or `CANCELLED`.
- Order total is the sum of its item prices.
- If every item is `CANCELLED`, the guest can close the order as `CANCELLED`.
- If items are final (`SERVED` or `CANCELLED`) and at least one is `SERVED`, the guest can request the bill and pay.

---

## Admin Panel

Full desktop experience for restaurant staff.

| Area | What you can do |
| --- | --- |
| **Tables** | Define how many tables exist. Tables with an open order are locked. |
| **Menu** | Browse categories; create items (photo, name, description, price). |
| **Orders** | See all orders per table — status, items, and totals. Cancel an open order if needed (e.g. the guest leaves), which frees the table. |
| **Kitchen queue** | See every ordered item and its status. Advance each item (`ORDERED` → `PREPARING` → `PREPARED` → `SERVED`). |
| **Users** | Create users (name + email); inspect their order history. |

---

## Customer App

Mobile-oriented guest flow.

1. **Login** — name + email only (no password).
2. **Tables** — see which tables are free or in use.
3. **Sit** — pick an available table; an order opens automatically.
4. **Table view** — ordered items, kitchen status, and running total.
5. **Order from menu** — open a cart, add items, confirm.
6. **Realtime toasts** — kitchen status changes surface as toasts (e.g. “Your Charred Tomatoes is now being prepared!”).
7. **Close or pay**
   - All items `CANCELLED` → close the order as cancelled, then exit or pick another table.
   - Items final and at least one `SERVED` → request the bill → **Pay** (demo success; no real payment).
8. **After pay** — order is `PAID`; guest can browse their orders or leave.

---

## Repo layout

```
demo/
├── app/
│   ├── design/        # Canvazz UI (Admin + Customer artboards)
│   ├── admin-panel/   # Runnable admin client
│   └── server/        # dbzz backend (schema + functions)
├── packages/          # Shared demo packages (e.g. codegen)
└── scripts/           # Smoke / tooling
```

Both clients consume the same server — that shared live model is the point of the demo.

---

## What this demo showcases

The restaurant domain is a thin shell around the dbzz features we care about. Each section below maps a product moment to the mechanism behind it.

### Multi-framework clients

dbzz is client-agnostic: one schema and one set of queries/mutations, used from whatever UI stack you pick. This demo runs:

- **Admin** — React + TanStack Start (web)
- **Customer** — React Native + Expo (Expo is required for Expo fetch)

Same backend, same realtime contract, two frameworks.

### Custom auth

Guests sign in with name + email only — deliberately minimal, not production auth. The point is the integration: a custom auth provider plugged into dbzz so identity flows through queries and mutations without baking a specific auth vendor into the core.

### Realtime queries

Every query is live. Kitchen advances an item in the Admin Panel → the guest sees the new status without refresh. A guest adds a dish → the kitchen queue updates immediately. Writes from either side land in the same model; subscribers get the next state for free.

### Event tables

Order and item status changes are recorded as events. The Customer App listens on those event tables and turns them into toasts (“your dish is preparing / prepared / served”), so the UI reacts to *what happened*, not just the latest snapshot.

### Schedule tables

When a guest orders an item, a schedule is set. If that item sits without a status advance for more than **2 minutes**, the Admin Panel gets a toast reminding staff to pick it up — a small ops nudge powered by dbzz schedules, not a client-side timer.

---

## Scripts

From `demo/`:

| Command | Purpose |
| --- | --- |
| `bun run design:dev` | Open the Canvazz design project |
| `bun run admin:dev` | Run the Admin Panel |
| `bun run server:dev` | Run the dbzz server |
| `bun run codegen` | Regenerate client types from the server |
| `bun run typecheck` | Typecheck the workspace |
| `bun run smoke` | Smoke test |
| `bun run --cwd app/server test` | Isolated backend acceptance gate |

### Backend setup

The demo consumes the exact published `@dbzz/*@0.2.1` artifacts from the
local registry at `http://127.0.0.1:4873`. From `demo/`:

```sh
bun install --frozen-lockfile
bun run server:start
```

The normal `dbz start` path loads `app/server/credential-verifier.ts`, opens
the durable database under `app/server/.zdb`, and listens on
`http://127.0.0.1:3212`. In another terminal, create the idempotent restaurant
dataset:

```sh
bun run seed
```

Guest login is intentionally passwordless for this local product demo. The
login procedure issues a signed bearer credential whose stable issuer and
subject resolve to a durable dbzz `Identity`; the application `users` row is
then linked to that Identity. Staff operations require
`DBZZ_DEMO_STAFF_TOKEN` (default `savoria-demo-staff`). Set
`DBZZ_DEMO_SIGNING_SECRET` and `DBZZ_DEMO_STAFF_TOKEN` before exposing the demo
outside a local development machine.

Run the focused backend gate without touching the development server:

```sh
bun run --cwd app/server test
```

It starts the real app through the installed `@dbzz/cli@0.2.1` on ephemeral
ports and temporary durable databases. The suite covers durable Identity
across restart, authorization, atomic seating conflicts, price snapshots,
item/order transitions, payment, owner-isolated events, and the real schedule
table path. Its scheduler case advances a test-local clock and invokes the
runtime scheduler directly, while production continues to use the fixed
two-minute delay.
