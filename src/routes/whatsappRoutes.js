const express = require("express");
const fs = require("fs");
const {
  getSocket,
  getQRCodeImageData,
  isWhatsAppConnected,
  clearWhatsAppInstance,
} = require("../whatsapp/whatsappInstance");
const { connectToWhatsApp } = require("../whatsapp/whatsappConnection");
const { updateQRStatus } = require("../socket/socketHandler");
const {
  sendMessage,
  sendGroupMessage,
  createMessageContent,
  saveUploadedFile,
} = require("../services/messageService");
const { SESSION_DIR } = require("../config/constants");

const router = express.Router();

// Status endpoint
router.get("/status", (req, res) => {
  const sock = getSocket();
  const qrCodeImageData = getQRCodeImageData();

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

// Connect endpoint
router.get("/connect", (req, res) => {
  const sock = getSocket();
  const qrCodeImageData = getQRCodeImageData();

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

// Get groups endpoint
router.get("/get-groups", async (req, res) => {
  if (!isWhatsAppConnected()) {
    return res.status(400).json({
      success: false,
      error: "WhatsApp not connected or socket not open.",
      message: "Cannot fetch groups when WhatsApp is not connected.",
    });
  }

  try {
    const sock = getSocket();
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

// Disconnect endpoint
router.post("/disconnect", async (req, res) => {
  console.log("Received /disconnect request.");
  const sock = getSocket();

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
      clearWhatsAppInstance();
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
    clearWhatsAppInstance();
    updateQRStatus("disconnected", "WhatsApp not active, but session cleared.");
    return res.status(200).json({
      success: true,
      message: "WhatsApp not active, but session cleared.",
    });
  }
});

// Send message endpoint
router.post("/send-message", async (req, res) => {
  const { to, message } = req.body;
  const fileDikirim = req.files ? req.files.file_dikirim : null;

  let uploadedFilePath = null;
  let fileName = null;

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
      const fileData = await saveUploadedFile(fileDikirim);
      uploadedFilePath = fileData.filePath;
      fileName = fileData.fileName;

      content = createMessageContent(
        message,
        uploadedFilePath,
        fileDikirim.name,
        fileDikirim.mimetype
      );
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
    return res.status(500).json({
      success: false,
      message: "Failed to send message.",
      error: error.message || error.toString(),
    });
  }
});

// Send group text message endpoint
router.post("/send-group-text", async (req, res) => {
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

  try {
    const result = await sendGroupMessage(id_group, { text: message });

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

// Send group message with file endpoint
router.post("/send-group-message", async (req, res) => {
  const { id_group, message } = req.body;
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

    if (!id_group) {
      return res.status(400).json({
        success: false,
        error: 'Missing "id_group" in request body.',
      });
    }

    if (!message && !fileDikirim) {
      return res.status(400).json({
        success: false,
        error: 'Missing "message" if no file uploaded for group text.',
      });
    }

    let content;

    if (fileDikirim) {
      const fileData = await saveUploadedFile(fileDikirim);
      uploadedFilePath = fileData.filePath;

      content = createMessageContent(
        message,
        uploadedFilePath,
        fileDikirim.name,
        fileDikirim.mimetype
      );
    } else {
      content = { text: message };
    }

    const result = await sendGroupMessage(id_group, content, uploadedFilePath);

    return res.status(200).json({
      success: true,
      message: "Group message sent successfully.",
      data: result,
    });
  } catch (error) {
    console.error("❌ Failed to send group message:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to send group message.",
      error: error.message || error.toString(),
    });
  }
});

module.exports = router;
