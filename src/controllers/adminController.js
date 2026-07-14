const mongoose = require("mongoose");
const Order = require("../models/Order");
const MenuItem = require("../models/MenuItem");
const { LOW_STOCK_THRESHOLD } = require("../utils/stockEvents");

function parseDateRange(req) {
  const { start, end } = req.query;
  const match = { status: "completed" };
  if (start || end) {
    match.createdAt = {};
    if (start) match.createdAt.$gte = new Date(start);
    if (end) match.createdAt.$lte = new Date(end);
  }
  return match;
}

// GET /api/admin/delivery-times?start=&end=
// Average time (in seconds) between order creation and waiter sign-off,
// grouped by waiter.
async function deliveryTimes(req, res) {
  const match = parseDateRange(req);

  const results = await Order.aggregate([
    { $match: match },
    {
      $project: {
        assignedWaiter: 1,
        seconds: { $divide: [{ $subtract: ["$completedAt", "$createdAt"] }, 1000] },
      },
    },
    {
      $group: {
        _id: "$assignedWaiter",
        avgSeconds: { $avg: "$seconds" },
        orderCount: { $sum: 1 },
      },
    },
    {
      $lookup: {
        from: "waiters",
        localField: "_id",
        foreignField: "_id",
        as: "waiter",
      },
    },
    { $unwind: "$waiter" },
    {
      $project: {
        _id: 0,
        waiterId: "$_id",
        waiterName: "$waiter.name",
        avgSeconds: { $round: ["$avgSeconds", 1] },
        orderCount: 1,
      },
    },
    { $sort: { avgSeconds: 1 } },
  ]);

  return res.json(results);
}

// GET /api/admin/best-sellers?start=&end=&limit=10
async function bestSellers(req, res) {
  const match = parseDateRange(req);
  const limit = Number(req.query.limit) || 10;

  const results = await Order.aggregate([
    { $match: match },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.menuItem",
        name: { $first: "$items.name" },
        totalQuantitySold: { $sum: "$items.quantity" },
        totalRevenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
      },
    },
    { $sort: { totalQuantitySold: -1 } },
    { $limit: limit },
  ]);

  return res.json(results);
}

// GET /api/admin/low-stock
async function lowStock(req, res) {
  const items = await MenuItem.find({ stockQty: { $lt: LOW_STOCK_THRESHOLD } }).sort({ stockQty: 1 });
  return res.json({ threshold: LOW_STOCK_THRESHOLD, items });
}

// GET /api/admin/orders/active
// Every currently open order, PIN included. This is the "forgot my PIN"
// lookup screen for admins/managers - the only place in the system the
// PIN is visible outside of the guest who placed the order.
async function activeOrders(req, res) {
  const orders = await Order.find({ status: "active" })
    .populate("assignedWaiter", "name")
    .sort({ createdAt: 1 });

  const result = orders.map((o) => ({
    orderId: o._id,
    tableNumber: o.tableNumber,
    pin: o.pin,
    items: o.items,
    totalAmount: o.totalAmount,
    waiterName: o.assignedWaiter?.name || "Unassigned",
    createdAt: o.createdAt,
  }));

  return res.json(result);
}

// GET /api/admin/orders/history?start=&end=&limit=100
// Every completed order, most recent first - a permanent record for
// future reference, with the placed time, the completed time, and now
// also when the kitchen and bar sides each finished prepping their items
// (the later of each item's preparedAt within that category), so prep
// speed on both sides can be monitored from the same view.
async function orderHistory(req, res) {
  const match = { status: "completed" };
  const { start, end } = req.query;
  if (start || end) {
    match.completedAt = {};
    if (start) match.completedAt.$gte = new Date(start);
    if (end) match.completedAt.$lte = new Date(end);
  }
  const limit = Number(req.query.limit) || 200;

  const orders = await Order.find(match)
    .populate("assignedWaiter", "name")
    .sort({ completedAt: -1 })
    .limit(limit);

  function latestPreparedAt(items) {
    const times = items.filter((i) => i.preparedAt).map((i) => new Date(i.preparedAt).getTime());
    if (times.length === 0 || times.length < items.length) return null; // not all prepped (or none)
    return new Date(Math.max(...times));
  }

  const result = orders.map((o) => {
    const foodItems = o.items.filter((i) => i.category === "food");
    const drinkItems = o.items.filter((i) => i.category === "drink");

    return {
      orderId: o._id,
      tableNumber: o.tableNumber,
      items: o.items.map((i) => ({
        name: i.name,
        price: i.price,
        quantity: i.quantity,
        category: i.category,
        prepared: i.prepared,
        preparedAt: i.preparedAt,
      })),
      totalAmount: o.totalAmount,
      waiterName: o.assignedWaiter?.name || "Unassigned",
      placedAt: o.createdAt,
      kitchenReadyAt: foodItems.length > 0 ? latestPreparedAt(foodItems) : null,
      barReadyAt: drinkItems.length > 0 ? latestPreparedAt(drinkItems) : null,
      completedAt: o.completedAt,
    };
  });

  return res.json(result);
}

// GET /api/admin/sales/summary
// Quick revenue + order-count totals for today, this (ISO) week, and this
// calendar month - the three numbers a "Sales" button most likely wants
// front and center.
async function salesSummary(req, res) {
  const now = new Date();

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const startOfWeek = new Date(startOfDay);
  const isoDayOfWeek = (startOfDay.getDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  startOfWeek.setDate(startOfDay.getDate() - isoDayOfWeek);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  async function totalsSince(since) {
    const [row] = await Order.aggregate([
      { $match: { status: "completed", completedAt: { $gte: since } } },
      { $group: { _id: null, revenue: { $sum: "$totalAmount" }, orderCount: { $sum: 1 } } },
    ]);
    return { revenue: row?.revenue || 0, orderCount: row?.orderCount || 0 };
  }

  const [today, thisWeek, thisMonth] = await Promise.all([
    totalsSince(startOfDay),
    totalsSince(startOfWeek),
    totalsSince(startOfMonth),
  ]);

  return res.json({ today, thisWeek, thisMonth });
}

// GET /api/admin/sales?period=day|week|month&start=&end=
// A revenue + order-count breakdown grouped by day, ISO week, or month,
// for whatever range is given (defaults to everything on record).
async function salesBreakdown(req, res) {
  const period = ["day", "week", "month"].includes(req.query.period) ? req.query.period : "day";
  const { start, end } = req.query;
  const match = { status: "completed" };
  if (start || end) {
    match.completedAt = {};
    if (start) match.completedAt.$gte = new Date(start);
    if (end) match.completedAt.$lte = new Date(end);
  }

  let groupId;
  if (period === "day") {
    groupId = { $dateToString: { format: "%Y-%m-%d", date: "$completedAt" } };
  } else if (period === "week") {
    groupId = {
      isoYear: { $isoWeekYear: "$completedAt" },
      isoWeek: { $isoWeek: "$completedAt" },
    };
  } else {
    groupId = { $dateToString: { format: "%Y-%m", date: "$completedAt" } };
  }

  const rows = await Order.aggregate([
    { $match: match },
    { $group: { _id: groupId, revenue: { $sum: "$totalAmount" }, orderCount: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  const result = rows.map((r) => ({
    period:
      typeof r._id === "string" ? r._id : `${r._id.isoYear}-W${String(r._id.isoWeek).padStart(2, "0")}`,
    revenue: r.revenue,
    orderCount: r.orderCount,
  }));

  return res.json(result);
}

module.exports = {
  deliveryTimes,
  bestSellers,
  lowStock,
  activeOrders,
  orderHistory,
  salesSummary,
  salesBreakdown,
};
