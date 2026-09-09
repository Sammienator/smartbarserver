require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");

const connectDB = require("./src/config/db");
const { initSocket } = require("./src/config/socket");
const routes = require("./src/routes");

const app = express();

// ============================================================
// CORS Configuration
// ============================================================
// CLIENT_ORIGIN can be a single URL or a comma-separated list
// Example: "https://smartbarruaka.vercel.app,https://smartbar-staging.vercel.app"
const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser requests (curl, server-to-server, health checks)
  if (allowedOrigins.length === 0) return true; // nothing configured → allow all (dev fallback)
  return allowedOrigins.includes(origin.replace(/\/$/, ""));
}

const corsOptionsDelegate = (req, callback) => {
  const origin = req.header("Origin");
  if (isOriginAllowed(origin)) {
    callback(null, { origin: origin || true, credentials: true });
  } else {
    console.warn(
      `[CORS] Rejected origin: ${origin}. Allowed: ${
        allowedOrigins.join(", ") || "(any - none configured)"
      }`
    );
    callback(null, { origin: false, credentials: true });
  }
};

app.use(cors(corsOptionsDelegate));

// ============================================================
// Body parsing
// ============================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// Health check
// ============================================================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    mode: "production",
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// API Routes
// ============================================================
// All routes are under /api (including payments)
// → /api/payments/initiate
// → /api/payments/daraja-callback
// → /api/payments/:paymentId
app.use("/api", routes);

// ============================================================
// Centralized error handler
// ============================================================
app.use((err, req, res, next) => {
  console.error("[error]", err);

  if (err.name === "MulterError") {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Image is too large (max 5MB)"
        : err.message;
    return res.status(400).json({ error: message });
  }

  res
    .status(err.status || 500)
    .json({ error: err.message || "Internal server error" });
});

// ============================================================
// Start server
// ============================================================
const httpServer = http.createServer(app);

initSocket(httpServer, { clientOrigin: allowedOrigins });

const PORT = process.env.PORT || 8080;

connectDB()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`[server] Smart Bar backend listening on port ${PORT}`);
      console.log(`[server] Mode: PRODUCTION (Daraja live only)`);
      console.log(
        `[CORS] Allowed origins: ${
          allowedOrigins.join(", ") || "* (none configured — allowing all)"
        }`
      );
    });
  })
  .catch((err) => {
    console.error("[server] Failed to connect to MongoDB:", err);
    process.exit(1);
  });
