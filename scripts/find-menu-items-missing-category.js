// One-off maintenance script: finds any menu items in the database that
// don't have a category set (the likely cause of the
// "items.N.category: Path `category` is required" error when placing an
// order - it means one of the items in the cart references a menu item
// like this).
//
// Usage:
//   node scripts/find-menu-items-missing-category.js
//
// Requires the same MONGO_URI as the main app (reads from .env).

require("dotenv").config();
const mongoose = require("mongoose");
const MenuItem = require("../src/models/MenuItem");

async function main() {
  const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/smart_bar";
  await mongoose.connect(uri);

  // Bypass the app-level required validator with a raw query, since that's
  // exactly the documents we're hunting for.
  const broken = await MenuItem.find({
    $or: [{ category: { $exists: false } }, { category: null }, { category: "" }],
  }).lean();

  if (broken.length === 0) {
    console.log("No menu items are missing a category. The database looks fine.");
  } else {
    console.log(`Found ${broken.length} menu item(s) missing a category:\n`);
    for (const item of broken) {
      console.log(`- ${item.name}  (_id: ${item._id})`);
      console.log(
        `  Fix with: curl -X PATCH http://localhost:${process.env.PORT || 4000}/api/menu/${item._id} ` +
          `-H "Content-Type: application/json" -d '{"category":"food"}'   (or "drink")\n`
      );
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
