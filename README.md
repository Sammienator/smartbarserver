# Smart Bar — Backend

Node.js/Express + Socket.io + MongoDB (Mongoose) backend for the Smart Bar scan-to-order system.

## Setup

```bash
npm install
cp .env.example .env   # then edit MONGO_URI etc. as needed
npm run dev             # or: npm start
```

Requires a running MongoDB instance (local or Atlas) reachable at `MONGO_URI`.

## Project layout

```
server.js                     entry point - Express app, HTTP server, Socket.io
src/config/db.js               MongoDB connection
src/config/socket.js           Socket.io setup + rooms (guests / admins / waiter:<id>)
src/models/                    Mongoose schemas: MenuItem, Table, Waiter, Order
src/utils/generatePin.js       unique 4-digit PIN generator (scoped to active orders)
src/utils/assignWaiter.js      picks the best available waiter for a new order
src/utils/stockEvents.js       broadcasts stock updates + low-stock alerts
src/utils/asyncHandler.js      wraps async route handlers so errors reach Express's error handler
src/controllers/               route logic
src/routes/                    Express routers, mounted under /api
```

## Core flow implemented

1. **Guest places an order** — `POST /api/orders`
   - Stock is decremented atomically per item (`findOneAndUpdate` with a `stockQty >= quantity` guard), so two guests can't oversell the same item.
   - A waiter is assigned by picking whoever is on shift with the fewest active orders right now (see **assumption** below).
   - If no waiter is available, or stock runs out mid-request, everything already decremented is rolled back and the order is not created.
   - A unique 4-digit PIN is generated (unique only among currently *active* orders) and returned **only** in this response — it is never sent to the waiter or admin views.
   - The order is pushed in real time to the assigned waiter via their `waiter:<id>` socket room.

2. **Waiter fulfills and delivers** — no explicit API call; this is a physical/real-world step. The waiter's active queue is fetched via `GET /api/orders/waiter/:waiterId`.

3. **Waiter ends the order** — `POST /api/orders/:orderId/end` with `{ pin }`
   - Only a correct PIN match closes the order.
   - On success, the order's status flips to `completed`, freeing the waiter for other orders (their active-order count naturally drops, which is what the assignment logic reads from).

4. **Real-time sync** — Socket.io powers three channels:
   - `stock:update` → broadcast to all guest clients whenever an item's stock changes.
   - `inventory:lowstock` → sent to the admin room whenever an item drops below `LOW_STOCK_THRESHOLD` (default 5).
   - `order:new` / `order:ended` → sent to the specific waiter's room.

## API summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/menu` | list menu items |
| POST | `/api/menu` | create a menu item (admin) |
| PATCH | `/api/menu/:id` | edit a menu item (admin) |
| PATCH | `/api/menu/:id/restock` | add stock (admin) |
| DELETE | `/api/menu/:id` | remove an item no longer being sold (admin) |
| GET | `/api/tables` | list tables |
| POST | `/api/tables` | create a table + generate its QR token (admin) |
| GET | `/api/waiters` | list waiters |
| POST | `/api/waiters` | add a waiter (admin) |
| PATCH | `/api/waiters/:id/shift` | toggle on/off shift |
| POST | `/api/orders` | guest places an order |
| POST | `/api/orders/:orderId/end` | waiter closes an order with the PIN |
| GET | `/api/orders/waiter/:waiterId` | a waiter's current active orders |
| GET | `/api/admin/delivery-times?start=&end=` | avg time-to-close per waiter |
| GET | `/api/admin/best-sellers?start=&end=&limit=` | most-ordered items in a date range |
| GET | `/api/admin/low-stock` | items below the stock threshold |
| GET | `/api/admin/orders/active` | every open order + its PIN (forgot-PIN lookup) |
| GET | `/api/admin/orders/history?start=&end=&limit=` | completed orders, most recent first, now including kitchen/bar ready timestamps |
| GET | `/api/admin/sales/summary` | revenue + order count for today, this week, this month |
| GET | `/api/admin/sales?period=day\|week\|month&start=&end=` | revenue breakdown grouped by period |
| GET | `/api/stations/:station/orders` | pending items for `kitchen` or `bar` |
| POST | `/api/stations/:station/orders/:orderId/items/:itemId/ready` | mark one item prepared — **no PIN required** |

