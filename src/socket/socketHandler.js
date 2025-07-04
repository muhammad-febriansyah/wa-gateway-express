const { Server } = require("socket.io");
const {
  getQRCodeImageData,
  setSocketIoClient,
  isWhatsAppConnected,
} = require("../whatsapp/whatsappInstance");

const updateQRStatus = (type, message = "") => {
  const socketIoClient =
    require("../whatsapp/whatsappInstance").getSocketIoClient();

  if (!socketIoClient) {
    console.warn("Socket.IO client not connected, cannot send QR status.");
    return;
  }

  const qrCodeImageData = getQRCodeImageData();

  switch (type) {
    case "qr":
      socketIoClient.emit("qr", qrCodeImageData);
      socketIoClient.emit("log", message || "QR Code received, please scan!");
      break;
    case "connected":
      socketIoClient.emit("qrstatus", "./assets/check.svg");
      socketIoClient.emit("log", message || "✅ WhatsApp connected!");
      break;
    case "qrscanned":
      socketIoClient.emit("qrstatus", "./assets/check.svg");
      socketIoClient.emit("log", message || "QR Code has been scanned!");
      break;
    case "loading":
      socketIoClient.emit("qrstatus", "./assets/loader.gif");
      socketIoClient.emit(
        "log",
        message || "Registering QR Code, please wait!"
      );
      break;
    case "disconnected":
      socketIoClient.emit("qrstatus", "./assets/disconnected.svg");
      socketIoClient.emit(
        "log",
        message || "WhatsApp disconnected. Reconnecting..."
      );
      break;
    default:
      break;
  }
};

const initializeSocket = (server) => {
  const io = new Server(server);

  io.on("connection", async (socket) => {
    setSocketIoClient(socket);
    console.log("A client connected to Socket.IO.");

    if (isWhatsAppConnected()) {
      updateQRStatus("connected");
    } else if (getQRCodeImageData()) {
      updateQRStatus("qr", "QR Code ready. Scan to connect.");
    } else {
      updateQRStatus("loading", "Initializing WhatsApp connection...");
    }

    socket.on("disconnect", () => {
      console.log("Client disconnected from Socket.IO.");
      setSocketIoClient(null);
    });
  });

  return io;
};

module.exports = {
  initializeSocket,
  updateQRStatus,
};
