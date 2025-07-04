const fs = require("fs");
const path = require("path");
const {
  getSocket,
  isWhatsAppConnected,
} = require("../whatsapp/whatsappInstance");
const {
  IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  UPLOADS_DIR,
} = require("../config/constants");

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

const formatJid = (jid) => {
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

  return targetJid;
};

const createMessageContent = (message, filePath, fileName, mimeType) => {
  if (!filePath) {
    return { text: message };
  }

  const ext = path.extname(fileName).toLowerCase();

  if (IMAGE_EXTENSIONS.includes(ext)) {
    return { image: { url: filePath }, caption: message || "" };
  } else if (AUDIO_EXTENSIONS.includes(ext)) {
    return {
      audio: { url: filePath },
      mimetype: mimeType,
      ptt: true,
    };
  } else if (VIDEO_EXTENSIONS.includes(ext)) {
    return { video: { url: filePath }, caption: message || "" };
  } else {
    return {
      document: { url: filePath },
      mimetype: mimeType,
      fileName: fileName,
      caption: message || "",
    };
  }
};

const saveUploadedFile = async (file) => {
  const fileName = `${Date.now()}_${file.name}`;
  const filePath = path.join(UPLOADS_DIR, fileName);

  await file.mv(filePath);
  console.log(`File uploaded: ${filePath}`);

  return { filePath, fileName };
};

async function sendMessage(jid, content, filePath = null) {
  if (!isWhatsAppConnected()) {
    throw new Error(
      "WhatsApp is not connected or socket is not open. Please ensure the connection is active."
    );
  }

  const sock = getSocket();
  if (!sock) {
    throw new Error("WhatsApp socket is not available.");
  }

  const targetJid = formatJid(jid);

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

async function sendGroupMessage(groupId, content, filePath = null) {
  if (!isWhatsAppConnected()) {
    throw new Error("WhatsApp is not connected or socket is not open.");
  }

  const sock = getSocket();
  if (!sock) {
    throw new Error("WhatsApp socket is not available.");
  }

  const formattedGroupId = groupId.endsWith("@g.us")
    ? groupId
    : `${groupId}@g.us`;

  try {
    // Verify group membership
    const groups = await sock.groupFetchAllParticipating();
    const groupIds = Object.keys(groups);

    if (!groupIds.includes(formattedGroupId)) {
      throw new Error(
        `Group ID "${formattedGroupId}" not found in joined groups. Make sure this WA account is a member of that group.`
      );
    }

    const result = await sendMessage(formattedGroupId, content, filePath);
    return result;
  } catch (error) {
    if (filePath) {
      cleanupFile(filePath);
    }
    throw error;
  }
}

module.exports = {
  sendMessage,
  sendGroupMessage,
  createMessageContent,
  saveUploadedFile,
  cleanupFile,
};
