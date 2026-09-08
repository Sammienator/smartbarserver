const MenuItem = require("../models/MenuItem");
const Table = require("../models/Table");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const generateUniquePin = require("../utils/generatePin");
const assignWaiter = require("../utils/assignWaiter");
const { getIO } = require("../config/socket");
const { emitStockUpdate } = require("../utils/stockEvents");
const axios = require("axios");

/**
 * POST /api/payments/initiate
 * Initiates payment via Daraja (M-Pesa) or Paystack (Card)
 * Order is NOT created yet - only after payment succeeds
 */
async function initiatePayment(req, res) {
  const { tableNumber, items, paymentMethod, phone, email, amount, category } = req.body;

  if (!tableNumber || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "tableNumber and items array are required" });
  }

  if (!paymentMethod || !["mpesa", "card"].includes(paymentMethod)) {
    return res.status(400).json({ error: "Payment method must be 'mpesa' or 'card'" });
  }

  // M-Pesa requires phone
  if (paymentMethod === "mpesa" && !phone) {
    return res.status(400).json({ error: "Phone number required for M-Pesa" });
  }

  // Card requires email
  if (paymentMethod === "card" && !email) {
    return res.status(400).json({ error: "Email required for card payment" });
  }

  const table = await Table.findOne({ tableNumber, isActive: true });
  if (!table) {
    return res.status(404).json({ error: `No active table found with number ${tableNumber}` });
  }

  try {
    if (paymentMethod === "mpesa") {
      return await initiateDarajaPayment(req, res, {
        tableNumber,
        items,
        phone,
        amount,
        category,
        table,
      });
    } else if (paymentMethod === "card") {
      return await initiatePaystackPayment(req, res, {
        tableNumber,
        items,
        email,
        amount,
        category,
        table,
      });
    }
  } catch (err) {
    console.error("[payment] Error initiating payment:", err);
    return res.status(500).json({ error: "Payment initiation failed" });
  }
}

/**
 * M-Pesa Payment via Daraja API
 * Supports both Till Number and PayBill
 */
async function initiateDarajaPayment(req, res, { tableNumber, items, phone, amount, category, table }) {
  try {
    // Get Daraja credentials from environment
    const consumerKey = process.env.DARAJA_CONSUMER_KEY;
    const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
    const passKey = process.env.DARAJA_PASS_KEY;
    const shortCode = process.env.DARAJA_BUSINESS_CODE || process.env.DARAJA_SHORTCODE;
    const tillNumber = process.env.DARAJA_TILL_NUMBER; // Optional: if present, use till mode
    const callbackUrl = process.env.DARAJA_CALLBACK_URL;

    if (!consumerKey || !consumerSecret || !shortCode) {
      return res.status(500).json({ error: "Daraja credentials not configured" });
    }

    // Step 1: Get Daraja access token
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
    const tokenResponse = await axios.get(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    const accessToken = tokenResponse.data.access_token;

    // Step 2: Create payment record in database (order NOT created yet)
    const reference = `MPESA-${tableNumber}-${Date.now()}`;
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, -3);
    const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString("base64");

    // Format phone number to 254 format
    const formattedPhone = formatPhoneNumber(phone);

    const payment = await Payment.create({
      reference,
      tableNumber,
      phone: formattedPhone,
      amount: Math.floor(amount),
      paymentMethod: "mpesa",
      items,
      category,
      status: "pending",
    });

    // Step 3: Determine transaction type based on till availability
    const usesTillNumber = !!tillNumber;
    const transactionType = usesTillNumber 
      ? "CustomerBuyGoodsOnline" 
      : "CustomerPayBillOnline";
    const partyB = usesTillNumber ? tillNumber : shortCode;

    console.log(
      `[daraja] Initiating ${usesTillNumber ? "Till Number" : "PayBill"} payment:`,
      {
        phone: formattedPhone,
        amount: Math.floor(amount),
        transactionType,
        partyB,
      }
    );

    // Step 4: Initiate STK push to phone
    const darajaResponse = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: transactionType,
        Amount: Math.floor(amount),
        PartyA: formattedPhone,
        PartyB: partyB, // Till number or short code
        PhoneNumber: formattedPhone,
        CallBackURL: callbackUrl,
        AccountReference: `Table-${tableNumber}`,
        TransactionDesc: `Smart Bar - Table ${tableNumber}`,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    console.log("[daraja] STK push initiated for phone:", formattedPhone);

    return res.json({
      success: true,
      paymentId: payment._id,
      message: "Enter your M-Pesa PIN on your phone to complete payment",
      transactionType: usesTillNumber ? "till" : "paybill",
    });
  } catch (err) {
    console.error("[daraja] Error:", err.response?.data || err.message);
    return res.status(500).json({ error: "Failed to initiate M-Pesa payment" });
  }
}

