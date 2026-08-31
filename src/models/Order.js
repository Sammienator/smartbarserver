const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem", required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    category: { type: String, enum: ["drink", "food"], required: true },

    // Kitchen/bar prep tracking - independent of the guest's PIN close-out.
    prepared: { type: Boolean, default: false },
    preparedAt: { type: Date, default: null },
  }
);

const orderSchema = new mongoose.Schema(
  {
    table: { type: mongoose.Schema.Types.ObjectId, ref: "Table", required: true },
    tableNumber: { type: Number, required: true },
    items: { type: [orderItemSchema], required: true, validate: (v) => v.length > 0 },
    totalAmount: { type: Number, required: true, min: 0 },

    // 4-digit code the guest hands to the waiter to close the order out.
    // Only revealed to the guest AFTER successful payment.
    pin: { type: String, required: true, match: /^\d{4}$/ },

    assignedWaiter: { type: mongoose.Schema.Types.ObjectId, ref: "Waiter", required: true },

    // pending_payment = created, waiting for Paystack success
    // active        = paid, visible to waiter / stations
    // completed     = waiter closed with PIN
    // cancelled     = payment failed / abandoned (stock rolled back)
    status: {
      type: String,
      enum: ["pending_payment", "active", "completed", "cancelled"],
      default: "pending_payment",
    },

    // Paystack
    paymentReference: { type: String, default: null, index: true },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "paid", "failed"],
      default: "unpaid",
    },
    paidAt: { type: Date, default: null },

    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// PIN uniqueness only while the order is still open (pending or active).
orderSchema.index(
  { pin: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["pending_payment", "active"] } } }
);

orderSchema.index({ assignedWaiter: 1, status: 1 });
orderSchema.index({ createdAt: 1 });
orderSchema.index({ paymentReference: 1 }, { sparse: true });

// Self-healing: fill missing category from MenuItem before validation.
orderSchema.pre("validate", async function (next) {
  const itemsMissingCategory = this.items.filter((item) => !item.category);
  if (itemsMissingCategory.length === 0) return next();

  const MenuItem = mongoose.model("MenuItem");
  for (const item of itemsMissingCategory) {
    const menuItem = await MenuItem.findById(item.menuItem).select("category").lean();
    if (menuItem?.category) item.category = menuItem.category;
  }
  next();
});

module.exports = mongoose.model("Order", orderSchema);
