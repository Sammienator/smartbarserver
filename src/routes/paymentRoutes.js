const express = require("express");
const router = express.Router();
const {
  initiatePayment,
  darajaCallback,
  paystackCallback,
  getPaymentStatus,
} = require("../controllers/paymentController");

/**
 * POST /api/payments/initiate
 */
router.post("/initiate", initiatePayment);

/**
 * POST /api/payments/daraja-callback
 * This is the URL you put in DARAJA_CALLBACK_URL
 * Example: https://your-backend.com/api/payments/daraja-callback
 */
router.post("/daraja-callback", darajaCallback);

/**
 * GET /api/payments/paystack-callback
 */
router.get("/paystack-callback", paystackCallback);

/**
 * GET /api/payments/:paymentId
 * Frontend polls this to know when payment is completed
 */
router.get("/:paymentId", getPaymentStatus);

module.exports = router;
