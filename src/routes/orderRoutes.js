const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const {
  createOrder,
  createPaidOrder,
  endOrder,
  getActiveOrdersForWaiter,
} = require("../controllers/orderController");

// Payment-first entry point (preferred)
router.post("/pay", asyncHandler(createPaidOrder));

// Legacy direct create (no payment) — useful for testing
router.post("/", asyncHandler(createOrder));

router.post("/:orderId/end", asyncHandler(endOrder));
router.get("/waiter/:waiterId", asyncHandler(getActiveOrdersForWaiter));

module.exports = router;
