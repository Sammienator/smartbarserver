const Order = require("../models/Order");
const { getIO } = require("../config/socket");
const { CATEGORY_TO_STATION } = require("./orderController");

const STATION_TO_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORY_TO_STATION).map(([category, station]) => [station, category])
);

function categoryForStation(station) {
  return STATION_TO_CATEGORY[station] || null;
}

/**
 * GET /api/stations/:station/orders
 * station = "kitchen" | "bar"
 *
 * Returns every active order that contains at least one item belonging
 * to this station, with only that station's items included (a mixed
 * food+drink order shows up on both the kitchen and bar screens, each
 * only seeing their own items).
 */
async function getStationOrders(req, res) {
  const { station } = req.params;
  const category = categoryForStation(station);
  if (!category) {
    return res.status(404).json({ error: `Unknown station "${station}". Use "kitchen" or "bar".` });
  }

  const orders = await Order.find({ status: "active", "items.category": category }).sort({ createdAt: 1 });

  const result = orders
    .map((o) => ({
      orderId: o._id,
      tableNumber: o.tableNumber,
      createdAt: o.createdAt,
      items: o.items
        .filter((i) => i.category === category)
        .map((i) => ({
          itemId: i._id,
          name: i.name,
          quantity: i.quantity,
          prepared: i.prepared,
          preparedAt: i.preparedAt,
        })),
    }))
    .filter((o) => o.items.length > 0);

  return res.json(result);
}

/**
 * POST /api/stations/:station/orders/:orderId/items/:itemId/ready
 *
 * Marks a single item as prepared. No PIN required - this is purely a
 * kitchen/bar prep signal, separate from the waiter's guest-facing,
 * PIN-based order close-out.
 */
async function markItemReady(req, res) {
  const { station, orderId, itemId } = req.params;
  const category = categoryForStation(station);
  if (!category) {
    return res.status(404).json({ error: `Unknown station "${station}". Use "kitchen" or "bar".` });
  }

  const order = await Order.findById(orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });

  const item = order.items.id(itemId);
  if (!item || item.category !== category) {
    return res.status(404).json({ error: "Item not found for this station" });
  }

  item.prepared = true;
  item.preparedAt = new Date();
  // See the same fix/comment in orderController.endOrder - avoids
  // re-validating every item on the order (including ones from before
  // the `category` field existed) just because one item's prep status changed.
  await order.save({ validateModifiedOnly: true });

  const io = getIO();
  io.to(`station:${station}`).emit("station:itemReady", { orderId: order._id, itemId: item._id, station });
  io.to(`waiter:${order.assignedWaiter}`).emit("item:ready", {
    orderId: order._id,
    itemId: item._id,
    name: item.name,
    station,
  });

  const allReady = order.items.every((i) => i.prepared);
  if (allReady) {
    io.to(`waiter:${order.assignedWaiter}`).emit("order:ready", {
      orderId: order._id,
      tableNumber: order.tableNumber,
    });
  }

  return res.json({ orderId: order._id, itemId: item._id, prepared: true, allReady });
}

module.exports = { getStationOrders, markItemReady };
