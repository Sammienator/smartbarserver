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
 * Start payment process
 * 
 * Body:
 * {
 *   tableNumber: 5,
 *   items: [
 *     { menuItemId: "123abc", quantity: 2 }
 *   ],
 *   paymentMethod: "mpesa" | "card",
 *   phone: "254712345678",  // Required for M-Pesa
 *   email: "user@example.com", // Required for Card
 *   amount: 2500,
 *   category: "food" | "drink"
 * }
 * 
 * Response (M-Pesa):
 * {
 *   success: true,
 *   paymentId: "...",
 *   message: "Enter your M-Pesa PIN on your phone to complete payment"
 * }
 * 
 * Response (Card):
 * {
 *   success: true,
 *   paymentId: "...",
 *   paymentUrl: "https://checkout.paystack.com/..."
 * }
 */
router.post("/initiate", initiatePayment);

/**
 * POST /api/payments/daraja-callback
 * Daraja calls this when M-Pesa payment status changes
 * 
 * Should be configured in Daraja dashboard:
 * Callback URL: https://yourdomain.com/api/payments/daraja-callback
 */
router.post("/daraja-callback", darajaCallback);

/**
 * GET /api/payments/paystack-callback
 * Paystack redirects here after payment attempt
 * 
 * Query params:
 * - reference: Payment reference ID
 * 
 * Should be configured in Paystack dashboard:
 * Redirect URL: https://yourdomain.com/api/payments/paystack-callback
 */
router.get("/paystack-callback", paystackCallback);

/**
 * GET /api/payments/:paymentId
 * Get payment status (for polling)
 * 
 * Response:
 * {
 *   status: "pending" | "completed" | "failed",
 *   paymentMethod: "mpesa" | "card",
 *   amount: 2500,
 *   orderId: "..." or null,
 *   pin: "1234" or null
 * }
 */
router.get("/:paymentId", getPaymentStatus);

module.exports = router;
