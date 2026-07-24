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

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// ====== DATABASE (SQLite) ======
// QUAN TRỌNG: ổ đĩa mặc định của container trên Railway KHÔNG tồn tại lâu dài —
// mỗi lần deploy lại, container cũ bị xóa và file database cũng mất theo.
// Để dữ liệu (tài khoản, khách hàng...) sống sót qua mỗi lần deploy, cần gắn
// một Railway Volume (ổ đĩa lưu trữ lâu dài) rồi trỏ biến môi trường DATA_DIR
// tới đường dẫn mount của Volume đó (ví dụ: DATA_DIR=/data).
// Nếu chưa cấu hình DATA_DIR, sẽ dùng tạm ổ đĩa của container (mất dữ liệu khi deploy lại).
//
// Railway TỰ ĐỘNG cấp biến RAILWAY_VOLUME_MOUNT_PATH khi bạn gắn Volume vào
// service này, nên nếu bạn không tự đặt DATA_DIR, code sẽ tự dùng luôn biến
// đó — bạn chỉ cần tạo Volume trên dashboard, không cần set tay DATA_DIR nữa.
const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const usingPersistentVolume = !!(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH);

if (!usingPersistentVolume) {
  console.warn('⚠️  CẢNH BÁO: chưa gắn Railway Volume (không có DATA_DIR / RAILWAY_VOLUME_MOUNT_PATH).');
  console.warn('⚠️  Database đang lưu tạm trong container — TÀI KHOẢN SẼ MẤT khi deploy lại!');
  console.warn('⚠️  Vào Railway → tạo Volume → gắn vào service này để dữ liệu không bị mất.');
} else {
  console.log(`✅ Đang lưu database tại thư mục lâu dài: ${dataDir}`);
}

// Tự tạo thư mục nếu chưa tồn tại (phòng trường hợp Volume vừa gắn lần đầu).
try {
  fs.mkdirSync(dataDir, { recursive: true });
} catch (err) {
  console.error(`❌ Không tạo được thư mục dữ liệu "${dataDir}":`, err.message);
}

const db = new Database(path.join(dataDir, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS customer_data (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS saved_tiktok_ids (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- Lưu lịch sử toàn bộ comment theo từng phiên Live (để xem lại / in bù sau).
  -- Đặt tên bảng là "live_session_data" (khác với bảng "sessions" ở trên vốn
  -- dùng cho token đăng nhập) để tránh nhầm lẫn 2 khái niệm "session".
  CREATE TABLE IF NOT EXISTS live_session_data (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // Phiên đăng nhập: 90 ngày

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

// Tra userId từ token phiên đăng nhập — dùng chung cho cả REST API (middleware
// requireAuth bên dưới) lẫn WebSocket (nơi không có sẵn header Authorization).
function getUserIdFromToken(token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session || session.expires_at < Date.now()) {
    if (session) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return session.user_id;
}

// Middleware xác thực: đọc header "Authorization: Bearer <token>"
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const userId = getUserIdFromToken(token);
  if (!userId) {
    return res.status(401).json({ error: 'Thiếu token đăng nhập hoặc phiên đã hết hạn, vui lòng đăng nhập lại.' });
  }
  req.userId = userId;
  req.sessionToken = token;
  next();
}

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
// Mặc định Express chỉ nhận tối đa 100KB cho body dạng JSON — quá nhỏ vì dữ
// liệu lịch sử comment (customer_data, live_session_data) tích lũy theo thời
// gian có thể lớn hơn nhiều. Tăng lên 50MB để tránh lỗi "413 Payload Too Large".
app.use(express.json({ limit: '50mb' }));

// Phục vụ luôn trang giao diện (thư mục public/) — để bạn mở web bằng
// địa chỉ https://... thay vì mở file HTML trực tiếp trên máy (file://...).
// Mở file:// khiến nhiều trình duyệt (đặc biệt Firefox) chặn hẳn các request
// gọi API dù server đã cấu hình CORS đúng, vì đó là giới hạn bảo mật cố định
// của trình duyệt đối với trang mở kiểu file://, không sửa được từ phía server.
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  // Trình duyệt gửi request "OPTIONS" dò trước (preflight) khi POST kèm JSON.
  // Phải trả lời ngay ở đây (200/204), nếu không trình duyệt sẽ chặn request thật
  // và báo lỗi kiểu "không kết nối được" dù server vẫn đang chạy bình thường.
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ====== API TÀI KHOẢN & DỮ LIỆU KHÁCH HÀNG ======

// Đăng ký tài khoản mới
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Thiếu username hoặc password.' });
  }
  if (String(password).length < 4) {
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 4 ký tự.' });
  }
  const existed = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existed) {
    return res.status(409).json({ error: 'Username đã tồn tại.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)'
  ).run(username, passwordHash, salt, Date.now());

  const token = createSession(info.lastInsertRowid);
  res.json({ token, username });
});

// Đăng nhập
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Thiếu username hoặc password.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: 'Sai username hoặc password.' });
  }
  const passwordHash = hashPassword(password, user.salt);
  if (passwordHash !== user.password_hash) {
    return res.status(401).json({ error: 'Sai username hoặc password.' });
  }
  const token = createSession(user.id);
  res.json({ token, username: user.username });
});

