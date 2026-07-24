const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const net = require('net');
// tiktok-live-connector la ESM-only tu 1 so ban gan day, nen phai dung import() dong
// thay vi require(). Ta nap no bat dong bo va bao mot Promise "connectorReady" de
// cac noi khac cho toi khi nao class ket noi da san sang moi dung.
let ConnectorClass = null;
let isV2 = false;
let _resolveConnectorReady;
const connectorReady = new Promise((resolve) => { _resolveConnectorReady = resolve; });

(async () => {
  const tiktokLib = await import('tiktok-live-connector');

  // tiktok-live-connector v1.x export "WebcastPushConnection".
  // tiktok-live-connector v2.x export "TikTokLiveConnection" (API cũng khác đôi chút).
  // Dò nhiều khả năng để tương thích cả 2 nhánh version.
  ConnectorClass =
    tiktokLib.WebcastPushConnection ||
    tiktokLib.TikTokLiveConnection ||
    tiktokLib.default?.WebcastPushConnection ||
    tiktokLib.default?.TikTokLiveConnection ||
    (typeof tiktokLib.default === 'function' ? tiktokLib.default : null) ||
    (typeof tiktokLib === 'function' ? tiktokLib : null);

  isV2 = !!(tiktokLib.TikTokLiveConnection || tiktokLib.default?.TikTokLiveConnection);

  if (!ConnectorClass) {
    console.error('❌ Không tìm thấy class kết nối trong package tiktok-live-connector.');
    console.error('Các export hiện có:', Object.keys(tiktokLib));
    console.error('Chạy `npm ls tiktok-live-connector` để kiểm tra version đã cài.');
  } else {
    console.log(`[TikTok] Dùng class kết nối: ${ConnectorClass.name || '(anonymous)'} (${isV2 ? 'API v2' : 'API v1'})`);
  }

  _resolveConnectorReady();
})();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Token bí mật để server xác nhận đúng ESP32 của bạn khi nó kết nối vào.
// Đặt trùng với PRINTER_TOKEN trong firmware ESP32.
const PRINTER_TOKEN = process.env.PRINTER_TOKEN || 'doi-chuoi-bi-mat-nay-thanh-cua-ban';

// Socket của ESP32 đang giữ kết nối (chỉ 1 thiết bị in tại 1 thời điểm)
let printerSocket = null;

// Các lệnh in đang chờ ESP32 phản hồi kết quả (map requestId -> { resolve, timer })
const pendingPrintJobs = new Map();

app.use(express.raw({ type: 'application/octet-stream', limit: '10mb' }));
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// Endpoint gửi lệnh in: chuyển tiếp dữ liệu ESC/POS (raw bytes) sang ESP32
// đang giữ kết nối WebSocket. ESP32 sẽ tự mở TCP tới máy in trong LAN của nó.
app.post('/print', (req, res) => {
  if (!printerSocket || printerSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).send('Chưa có thiết bị in (ESP32) nào kết nối tới server. Kiểm tra ESP32 đã bật và có WiFi chưa.');
  }
  if (!req.body || !req.body.length) {
    return res.status(400).send('Thiếu dữ liệu in.');
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payloadBase64 = Buffer.from(req.body).toString('base64');

  const timer = setTimeout(() => {
    pendingPrintJobs.delete(requestId);
    res.status(504).send('Hết thời gian chờ phản hồi từ ESP32 (máy in có thể đang tắt hoặc mất mạng).');
  }, 10000);

  pendingPrintJobs.set(requestId, {
    resolve: (ok, error) => {
      clearTimeout(timer);
      pendingPrintJobs.delete(requestId);
      if (ok) res.send('Đã gửi lệnh in thành công');
      else res.status(500).send('Lỗi in từ ESP32: ' + (error || 'không rõ nguyên nhân'));
    }
  });

  printerSocket.send(JSON.stringify({ type: 'print', requestId, payload: payloadBase64 }));
});

let tiktokConnection = null;

