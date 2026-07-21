const multer = require("multer");
const cloudinary = require("../config/cloudinary");

// Images are received into memory (never written to local disk) and then
// streamed straight to Cloudinary. This is what makes uploaded photos
// survive redeploys/restarts on hosts with an ephemeral filesystem
// (Render, Heroku, etc.) - previously they were saved under server/uploads,
// which is wiped every time the app restarts on those platforms.
const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (!file.mimetype.startsWith("image/")) {
    return cb(new Error("Only image files are allowed"));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per image
});

// Streams an in-memory image buffer (from req.file.buffer, after
// upload.single("image") has run) up to Cloudinary and resolves to its
// public, permanent secure URL - the same string that used to be built
// locally by the old disk-based fileUrl(req, filename) helper. Controllers
// call this directly and await it: `await uploadToCloudinary(req.file.buffer)`.
function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "smart-bar", resource_type: "image" },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

module.exports = { upload, uploadToCloudinary };
