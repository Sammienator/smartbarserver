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
// GET /api/orders/waiter/:waiterId
// optional query: ?status=active
router.get("/waiter/:waiterId", asyncHandler(getWaiterOrders));

// Update order status
// PATCH /api/orders/:orderId/status  body: { status: "active"|"completed"|"cancelled" }
router.patch("/:orderId/status", asyncHandler(updateOrderStatus));

module.exports = router;
