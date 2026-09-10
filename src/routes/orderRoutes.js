const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const {
  createOrder,
  getWaiterOrders,
  updateOrderStatus,
} = require("../controllers/orderController");

// Legacy direct create (no payment) — useful for testing
router.post("/", asyncHandler(createOrder));

// Get orders assigned to a waiter
router.get("/waiter/:waiterId", asyncHandler(getWaiterOrders));

// Update order status (e.g. complete / cancel)
router.patch("/:orderId/status", asyncHandler(updateOrderStatus));

module.exports = router;
