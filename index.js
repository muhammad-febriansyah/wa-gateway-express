const express = require("express");
const http = require("http");
const cors = require("cors");
const bodyParser = require("body-parser");
const expressFileUpload = require("express-fileupload");
const path = require("path");
const fs = require("fs");

const { initializeSocket } = require("./src/socket/socketHandler");
const { connectToWhatsApp } = require("./src/whatsapp/whatsappConnection");
const whatsappRoutes = require("./src/routes/whatsappRoutes");
const { UPLOADS_DIR } = require("./src/config/constants");

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 8000;

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  console.log(`Created uploads directory: ${UPLOADS_DIR}`);
}

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  expressFileUpload({
    createParentPath: true,
  })
);

app.use("/assets", express.static(path.join(__dirname, "client", "assets")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "index.html"));
});

app.use("/", whatsappRoutes);

initializeSocket(server);

server.listen(port, () => {
  console.log(`🚀 WhatsApp Gateway listening on port ${port}`);
  console.log(
    `Open http://localhost:${port} in your browser to see the QR code.`
  );
  connectToWhatsApp().catch((err) =>
    console.error("Failed to connect to WhatsApp on startup:", err)
  );
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  const { sock } = require("./src/whatsapp/whatsappInstance");

  if (sock) {
    try {
      await sock.logout();
      console.log("WhatsApp disconnected gracefully.");
    } catch (e) {
      console.error("Error during graceful logout:", e);
    }
  }

  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });
});
