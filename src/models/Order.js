const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    table: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Table",
      required: true,
    },
    tableNumber: {
      type: Number,
      required: true,
      index: true,
    },
    items: [
      {
        menuItem: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "MenuItem",
          required: true,
        },
        name: String,
        price: Number,
        quantity: {
          type: Number,
          required: true,
          min: 1,
        },
        category: {
          type: String,
          enum: ["food", "drink"],
          required: true,
        },
      },
    ],
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    pin: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Payment info
    paymentMethod: {
      type: String,
      enum: ["mpesa", "card"],
      required: true,
    },
    phone: {
      type: String,
      sparse: true,
    },
    email: {
      type: String,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Payment",
    },
    // Order status
    assignedWaiter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Waiter",
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "completed", "cancelled"],
      default: "active",
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("Order", orderSchema);
