const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const { paystackWebhook, verifyPayment } = require("../controllers/paymentController");

// Webhook is mounted with raw body in server.js — this handler expects Buffer.
router.post("/webhook", asyncHandler(paystackWebhook));

router.get("/verify/:reference", asyncHandler(verifyPayment));

module.exports = router;
