const MenuItem = require("../models/MenuItem");
const Table = require("../models/Table");
const Order = require("../models/Order");
const generateUniquePin = require("../utils/generatePin");
const assignWaiter = require("../utils/assignWaiter");
const { getIO } = require("../config/socket");
const { emitStockUpdate } = require("../utils/stockEvents");

/**
 * POST /api/orders
 * body: { tableNumber: Number, items: [{ menuItemId, quantity }] }
 *
 * Order of operations matters here:
 *  1. Decrement stock atomically per item (so two guests can't both grab
 *     the last unit).
 *  2. Assign a waiter. If none is available, roll the stock decrements
 *     back so nothing is "lost" against an order that never got created.
 *  3. Generate a unique PIN and create the order record.
 *  4. Push the order to the assigned waiter and broadcast stock changes.
 */
async function createOrder(req, res) {
  const { tableNumber, items } = req.body;

  if (!tableNumber || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "tableNumber and a non-empty items array are required" });
  }

  const table = await Table.findOne({ tableNumber, isActive: true });
  if (!table) {
    return res.status(404).json({ error: `No active table found with number ${tableNumber}` });
  }

  // 1. Attempt to decrement stock for every item, tracking what succeeded
  // so we can compensate if a later item fails or no waiter is free.
  const decremented = [];
  const orderItems = [];
  let totalAmount = 0;

  try {
    for (const { menuItemId, quantity } of items) {
      if (!menuItemId || !quantity || quantity < 1) {
        throw new Error("Each item requires a valid menuItemId and quantity >= 1");
      }

      const updated = await MenuItem.findOneAndUpdate(
        { _id: menuItemId, stockQty: { $gte: quantity } },
        { $inc: { stockQty: -quantity } },
        { new: true }
      );

      if (!updated) {
        const existing = await MenuItem.findById(menuItemId);
        const label = existing ? existing.name : menuItemId;
        throw new Error(`Not enough stock for "${label}"`);
      }

      // Guards against menu items that predate the `category` field (or
      // were inserted directly into the database without going through
      // this app) - without this check, Order.create() below would fail
      // with an opaque Mongoose ValidationError instead of a clear,
      // actionable message.
      if (!updated.category) {
        throw new Error(
          `"${updated.name}" has no category (food/drink) set and can't be ordered yet. ` +
            `Fix it via PATCH /api/menu/${updated._id} with { "category": "food" } or "drink", then try again.`
        );
      }

      decremented.push({ menuItemId, quantity });
      orderItems.push({
        menuItem: updated._id,
        name: updated.name,
        price: updated.price,
        quantity,
        category: updated.category,
      });
      totalAmount += updated.price * quantity;
      emitStockUpdate(updated);
    }
  } catch (err) {
    await rollbackStock(decremented);
    return res.status(409).json({ error: err.message });
  }

  // 2. Assign a waiter. Roll back stock if nobody is available so the
  // order truly never happened.
  const waiter = await assignWaiter({ zone: table.zone });
  if (!waiter) {
    await rollbackStock(decremented);
    return res.status(503).json({ error: "No waiters are currently available. Please try again shortly." });
  }

  // 3. Generate PIN and create the order.
  const pin = await generateUniquePin();

  const order = await Order.create({
    table: table._id,
    tableNumber: table.tableNumber,
    items: orderItems,
    totalAmount,
    pin,
    assignedWaiter: waiter._id,
    status: "active",
  });

  // 4. Notify the assigned waiter in real time.
  const io = getIO();
  io.to(`waiter:${waiter._id}`).emit("order:new", {
    orderId: order._id,
    tableNumber: order.tableNumber,
    items: order.items,
    totalAmount: order.totalAmount,
    createdAt: order.createdAt,
  });

  // Also notify the kitchen and/or bar, whichever categories this order
  // actually contains, so prep staff see it immediately without polling.
  notifyStations(order);

  // The PIN is returned to the guest here and only here - it is not
  // included in any waiter-facing or admin-facing responses/events.
  return res.status(201).json({
    orderId: order._id,
    tableNumber: order.tableNumber,
    items: order.items,
    totalAmount: order.totalAmount,
    pin: order.pin,
    status: order.status,
    assignedWaiter: { id: waiter._id, name: waiter.name },
  });
}

const CATEGORY_TO_STATION = { food: "kitchen", drink: "bar" };

// Notifies the kitchen and/or bar rooms about a newly placed order,
// sending each station only the items it actually needs to prepare.
function notifyStations(order) {
  const io = getIO();
  for (const station of new Set(Object.values(CATEGORY_TO_STATION))) {
    const category = Object.keys(CATEGORY_TO_STATION).find((c) => CATEGORY_TO_STATION[c] === station);
    const stationItems = order.items.filter((i) => i.category === category);
    if (stationItems.length === 0) continue;

    io.to(`station:${station}`).emit("station:neworder", {
      orderId: order._id,
      tableNumber: order.tableNumber,
      createdAt: order.createdAt,
      items: stationItems.map((i) => ({
        itemId: i._id,
        name: i.name,
        quantity: i.quantity,
        prepared: i.prepared,
      })),
    });
  }
}

async function rollbackStock(decremented) {
  for (const { menuItemId, quantity } of decremented) {
    const restored = await MenuItem.findByIdAndUpdate(
      menuItemId,
      { $inc: { stockQty: quantity } },
      { new: true }
    );
    if (restored) emitStockUpdate(restored);
  }
}

/**
 * POST /api/orders/:orderId/end
 * body: { pin: "1234" }
 *
 * Only a correct PIN match closes the order. On success, the order leaves
 * the waiter's active queue and they become free for other pending orders.
 */
async function endOrder(req, res) {
  const { orderId } = req.params;
  const { pin } = req.body;

  if (!pin || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: "A 4-digit pin is required" });
  }

  const order = await Order.findById(orderId);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  if (order.status === "completed") {
    return res.status(409).json({ error: "This order has already been ended" });
  }
  if (order.pin !== pin) {
    return res.status(400).json({ error: "Incorrect PIN" });
  }

  order.status = "completed";
  order.completedAt = new Date();
  // validateModifiedOnly: only re-check the fields we actually changed
  // (status, completedAt), not the whole document. Without this, saving
  // ANY order re-validates its full items array - including items on
  // orders placed before the `category` field existed, which would
  // otherwise fail here with an unrelated "category is required" error.
  await order.save({ validateModifiedOnly: true });

  const io = getIO();
  io.to(`waiter:${order.assignedWaiter}`).emit("order:ended", {
    orderId: order._id,
    tableNumber: order.tableNumber,
  });
  io.to("admins").emit("order:completed", {
    orderId: order._id,
    tableNumber: order.tableNumber,
    waiterId: order.assignedWaiter,
    createdAt: order.createdAt,
    completedAt: order.completedAt,
  });

  return res.json({ orderId: order._id, status: order.status, completedAt: order.completedAt });
}

/**
 * GET /api/orders/waiter/:waiterId
 * Active orders currently assigned to a given waiter.
 */
async function getActiveOrdersForWaiter(req, res) {
  const { waiterId } = req.params;
  const orders = await Order.find({ assignedWaiter: waiterId, status: "active" })
    .select("-pin") // never expose the PIN to the waiter's screen
    .sort({ createdAt: 1 });
  return res.json(orders);
}

module.exports = { createOrder, endOrder, getActiveOrdersForWaiter, CATEGORY_TO_STATION };
