require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");

const connectDB = require("./src/config/db");
const { initSocket } = require("./src/config/socket");
const routes = require("./src/routes");

const app = express();

// Clean client origin
const clientOrigin = (process.env.CLIENT_ORIGIN || "")
  .trim()
  .replace(/\/$/, "");

app.use(cors({ 
  origin: clientOrigin || "*", 
  credentials: true 
}));

app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use("/api", routes);

// Centralized error handler
app.use((err, req, res, next) => {
  console.error("[error]", err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const httpServer = http.createServer(app);

initSocket(httpServer, { clientOrigin });

const PORT = process.env.PORT || 4000;

connectDB().then(() => {
  httpServer.listen(PORT, () => {
    console.log(`[server] Smart Bar backend listening on port ${PORT}`);
    console.log(`[CORS] Allowed origin: ${clientOrigin || "*"}`);
  });
});