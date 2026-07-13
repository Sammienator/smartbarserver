const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const {
  deliveryTimes,
  bestSellers,
  lowStock,
  activeOrders,
  orderHistory,
  salesSummary,
  salesBreakdown,
} = require("../controllers/adminController");

router.get("/delivery-times", asyncHandler(deliveryTimes));
router.get("/best-sellers", asyncHandler(bestSellers));
router.get("/low-stock", asyncHandler(lowStock));
router.get("/orders/active", asyncHandler(activeOrders));
router.get("/orders/history", asyncHandler(orderHistory));
router.get("/sales/summary", asyncHandler(salesSummary));
router.get("/sales", asyncHandler(salesBreakdown));

module.exports = router;