/**
 * Format phone to 254 format
 */
function formatPhoneNumber(phone) {
  let digits = phone.toString().replace(/\D/g, "");
  if (digits.startsWith("0")) {
    digits = "254" + digits.slice(1);
  } else if (digits.length === 9 && digits.startsWith("7")) {
    digits = "254" + digits;
  } else if (!digits.startsWith("254")) {
    digits = "254" + digits;
  }
  return digits;
}

/**
 * Card Payment via Paystack
 */
async function initiatePaystackPayment(req, res, { tableNumber, items, email, amount, category, table }) {
  try {
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    const callbackUrl = process.env.PAYSTACK_CALLBACK_URL;

    if (!paystackKey) {
      return res.status(500).json({ error: "Paystack key not configured" });
    }

    // Step 1: Create payment record (order NOT created yet)
    const reference = `CARD-${tableNumber}-${Date.now()}`;

    const payment = await Payment.create({
      reference,
      tableNumber,
      email,
      amount: Math.floor(amount),
      paymentMethod: "card",
      items,
      category,
      status: "pending",
    });

    // Step 2: Initialize Paystack transaction
    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.floor(amount * 100), // Paystack wants amount in cents
        reference,
        metadata: {
          tableNumber,
          category,
          paymentId: payment._id.toString(),
        },
        callback_url: callbackUrl,
      },
      {
        headers: {
          Authorization: `Bearer ${paystackKey}`,
        },
      }
    );

    console.log("[paystack] Transaction initialized for email:", email);

    // Return payment URL for redirect
    return res.json({
      success: true,
      paymentId: payment._id,
      paymentUrl: paystackResponse.data.data.authorization_url,
    });
  } catch (err) {
    console.error("[paystack] Error:", err.response?.data || err.message);
    return res.status(500).json({ error: "Failed to initiate card payment" });
  }
}

/**
 * Daraja Callback Handler
 * POST /api/payments/daraja-callback
 * Called by Daraja when payment status changes
 */
async function darajaCallback(req, res) {
  const { Body } = req.body;

  try {
    const stkCallback = Body.stkCallback;
    const reference = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;

    console.log("[daraja-callback] Received callback:", { reference, resultCode });

    // Find payment record
    const payment = await Payment.findOne({ reference });
    if (!payment) {
      console.error("[daraja-callback] Payment not found:", reference);
      return res.status(404).json({ error: "Payment record not found" });
    }

    if (resultCode === 0) {
      // ✓ Payment successful
      payment.status = "completed";
      payment.transactionId = stkCallback.MerchantRequestID;
      await payment.save();

      console.log("[daraja] Payment SUCCESSFUL - Creating order now");

      // NOW create the order
      const order = await createOrderAfterPayment(payment);

      if (order) {
        return res.json({ success: true, orderId: order._id, pin: order.pin });
      } else {
        return res.status(500).json({ error: "Order creation failed" });
      }
    } else {
      // ✗ Payment failed
      payment.status = "failed";
      payment.failureReason = stkCallback.ResultDesc;
      await payment.save();

      console.log("[daraja] Payment FAILED:", stkCallback.ResultDesc);
      return res.json({ success: false, error: stkCallback.ResultDesc });
    }
  } catch (err) {
    console.error("[daraja-callback] Error:", err);
    return res.status(500).json({ error: "Callback processing failed" });
  }
}

/**
 * Paystack Callback Handler
 * GET /api/payments/paystack-callback?reference=xxx
 * Called after Paystack redirects user back
 */
