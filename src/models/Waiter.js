const mongoose = require("mongoose");

const waiterSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // No authentication/login is used for waiters (per current requirements).
    // A waiter's device simply operates as this identity - selected once at
    // the start of a shift, with no password involved.
    zone: { type: String, default: "" },
    isOnShift: { type: Boolean, default: true },
    // Assumption (open item in the planning doc): waiters CAN hold more than
    // one active order at a time. Assignment balances load across whoever is
    // on shift by giving new orders to the waiter with the fewest active
    // orders right now. Set maxActiveOrders to 1 later if you'd rather limit
    // each waiter to a single order at a time.
    maxActiveOrders: { type: Number, default: null }, // null = unlimited
  },
  { timestamps: true }
);

module.exports = mongoose.model("Waiter", waiterSchema);
