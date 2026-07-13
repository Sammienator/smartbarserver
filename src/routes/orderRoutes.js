const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const { createOrder, endOrder, getActiveOrdersForWaiter } = require("../controllers/orderController");

router.post("/", asyncHandler(createOrder));
router.post("/:orderId/end", asyncHandler(endOrder));
router.get("/waiter/:waiterId", asyncHandler(getActiveOrdersForWaiter));

module.exports = router;
