const MenuItem = require("../models/MenuItem");
const Table = require("../models/Table");
const Order = require("../models/Order");
const generateUniquePin = require("../utils/generatePin");
const assignWaiter = require("../utils/assignWaiter");
const { getIO } = require("../config/socket");
const { emitStockUpdate } = require("../utils/stockEvents");

const CATEGORY_TO_STATION = { food: "kitchen", drink: "bar" };

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
 * Shared stock + waiter + order-item preparation used by both
 * the legacy createOrder and the payment-first createPaidOrder flow.
 */
async function prepareOrderPayload(tableNumber, items) {
  if (!tableNumber || !Array.isArray(items) || items.length === 0) {
    const err = new Error("tableNumber and a non-empty items array are required");
    err.status = 400;
    throw err;
  }

  const table = await Table.findOne({ tableNumber, isActive: true });
  if (!table) {
    const err = new Error(`No active table found with number ${tableNumber}`);
    err.status = 404;
    throw err;
  }

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

      if (!updated.category) {
        throw new Error(
          `Menu item "${updated.name}" is missing a category. Ask staff to fix it in admin before ordering.`
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
    err.status = err.status || 409;
    throw err;
  }

  const waiter = await assignWaiter({ zone: table.zone });
  if (!waiter) {
    await rollbackStock(decremented);
    const err = new Error("No waiters are currently available. Please try again shortly.");
    err.status = 503;
    throw err;
  }

  const pin = await generateUniquePin();

  return { table, orderItems, totalAmount, waiter, pin, decremented };
}

/**
 * POST /api/orders/pay
 * Payment-first flow:
 *  1. Validate + decrement stock + assign waiter + generate PIN
 *  2. Create order as pending_payment (PIN not returned yet)
 *  3. Initialize Paystack transaction
 *  4. Return authorization_url so the guest can pay
 *
 * PIN is only released after successful payment (webhook or verify).
 */
async function createPaidOrder(req, res) {
  const { tableNumber, items, email, callbackUrl } = req.body;

  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(503).json({ error: "Payment provider is not configured on the server" });
  }

  let prepared;
  try {
    prepared = await prepareOrderPayload(tableNumber, items);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const { table, orderItems, totalAmount, waiter, pin, decremented } = prepared;

  // Guest email is required by Paystack; fall back to a placeholder if none given.
  const customerEmail =
    (typeof email === "string" && email.includes("@") && email) ||
    `table${table.tableNumber}@smartbar.local`;

  const order = await Order.create({
    table: table._id,
    tableNumber: table.tableNumber,
    items: orderItems,
    totalAmount,
    pin,
    assignedWaiter: waiter._id,
    status: "pending_payment",
    paymentStatus: "unpaid",
  });

  // Unique reference we control (also stored on the order).
  const reference = `sb_${order._id}_${Date.now()}`;

  const amountKobo = Math.round(totalAmount * 100);
  if (amountKobo < 100) {
    // Paystack minimum is typically 100 kobo (KES 1) — adjust if needed.
    await Order.findByIdAndDelete(order._id);
    await rollbackStock(decremented);
    return res.status(400).json({ error: "Order total is too low to process payment" });
  }

  const initBody = {
    email: customerEmail,
    amount: amountKobo,
    currency: "KES",
    reference,
    // Restrict channels if desired: card + mobile_money (Airtel + M-Pesa).
    // To exclude M-Pesa entirely you'd need Charge API with provider atl — 
    // for hosted checkout both mobile providers appear under mobile_money.
    channels: ["card", "mobile_money"],
    metadata: {
      orderId: String(order._id),
      tableNumber: table.tableNumber,
      custom_fields: [
        { display_name: "Table", variable_name: "table_number", value: String(table.tableNumber) },
        { display_name: "Order ID", variable_name: "order_id", value: String(order._id) },
      ],
    },
  };

  if (callbackUrl && typeof callbackUrl === "string") {
    initBody.callback_url = callbackUrl;
  }

  try {
    const resp = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initBody),
    });

    const body = await resp.json();
    if (!resp.ok || !body.status) {
      // Payment init failed — roll everything back.
      await Order.findByIdAndDelete(order._id);
      await rollbackStock(decremented);
      console.error("[paystack] initialize failed", body);
      return res.status(502).json({
        error: body.message || "Could not start payment. Please try again.",
      });
    }

    order.paymentReference = reference;
    await order.save({ validateModifiedOnly: true });

    // Do NOT return the PIN here.
    return res.status(201).json({
      orderId: order._id,
      reference,
      authorization_url: body.data.authorization_url,
      access_code: body.data.access_code,
      totalAmount,
      tableNumber: order.tableNumber,
      // Guest must complete payment; PIN comes after verify/webhook.
      paymentRequired: true,
    });
  } catch (err) {
    await Order.findByIdAndDelete(order._id);
    await rollbackStock(decremented);
    console.error("[paystack] initialize error", err);
    return res.status(502).json({ error: "Payment service unavailable. Please try again." });
  }
}

/**
 * Legacy POST /api/orders — kept for backwards compatibility / testing.
 * Prefer POST /api/orders/pay in production.
 */
async function createOrder(req, res) {
  const { tableNumber, items } = req.body;

  let prepared;
  try {
    prepared = await prepareOrderPayload(tableNumber, items);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const { table, orderItems, totalAmount, waiter, pin } = prepared;

  const order = await Order.create({
    table: table._id,
    tableNumber: table.tableNumber,
    items: orderItems,
    totalAmount,
    pin,
    assignedWaiter: waiter._id,
    status: "active",
    paymentStatus: "paid", // legacy path treats as already settled
    paidAt: new Date(),
  });

  const io = getIO();
  io.to(`waiter:${waiter._id}`).emit("order:new", {
    orderId: order._id,
    tableNumber: order.tableNumber,
    items: order.items,
    totalAmount: order.totalAmount,
    createdAt: order.createdAt,
  });

  notifyStations(order);

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

/**
 * POST /api/orders/:orderId/end
 * body: { pin: "1234" }
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
  if (order.status === "pending_payment") {
    return res.status(402).json({ error: "This order has not been paid yet" });
  }
  if (order.status === "cancelled") {
    return res.status(409).json({ error: "This order was cancelled" });
  }
  if (order.pin !== pin) {
    return res.status(400).json({ error: "Incorrect PIN" });
  }

  order.status = "completed";
  order.completedAt = new Date();
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
 * Only active (paid) orders.
 */
async function getActiveOrdersForWaiter(req, res) {
  const { waiterId } = req.params;
  const orders = await Order.find({ assignedWaiter: waiterId, status: "active" })
    .select("-pin")
    .sort({ createdAt: 1 });
  return res.json(orders);
}

module.exports = {
  createOrder,
  createPaidOrder,
  endOrder,
  getActiveOrdersForWaiter,
  CATEGORY_TO_STATION,
};