async function paystackCallback(req, res) {
  const { reference } = req.query;

  if (!reference) {
    return res.redirect("/payment-failed?error=no_reference");
  }

  try {
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;

    // Step 1: Verify payment with Paystack
    const verifyResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${paystackKey}`,
        },
      }
    );

    const paymentData = verifyResponse.data.data;
    const status = paymentData.status;

    console.log("[paystack-callback] Verified payment:", { reference, status });

    // Step 2: Find payment record
    const payment = await Payment.findOne({ reference });
    if (!payment) {
      console.error("[paystack-callback] Payment not found:", reference);
      return res.redirect("/payment-failed?error=payment_not_found");
    }

    if (status === "success") {
      // ✓ Payment successful
      payment.status = "completed";
      payment.transactionId = paymentData.reference;
      payment.transactionData = paymentData;
      await payment.save();

      console.log("[paystack] Payment SUCCESSFUL - Creating order now");

      // NOW create the order
      const order = await createOrderAfterPayment(payment);

      if (order) {
        // Redirect to success page with order PIN
        return res.redirect(
          `/payment-success?status=success&orderId=${order._id}&pin=${order.pin}`
        );
      } else {
        return res.redirect("/payment-failed?error=order_creation_failed");
      }
    } else {
      // ✗ Payment failed
      payment.status = "failed";
      payment.failureReason = paymentData.gateway_response;
      await payment.save();

      console.log("[paystack] Payment FAILED:", paymentData.gateway_response);
      return res.redirect(`/payment-failed?status=failed&reference=${reference}`);
    }
  } catch (err) {
    console.error("[paystack-callback] Error:", err);
    return res.redirect("/payment-failed?error=verification_failed");
  }
}

/**
 * Create Order After Payment Succeeds
 * This is where the PIN is generated and order is pushed to kitchen/bar
 */
async function createOrderAfterPayment(payment) {
  const { tableNumber, items: paymentItems, category } = payment;

  try {
    const table = await Table.findOne({ tableNumber, isActive: true });
    if (!table) {
      console.error("[order-creation] Table not found:", tableNumber);
      return null;
    }

    // Step 1: Decrement stock for all items
    const decremented = [];
    const orderItems = [];
    let totalAmount = 0;

    for (const { menuItemId, quantity } of paymentItems) {
      const updated = await MenuItem.findOneAndUpdate(
        { _id: menuItemId, stockQty: { $gte: quantity } },
        { $inc: { stockQty: -quantity } },
        { new: true }
      );

      if (!updated) {
        const existing = await MenuItem.findById(menuItemId);
        throw new Error(`Not enough stock for "${existing ? existing.name : menuItemId}"`);
      }

      decremented.push({ menuItemId, quantity });
      orderItems.push({
        menuItem: updated._id,
        name: updated.name,
        price: updated.price,
        quantity,
        category: updated.category,
      });
      totalAmount += updated.price * quantity;
      emitStockUpdate(updated);
    }

    // Step 2: Assign waiter
    const waiter = await assignWaiter({ zone: table.zone });
    if (!waiter) {
      await rollbackStock(decremented);
      console.error("[order-creation] No waiter available");
      return null;
    }

    // Step 3: Generate PIN and create order
    const pin = await generateUniquePin();

    const order = await Order.create({
      table: table._id,
      tableNumber,
      items: orderItems,
      totalAmount,
      pin,
      paymentMethod: payment.paymentMethod,
      phone: payment.phone || null,
      email: payment.email || null,
      paymentId: payment._id,
      assignedWaiter: waiter._id,
      status: "active",
    });

    console.log("[order-creation] ✓ Order created:", { orderId: order._id, pin, tableNumber });

    // Step 4: Update payment with order reference
    payment.orderId = order._id;
    payment.pin = pin;
    await payment.save();

    // Step 5: Notify waiter in real time
    const io = getIO();
    io.to(`waiter:${waiter._id}`).emit("order:new", {
      orderId: order._id,
      tableNumber: order.tableNumber,
      items: order.items,
      totalAmount: order.totalAmount,
      paymentMethod: order.paymentMethod,
      pin: order.pin,
      createdAt: order.createdAt,
    });

    // Step 6: Notify kitchen/bar stations
    notifyStations(order);

    return order;
  } catch (err) {
    console.error("[order-creation] Error:", err.message);
    return null;
  }
}

/**
 * Notify kitchen and/or bar about new order
 */
function notifyStations(order) {
  const io = getIO();
  const CATEGORY_TO_STATION = { food: "kitchen", drink: "bar" };

  for (const station of new Set(Object.values(CATEGORY_TO_STATION))) {
    const category = Object.keys(CATEGORY_TO_STATION).find((c) => CATEGORY_TO_STATION[c] === station);
    const stationItems = order.items.filter((i) => i.category === category);
    if (stationItems.length === 0) continue;

    io.to(`station:${station}`).emit("station:neworder", {
      orderId: order._id,
      tableNumber: order.tableNumber,
      pin: order.pin,
      createdAt: order.createdAt,
      items: stationItems.map((i) => ({
        itemId: i._id,
        name: i.name,
        quantity: i.quantity,
        category: i.category,
      })),
    });
  }
}

async function rollbackStock(items) {
  for (const { menuItemId, quantity } of items) {
    await MenuItem.findByIdAndUpdate(menuItemId, { $inc: { stockQty: quantity } });
  }
}

/**
 * Get payment status
 * GET /api/payments/:paymentId
 */
async function getPaymentStatus(req, res) {
  try {
    const payment = await Payment.findById(req.params.paymentId).populate("orderId");

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    return res.json({
      status: payment.status,
      paymentMethod: payment.paymentMethod,
      amount: payment.amount,
      orderId: payment.orderId?._id || null,
      pin: payment.pin || null,
    });
  } catch (err) {
    return res.status(500).json({ error: "Failed to get payment status" });
  }
}

module.exports = {
  initiatePayment,
  darajaCallback,
  paystackCallback,
  getPaymentStatus,
};
