const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
  {
    menuItem: { type: mongoose.Schema.Types.ObjectId, ref: "MenuItem", required: true },
    name: { type: String, required: true }, // snapshot, in case the menu item is edited later
    price: { type: Number, required: true }, // snapshot of price at order time
    quantity: { type: Number, required: true, min: 1 },
    category: { type: String, enum: ["drink", "food"], required: true }, // snapshot, used to route to kitchen/bar

    // Kitchen/bar prep tracking - independent of the guest's PIN close-out.
    // A head chef or bartender flips this once their item is ready, with
    // no PIN involved at all.
    prepared: { type: Boolean, default: false },
    preparedAt: { type: Date, default: null },
  }
  // Note: subdocuments keep their default auto-generated _id (needed so
  // kitchen/bar staff can mark a specific item ready).
);

const orderSchema = new mongoose.Schema(
  {
    table: { type: mongoose.Schema.Types.ObjectId, ref: "Table", required: true },
    tableNumber: { type: Number, required: true }, // denormalized for fast display
    items: { type: [orderItemSchema], required: true, validate: (v) => v.length > 0 },
    totalAmount: { type: Number, required: true, min: 0 },

    // 4-digit code the guest hands to the waiter to close the order out.
    // Uniqueness is enforced only while an order is "active" - see the
    // partial index below - so digits can be safely reused once an order
    // completes.
    pin: { type: String, required: true, match: /^\d{4}$/ },

    assignedWaiter: { type: mongoose.Schema.Types.ObjectId, ref: "Waiter", required: true },

    status: {
      type: String,
      enum: ["active", "completed"],
      default: "active",
    },

    completedAt: { type: Date, default: null },
  },
  { timestamps: true } // createdAt = order placed time, used for delivery-time reporting
);

// Enforce PIN uniqueness only among currently active orders.
orderSchema.index(
  { pin: 1 },
  { unique: true, partialFilterExpression: { status: "active" } }
);

orderSchema.index({ assignedWaiter: 1, status: 1 });
orderSchema.index({ createdAt: 1 });

// Self-healing safety net: if any item on this order is missing its
// category (e.g. an order placed before the `category` field existed on
// order items), look it up from the referenced MenuItem and fill it in
// before validation runs, rather than failing with a confusing
// "category is required" error on an unrelated save (ending the order,
// marking an item ready, etc). If the referenced menu item has since been
// deleted or also has no category, validation still fails - but with a
// much smaller, genuinely-broken-data blast radius than before.
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
