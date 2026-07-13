const Order = require("../models/Order");

/**
 * Generates a random 4-digit PIN (as a string, e.g. "0042") that is not
 * currently in use by any ACTIVE order. Completed orders don't count, so
 * digits get reused freely over time.
 *
 * A handful of retries is more than enough at realistic scale: even with
 * a few hundred simultaneously open orders, collisions against the 10,000
 * possible 4-digit codes are rare, and the unique partial index on Order.pin
 * guarantees correctness even in the unlikely case two requests race.
 */
async function generateUniquePin({ maxAttempts = 15 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    const clash = await Order.exists({ pin: candidate, status: "active" });
    if (!clash) return candidate;
  }
  throw new Error("Could not generate a unique order PIN - too many active orders");
}

module.exports = generateUniquePin;
