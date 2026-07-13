const crypto = require("crypto");
const Table = require("../models/Table");

// GET /api/tables
async function listTables(req, res) {
  const tables = await Table.find().sort({ tableNumber: 1 });
  return res.json(tables);
}

// POST /api/tables   (admin) - body: { tableNumber, zone }
// Generates the qrToken automatically; encode this token into the
// physical QR code you print for the table (e.g. as part of a URL like
// https://yourapp.com/order?table=<qrToken>).
async function createTable(req, res) {
  const { tableNumber, zone } = req.body;
  if (!tableNumber) return res.status(400).json({ error: "tableNumber is required" });

  const qrToken = crypto.randomBytes(8).toString("hex");
  const table = await Table.create({ tableNumber, zone: zone || "", qrToken });
  return res.status(201).json(table);
}

module.exports = { listTables, createTable };
