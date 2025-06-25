const express = require("express");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  useMultiFileAuthState,
  makeInMemoryStore,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const { Boom } = require("@hapi/boom");
const path = require("path");
const fs = require("fs");
const http = require("http");
const expressFileUpload = require("express-fileupload");
const cors = require("cors");
const bodyParser = require("body-parser");
const qrcode = require("qrcode");

const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server);

const port = process.env.PORT || 8000;

const SESSION_DIR = path.resolve(__dirname, "baileys_auth_info");
const UPLOADS_DIR = path.resolve(__dirname, "uploads");

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  console.log(`Created session directory: ${SESSION_DIR}`);
}
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

const store = makeInMemoryStore({
  logger: pino().child({ level: "silent", stream: "store" }),
});

let sock;
let qrCodeImageData = null;
let socketIoClient;

const updateQRStatus = (type, message = "") => {
  if (!socketIoClient) {
    console.warn("Socket.IO client not connected, cannot send QR status.");
    return;
  }

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

const isWhatsAppConnected = () => {
  return sock && sock.user && sock.ws && sock.ws.readyState === sock.ws.OPEN;
};

async function connectToWhatsApp() {
  console.log("Attempting to connect to WhatsApp...");
  updateQRStatus("loading", "Connecting to WhatsApp...");

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using Baileys version ${version}${isLatest ? " (latest)" : ""}`);

  sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: "silent" }),
    version,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
  });

  store.bind(sock.ev);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        qrCodeImageData = await qrcode.toDataURL(qr);
        console.log("QR Code generated and converted to image data.");
        updateQRStatus("qr", "QR Code received, please scan!");
      } catch (err) {
        console.error("Failed to convert QR Code to image data:", err);
        qrCodeImageData = null;
        updateQRStatus("disconnected", "Failed to generate QR code.");
      }
    }

    if (connection === "close") {
      let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(
        `Connection closed: ${reason} - ${
          lastDisconnect?.error?.message || "Unknown reason"
        }`
      );
      qrCodeImageData = null;

      if (
        reason === DisconnectReason.badAuth ||
        reason === DisconnectReason.loggedOut
      ) {
        console.log(
          "Bad Session File or Logged Out. Deleting session and reconnecting..."
        );
        if (fs.existsSync(SESSION_DIR)) {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          console.log(`Session directory '${SESSION_DIR}' deleted.`);
        }
        sock = null;
        updateQRStatus("disconnected", "Session expired. Reconnecting...");
        setTimeout(() => connectToWhatsApp(), 1000);
      } else if (
        reason === DisconnectReason.connectionClosed ||
        reason === DisconnectReason.connectionLost ||
        reason === DisconnectReason.timedOut ||
        reason === DisconnectReason.restartRequired
      ) {
        console.log("Connection lost/closed/timeout, reconnecting...");
        updateQRStatus("disconnected", "Connection lost. Reconnecting...");
        setTimeout(() => connectToWhatsApp(), 3000);
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log(
          "Connection Replaced, Another New Session Opened, Please Close Current Session First"
        );
        sock.logout();
        sock = null;
        updateQRStatus(
          "disconnected",
          "Session replaced. Please log in again."
        );
      } else {
        console.log(
          `Unknown DisconnectReason: ${reason}|${lastDisconnect?.error?.message}`
        );
        sock.end(
          `Unknown DisconnectReason: ${reason}|${lastDisconnect?.error?.message}`
        );
        sock = null;
        updateQRStatus(
          "disconnected",
          "Disconnected due to an unknown error. Reconnecting..."
        );
        setTimeout(() => connectToWhatsApp(), 5000);
      }
    } else if (connection === "open") {
      console.log("✅ WhatsApp connection opened successfully!");
      qrCodeImageData = null;
      updateQRStatus("connected", "✅ WhatsApp connected!");

      try {
        let getGroups = await sock.groupFetchAllParticipating();
        let groups = Object.values(getGroups);
        console.log("\n--- Joined Groups ---");
        for (let group of groups) {
          console.log(`ID: ${group.id} | Nama Grup: ${group.subject}`);
        }
        console.log("---------------------\n");
      } catch (groupError) {
        console.error("Failed to fetch joined groups:", groupError);
      }
    } else if (connection === "connecting") {
      updateQRStatus("loading", "Connecting to WhatsApp...");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type === "notify" && messages.length > 0) {
      const msg = messages[0];

      if (!msg.key.fromMe) {
        const senderJid = msg.key.remoteJid;
        const messageText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          "";

        console.log(`📩 Pesan dari ${senderJid}: ${messageText}`);

        try {
          await sock.readMessages([msg.key]);
        } catch (readErr) {
          console.error("Failed to mark message as read:", readErr);
        }

        const lowerCaseMessage = messageText.toLowerCase();
        if (lowerCaseMessage === "ping") {
          await sock.sendMessage(senderJid, { text: "Pong!" }, { quoted: msg });
        } else if (lowerCaseMessage === "halo") {
          await sock.sendMessage(
            senderJid,
            { text: "Halo juga! Saya adalah Bot WhatsApp." },
            { quoted: msg }
          );
        } else {
        }
      }
    }
  });
}

io.on("connection", async (socket) => {
  socketIoClient = socket;

  console.log("A client connected to Socket.IO.");

  if (isWhatsAppConnected()) {
    updateQRStatus("connected");
  } else if (qrCodeImageData) {
    updateQRStatus("qr", "QR Code ready. Scan to connect.");
  } else {
    updateQRStatus("loading", "Initializing WhatsApp connection...");
  }

  socket.on("disconnect", () => {
    console.log("Client disconnected from Socket.IO.");
    socketIoClient = null;
  });
});

app.get("/status", (req, res) => {
  if (isWhatsAppConnected()) {
    return res.status(200).json({
      status: "connected",
      user: sock.user.id,
      name: sock.user.name,
      message: "WhatsApp connected successfully.",
    });
  } else if (qrCodeImageData) {
    return res.status(200).json({
      status: "waiting_for_scan",
      message: "WhatsApp not connected. Scan the QR code to connect.",
      qrCode: qrCodeImageData,
    });
  } else if (sock) {
    return res.status(200).json({
      status: "connecting",
      message: "WhatsApp connection in progress.",
    });
  } else {
    return res.status(200).json({
      status: "disconnected",
      message: "WhatsApp not connected. Please connect first.",
    });
  }
});

app.get("/connect", (req, res) => {
  if (isWhatsAppConnected()) {
    return res.status(200).json({
      status: "already_connected",
      user: sock.user.id,
      message: "Already connected to WhatsApp.",
    });
  }
  if (!sock) {
    connectToWhatsApp();
    return res.status(202).json({
      message:
        "Initiating WhatsApp connection. Check /status or the web UI for QR code.",
    });
  } else if (qrCodeImageData) {
    return res.status(200).json({
      status: "waiting_for_scan",
      message: "QR Code already generated. Scan to connect.",
      qrCode: qrCodeImageData,
    });
  } else {
    return res.status(202).json({
      message: "WhatsApp connection process already in progress.",
    });
  }
});

app.get("/get-groups", async (req, res) => {
  if (!isWhatsAppConnected()) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp not connected or socket not open.",
      message: "Cannot fetch groups when WhatsApp is not connected.",
    });
  }
  try {
    const groups = await sock.groupFetchAllParticipating();
    const simplifiedGroups = Object.values(groups).map((g) => ({
      id: g.id,
      name: g.subject,
      participants: g.participants.length,
    }));
    return res.status(200).json({
      success: true,
      data: simplifiedGroups,
      message: "Groups fetched successfully.",
    });
  } catch (error) {
    console.error("❌ Failed to fetch groups:", error);
    return res.status(500).json({
      success: false,
      error: error.message || error.toString(),
      message: "Failed to fetch groups.",
    });
  }
});

app.post("/disconnect", async (req, res) => {
  console.log("Received /disconnect request.");
  if (sock) {
    try {
      await sock.logout();
      console.log("Logged out from WhatsApp.");
    } catch (e) {
      console.error("Error during sock.logout():", e);
    } finally {
      if (fs.existsSync(SESSION_DIR)) {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        console.log(`Session directory '${SESSION_DIR}' deleted.`);
      }
      sock = null;
      qrCodeImageData = null;
      updateQRStatus(
        "disconnected",
        "WhatsApp session disconnected and cleared."
      );
      console.log("WhatsApp session cleared. Ready for new connection.");
      return res.status(200).json({
        success: true,
        message: "WhatsApp session disconnected and cleared.",
      });
    }
  } else {
    console.log(
      "WhatsApp not connected, but received /disconnect request. Clearing session directory if exists."
    );
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      console.log(`Session directory '${SESSION_DIR}' deleted.`);
    }
    sock = null;
    qrCodeImageData = null;
    updateQRStatus("disconnected", "WhatsApp not active, but session cleared.");
    return res.status(200).json({
      success: true,
      message: "WhatsApp not active, but session cleared.",
    });
  }
});

const cleanupFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error(`Error deleting file ${filePath}:`, err);
      } else {
        console.log(`File deleted: ${filePath}`);
      }
    });
  }
};

async function sendMessage(jid, content, filePath = null) {
  if (!isWhatsAppConnected()) {
    throw new Error(
      "WhatsApp is not connected or socket is not open. Please ensure the connection is active."
    );
  }

  let targetJid = jid;

  if (!jid.includes("@")) {
    if (jid.startsWith("62")) {
      targetJid = `${jid}@s.whatsapp.net`;
    } else if (jid.startsWith("0")) {
      targetJid = `62${jid.substring(1)}@s.whatsapp.net`;
    } else {
      targetJid = `${jid}@s.whatsapp.net`;
    }
  }

  try {
    let resolvedJid = targetJid;
    if (targetJid.endsWith("@s.whatsapp.net")) {
      const [result] = await sock.onWhatsApp(targetJid);
      if (!result?.exists) {
        throw new Error(
          `Number ${targetJid.split("@")[0]} not registered on WhatsApp.`
        );
      }
      resolvedJid = result.jid;
    } else if (!targetJid.endsWith("@g.us")) {
      throw new Error(
        `Invalid JID format: ${jid}. Must be a valid phone number or group ID.`
      );
    }

    const result = await sock.sendMessage(resolvedJid, content);
    console.log(`✅ Message sent to ${resolvedJid}`);
    return result;
  } catch (error) {
    console.error(`❌ Error sending message to ${jid}:`, error);
    throw error;
  } finally {
    if (filePath) {
      cleanupFile(filePath);
    }
  }
}

app.post("/send-message", async (req, res) => {
  const { to, message } = req.body;
  const fileDikirim = req.files ? req.files.file_dikirim : null;

  let uploadedFilePath = null;

  try {
    if (!to) {
      return res.status(400).json({
        success: false,
        error: 'Missing "to" parameter (recipient number).',
      });
    }

    if (!message && !fileDikirim) {
      return res.status(400).json({
        success: false,
        error:
          'Missing "message" for text message or "file_dikirim" for file message.',
      });
    }

    let content;

    if (fileDikirim) {
      const fileName = `${Date.now()}_${fileDikirim.name}`;
      uploadedFilePath = path.join(UPLOADS_DIR, fileName);

      await fileDikirim.mv(uploadedFilePath);
      console.log(`File uploaded: ${uploadedFilePath}`);

      const extensionName = path.extname(fileName).toLowerCase();
      const mimeType = fileDikirim.mimetype;

      if ([".jpeg", ".jpg", ".png", ".gif"].includes(extensionName)) {
        content = { image: { url: uploadedFilePath }, caption: message || "" };
      } else if ([".mp3", ".ogg", ".wav"].includes(extensionName)) {
        content = {
          audio: { url: uploadedFilePath },
          mimetype: mimeType,
          ptt: true,
        };
      } else if ([".mp4", ".avi", ".mov"].includes(extensionName)) {
        content = { video: { url: uploadedFilePath }, caption: message || "" };
      } else {
        content = {
          document: { url: uploadedFilePath },
          mimetype: mimeType,
          fileName: fileDikirim.name,
          caption: message || "",
        };
      }
    } else {
      content = { text: message };
    }

    const result = await sendMessage(to, content, uploadedFilePath);
    return res.status(200).json({
      success: true,
      message: "Message sent successfully.",
      data: result,
    });
  } catch (error) {
    console.error("❌ Failed to send message:", error);
    cleanupFile(uploadedFilePath);
    return res.status(500).json({
      success: false,
      message: "Failed to send message.",
      error: error.message || error.toString(),
    });
  }
});

app.post("/send-group-text", async (req, res) => {
  const { id_group, message } = req.body;

  if (!isWhatsAppConnected()) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp is not connected or socket is not open.",
      message: "Cannot send message when WhatsApp is not connected.",
    });
  }

  if (!id_group || !message) {
    return res.status(400).json({
      success: false,
      error: 'Missing "id_group" or "message" in request body.',
    });
  }

  const formattedGroupId = id_group.endsWith("@g.us")
    ? id_group
    : `${id_group}@g.us`;

  try {
    const result = await sendMessage(formattedGroupId, { text: message });

    return res.status(200).json({
      success: true,
      message: "Group text message sent successfully.",
      data: result,
    });
  } catch (err) {
    console.error("❌ Error sending group text message:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to send group text message.",
      error: err.message || err.toString(),
    });
  }
});

app.post("/send-group-message", async (req, res) => {
  const rawGroupId = req.body.id_group || "";
  const id_group = rawGroupId.endsWith("@g.us")
    ? rawGroupId
    : `${rawGroupId}@g.us`;
  const message = req.body.message || "";
  const fileDikirim = req.files?.file_dikirim || null;

  let uploadedFilePath = null;

  try {
    if (!isWhatsAppConnected()) {
      return res.status(400).json({
        success: false,
        error: "WhatsApp is not connected or socket is not open.",
        message: "Cannot send group message when WhatsApp is not connected.",
      });
    }

    const groups = await sock.groupFetchAllParticipating();
    const groupIds = Object.keys(groups);
    if (!groupIds.includes(id_group)) {
      return res.status(400).json({
        success: false,
        error: `Group ID "${id_group}" not found in joined groups. Make sure this WA account is a member of that group.`,
      });
    }

    let content;

    if (fileDikirim) {
      const fileName = `${Date.now()}_${fileDikirim.name}`;
      uploadedFilePath = path.join(UPLOADS_DIR, fileName);
      await fileDikirim.mv(uploadedFilePath);
      console.log("📁 File uploaded:", uploadedFilePath);

      const ext = path.extname(fileName).toLowerCase();
      const mimeType = fileDikirim.mimetype;

      if ([".jpg", ".jpeg", ".png", ".gif"].includes(ext)) {
        content = { image: { url: uploadedFilePath }, caption: message };
      } else if ([".mp3", ".ogg", ".wav"].includes(ext)) {
        content = {
          audio: { url: uploadedFilePath },
          mimetype: mimeType,
          ptt: true,
        };
      } else if ([".mp4", ".avi", ".mov"].includes(ext)) {
        content = { video: { url: uploadedFilePath }, caption: message };
      } else {
        content = {
          document: { url: uploadedFilePath },
          mimetype: mimeType,
          fileName: fileDikirim.name,
          caption: message,
        };
      }
    } else {
      if (!message) {
        return res.status(400).json({
          success: false,
          error: 'Missing "message" if no file uploaded for group text.',
        });
      }
      content = { text: message };
    }

    const result = await sendMessage(id_group, content, uploadedFilePath);

    return res.status(200).json({
      success: true,
      message: "Group message sent successfully.",
      data: result,
    });
  } catch (error) {
    console.error("❌ Failed to send group message:", error);
    cleanupFile(uploadedFilePath);
    return res.status(500).json({
      success: false,
      message: "Failed to send group message.",
      error: error.message || error.toString(),
    });
  }
});

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
