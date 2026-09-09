const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    reference: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Daraja identifiers (needed for reliable callback matching)
    checkoutRequestID: {
      type: String,
      sparse: true,
      index: true,
    },
    merchantRequestID: {
      type: String,
      sparse: true,
    },

    tableNumber: {
      type: Number,
      required: true,
    },

    paymentMethod: {
      type: String,
      enum: ["mpesa", "card"],
      required: true,
    },

    // M-Pesa
    phone: {
      type: String,
      sparse: true,
    },

    // Card
    email: {
      type: String,
      sparse: true,
      lowercase: true,
      trim: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "pending",
      index: true,
    },

    items: [
      {
        menuItemId: mongoose.Schema.Types.ObjectId,
        quantity: Number,
      },
    ],

    category: {
      type: String,
      enum: ["food", "drink"],
    },

    // Provider transaction IDs
    transactionId: String,
    mpesaReceiptNumber: String,

    // Full raw response from provider (useful for debugging)
    transactionData: mongoose.Schema.Types.Mixed,

    failureReason: String,

    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      sparse: true,
    },

    pin: {
      type: String,
      sparse: true,
    },
  },
  {
    timestamps: true,
  }
);

// Helpful compound index for lookups
paymentSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("Payment", paymentSchema);
