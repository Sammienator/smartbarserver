const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const { getStationOrders, markItemReady } = require("../controllers/stationController");

// :station is "kitchen" or "bar" - both handled by the same generic logic.
router.get("/:station/orders", asyncHandler(getStationOrders));
router.post("/:station/orders/:orderId/items/:itemId/ready", asyncHandler(markItemReady));

module.exports = router;
