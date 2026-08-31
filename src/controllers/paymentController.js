const crypto = require("crypto");
const Order = require("../models/Order");
const MenuItem = require("../models/MenuItem");
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

async function rollbackStockForOrder(order) {
  for (const item of order.items) {
    const restored = await MenuItem.findByIdAndUpdate(
      item.menuItem,
      { $inc: { stockQty: item.quantity } },
      { new: true }
    );
    if (restored) emitStockUpdate(restored);
  }
}

/**
 * Activate a pending order after successful payment.
 * Notifies waiter + stations. PIN is already on the document.
 */
async function activatePaidOrder(order) {
  if (order.status === "active" && order.paymentStatus === "paid") {
    return order; // already handled (idempotent)
  }

  order.status = "active";
  order.paymentStatus = "paid";
  order.paidAt = new Date();
  await order.save({ validateModifiedOnly: true });

  const io = getIO();
  io.to(`waiter:${order.assignedWaiter}`).emit("order:new", {
    orderId: order._id,
    tableNumber: order.tableNumber,
    items: order.items,
    totalAmount: order.totalAmount,
    createdAt: order.createdAt,
  });

  notifyStations(order);

  // Let the guest PWA know payment cleared (if they joined a room).
  io.to(`order:${order._id}`).emit("order:paid", {
    orderId: order._id,
    pin: order.pin,
    tableNumber: order.tableNumber,
    totalAmount: order.totalAmount,
    items: order.items,
  });

  return order;
}

/**
 * POST /api/payments/webhook
 * Paystack sends events here. Must verify the signature.
 * Body is the raw buffer when mounted with express.raw.
 */
async function paystackWebhook(req, res) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error("[paystack] PAYSTACK_SECRET_KEY not set");
    return res.status(500).send("Misconfigured");
  }

  const signature = req.headers["x-paystack-signature"];
  if (!signature) {
    return res.status(400).send("Missing signature");
  }

  const hash = crypto
    .createHmac("sha512", secret)
    .update(req.body) // raw Buffer
    .digest("hex");

  if (hash !== signature) {
    console.warn("[paystack] Invalid webhook signature");
    return res.status(400).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  // Acknowledge quickly; process async-safe (we await but keep it light).
  if (event.event === "charge.success") {
    const data = event.data || {};
    const reference = data.reference;
    if (!reference) {
      return res.sendStatus(200);
    }

    const order = await Order.findOne({ paymentReference: reference });
    if (!order) {
      console.warn(`[paystack] No order for reference ${reference}`);
      return res.sendStatus(200);
    }

    if (order.paymentStatus === "paid") {
      return res.sendStatus(200);
    }

    // Optional amount check (Paystack amount is in kobo/cents).
    const expectedKobo = Math.round(order.totalAmount * 100);
    if (typeof data.amount === "number" && data.amount !== expectedKobo) {
      console.error(
        `[paystack] Amount mismatch for ${reference}: got ${data.amount}, expected ${expectedKobo}`
      );
      return res.sendStatus(200);
    }

    try {
      await activatePaidOrder(order);
      console.log(`[paystack] Order ${order._id} activated (ref ${reference})`);
    } catch (err) {
      console.error("[paystack] Failed to activate order", err);
    }
  }

  // You can handle charge.failed here if you want to cancel + restore stock.
  if (event.event === "charge.failed") {
    const reference = event.data?.reference;
    if (reference) {
      const order = await Order.findOne({ paymentReference: reference });
      if (order && order.status === "pending_payment") {
        order.status = "cancelled";
        order.paymentStatus = "failed";
        await order.save({ validateModifiedOnly: true });
        await rollbackStockForOrder(order);
        console.log(`[paystack] Order ${order._id} cancelled (failed payment)`);
      }
    }
  }

  return res.sendStatus(200);
}

/**
 * GET /api/payments/verify/:reference
 * Client calls this after Paystack redirect/popup success to obtain the PIN.
 * Also double-checks with Paystack if webhook is delayed.
 */
async function verifyPayment(req, res) {
  const { reference } = req.params;
  if (!reference) {
    return res.status(400).json({ error: "reference is required" });
  }

  let order = await Order.findOne({ paymentReference: reference });
  if (!order) {
    return res.status(404).json({ error: "Order not found for this payment reference" });
  }

  // Already paid — return PIN.
  if (order.paymentStatus === "paid" && order.status === "active") {
    return res.json({
      orderId: order._id,
      tableNumber: order.tableNumber,
      items: order.items,
      totalAmount: order.totalAmount,
      pin: order.pin,
      status: order.status,
      paymentStatus: order.paymentStatus,
    });
  }

  if (order.status === "cancelled") {
    return res.status(402).json({ error: "Payment failed or was cancelled" });
  }

  // Webhook may be delayed — verify with Paystack API.
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    return res.status(503).json({ error: "Payment provider not configured" });
  }

  try {
    const resp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await resp.json();

    if (!body.status || body.data?.status !== "success") {
      return res.status(402).json({
        error: "Payment not completed yet",
        paymentStatus: order.paymentStatus,
        status: order.status,
      });
    }

    // Amount safety check
    const expectedKobo = Math.round(order.totalAmount * 100);
    if (body.data.amount !== expectedKobo) {
      return res.status(400).json({ error: "Payment amount mismatch" });
    }

    order = await activatePaidOrder(order);

    return res.json({
      orderId: order._id,
      tableNumber: order.tableNumber,
      items: order.items,
      totalAmount: order.totalAmount,
      pin: order.pin,
      status: order.status,
      paymentStatus: order.paymentStatus,
    });
  } catch (err) {
    console.error("[paystack] verify failed", err);
    return res.status(502).json({ error: "Could not verify payment with provider" });
  }
}

module.exports = {
  paystackWebhook,
  verifyPayment,
  activatePaidOrder,
  CATEGORY_TO_STATION,
};
