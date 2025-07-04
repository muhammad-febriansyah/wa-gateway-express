const path = require("path");

const SESSION_DIR = path.resolve(__dirname, "../../baileys_auth_info");
const UPLOADS_DIR = path.resolve(__dirname, "../../uploads");

const IMAGE_EXTENSIONS = [".jpeg", ".jpg", ".png", ".gif"];
const AUDIO_EXTENSIONS = [".mp3", ".ogg", ".wav"];
const VIDEO_EXTENSIONS = [".mp4", ".avi", ".mov"];

module.exports = {
  SESSION_DIR,
  UPLOADS_DIR,
  IMAGE_EXTENSIONS,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
};
