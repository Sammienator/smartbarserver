const mongoose = require("mongoose");

const tableSchema = new mongoose.Schema(
  {
    tableNumber: { type: Number, required: true, unique: true },
    // Optional grouping (e.g. "patio", "bar", "vip") used to prefer
    // assigning orders to a waiter working the same zone, when possible.
    zone: { type: String, default: "" },
    // The token encoded in the table's physical QR code. Kept separate
    // from tableNumber so codes can be reissued without renumbering tables.
    qrToken: { type: String, required: true, unique: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Table", tableSchema);
