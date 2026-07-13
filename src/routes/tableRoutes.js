const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const { listTables, createTable } = require("../controllers/tableController");

router.get("/", asyncHandler(listTables));
router.post("/", asyncHandler(createTable));

module.exports = router;
