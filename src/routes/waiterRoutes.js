const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const { listWaiters, createWaiter, updateWaiter, setShiftStatus } = require("../controllers/waiterController");

router.get("/", asyncHandler(listWaiters));
router.post("/", asyncHandler(createWaiter));
router.patch("/:id", asyncHandler(updateWaiter));
router.patch("/:id/shift", asyncHandler(setShiftStatus));

module.exports = router;