// Đăng xuất
app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  res.json({ ok: true });
});

// Lấy danh sách khách hàng/người đã thêm của tài khoản đang đăng nhập
// Cấu trúc dữ liệu: object dạng { [uniqueId]: { nickname, uniqueId, avatar, items: [...] } }
app.get('/api/customers', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM customer_data WHERE user_id = ?').get(req.userId);
  res.json({ customers: row ? JSON.parse(row.data) : {} });
});

// Lưu (ghi đè) danh sách khách hàng/người đã thêm của tài khoản đang đăng nhập
app.post('/api/customers', requireAuth, (req, res) => {
  const { customers } = req.body || {};
  if (typeof customers !== 'object' || customers === null || Array.isArray(customers)) {
    return res.status(400).json({ error: 'Dữ liệu customers phải là một object.' });
  }
  const dataStr = JSON.stringify(customers);
  const now = Date.now();
  db.prepare(`
    INSERT INTO customer_data (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(req.userId, dataStr, now);
  res.json({ ok: true, count: Object.keys(customers).length });
});

// Lấy danh sách ID TikTok Live đã từng kết nối (để hiện lại, chọn nhanh)
// Cấu trúc dữ liệu: mảng [{ id: 'username', addedAt: number }, ...], mới nhất ở đầu
app.get('/api/tiktok-ids', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM saved_tiktok_ids WHERE user_id = ?').get(req.userId);
  res.json({ tiktokIds: row ? JSON.parse(row.data) : [] });
});

// Lưu (ghi đè) danh sách ID TikTok Live đã từng kết nối
app.post('/api/tiktok-ids', requireAuth, (req, res) => {
  const { tiktokIds } = req.body || {};
  if (!Array.isArray(tiktokIds)) {
    return res.status(400).json({ error: 'Dữ liệu tiktokIds phải là một mảng (array).' });
  }
  const dataStr = JSON.stringify(tiktokIds);
  const now = Date.now();
  db.prepare(`
    INSERT INTO saved_tiktok_ids (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(req.userId, dataStr, now);
  res.json({ ok: true, count: tiktokIds.length });
});

// Lấy lịch sử các phiên Live đã lưu (toàn bộ comment nhận được, dù đã in hay chưa)
// Cấu trúc dữ liệu: object dạng
// { [sessionId]: { username, startedAt, comments: [{id, nickname, uniqueId, avatar, comment, receivedAt, added}] } }
app.get('/api/sessions', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM live_session_data WHERE user_id = ?').get(req.userId);
  res.json({ sessions: row ? JSON.parse(row.data) : {} });
});

// Lưu (ghi đè) lịch sử các phiên Live của tài khoản đang đăng nhập
app.post('/api/sessions', requireAuth, (req, res) => {
  const { sessions } = req.body || {};
  if (typeof sessions !== 'object' || sessions === null || Array.isArray(sessions)) {
    return res.status(400).json({ error: 'Dữ liệu sessions phải là một object.' });
  }
  const dataStr = JSON.stringify(sessions);
  const now = Date.now();
  db.prepare(`
    INSERT INTO live_session_data (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(req.userId, dataStr, now);
  res.json({ ok: true, count: Object.keys(sessions).length });
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
// Username của phiên Live đang mở hiện tại (null nếu chưa kết nối gì).
// Dùng để: (1) mọi thiết bị mới mở trang có thể hỏi lại trạng thái hiện tại,
// (2) tránh việc 2 thiết bị cùng bấm kết nối 1 username giống nhau làm ngắt
// rồi nối lại gây giật cho những thiết bị khác đang xem.
let currentLiveUsername = null;

// Lưu tạm các comment gần đây nhất của phiên Live hiện tại (tối đa 200 dòng).
// Khi 1 thiết bị mới mở trang/kết nối lại trong lúc đang live, server gửi
// nguyên lịch sử này cho nó để đồng bộ ngay, không phải chờ có comment mới.
let commentHistory = [];
const COMMENT_HISTORY_LIMIT = 200;

// Gửi 1 message tới TẤT CẢ trình duyệt đang mở trang (bỏ qua socket của ESP32),
// để mọi thiết bị (laptop, điện thoại...) luôn thấy cùng 1 luồng dữ liệu.
function broadcastToBrowsers(msgObj) {
  const payload = JSON.stringify(msgObj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && !client.isPrinter) {
      client.send(payload);
    }
  });
}

// "Thế hệ" (generation) của kết nối TikTok hiện tại. Mỗi lần bắt đầu 1 phiên
// Live mới (kể cả kết nối lại cùng 1 ID), số này tăng lên 1. Các listener
// (chat, streamEnd, connect...) của phiên CŨ đều tự kiểm tra "mình có còn là
// thế hệ mới nhất không" trước khi gửi dữ liệu về trình duyệt — nếu không,
// coi như dữ liệu đó đã lỗi thời và bỏ qua. Đây là lớp bảo vệ chính chống
// hiện tượng lẫn comment của phiên Live cũ vào phiên Live mới, vì thư viện
// tiktok-live-connector có thể vẫn bắn nốt vài sự kiện "chat" của phòng cũ
// trong khoảnh khắc ngắn trước khi disconnect() thật sự có hiệu lực.
let tiktokConnectionGeneration = 0;

// Gỡ toàn bộ listener + ngắt kết nối 1 connector cũ một cách an toàn.
function shutdownTiktokConnection(conn) {
  if (!conn) return;
  try { conn.removeAllListeners('chat'); } catch (e) {}
  try { conn.removeAllListeners('streamEnd'); } catch (e) {}
  try { conn.disconnect(); } catch (e) {}
}

wss.on('connection', (ws) => {
  // Thiết bị (trình duyệt) vừa mở kết nối. Nếu đang có 1 phiên Live đang chạy,
  // gửi ngay trạng thái hiện tại + toàn bộ lịch sử comment gần đây cho thiết bị
  // này, để nó đồng bộ ngay lập tức mà không cần đợi comment mới hay phải tự
  // bấm "Kết Nối" lại. An toàn với cả ESP32: firmware ESP32 chỉ xử lý message
  // có type "print", các type khác (STATUS/HISTORY) nó tự bỏ qua.
  if (currentLiveUsername) {
    ws.send(JSON.stringify({
      type: 'STATUS',
      success: true,
      msg: `Đã kết nối thành công Live của: @${currentLiveUsername}`,
      roomUsername: currentLiveUsername
    }));
    if (commentHistory.length) {
      ws.send(JSON.stringify({
        type: 'HISTORY',
        roomUsername: currentLiveUsername,
        comments: commentHistory
      }));
    }
  }

  ws.on('close', () => {
    if (ws.isPrinter) {
      if (printerSocket === ws) {
        printerSocket = null;
        console.log('[Printer] ESP32 đã ngắt kết nối.');
      }
      return; // ESP32 ngắt kết nối thì không đụng gì tới phiên TikTok của trình duyệt
    }
    // Nhiều thiết bị (laptop, điện thoại...) có thể cùng xem 1 phiên Live.
    // Chỉ thực sự ngắt kết nối TikTok khi KHÔNG CÒN thiết bị trình duyệt nào
    // đang mở trang nữa — tránh việc 1 thiết bị đóng tab làm mất live của
    // các thiết bị khác đang xem.
    const conNguoiXemKhac = Array.from(wss.clients).some(
      (client) => client !== ws && client.readyState === WebSocket.OPEN && !client.isPrinter
    );
    if (conNguoiXemKhac) return;

    if (tiktokConnection) {
      shutdownTiktokConnection(tiktokConnection);
      tiktokConnection = null;
      currentLiveUsername = null;
      commentHistory = [];
    }
    tiktokConnectionGeneration++; // vô hiệu hóa mọi sự kiện cũ còn sót lại của trình duyệt này
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

      // Xóa 1 phiên lịch sử — xóa THẲNG trên dữ liệu đã lưu trong DB (không
      // phải ghi đè toàn bộ bằng bản sao cục bộ của trình duyệt), để tránh
      // trường hợp 1 thiết bị khác đang giữ bản dữ liệu cũ (chưa kịp đồng bộ)
      // lỡ ghi đè làm "hồi sinh" lại phiên vừa xóa. Sau khi xóa xong, phát tin
      // cho MỌI thiết bị đang mở trang để chúng tự xóa khỏi giao diện ngay,
      // không cần tải lại trang.
      if (data.type === 'DELETE_SESSION') {
        const userId = getUserIdFromToken(data.token);
        if (!userId || !data.sessionId) return;
        const row = db.prepare('SELECT data FROM live_session_data WHERE user_id = ?').get(userId);
        const sessions = row ? JSON.parse(row.data) : {};
        if (sessions[data.sessionId]) {
          delete sessions[data.sessionId];
          db.prepare(`
            INSERT INTO live_session_data (user_id, data, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
          `).run(userId, JSON.stringify(sessions), Date.now());
        }
        broadcastToBrowsers({ type: 'SESSION_DELETED', sessionId: data.sessionId });
        return;
      }

      // Xóa 1 sản phẩm khỏi giỏ hàng của 1 khách hàng — cùng nguyên tắc: xóa
      // thẳng trên dữ liệu đã lưu, rồi phát tin cho mọi thiết bị tự cập nhật.
      if (data.type === 'DELETE_CART_ITEM') {
        const userId = getUserIdFromToken(data.token);
        if (!userId || !data.customerId || !data.itemId) return;
        const row = db.prepare('SELECT data FROM customer_data WHERE user_id = ?').get(userId);
        const customersData = row ? JSON.parse(row.data) : {};
        let customerRemoved = false;
        if (customersData[data.customerId]) {
          customersData[data.customerId].items = (customersData[data.customerId].items || [])
            .filter(it => it.id !== data.itemId);
          if (customersData[data.customerId].items.length === 0) {
            delete customersData[data.customerId];
            customerRemoved = true;
          }
          db.prepare(`
            INSERT INTO customer_data (user_id, data, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
          `).run(userId, JSON.stringify(customersData), Date.now());
        }
        broadcastToBrowsers({
          type: 'CART_ITEM_DELETED',
          customerId: data.customerId,
          itemId: data.itemId,
          customerRemoved
        });
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

        // Nếu đúng phiên Live này đang chạy sẵn rồi (do 1 thiết bị khác đã kết
        // nối trước đó), không cần ngắt/nối lại — chỉ đồng bộ trạng thái + lịch
        // sử cho riêng thiết bị vừa bấm, để không làm gián đoạn các thiết bị
        // khác đang xem cùng phiên Live đó.
        if (tiktokConnection && currentLiveUsername && currentLiveUsername.toLowerCase() === username.toLowerCase()) {
          console.log(`[TikTok] @${username} đã đang kết nối sẵn -> chỉ đồng bộ lại, không nối lại.`);
          ws.send(JSON.stringify({
            type: 'STATUS',
            success: true,
            msg: `Đã kết nối thành công Live của: @${username}`,
            roomUsername: username
          }));
          if (commentHistory.length) {
            ws.send(JSON.stringify({ type: 'HISTORY', roomUsername: username, comments: commentHistory }));
          }
          return;
        }

        if (tiktokConnection) {
          shutdownTiktokConnection(tiktokConnection);
          tiktokConnection = null;
        }
        currentLiveUsername = null;
        commentHistory = [];
        tiktokConnectionGeneration++;
        const myGeneration = tiktokConnectionGeneration; // "chứng minh thư" của phiên kết nối này

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
          if (myGeneration !== tiktokConnectionGeneration) return; // đã có phiên mới hơn thay thế, bỏ qua kết quả trễ này
          console.log(`[TikTok Success] ✅ Kết nối thành công! Room ID: ${state.roomId}`);
          currentLiveUsername = username; // đánh dấu đây là phiên Live đang mở, để mọi thiết bị mới đều đồng bộ theo
          broadcastToBrowsers({
            type: 'STATUS',
            success: true,
            msg: `Đã kết nối thành công Live của: @${username}`,
            roomUsername: username
          });
        }).catch(err => {
          if (myGeneration !== tiktokConnectionGeneration) return; // đã có phiên mới hơn thay thế, bỏ qua lỗi trễ này
          console.error(`[TikTok Error] ❌ Lỗi kết nối:`, err.message || err);
          let userMsg = `Lỗi kết nối TikTok: ${err.message || err}`;
          if (err.toString().includes('LIVE_NOT_FOUND') || err.toString().includes('offline')) {
            userMsg = `Tài khoản @${username} hiện KHÔNG PHÁT LIVE.`;
          }
          broadcastToBrowsers({ type: 'STATUS', success: false, msg: userMsg });
        });

        let debugLogged = 0;
        tiktokConnection.on('chat', data => {
          if (myGeneration !== tiktokConnectionGeneration) return; // comment trễ từ phiên Live cũ -> bỏ qua, không gửi về trình duyệt

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
          const commentObj = {
            nickname,
            uniqueId,
            comment: commentText,
            avatar,
            receivedAt: new Date().toISOString() // mốc thời gian thống nhất, để mọi thiết bị hiện đúng cùng 1 giờ nhận
          };

          commentHistory.push(commentObj);
          if (commentHistory.length > COMMENT_HISTORY_LIMIT) commentHistory.shift();

          broadcastToBrowsers({
            type: 'COMMENT',
            roomUsername: username, // ID phòng Live mà comment này thuộc về, để trình duyệt tự đối chiếu thêm 1 lớp nữa
            comment: commentObj
          });
        });

        tiktokConnection.on('streamEnd', () => {
          if (myGeneration !== tiktokConnectionGeneration) return; // sự kiện trễ từ phiên Live cũ -> bỏ qua
          console.log(`[TikTok] Phiên Live đã kết thúc.`);
          currentLiveUsername = null;
          commentHistory = [];
          broadcastToBrowsers({ type: 'STATUS', success: false, msg: 'Phiên Live đã kết thúc.' });
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