wss.on('connection', (ws) => {
  ws.on('close', () => {
    if (ws.isPrinter) {
      if (printerSocket === ws) {
        printerSocket = null;
        console.log('[Printer] ESP32 đã ngắt kết nối.');
      }
      return; // ESP32 ngắt kết nối thì không đụng gì tới phiên TikTok của trình duyệt
    }
    if (tiktokConnection) {
      try { tiktokConnection.disconnect(); } catch (e) {}
      tiktokConnection = null;
    }
  });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // ESP32 tự giới thiệu khi vừa kết nối
      if (data.type === 'hello' && data.role === 'printer') {
        if (data.token !== PRINTER_TOKEN) {
          console.warn('[Printer] Một thiết bị cố kết nối với token sai, đã từ chối.');
          ws.close();
          return;
        }
        ws.isPrinter = true;
        printerSocket = ws;
        console.log('[Printer] ✅ ESP32 đã kết nối, sẵn sàng nhận lệnh in.');
        return;
      }

      // ESP32 báo kết quả sau khi in xong (hoặc lỗi)
      if (data.type === 'print_result') {
        const job = pendingPrintJobs.get(data.requestId);
        if (job) job.resolve(data.ok, data.error);
        return;
      }

      if (data.type === 'START_TIKTOK') {
        await connectorReady; // đợi module ESM nạp xong lần đầu (nếu chưa)
        const inputUrl = (data.username || '').trim();
        let username = inputUrl;

        // Trích xuất Username từ Link hoặc tên
        if (inputUrl.includes('tiktok.com/')) {
          const match = inputUrl.match(/@([^/?#\s]+)/);
          if (match) username = match[1];
        } else {
          username = username.replace('@', '').trim();
        }
        username = username.replace(/\/+$/, '').trim();

        if (!username) {
          return ws.send(JSON.stringify({
            type: 'STATUS',
            success: false,
            msg: 'Không xác định được username TikTok từ dữ liệu nhập.'
          }));
        }

        console.log(`\n----------------------------------------`);
        console.log(`[TikTok] Nhận yêu cầu: ${inputUrl}`);
        console.log(`[TikTok] Đã trích xuất Username: @${username}`);

        if (tiktokConnection) {
          try { tiktokConnection.disconnect(); } catch (e) {}
        }

        try {
          if (typeof ConnectorClass === 'function') {
            const connectionOptions = {
              processInitialData: false,
              enableExtendedGiftInfo: false,
            };
            // Nếu bạn có API key từ https://www.eulerstream.com, điền vào biến môi trường
            // TIKTOK_SIGN_API_KEY trước khi chạy `node server-tiktok-in-phieu.js`, ví dụ:
            //   set TIKTOK_SIGN_API_KEY=xxxx   (Windows CMD)
            //   $env:TIKTOK_SIGN_API_KEY="xxxx" (PowerShell)
            if (process.env.TIKTOK_SIGN_API_KEY) {
              connectionOptions.signApiKey = process.env.TIKTOK_SIGN_API_KEY;
            }
            tiktokConnection = isV2
              ? new ConnectorClass(username, connectionOptions)
              : new ConnectorClass(username);
          } else {
            throw new Error('Chưa nạp được Class kết nối (kiểm tra log server khi khởi động).');
          }
        } catch (err) {
          console.error(`[TikTok Error] Khởi tạo thất bại:`, err.message);
          console.error(err.stack);
          return ws.send(JSON.stringify({ 
            type: 'STATUS', 
            success: false, 
            msg: `Lỗi khởi tạo: ${err.message}` 
          }));
        }

        tiktokConnection.connect().then(state => {
          console.log(`[TikTok Success] ✅ Kết nối thành công! Room ID: ${state.roomId}`);
          ws.send(JSON.stringify({ 
            type: 'STATUS', 
            success: true, 
            msg: `Đã kết nối thành công Live của: @${username}` 
          }));
        }).catch(err => {
          console.error(`[TikTok Error] ❌ Lỗi kết nối:`, err.message || err);
          let userMsg = `Lỗi kết nối TikTok: ${err.message || err}`;
          if (err.toString().includes('LIVE_NOT_FOUND') || err.toString().includes('offline')) {
            userMsg = `Tài khoản @${username} hiện KHÔNG PHÁT LIVE.`;
          }
          ws.send(JSON.stringify({ 
            type: 'STATUS', 
            success: false, 
            msg: userMsg
          }));
        });

        let debugLogged = 0;
        tiktokConnection.on('chat', data => {
          // DEBUG: in ra cấu trúc dữ liệu thật của 3 comment đầu để đối chiếu field.
          // Sau khi xác định đúng field, có thể xóa khối debug này.
          if (debugLogged < 3) {
            debugLogged++;
            console.log('[DEBUG chat payload]', JSON.stringify(data, null, 2));
          }

          const uniqueId =
            data.uniqueId ||
            data.user?.uniqueId ||
            data.user?.unique_id ||
            data.user?.displayId ||
            'unknown';

          const nickname =
            data.nickname ||
            data.user?.nickname ||
            uniqueId;

          const avatar =
            data.profilePictureUrl ||
            data.user?.profilePicture?.urls?.[0] ||
            data.user?.avatarThumb?.urlList?.[0] ||
            data.user?.avatarThumb?.url_list?.[0];

          const commentText =
            data.comment ||
            data.content ||
            data.text ||
            data.msg ||
            '';

          console.log(`[Comment] @${uniqueId}: ${commentText}`);
          ws.send(JSON.stringify({
            type: 'COMMENT',
            comment: {
              nickname,      // Tên hiển thị
              uniqueId,      // ID TikTok (@username)
              comment: commentText, // Nội dung comment
              avatar
            }
          }));
        });

        tiktokConnection.on('streamEnd', () => {
          console.log(`[TikTok] Phiên Live đã kết thúc.`);
          ws.send(JSON.stringify({ type: 'STATUS', success: false, msg: 'Phiên Live đã kết thúc.' }));
        });
      }
    } catch (e) {
      console.error('Lỗi hệ thống:', e);
    }
  });
});

const PORT = process.env.PORT || 8181;

server.listen(PORT, () => {
  console.log(`Bridge Server đang chạy tại cổng ${PORT}`);
  console.log('✅ Sẵn sàng nhận lệnh kết nối TikTok Live!');
});