const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const {
  createOrder,
  getWaiterOrders,
  endOrder,
  updateOrderStatus,
} = require("../controllers/orderController");

router.post("/", asyncHandler(createOrder));
router.get("/waiter/:waiterId", asyncHandler(getWaiterOrders));
router.post("/:orderId/end", asyncHandler(endOrder));
router.patch("/:orderId/status", asyncHandler(updateOrderStatus));

module.exports = router;
