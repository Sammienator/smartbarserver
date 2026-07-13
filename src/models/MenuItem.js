const mongoose = require("mongoose");

const menuItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ["drink", "food"],
      required: true,
    },
    price: { type: Number, required: true, min: 0 },
    imageUrl: { type: String, default: "" },
    stockQty: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true }
);

// Convenience virtual - true once stock runs out, used by the guest app
// to grey out / disable the "Order" button on an item card.
menuItemSchema.virtual("isAvailable").get(function () {
  return this.stockQty > 0;
});

menuItemSchema.set("toJSON", { virtuals: true });
menuItemSchema.set("toObject", { virtuals: true });

module.exports = mongoose.model("MenuItem", menuItemSchema);
