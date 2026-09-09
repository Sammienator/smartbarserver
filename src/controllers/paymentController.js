const MenuItem = require("../models/MenuItem");
const Table = require("../models/Table");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const generateUniquePin = require("../utils/generatePin");
const assignWaiter = require("../utils/assignWaiter");
const { getIO } = require("../config/socket");
const { emitStockUpdate } = require("../utils/stockEvents");
const axios = require("axios");

// ============================================================
// PRODUCTION ONLY – no sandbox logic
// ============================================================
const DARAJA_BASE_URL = "https://api.safaricom.co.ke";

/**
 * POST /api/payments/initiate
 * Body: { tableNumber, items, paymentMethod: "mpesa"|"card", phone?, email?, amount, category }
 */
async function initiatePayment(req, res) {
  const { tableNumber, items, paymentMethod, phone, email, amount, category } = req.body;

  if (!tableNumber || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "tableNumber and items array are required" });
  }

  if (!paymentMethod || !["mpesa", "card"].includes(paymentMethod)) {
    return res.status(400).json({ error: "Payment method must be 'mpesa' or 'card'" });
  }

  if (paymentMethod === "mpesa" && !phone) {
    return res.status(400).json({ error: "Phone number required for M-Pesa" });
  }

  if (paymentMethod === "card" && !email) {
    return res.status(400).json({ error: "Email required for card payment" });
  }

  if (!amount || amount < 1) {
    return res.status(400).json({ error: "Valid amount is required" });
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
    }

    // Card – currently using Paystack
    return await initiatePaystackPayment(req, res, {
      tableNumber,
      items,
      email,
      amount,
      category,
      table,
    });
  } catch (err) {
    console.error("[payment] Error initiating payment:", err);
    return res.status(500).json({ error: "Payment initiation failed" });
  }
}

/**
 * M-Pesa STK Push via Daraja (PRODUCTION)
 * Uses Till Number (CustomerBuyGoodsOnline)
 */
