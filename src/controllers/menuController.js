const MenuItem = require("../models/MenuItem");
const { emitStockUpdate } = require("../utils/stockEvents");
const { getIO } = require("../config/socket");

// GET /api/menu
async function listMenuItems(req, res) {
  const items = await MenuItem.find().sort({ category: 1, name: 1 });
  return res.json(items);
}

// POST /api/menu   (admin)
async function createMenuItem(req, res) {
  const { name, category, price, imageUrl, stockQty, description } = req.body;
  if (!name || !category || price == null) {
    return res.status(400).json({ error: "name, category, and price are required" });
  }
  const item = await MenuItem.create({
    name,
    category,
    price,
    imageUrl: imageUrl || "",
    stockQty: stockQty ?? 0,
    description: description || "",
  });
  return res.status(201).json(item);
}

// PATCH /api/menu/:id   (admin) - edit name/price/image/category/description
async function updateMenuItem(req, res) {
  const { id } = req.params;
  const { name, category, price, imageUrl, description } = req.body;

  const item = await MenuItem.findByIdAndUpdate(
    id,
    {
      $set: {
        ...(name && { name }),
        ...(category && { category }),
        ...(price != null && { price }),
        ...(imageUrl != null && { imageUrl }),
        ...(description != null && { description }),
      },
    },
    { new: true }
  );

  if (!item) return res.status(404).json({ error: "Menu item not found" });
  return res.json(item);
}

// PATCH /api/menu/:id/restock   (admin) - add stock, e.g. after a delivery
async function restockItem(req, res) {
  const { id } = req.params;
  const { addQty } = req.body;

  if (!addQty || addQty <= 0) {
    return res.status(400).json({ error: "addQty must be a positive number" });
  }

  const item = await MenuItem.findByIdAndUpdate(id, { $inc: { stockQty: addQty } }, { new: true });
  if (!item) return res.status(404).json({ error: "Menu item not found" });

  emitStockUpdate(item);
  return res.json(item);
}

// DELETE /api/menu/:id   (admin) - remove an item no longer being sold.
// Safe to do even with existing orders: each order snapshots the item's
// name/price/category at the time it was placed, so past and in-progress
// orders are unaffected by the menu item being removed afterwards.
async function deleteMenuItem(req, res) {
  const { id } = req.params;
  const item = await MenuItem.findByIdAndDelete(id);
  if (!item) return res.status(404).json({ error: "Menu item not found" });

  getIO().to("guests").emit("menu:removed", { menuItemId: item._id });

  return res.json({ deleted: true, id: item._id });
}

module.exports = { listMenuItems, createMenuItem, updateMenuItem, restockItem, deleteMenuItem };
