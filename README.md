# WhatsApp Gateway API

WhatsApp Gateway API menggunakan Baileys untuk mengirim pesan WhatsApp secara programatik.

## Struktur Folder

```
project/
├── app.js                                 # Main application file
├── package.json                           # Dependencies
├── src/
│   ├── config/
│   │   └── constants.js                   # Configuration constants
│   ├── whatsapp/
│   │   ├── whatsappInstance.js           # WhatsApp instance management
│   │   ├── whatsappConnection.js         # Connection logic
│   │   └── messageHandler.js             # Message handling
│   ├── services/
│   │   └── messageService.js             # Message sending service
│   ├── routes/
│   │   └── whatsappRoutes.js             # API routes
│   └── socket/
│       └── socketHandler.js              # Socket.IO handler
├── client/                               # Frontend files
│   ├── index.html
│   └── assets/
│       ├── check.svg
│       ├── loader.gif
│       └── disconnected.svg
├── baileys_auth_info/                    # Auto-generated auth files
└── uploads/                              # Auto-generated uploads folder
```

## Instalasi

1. Clone atau download project
2. Install dependencies:

   ```bash
   npm install
   ```

3. Jalankan aplikasi:

   ```bash
   npm start
   ```

   Atau untuk development:

   ```bash
   npm run dev
   ```

4. Buka browser dan akses `http://localhost:8000`

## API Endpoints

### 1. Status Connection

```http
GET /status
```

Mengecek status koneksi WhatsApp

### 2. Connect to WhatsApp

```http
GET /connect
```

Memulai koneksi ke WhatsApp

### 3. Disconnect

```http
POST /disconnect
```

Memutuskan koneksi WhatsApp

### 4. Get Groups

```http
GET /get-groups
```

Mengambil daftar grup yang diikuti

### 5. Send Message

```http
POST /send-message
```

Body:

- `to`: Nomor tujuan (format: 628123456789)
- `message`: Pesan teks
- `file_dikirim`: File yang akan dikirim (optional)

### 6. Send Group Text

```http
POST /send-group-text
```

Body:

- `id_group`: ID grup
- `message`: Pesan teks

### 7. Send Group Message

```http
POST /send-group-message
```

Body:

- `id_group`: ID grup
- `message`: Pesan teks (optional jika ada file)
- `file_dikirim`: File yang akan dikirim (optional)

## Fitur

- ✅ Scan QR Code melalui web interface
- ✅ Auto-reconnect ketika koneksi terputus
- ✅ Send text messages
- ✅ Send files (images, audio, video, documents)
- ✅ Send group messages
- ✅ Auto-reply untuk pesan tertentu
- ✅ Real-time status updates via Socket.IO
- ✅ Session management

## Format Nomor

Nomor WhatsApp dapat menggunakan format:

- `628123456789` (dengan kode negara)
- `08123456789` (akan otomatis dikonversi ke 628123456789)

## Error Handling

API akan mengembalikan response JSON dengan format:

```json
{
  "success": true/false,
  "message": "Pesan status",
  "data": {}, // optional
  "error": "" // optional jika ada error
}
```

## Notes

- File yang diupload akan otomatis dihapus setelah dikirim
- Session WhatsApp akan tersimpan di folder `baileys_auth_info`
- Untuk menghapus session, gunakan endpoint `/disconnect`
- Aplikasi mendukung auto-reply untuk pesan "ping" dan "halo"

## Pengembangan

Untuk menambahkan fitur baru:

1. **Auto-reply**: Edit file `src/whatsapp/messageHandler.js`
2. **API endpoints**: Tambahkan di `src/routes/whatsappRoutes.js`
3. **Services**: Tambahkan di `src/services/`
4. **Configuration**: Edit `src/config/constants.js`

## Troubleshooting

1. **QR Code tidak muncul**: Pastikan browser mendukung Socket.IO
2. **Koneksi terputus**: Cek koneksi internet dan restart aplikasi
3. **File tidak terkirim**: Pastikan file size tidak terlalu besar
4. **Grup tidak ditemukan**: Pastikan bot sudah join ke grup tersebut
