const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    reference: {
      type: String,
      required: true,
      unique: true,
      index: true,
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
    // M-Pesa: phone number
    phone: {
      type: String,
      sparse: true,
    },
    // Card: email address
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
    // Items ordered (stored for reference)
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
    // Transaction ID from payment provider
    transactionId: String,
    
    // Full transaction data from provider
    transactionData: mongoose.Schema.Types.Mixed,
    
    // Reason for failure if applicable
    failureReason: String,
    
    // Order created from this payment
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      sparse: true,
    },
    
    // PIN generated for this order
    pin: {
      type: String,
      sparse: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Payment", paymentSchema);
