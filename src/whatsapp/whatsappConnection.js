const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const qrcode = require("qrcode");

const { SESSION_DIR } = require("../config/constants");
const { updateQRStatus } = require("../socket/socketHandler");
const {
  setSocket,
  setQRCodeImageData,
  clearWhatsAppInstance,
  getSocket,
} = require("./whatsappInstance");
const { handleIncomingMessage } = require("./messageHandler");

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  console.log(`Created session directory: ${SESSION_DIR}`);
}

async function connectToWhatsApp() {
  console.log("Attempting to connect to WhatsApp...");
  updateQRStatus("loading", "Connecting to WhatsApp...");

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using Baileys version ${version}${isLatest ? " (latest)" : ""}`);

  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: "silent" }),
    version,
    shouldIgnoreJid: (jid) => isJidBroadcast(jid),
  });

  setSocket(sock);

  sock.ev.on("connection.update", async (update) => {
    await handleConnectionUpdate(update);
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", handleIncomingMessage);
}

async function handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    try {
      const qrCodeImageData = await qrcode.toDataURL(qr);
      setQRCodeImageData(qrCodeImageData);
      console.log("QR Code generated and converted to image data.");
      updateQRStatus("qr", "QR Code received, please scan!");
    } catch (err) {
      console.error("Failed to convert QR Code to image data:", err);
      setQRCodeImageData(null);
      updateQRStatus("disconnected", "Failed to generate QR code.");
    }
  }

  if (connection === "close") {
    await handleConnectionClose(lastDisconnect);
  } else if (connection === "open") {
    await handleConnectionOpen();
  } else if (connection === "connecting") {
    updateQRStatus("loading", "Connecting to WhatsApp...");
  }
}

async function handleConnectionClose(lastDisconnect) {
  let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
  console.log(
    `Connection closed: ${reason} - ${
      lastDisconnect?.error?.message || "Unknown reason"
    }`
  );
  setQRCodeImageData(null);

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
    clearWhatsAppInstance();
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
    const sock = getSocket();
    if (sock) {
      sock.logout();
    }
    clearWhatsAppInstance();
    updateQRStatus("disconnected", "Session replaced. Please log in again.");
  } else {
    console.log(
      `Unknown DisconnectReason: ${reason}|${lastDisconnect?.error?.message}`
    );
    const sock = getSocket();
    if (sock) {
      sock.end(
        `Unknown DisconnectReason: ${reason}|${lastDisconnect?.error?.message}`
      );
    }
    clearWhatsAppInstance();
    updateQRStatus(
      "disconnected",
      "Disconnected due to an unknown error. Reconnecting..."
    );
    setTimeout(() => connectToWhatsApp(), 5000);
  }
}

async function handleConnectionOpen() {
  console.log("✅ WhatsApp connection opened successfully!");
  setQRCodeImageData(null);
  updateQRStatus("connected", "✅ WhatsApp connected!");

  try {
    const sock = getSocket();
    if (sock) {
      let getGroups = await sock.groupFetchAllParticipating();
      let groups = Object.values(getGroups);
      console.log("\n--- Joined Groups ---");
      for (let group of groups) {
        console.log(`ID: ${group.id} | Nama Grup: ${group.subject}`);
      }
      console.log("---------------------\n");
    }
  } catch (groupError) {
    console.error("Failed to fetch joined groups:", groupError);
  }
}

module.exports = {
  connectToWhatsApp,
};
