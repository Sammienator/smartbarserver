const { Server } = require("socket.io");

let io = null;

/**
 * Rooms used:
 *  - "guests"        -> every connected guest app (all tables). Used to
 *                        broadcast live stock updates.
 *  - "admins"         -> admin dashboard clients. Used for low-stock alerts
 *                        and any other live admin metrics.
 *  - `waiter:<id>`    -> one room per waiter, so a new/ended order only
 *                        notifies the specific waiter it concerns.
 *  - `station:kitchen`, `station:bar` -> kitchen and bar prep screens.
 *                        New orders and item-ready updates for that
 *                        station's items are broadcast here.
 */
function initSocket(httpServer, { clientOrigin } = {}) {
  io = new Server(httpServer, {
    cors: {
      origin: clientOrigin || "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`[socket] client connected: ${socket.id}`);

    socket.on("join:guest", () => {
      socket.join("guests");
    });

    socket.on("join:admin", () => {
      socket.join("admins");
    });

    socket.on("join:waiter", (waiterId) => {
      if (!waiterId) return;
      socket.join(`waiter:${waiterId}`);
    });

    socket.on("leave:waiter", (waiterId) => {
      if (!waiterId) return;
      socket.leave(`waiter:${waiterId}`);
    });

    socket.on("join:station", (station) => {
      if (station !== "kitchen" && station !== "bar") return;
      socket.join(`station:${station}`);
    });

    socket.on("leave:station", (station) => {
      if (station !== "kitchen" && station !== "bar") return;
      socket.leave(`station:${station}`);
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
