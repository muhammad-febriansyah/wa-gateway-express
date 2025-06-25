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

// Define directories for session data and uploaded files
const SESSION_DIR = path.resolve(__dirname, "baileys_auth_info");
const UPLOADS_DIR = path.resolve(__dirname, "uploads");

// Create directories if they don't exist
if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  console.log(`Created session directory: ${SESSION_DIR}`);
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  console.log(`Created uploads directory: ${UPLOADS_DIR}`);
}

// Middleware setup for Express
app.use(cors()); // Enable Cross-Origin Resource Sharing
app.use(bodyParser.json()); // Parse JSON request bodies
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded request bodies
app.use(
  expressFileUpload({
    createParentPath: true, // Automatically create parent directories for uploaded files
  })
);

// Serve static assets from the 'client/assets' directory
app.use("/assets", express.static(path.join(__dirname, "client", "assets")));

// Serve the main client HTML file for the root URL
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "index.html"));
});

// In-memory store for Baileys data (chats, contacts, messages)
const store = makeInMemoryStore({
  logger: pino().child({ level: "silent", stream: "store" }), // Suppress store logs
});

let sock; // Global variable to hold the WhatsApp socket instance
let qrCodeImageData = null; // Stores QR code as a data URL string
let socketIoClient; // Reference to the connected Socket.IO client for real-time updates

