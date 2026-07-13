const Waiter = require("../models/Waiter");
const Order = require("../models/Order");

/**
 * Picks a waiter to assign a new order to.
 *
 * Strategy: among waiters currently on shift, pick the one with the fewest
 * active (unclosed) orders right now - a simple load-balance. Waiters who
 * already have maxActiveOrders open are skipped entirely.
 *
 * Returns the chosen Waiter document, or null if nobody is available
 * (caller should decide how to handle that - e.g. queue the order, or
 * surface a "no waiters available" error to the guest app).
 */
async function assignWaiter({ zone } = {}) {
  const onShiftWaiters = await Waiter.find({ isOnShift: true }).lean();
  if (onShiftWaiters.length === 0) return null;

  const activeCounts = await Order.aggregate([
    { $match: { status: "active" } },
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

  // Prefer waiters in the requested zone, if one was given and any match.
  const zoneMatches = zone ? candidates.filter((c) => c.waiter.zone === zone) : [];
  const pool = zoneMatches.length > 0 ? zoneMatches : candidates;

  pool.sort((a, b) => a.activeCount - b.activeCount);
  return pool[0].waiter;
}

module.exports = assignWaiter;
