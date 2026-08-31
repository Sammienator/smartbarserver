const Waiter = require("../models/Waiter");
const Order = require("../models/Order");

/**
 * Picks a waiter to assign a new order to.
 *
 * Strategy: among waiters currently on shift, pick the one with the fewest
 * open orders (pending_payment + active) right now - a simple load-balance.
 * Waiters who already have maxActiveOrders open are skipped entirely.
 */
async function assignWaiter({ zone } = {}) {
  const onShiftWaiters = await Waiter.find({ isOnShift: true }).lean();
  if (onShiftWaiters.length === 0) return null;

  const activeCounts = await Order.aggregate([
    { $match: { status: { $in: ["pending_payment", "active"] } } },
    { $group: { _id: "$assignedWaiter", count: { $sum: 1 } } },
  ]);
  const countsByWaiterId = new Map(activeCounts.map((c) => [String(c._id), c.count]));

  const candidates = onShiftWaiters
    .map((w) => ({
      waiter: w,
      activeCount: countsByWaiterId.get(String(w._id)) || 0,
    }))
    .filter((c) => c.waiter.maxActiveOrders == null || c.activeCount < c.waiter.maxActiveOrders);

  if (candidates.length === 0) return null;

  const zoneMatches = zone ? candidates.filter((c) => c.waiter.zone === zone) : [];
  const pool = zoneMatches.length > 0 ? zoneMatches : candidates;

  pool.sort((a, b) => a.activeCount - b.activeCount);
  return pool[0].waiter;
}

module.exports = assignWaiter;