// Function to update QR code/connection status via Socket.IO
const updateQRStatus = (type, message = "") => {
  if (!socketIoClient) {
    console.warn("Socket.IO client not connected, cannot send QR status.");
    return;
  }

  // Send updates to the connected client based on the status type
  switch (type) {
    case "qr":
      socketIoIoClient.emit("qr", qrCodeImageData);
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

/**
 * Checks if the WhatsApp socket is connected and ready to send messages.
 * This includes checking if the `sock` object exists, has user info, and its
 * underlying WebSocket is in the OPEN state.
 * @returns {boolean} True if WhatsApp is connected and socket is open, false otherwise.
 */
const isWhatsAppConnected = () => {
  return sock && sock.user && sock.ws && sock.ws.readyState === sock.ws.OPEN;
};

// Main function to connect to WhatsApp using Baileys
async function connectToWhatsApp() {
  console.log("Attempting to connect to WhatsApp...");
  updateQRStatus("loading", "Connecting to WhatsApp..."); // Update client with loading status

  // Load authentication state from files or create a new one
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  // Fetch the latest Baileys version
  let { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using Baileys version ${version}${isLatest ? " (latest)" : ""}`);

  // Create a new WhatsApp socket instance
  sock = makeWASocket({
    printQRInTerminal: false, // Do not print QR in terminal, send via Socket.IO
    auth: state, // Authentication state
    logger: pino({ level: "silent" }), // Suppress verbose Baileys logs
    version, // Use the fetched Baileys version
    shouldIgnoreJid: (jid) => isJidBroadcast(jid), // Ignore broadcast messages
  });

  // Bind the in-memory store to the socket events for data synchronization
  store.bind(sock.ev);

  // Event listener for connection updates (e.g., QR code, connection open/close)
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Handle QR code generation
    if (qr) {
      try {
        qrCodeImageData = await qrcode.toDataURL(qr); // Convert QR string to data URL image
        console.log("QR Code generated and converted to image data.");
        updateQRStatus("qr", "QR Code received, please scan!");
      } catch (err) {
        console.error("Failed to convert QR Code to image data:", err);
        qrCodeImageData = null;
        updateQRStatus("disconnected", "Failed to generate QR code.");
      }
    }

    // Handle connection closure
    if (connection === "close") {
      let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(
        `Connection closed: ${reason} - ${
          lastDisconnect?.error?.message || "Unknown reason"
        }`
      );
      qrCodeImageData = null; // Clear QR image data on disconnect

      // Handle different disconnect reasons for reconnection logic
      if (
        reason === DisconnectReason.badAuth ||
        reason === DisconnectReason.loggedOut
      ) {
        console.log(
          "Bad Session File or Logged Out. Deleting session and reconnecting..."
        );
        // Delete session directory to force a fresh login
        if (fs.existsSync(SESSION_DIR)) {
          fs.rmSync(SESSION_DIR, { recursive: true, force: true });
          console.log(`Session directory '${SESSION_DIR}' deleted.`);
        }
        sock = null; // Clear sock instance
        updateQRStatus("disconnected", "Session expired. Reconnecting...");
        setTimeout(() => connectToWhatsApp(), 1000); // Reconnect after a short delay
      } else if (
        reason === DisconnectReason.connectionClosed ||
        reason === DisconnectReason.connectionLost ||
        reason === DisconnectReason.timedOut ||
        reason === DisconnectReason.restartRequired
      ) {
        console.log("Connection lost/closed/timeout, reconnecting...");
        updateQRStatus("disconnected", "Connection lost. Reconnecting...");
        setTimeout(() => connectToWhatsApp(), 3000); // Reconnect after a short delay
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log(
          "Connection Replaced, Another New Session Opened, Please Close Current Session First"
        );
        sock.logout(); // Log out current session
        sock = null; // Clear sock instance
        updateQRStatus(
          "disconnected",
          "Session replaced. Please log in again."
        );
      } else {
        // Unknown reason, attempt reconnect after a longer delay
        console.log(
          `Unknown DisconnectReason: ${reason}|${lastDisconnect?.error?.message}`
        );
        sock.end(
          `Unknown DisconnectReason: ${reason}|${lastDisconnect?.error?.message}`
        ); // End the socket
        sock = null; // Clear sock instance
        updateQRStatus(
          "disconnected",
          "Disconnected due to an unknown error. Reconnecting..."
        );
        setTimeout(() => connectToWhatsApp(), 5000);
      }
    } else if (connection === "open") {
      // Connection successfully opened
      console.log("✅ WhatsApp connection opened successfully!");
      qrCodeImageData = null; // Clear QR image data as it's no longer needed
      updateQRStatus("connected", "✅ WhatsApp connected!");

      // Log joined groups for debugging/information
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
      // Connection is in progress
      updateQRStatus("loading", "Connecting to WhatsApp...");
    }
  });

  // Event listener to save credentials when they are updated
  sock.ev.on("creds.update", saveCreds);

  // Event listener for incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type === "notify" && messages.length > 0) {
      const msg = messages[0];

      // Ignore messages sent by ourselves
      if (!msg.key.fromMe) {
        const senderJid = msg.key.remoteJid;
        const messageText =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          "";

        console.log(`📩 Pesan dari ${senderJid}: ${messageText}`);

        // Mark message as read
        try {
          await sock.readMessages([msg.key]);
        } catch (readErr) {
          console.error("Failed to mark message as read:", readErr);
        }

        // Basic auto-reply logic
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
          // Add more complex bot logic here if needed
        }
      }
    }
  });
}

// Socket.IO connection handler
io.on("connection", async (socket) => {
  socketIoClient = socket; // Store reference to the newly connected client

  console.log("A client connected to Socket.IO.");

  // Send initial status to the newly connected client
  if (isWhatsAppConnected()) {
    updateQRStatus("connected");
  } else if (qrCodeImageData) {
    updateQRStatus("qr", "QR Code ready. Scan to connect.");
  } else {
    updateQRStatus("loading", "Initializing WhatsApp connection...");
  }

  // Handle client disconnection from Socket.IO
  socket.on("disconnect", () => {
    console.log("Client disconnected from Socket.IO.");
    socketIoClient = null; // Clear reference when client disconnects
  });
});

// API endpoint to get connection status
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
    // If sock exists but not fully connected (e.g., connecting, or socket not open)
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

// API endpoint to initiate/check connection
app.get("/connect", (req, res) => {
  if (isWhatsAppConnected()) {
    return res.status(200).json({
      status: "already_connected",
      user: sock.user.id,
      message: "Already connected to WhatsApp.",
    });
  }
  // If sock is null or not fully initialized, attempt to connect
  if (!sock) {
    connectToWhatsApp();
    return res.status(202).json({
      message:
        "Initiating WhatsApp connection. Check /status or the web UI for QR code.",
    });
  } else if (qrCodeImageData) {
    // If QR code is already generated, provide it again
    return res.status(200).json({
      status: "waiting_for_scan",
      message: "QR Code already generated. Scan to connect.",
      qrCode: qrCodeImageData,
    });
  } else {
    // Connection process is already in progress but no QR yet (e.g., fetching version)
    return res.status(202).json({
      message: "WhatsApp connection process already in progress.",
    });
  }
});

// API endpoint to get list of joined groups
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
      id: g.id, // This `id` is the full JID needed for sending group messages
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

// API endpoint to disconnect and clear session
app.post("/disconnect", async (req, res) => {
  console.log("Received /disconnect request.");
  if (sock) {
    try {
      await sock.logout(); // Attempt to log out from WhatsApp
      console.log("Logged out from WhatsApp.");
    } catch (e) {
      console.error("Error during sock.logout():", e);
    } finally {
      // Always clear session directory and reset state
      if (fs.existsSync(SESSION_DIR)) {
        fs.rmSync(SESSION_DIR, { recursive: true, force: true });
        console.log(`Session directory '${SESSION_DIR}' deleted.`);
      }
      sock = null; // Clear the socket instance
      qrCodeImageData = null; // Clear any existing QR code data
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
    // If not connected, just clear session files if they exist
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

// Helper function to clean up uploaded files
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

/**
 * Generic function to send messages (used by both private and group messages).
 * @param {string} jid The JID (Jabber ID) of the recipient (e.g., '6281234567890@s.whatsapp.net' or '1234567890-1234567890@g.us').
 * @param {object} content The message content object (e.g., { text: 'Hello' } or { image: { url: '...' } }).
 * @param {string|null} filePath Optional path to an uploaded file, to be cleaned up after sending.
 * @returns {Promise<object>} The result of the sendMessage operation.
 * @throws {Error} If WhatsApp is not connected, or the JID is invalid/not found.
 */
async function sendMessage(jid, content, filePath = null) {
  // Ensure WhatsApp is connected before attempting to send
  if (!isWhatsAppConnected()) {
    throw new Error(
      "WhatsApp is not connected or socket is not open. Please ensure the connection is active."
    );
  }

  // Baileys requires a valid JID. For individual numbers, it must be '@s.whatsapp.net'.
  // For groups, it must be '@g.us'. The `onWhatsApp` check helps validate individual numbers.
  // For group JIDs, `onWhatsApp` might not always return a JID in the `exists` array,
  // so we primarily rely on the JID format for groups.
  let targetJid = jid;

  // Basic JID validation and formatting for individual numbers
  if (!jid.includes("@")) {
    // Assume it's a raw number
    if (jid.startsWith("62")) {
      targetJid = `${jid}@s.whatsapp.net`;
    } else if (jid.startsWith("0")) {
      targetJid = `62${jid.substring(1)}@s.whatsapp.net`;
    } else {
      targetJid = `${jid}@s.whatsapp.net`; // Default to individual if no country code
    }
  }

  try {
    // For individual messages, check if the number exists on WhatsApp.
    // For group messages, assume the provided `id_group` is already the correct JID.
    let resolvedJid = targetJid;
    if (targetJid.endsWith("@s.whatsapp.net")) {
      const [result] = await sock.onWhatsApp(targetJid);
      if (!result?.exists) {
        throw new Error(
          `Number ${targetJid.split("@")[0]} not registered on WhatsApp.`
        );
      }
      resolvedJid = result.jid; // Use the canonical JID returned by Baileys
    } else if (!targetJid.endsWith("@g.us")) {
      // If it's not an individual or group JID, it's likely malformed
      throw new Error(
        `Invalid JID format: ${jid}. Must be a valid phone number or group ID.`
      );
    }

    const result = await sock.sendMessage(resolvedJid, content);
    console.log(`✅ Message sent to ${resolvedJid}`);
    return result;
  } catch (error) {
    console.error(`❌ Error sending message to ${jid}:`, error);
    throw error; // Re-throw to be caught by the API endpoint's catch block
  } finally {
    if (filePath) {
      cleanupFile(filePath); // Clean up uploaded file after sending
    }
  }
}

// API endpoint to send private messages
app.post("/send-message", async (req, res) => {
  const { to, message } = req.body;
  const fileDikirim = req.files ? req.files.file_dikirim : null;

  let uploadedFilePath = null; // Declare and initialize here

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

    // Handle file uploads
    if (fileDikirim) {
      const fileName = `${Date.now()}_${fileDikirim.name}`; // Use Date.now() for unique filename
      uploadedFilePath = path.join(UPLOADS_DIR, fileName);

      await fileDikirim.mv(uploadedFilePath); // Move file to uploads directory
      console.log(`File uploaded: ${uploadedFilePath}`);

      const extensionName = path.extname(fileName).toLowerCase();
      const mimeType = fileDikirim.mimetype;

      if ([".jpeg", ".jpg", ".png", ".gif"].includes(extensionName)) {
        content = { image: { url: uploadedFilePath }, caption: message || "" };
      } else if ([".mp3", ".ogg", ".wav"].includes(extensionName)) {
        content = {
          audio: { url: uploadedFilePath },
          mimetype: mimeType, // Use actual mimetype
          ptt: true, // Mark as voice message
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

    // `to` can be a raw number (e.g., "62812...") or a full JID (e.g., "62812...@s.whatsapp.net")
    // sendMessage function will handle formatting.
    const result = await sendMessage(to, content, uploadedFilePath);
    return res.status(200).json({
      success: true,
      message: "Message sent successfully.",
      data: result,
    });
  } catch (error) {
    console.error("❌ Failed to send message:", error);
    cleanupFile(uploadedFilePath); // Ensure file is cleaned up even on error
    return res.status(500).json({
      success: false,
      message: "Failed to send message.",
      error: error.message || error.toString(),
    });
  }
});

// API endpoint to send group text messages (simplified)
app.post("/send-group-text", async (req, res) => {
  const { id_group, message } = req.body;

  if (!isWhatsAppConnected()) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp is not connected or socket is not open.",
      message: "Cannot send message when WhatsApp is not connected.",
    });
  }

  // Validasi input
  if (!id_group || !message) {
    return res.status(400).json({
      success: false,
      error: 'Missing "id_group" or "message" in request body.',
    });
  }

  // Ensure id_group is in the correct JID format
  const formattedGroupId = id_group.endsWith("@g.us")
    ? id_group
    : `${id_group}@g.us`;

  try {
    // Kirim pesan ke grup
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

// API endpoint to send group messages (text or file)
app.post("/send-group-message", async (req, res) => {
  const rawGroupId = req.body.id_group || "";
  // Ensure the group ID is in the correct JID format for groups
  const id_group = rawGroupId.endsWith("@g.us")
    ? rawGroupId
    : `${rawGroupId}@g.us`;
  const message = req.body.message || "";
  const fileDikirim = req.files?.file_dikirim || null;

  let uploadedFilePath = null; // Declare and initialize here

  try {
    // 1. Check WhatsApp connection status
    if (!isWhatsAppConnected()) {
      return res.status(400).json({
        success: false,
        error: "WhatsApp is not connected or socket is not open.",
        message: "Cannot send group message when WhatsApp is not connected.",
      });
    }

    // 2. Validate group existence (optional but good practice)
    // You might want to cache this check or only do it periodically for performance.
    // However, `sendMessage` will likely fail if the group doesn't exist or bot isn't in it.
    const groups = await sock.groupFetchAllParticipating();
    const groupIds = Object.keys(groups);
    if (!groupIds.includes(id_group)) {
      return res.status(400).json({
        success: false,
        error: `Group ID "${id_group}" not found in joined groups. Make sure this WA account is a member of that group.`,
      });
    }

    // 3. Prepare message content
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

    // 4. Send message using the generic sendMessage function
    const result = await sendMessage(id_group, content, uploadedFilePath);

    return res.status(200).json({
      success: true,
      message: "Group message sent successfully.",
      data: result,
    });
  } catch (error) {
    console.error("❌ Failed to send group message:", error);
    cleanupFile(uploadedFilePath); // Ensure file is cleaned up even on error
    return res.status(500).json({
      success: false,
      message: "Failed to send group message.",
      error: error.message || error.toString(),
    });
  }
});

// Start the server
server.listen(port, () => {
  console.log(`🚀 WhatsApp Gateway listening on port ${port}`);
  console.log(
    `Open http://localhost:${port} in your browser to see the QR code.`
  );
  // Initiate WhatsApp connection on server start
  connectToWhatsApp().catch((err) =>
    console.error("Failed to connect to WhatsApp on startup:", err)
  );
});

// Handle graceful shutdown when SIGINT (Ctrl+C) is received
process.on("SIGINT", async () => {
  console.log("Shutting down...");
  if (sock) {
    try {
      await sock.logout(); // Attempt to log out gracefully
      console.log("WhatsApp disconnected gracefully.");
    } catch (e) {
      console.error("Error during graceful logout:", e);
    }
  }
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0); // Exit the process cleanly
  });
});
