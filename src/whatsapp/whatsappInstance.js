const { makeInMemoryStore } = require("@whiskeysockets/baileys");
const pino = require("pino");

let sock = null;
let qrCodeImageData = null;
let socketIoClient = null;

const store = makeInMemoryStore({
  logger: pino().child({ level: "silent", stream: "store" }),
});

const getSocket = () => sock;
const setSocket = (newSock) => {
  sock = newSock;
  if (sock) {
    store.bind(sock.ev);
  }
};

const getQRCodeImageData = () => qrCodeImageData;
const setQRCodeImageData = (data) => {
  qrCodeImageData = data;
};

const getSocketIoClient = () => socketIoClient;
const setSocketIoClient = (client) => {
  socketIoClient = client;
};

const getStore = () => store;

const isWhatsAppConnected = () => {
  return sock && sock.user && sock.ws && sock.ws.readyState === sock.ws.OPEN;
};

const clearWhatsAppInstance = () => {
  sock = null;
  qrCodeImageData = null;
};

module.exports = {
  getSocket,
  setSocket,
  getQRCodeImageData,
  setQRCodeImageData,
  getSocketIoClient,
  setSocketIoClient,
  getStore,
  isWhatsAppConnected,
  clearWhatsAppInstance,
  sock,
  qrCodeImageData,
  socketIoClient,
  store,
};
