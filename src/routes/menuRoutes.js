const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const {
  listMenuItems,
  createMenuItem,
  updateMenuItem,
  restockItem,
  deleteMenuItem,
} = require("../controllers/menuController");

router.get("/", asyncHandler(listMenuItems));
router.post("/", asyncHandler(createMenuItem));
router.patch("/:id", asyncHandler(updateMenuItem));
router.patch("/:id/restock", asyncHandler(restockItem));
router.delete("/:id", asyncHandler(deleteMenuItem));

module.exports = router;
