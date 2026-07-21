const express = require("express");
const router = express.Router();

router.use("/orders", require("./orderRoutes"));
router.use("/menu", require("./menuRoutes"));
router.use("/waiters", require("./waiterRoutes"));
router.use("/tables", require("./tableRoutes"));
router.use("/admin", require("./adminRoutes"));
router.use("/stations", require("./stationRoutes"));
router.use("/upload", require("./uploadRoutes"));

module.exports = router;
