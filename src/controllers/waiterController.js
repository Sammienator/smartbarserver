const Waiter = require("../models/Waiter");

// GET /api/waiters
async function listWaiters(req, res) {
  const waiters = await Waiter.find().sort({ name: 1 });
  return res.json(waiters);
}

// POST /api/waiters   (admin) - no auth/password, just a name + optional zone/photo
async function createWaiter(req, res) {
  const { name, zone, maxActiveOrders, imageUrl } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });

  const waiter = await Waiter.create({
    name,
    zone: zone || "",
    maxActiveOrders: maxActiveOrders ?? null,
    imageUrl: imageUrl || "",
  });
  return res.status(201).json(waiter);
}

// PATCH /api/waiters/:id   (admin) - edit name/zone/photo
async function updateWaiter(req, res) {
  const { id } = req.params;
  const { name, zone, imageUrl } = req.body;

  const waiter = await Waiter.findByIdAndUpdate(
    id,
    {
      $set: {
        ...(name && { name }),
        ...(zone != null && { zone }),
        ...(imageUrl != null && { imageUrl }),
      },
    },
    { new: true }
  );

  if (!waiter) return res.status(404).json({ error: "Waiter not found" });
  return res.json(waiter);
}

// PATCH /api/waiters/:id/shift   body: { isOnShift: true|false }
async function setShiftStatus(req, res) {
  const { id } = req.params;
  const { isOnShift } = req.body;
  if (typeof isOnShift !== "boolean") {
    return res.status(400).json({ error: "isOnShift must be true or false" });
  }
  const waiter = await Waiter.findByIdAndUpdate(id, { isOnShift }, { new: true });
  if (!waiter) return res.status(404).json({ error: "Waiter not found" });
  return res.json(waiter);
}

module.exports = { listWaiters, createWaiter, updateWaiter, setShiftStatus };
