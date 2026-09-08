const MenuItem = require("../models/MenuItem");
const Table = require("../models/Table");
const Order = require("../models/Order");
const generateUniquePin = require("../utils/generatePin");
const assignWaiter = require("../utils/assignWaiter");
const { getIO } = require("../config/socket");
const { emitStockUpdate } = require("../utils/stockEvents");

/**
 * POST /api/orders
 * body: { 
 *   tableNumber: Number, 
 *   items: [{ menuItemId, quantity }],
 *   email: String (required),
 *   paymentMethod: String ("mpesa" | "card", required)
 * }
 *
 * Order of operations matters here:
 *  1. Validate email and payment method
 *  2. Decrement stock atomically per item (so two guests can't both grab
 *     the last unit).
 *  3. Assign a waiter. If none is available, roll the stock decrements
 *     back so nothing is "lost" against an order that never got created.
 *  4. Generate a unique PIN and create the order record.
 *  5. Push the order to the assigned waiter and broadcast stock changes.
 */
async function createOrder(req, res) {
  const { tableNumber, items, email, paymentMethod } = req.body;

  // Validate required payment fields
  if (!email || !paymentMethod) {
    return res.status(400).json({ 
      error: "Email and payment method are required to place an order" 
    });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ 
      error: "Please provide a valid email address" 
    });
  }

  // Validate payment method
  if (!["mpesa", "card"].includes(paymentMethod)) {
    return res.status(400).json({ 
      error: "Payment method must be 'mpesa' or 'card'" 
    });
  }

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

  // 3. Generate PIN and create the order with email and payment method.
  const pin = await generateUniquePin();

  const order = await Order.create({
    table: table._id,
    tableNumber: table.tableNumber,
    items: orderItems,
    totalAmount,
    pin,
    email,
    paymentMethod,
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
    email: order.email,
    paymentMethod: order.paymentMethod,
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
    email: order.email,
    paymentMethod: order.paymentMethod,
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
        price: i.price,
      })),
    });
  }
}

// Rolls back (increments) the stock of items that were decremented in the
// first pass but whose order couldn't be completed (e.g. waiter unavailable).
async function rollbackStock(items) {
  for (const { menuItemId, quantity } of items) {
    await MenuItem.findByIdAndUpdate(menuItemId, { $inc: { stockQty: quantity } });
  }
}

// Fetches all orders for a waiter, with optional filters.
async function getWaiterOrders(req, res) {
  const { waiterId } = req.params;
  const status = req.query.status; // "active", "completed", etc.

  const query = { assignedWaiter: waiterId };
  if (status) query.status = status;

  const orders = await Order.find(query).sort({ createdAt: -1 }).populate("table");
  return res.json(orders);
}

async function updateOrderStatus(req, res) {
  const { orderId } = req.params;
  const { status } = req.body;

  if (!["active", "completed", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const order = await Order.findByIdAndUpdate(orderId, { status }, { new: true });
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }

  // Notify the guest (via Socket.io room, not order PIN, so a random person
  // with the room name can't extract guest data). The guest subscribes to
  // this room so they can see when their order is completed.
  const io = getIO();
  io.to(`order:${orderId}`).emit("order:statusUpdate", {
    orderId: order._id,
    status: order.status,
  });

  return res.json(order);
}

module.exports = {
  createOrder,
  getWaiterOrders,
  updateOrderStatus,
};
