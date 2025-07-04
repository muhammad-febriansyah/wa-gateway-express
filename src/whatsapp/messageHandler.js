const { getSocket } = require("./whatsappInstance");

async function handleIncomingMessage({ messages, type }) {
  if (type === "notify" && messages.length > 0) {
    const msg = messages[0];
    const sock = getSocket();

    if (!msg.key.fromMe && sock) {
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

      await handleAutoReply(senderJid, messageText, msg, sock);
    }
  }
}

async function handleAutoReply(senderJid, messageText, msg, sock) {
  const lowerCaseMessage = messageText.toLowerCase();

  try {
    if (lowerCaseMessage === "ping") {
      await sock.sendMessage(senderJid, { text: "Pong!" }, { quoted: msg });
    } else if (lowerCaseMessage === "halo") {
      await sock.sendMessage(
        senderJid,
        { text: "Halo juga! Saya adalah Bot WhatsApp." },
        { quoted: msg }
      );
    }
  } catch (error) {
    console.error("Error in auto-reply:", error);
  }
}

module.exports = {
  handleIncomingMessage,
  handleAutoReply,
};
