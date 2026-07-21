require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");

const connectDB = require("./src/config/db");
const { initSocket } = require("./src/config/socket");
const routes = require("./src/routes");

const app = express();

// CLIENT_ORIGIN can be a single URL or a comma-separated list, e.g.
// "https://smartbarruaka.vercel.app,https://smartbar-staging.vercel.app"
// Trailing slashes are stripped so a stray "/" in the env var doesn't
// break an otherwise-correct match.
const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser requests (curl, server-to-server, health checks)
  if (allowedOrigins.length === 0) return true; // nothing configured -> allow all (dev fallback)
  return allowedOrigins.includes(origin.replace(/\/$/, ""));
}

const corsOptionsDelegate = (req, callback) => {
  const origin = req.header("Origin");
  if (isOriginAllowed(origin)) {
    callback(null, { origin: origin || true, credentials: true });
  } else {
    console.warn(`[CORS] Rejected origin: ${origin}. Allowed: ${allowedOrigins.join(", ") || "(any - none configured)"}`);
    callback(null, { origin: false, credentials: true });
  }
};

app.use(cors(corsOptionsDelegate));

app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api", routes);

// Centralized error handler
app.use((err, req, res, next) => {
  console.error("[error]", err);
  // Multer errors (bad field name, file too large, etc.) come through here
  // too - give them a clearer message than a raw stack trace.
  if (err.name === "MulterError") {
    const message =
      err.code === "LIMIT_FILE_SIZE"
        ? "Image is too large (max 5MB)"
        : err.message;
    return res.status(400).json({ error: message });
  }
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const httpServer = http.createServer(app);

initSocket(httpServer, { clientOrigin: allowedOrigins });

const PORT = process.env.PORT || 4000;

connectDB().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`[server] Smart Bar backend listening on port ${PORT}`);
    console.log(`[CORS] Allowed origins: ${allowedOrigins.join(", ") || "* (none configured — allowing all)"}`);
  });
});