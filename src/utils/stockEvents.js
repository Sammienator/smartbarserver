const { getIO } = require("../config/socket");

const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD) || 5;

/**
 * Broadcasts a stock change to every guest app (so item cards update live),
 * and separately alerts the admin dashboard if the item has dropped below
 * the configured low-stock threshold.
 */
function emitStockUpdate(menuItem) {
  const io = getIO();

  io.to("guests").emit("stock:update", {
    menuItemId: menuItem._id,
    stockQty: menuItem.stockQty,
    isAvailable: menuItem.stockQty > 0,
  });

  if (menuItem.stockQty < LOW_STOCK_THRESHOLD) {
    io.to("admins").emit("inventory:lowstock", {
      menuItemId: menuItem._id,
      name: menuItem.name,
      stockQty: menuItem.stockQty,
      threshold: LOW_STOCK_THRESHOLD,
    });
  }
}

module.exports = { emitStockUpdate, LOW_STOCK_THRESHOLD };
