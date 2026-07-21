const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGO_URI ;

  try {
    await mongoose.connect(uri);
    console.log(`[db] Connected to MongoDB at ${uri}`);
  } catch (err) {
    console.error("[db] MongoDB connection failed:", err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