async function initiateDarajaPayment(req, res, { tableNumber, items, phone, amount, category }) {
  try {
    const consumerKey = process.env.DARAJA_CONSUMER_KEY;
    const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
    const passKey = process.env.DARAJA_PASS_KEY;
    const shortCode = process.env.DARAJA_BUSINESS_CODE; // Store Number / Business Shortcode
    const tillNumber = process.env.DARAJA_TILL_NUMBER;   // Till Number
    const callbackUrl = process.env.DARAJA_CALLBACK_URL;

    // Validate required credentials
    const missing = [];
    if (!consumerKey) missing.push("DARAJA_CONSUMER_KEY");
    if (!consumerSecret) missing.push("DARAJA_CONSUMER_SECRET");
    if (!passKey) missing.push("DARAJA_PASS_KEY");
    if (!shortCode) missing.push("DARAJA_BUSINESS_CODE");
    if (!tillNumber) missing.push("DARAJA_TILL_NUMBER");
    if (!callbackUrl) missing.push("DARAJA_CALLBACK_URL");

    if (missing.length > 0) {
      console.error("[daraja] Missing env vars:", missing.join(", "));
      return res.status(500).json({
        error: "Daraja credentials not fully configured",
        missing,
      });
    }

    // ---------- 1. Get Access Token ----------
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");

    console.log(`[daraja] Requesting access token → ${DARAJA_BASE_URL}`);

    const tokenResponse = await axios.get(
      `${DARAJA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: { Authorization: `Basic ${auth}` },
        timeout: 12000,
      }
    );

    const accessToken = tokenResponse.data?.access_token;
    if (!accessToken) {
      console.error("[daraja] Token response:", tokenResponse.data);
      throw new Error("No access token received from Daraja");
    }

    console.log("[daraja] ✓ Access token obtained");

    // ---------- 2. Create pending Payment record ----------
    const reference = `MPESA-${tableNumber}-${Date.now()}`;
    const timestamp = new Date()
      .toISOString()
      .replace(/[^0-9]/g, "")
      .slice(0, 14); // YYYYMMDDHHmmss

    // Password = Base64(Shortcode + Passkey + Timestamp)
    const password = Buffer.from(`${shortCode}${passKey}${timestamp}`).toString("base64");
    const formattedPhone = formatPhoneNumber(phone);

    const payment = await Payment.create({
      reference,
      tableNumber,
      phone: formattedPhone,
      amount: Math.floor(Number(amount)),
      paymentMethod: "mpesa",
      items,
      category,
      status: "pending",
    });

    // ---------- 3. STK Push (Till Number) ----------
    console.log("[daraja] Initiating Till Number STK Push:", {
      phone: formattedPhone,
      amount: Math.floor(Number(amount)),
      BusinessShortCode: shortCode,
      PartyB: tillNumber,
      TransactionType: "CustomerBuyGoodsOnline",
    });

    const stkResponse = await axios.post(
      `${DARAJA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: shortCode,                 // 4346509
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerBuyGoodsOnline",
        Amount: Math.floor(Number(amount)),
        PartyA: formattedPhone,
        PartyB: tillNumber,                           // 3435327
        PhoneNumber: formattedPhone,
        CallBackURL: callbackUrl,
        AccountReference: `Table-${tableNumber}`,
        TransactionDesc: `Smart Bar - Table ${tableNumber}`,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );

    console.log("[daraja] ✓ STK Push accepted:", {
      MerchantRequestID: stkResponse.data.MerchantRequestID,
      CheckoutRequestID: stkResponse.data.CheckoutRequestID,
      ResponseCode: stkResponse.data.ResponseCode,
      ResponseDescription: stkResponse.data.ResponseDescription,
    });

    // Store the IDs so the callback can find this payment
    payment.merchantRequestID = stkResponse.data.MerchantRequestID;
    payment.checkoutRequestID = stkResponse.data.CheckoutRequestID;
    await payment.save();

    return res.json({
      success: true,
      paymentId: payment._id,
      checkoutRequestID: stkResponse.data.CheckoutRequestID,
      message: "Enter your M-Pesa PIN on your phone to complete payment",
      mode: "live",
    });
  } catch (err) {
    const darajaError = err.response?.data;
    console.error("[daraja] Error:", darajaError || err.message);

    // Helpful error messages for common production issues
    let userMessage = "Failed to initiate M-Pesa payment";
    if (darajaError?.errorCode === "404.001.03") {
      userMessage =
        "Invalid Access Token. Check that you are using LIVE Consumer Key/Secret/Passkey and that Lipa Na M-Pesa Online is activated on shortcode 4346509.";
    } else if (darajaError?.errorMessage) {
      userMessage = darajaError.errorMessage;
    }

    return res.status(500).json({
      error: userMessage,
      code: darajaError?.errorCode || null,
      details: darajaError || null,
    });
  }
}

/**
 * Format any Kenyan phone number to 2547XXXXXXXX
 */
function formatPhoneNumber(phone) {
  let digits = String(phone).replace(/\D/g, "");

  if (digits.startsWith("0")) {
    digits = "254" + digits.slice(1);
  } else if (digits.length === 9 && digits.startsWith("7")) {
    digits = "254" + digits;
  } else if (digits.startsWith("+254")) {
    digits = digits.slice(1);
  } else if (!digits.startsWith("254")) {
    digits = "254" + digits;
  }

  return digits;
}

/**
 * Card payments via Paystack (kept for future use)
 */
async function initiatePaystackPayment(req, res, { tableNumber, items, email, amount, category }) {
  try {
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    const callbackUrl = process.env.PAYSTACK_CALLBACK_URL;

    if (!paystackKey) {
      return res.status(500).json({ error: "Paystack key not configured" });
    }

    const reference = `CARD-${tableNumber}-${Date.now()}`;

    const payment = await Payment.create({
      reference,
      tableNumber,
      email,
      amount: Math.floor(Number(amount)),
      paymentMethod: "card",
      items,
      category,
      status: "pending",
    });

    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.floor(Number(amount) * 100), // kobo
        reference,
        metadata: {
          tableNumber,
          category,
          paymentId: payment._id.toString(),
        },
        callback_url: callbackUrl,
      },
      {
        headers: { Authorization: `Bearer ${paystackKey}` },
        timeout: 12000,
      }
    );

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
 * POST /api/payments/daraja-callback
 * Safaricom calls this after the customer enters PIN
 */
async function darajaCallback(req, res) {
  // Always acknowledge quickly so Daraja does not retry excessively
  res.status(200).json({ ResultCode: 0, ResultDesc: "Accepted" });

  try {
    const body = req.body?.Body || req.body;
    const stkCallback = body?.stkCallback;

    if (!stkCallback) {
      console.error("[daraja-callback] Invalid payload:", JSON.stringify(req.body));
      return;
    }

    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = stkCallback;

    console.log("[daraja-callback] Received:", {
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
    });

    // Find payment by CheckoutRequestID (most reliable) or fallback
    let payment = await Payment.findOne({ checkoutRequestID: CheckoutRequestID });

    if (!payment) {
      payment = await Payment.findOne({ merchantRequestID: MerchantRequestID });
    }

    if (!payment) {
      console.error("[daraja-callback] Payment not found for:", {
        CheckoutRequestID,
        MerchantRequestID,
      });
      return;
    }

    // Already processed?
    if (payment.status !== "pending") {
      console.log("[daraja-callback] Payment already processed:", payment.status);
      return;
    }

    if (ResultCode === 0) {
      // ---------- SUCCESS ----------
      const meta = {};
      if (CallbackMetadata?.Item) {
        for (const item of CallbackMetadata.Item) {
          meta[item.Name] = item.Value;
        }
      }

      payment.status = "completed";
      payment.transactionId = meta.MpesaReceiptNumber || MerchantRequestID;
      payment.mpesaReceiptNumber = meta.MpesaReceiptNumber || null;
      payment.transactionData = {
        amount: meta.Amount,
        mpesaReceiptNumber: meta.MpesaReceiptNumber,
        transactionDate: meta.TransactionDate,
        phoneNumber: meta.PhoneNumber,
        raw: stkCallback,
      };
      await payment.save();

      console.log("[daraja] ✓ Payment SUCCESSFUL – creating order");

      const order = await createOrderAfterPayment(payment);
      if (!order) {
        console.error("[daraja] Order creation failed after successful payment");
      }
    } else {
      // ---------- FAILED / CANCELLED ----------
      payment.status = "failed";
      payment.failureReason = ResultDesc || `ResultCode ${ResultCode}`;
      payment.transactionData = stkCallback;
      await payment.save();

      console.log("[daraja] Payment FAILED:", ResultDesc);
    }
  } catch (err) {
    console.error("[daraja-callback] Unexpected error:", err);
  }
}

/**
 * GET /api/payments/paystack-callback
 */
async function paystackCallback(req, res) {
  const { reference } = req.query;

  if (!reference) {
    return res.redirect("/payment-failed?error=no_reference");
  }

  try {
    const paystackKey = process.env.PAYSTACK_SECRET_KEY;

    const verifyResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${paystackKey}` },
        timeout: 12000,
      }
    );

    const paymentData = verifyResponse.data.data;
    const status = paymentData.status;

    const payment = await Payment.findOne({ reference });
    if (!payment) {
      return res.redirect("/payment-failed?error=payment_not_found");
    }

    if (status === "success") {
      payment.status = "completed";
      payment.transactionId = paymentData.reference;
      payment.transactionData = paymentData;
      await payment.save();

      const order = await createOrderAfterPayment(payment);
      if (order) {
        return res.redirect(
          `/payment-success?status=success&orderId=${order._id}&pin=${order.pin}`
        );
      }
      return res.redirect("/payment-failed?error=order_creation_failed");
    }

    payment.status = "failed";
    payment.failureReason = paymentData.gateway_response;
    await payment.save();
    return res.redirect(`/payment-failed?status=failed&reference=${reference}`);
  } catch (err) {
    console.error("[paystack-callback] Error:", err);
    return res.redirect("/payment-failed?error=verification_failed");
  }
}

/**
 * Create the actual Order only after payment succeeds
 */
async function createOrderAfterPayment(payment) {
  const { tableNumber, items: paymentItems, category } = payment;

  try {
    const table = await Table.findOne({ tableNumber, isActive: true });
    if (!table) {
      console.error("[order-creation] Table not found:", tableNumber);
      return null;
    }

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
        throw new Error(
          `Not enough stock for "${existing ? existing.name : menuItemId}"`
        );
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

    const waiter = await assignWaiter({ zone: table.zone });
    if (!waiter) {
      await rollbackStock(decremented);
      console.error("[order-creation] No waiter available");
      return null;
    }

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

    console.log("[order-creation] ✓ Order created:", {
      orderId: order._id,
      pin,
      tableNumber,
    });

    payment.orderId = order._id;
    payment.pin = pin;
    await payment.save();

    // Real-time notifications
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

    notifyStations(order);

    return order;
  } catch (err) {
    console.error("[order-creation] Error:", err.message);
    return null;
  }
}

function notifyStations(order) {
  const io = getIO();
  const CATEGORY_TO_STATION = { food: "kitchen", drink: "bar" };

  for (const station of new Set(Object.values(CATEGORY_TO_STATION))) {
    const category = Object.keys(CATEGORY_TO_STATION).find(
      (c) => CATEGORY_TO_STATION[c] === station
    );
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
    await MenuItem.findByIdAndUpdate(menuItemId, {
      $inc: { stockQty: quantity },
    });
  }
}

/**
 * GET /api/payments/:paymentId
 * Used by frontend to poll payment status
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
      mpesaReceiptNumber: payment.mpesaReceiptNumber || null,
      failureReason: payment.failureReason || null,
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
