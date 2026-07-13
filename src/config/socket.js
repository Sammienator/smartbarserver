const { Server } = require("socket.io");

let io = null;

/**
 * Rooms used:
 *  - "guests"        → every connected guest app (all tables)
 *  - "admins"        → admin dashboard clients
 *  - `waiter:<id>`   → specific waiter
 *  - `station:kitchen`, `station:bar` → kitchen and bar screens
 */

function initSocket(httpServer, { clientOrigin } = {}) {
  
  const allowedOrigin = clientOrigin 
    ? clientOrigin.trim().replace(/\/$/, "") 
    : "*";

  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigin,
      methods: ["GET", "POST"],
      credentials: true,
    },
    // === Crucial settings for Railway + WebSocket ===
    transports: ["websocket", "polling"],
    pingTimeout: 60000,
    pingInterval: 25000,
    allowUpgrades: true,
    upgradeTimeout: 30000,
  });

  console.log(`[Socket.IO] Initialized with origin → ${allowedOrigin}`);

  io.on("connection", (socket) => {
    console.log(`[socket] client connected: ${socket.id}`);

    socket.on("join:guest", () => socket.join("guests"));
    socket.on("join:admin", () => socket.join("admins"));

    socket.on("join:waiter", (waiterId) => {
      if (waiterId) socket.join(`waiter:${waiterId}`);
    });

    socket.on("leave:waiter", (waiterId) => {
      if (waiterId) socket.leave(`waiter:${waiterId}`);
    });

    socket.on("join:station", (station) => {
      if (station === "kitchen" || station === "bar") {
        socket.join(`station:${station}`);
      }
    });

    socket.on("leave:station", (station) => {
      if (station === "kitchen" || station === "bar") {
        socket.leave(`station:${station}`);
      }
    });

    socket.on("disconnect", () => {
      console.log(`[socket] client disconnected: ${socket.id}`);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error("Socket.io has not been initialized yet");
  return io;
}

module.exports = { initSocket, getIO };