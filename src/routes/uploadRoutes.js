const express = require("express");
const router = express.Router();
const asyncHandler = require("../utils/asyncHandler");
const { upload, uploadToCloudinary } = require("../middleware/upload");

// POST /api/upload   multipart/form-data, field name "image"
// Used by the admin app before creating/editing a menu item or a waiter:
// the browser uploads the file here first, gets back a permanent Cloudinary
// URL, then sends that URL as part of the normal JSON create/update request
// (e.g. POST /api/menu with { ...fields, imageUrl }). Keeps the rest of the
// API working with plain JSON instead of multipart everywhere.
router.post(
  "/",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided (field name must be 'image')" });
    }
    const url = await uploadToCloudinary(req.file.buffer);
    return res.status(201).json({ url });
  })
);

module.exports = router;