## Kitchen and bar stations

Two new "stations" - `kitchen` (food items) and `bar` (drink items) - share a single generic
implementation (`src/controllers/stationController.js`), since the logic is identical for both and
only the item category differs. A mixed order (food + drinks) shows up on both screens, each
seeing only its own items.

Marking an item ready is completely separate from the waiter's guest-facing, PIN-based order
close-out — a head chef or bartender just presses a button per item as it's finished, with no PIN
involved at all. Once every item on an order (kitchen and bar both) has been marked ready, an
`order:ready` event is sent to the assigned waiter as a bonus signal that the whole order is good
to deliver.

## Socket.io events (client side)

Emit on connect, depending on which app is connecting:
- `join:guest` — no payload
- `join:admin` — no payload
- `join:waiter` — payload: `waiterId`
- `join:station` — payload: `"kitchen"` or `"bar"`

Listen for:
- `stock:update` — `{ menuItemId, stockQty, isAvailable }`
- `menu:removed` — `{ menuItemId }` (sent to guests when an item is deleted from the menu entirely)
- `inventory:lowstock` — `{ menuItemId, name, stockQty, threshold }` (admin only)
- `order:new` — `{ orderId, tableNumber, items, totalAmount, createdAt }` (that waiter's room only)
- `order:ended` — `{ orderId, tableNumber }` (that waiter's room only)
- `order:completed` — same info, sent to the admin room for live dashboards
- `station:neworder` — `{ orderId, tableNumber, createdAt, items }` (that station's room only, items filtered to that station's category)
- `station:itemReady` — `{ orderId, itemId, station }` (broadcast to that station's room, e.g. if multiple bar screens are open)
- `item:ready` — `{ orderId, itemId, name, station }` (sent to the assigned waiter, one event per item)
- `order:ready` — `{ orderId, tableNumber }` (sent to the assigned waiter once every item on the order is prepared)

## Troubleshooting: "items.N.category: Path `category` is required"

This shows up in two different situations, both now handled:

**When placing a new order** - it means the order references a menu item with no `category` set
(created before that field existed, or inserted directly into the database). `createOrder` now
checks for this up front and fails with a clear, actionable message instead of a raw Mongoose
stack trace, naming the item and telling you how to fix it.

**When ending an order or marking an item ready on an order placed before the `category` field
existed** - calling `.save()` on a Mongoose document re-validates the *entire* document by
default, including fields you never touched. So closing out an old order could fail on an
unrelated field it never modified. Two fixes are in place for this:

1. Both `endOrder` and `markItemReady` now save with `{ validateModifiedOnly: true }`, so only the
   fields actually being changed (status, prepared, etc.) are re-checked.
2. As a deeper safety net, the `Order` model now self-heals: a `pre("validate")` hook automatically
   looks up and fills in any missing item category from the referenced menu item before validation
   runs, so this class of error shouldn't resurface even from a code path that saves the full
   document.

If you're still seeing this error after pulling in this update, double check the running server is
actually using this version of `src/models/Order.js` and `src/controllers/orderController.js` -
this is a very common source of confusion when a zip has been partially extracted over an older
copy.

To find and permanently fix any menu items still missing a category (recommended even with the
self-healing fix in place, since it only patches *orders*, not the menu items themselves):

```bash
node scripts/find-menu-items-missing-category.js
```

This lists every menu item missing a category and prints a ready-to-run `curl` command to fix
each one (`PATCH /api/menu/:id` with `{ "category": "food" }` or `"drink"`).

## Assumption made (flagged as an open item in the planning doc)

**Whether a waiter can hold several active orders at once, or only one at a time:**
This backend assumes waiters *can* hold multiple active orders simultaneously, and assignment simply load-balances across on-shift waiters by current active-order count. Each `Waiter` document has an optional `maxActiveOrders` field (defaults to `null`/unlimited) — set it to `1` for a specific waiter (or change the default) if you'd rather enforce one order at a time instead.

## Still open (from the planning doc, not yet decided)

- What happens if a guest loses their PIN, or a waiter mistypes it repeatedly (currently: no special handling beyond a `400 Incorrect PIN` response — worth deciding if there should be an admin override).
# smartbarserver
