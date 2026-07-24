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
// Node 22+ có SQLite đồng bộ tích hợp sẵn, không cần node-gyp/Visual Studio C++.
const { DatabaseSync: Database } = require('node:sqlite');

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
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_banned INTEGER NOT NULL DEFAULT 0,
    banned_reason TEXT,
    banned_at INTEGER
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

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    stock INTEGER,
    aliases TEXT NOT NULL DEFAULT '[]',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, code),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    source_comment_id TEXT,
    source_session_id TEXT,
    customer_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    product_code TEXT,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL DEFAULT 0,
    shipping_fee INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    phone TEXT,
    address TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    print_status TEXT NOT NULL DEFAULT 'not_printed',
    print_attempts INTEGER NOT NULL DEFAULT 0,
    last_print_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_comment
    ON orders(user_id, source_comment_id)
    WHERE source_comment_id IS NOT NULL AND deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    detail TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ====== MIGRATION: đảm bảo DB cũ (tạo trước khi có tính năng admin) cũng có
// đủ các cột is_admin / is_banned / banned_reason / banned_at. Với DB mới tạo
// từ đầu thì các cột này đã có sẵn trong CREATE TABLE ở trên, ALTER TABLE bên
// dưới sẽ báo lỗi "duplicate column" và bị try/catch bỏ qua — không sao cả.
function ensureColumn(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[Migration] Đã thêm cột "${column}" vào bảng "${table}".`);
  } catch (err) {
    // Cột đã tồn tại từ trước -> bỏ qua, không phải lỗi thật.
  }
}
ensureColumn('users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'is_banned', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'banned_reason', 'TEXT');
ensureColumn('users', 'banned_at', 'INTEGER');

// ====== CỘT PHỤC VỤ TÍNH NĂNG KEY / GÓI IN PHIẾU ======
// license_type: 'free' (mặc định, tài khoản mới đăng ký) | '1m' | '3m' | '6m' | '12m' | 'lifetime'
// license_expires_at: mốc thời gian (ms) hết hạn gói, NULL nếu là 'free' hoặc 'lifetime'
// license_granted_at: lần gần nhất admin cấp/gia hạn gói (để hiển thị lịch sử)
// live_sessions_used: số phiên Live tài khoản "free" đã bấm kết nối (tối đa FREE_LIVE_SESSION_LIMIT)
ensureColumn('users', 'license_type', "TEXT NOT NULL DEFAULT 'free'");
ensureColumn('users', 'license_expires_at', 'INTEGER');
ensureColumn('users', 'license_granted_at', 'INTEGER');
ensureColumn('users', 'live_sessions_used', 'INTEGER NOT NULL DEFAULT 0');

// ====== MÃ MÁY IN RIÊNG CHO TỪNG TÀI KHOẢN ======
// Trước đây server chỉ có 1 PRINTER_TOKEN dùng chung cho MỌI tài khoản -> dù
// ai bấm "in" thì lệnh cũng chỉ gửi tới đúng 1 chiếc ESP32 đang giữ kết nối
// (kiểu "ai kết nối trước thì nhận hết lệnh in"). Để mỗi tài khoản có máy in
// RIÊNG của mình, mỗi user cần 1 mã bí mật (printer_token) không trùng nhau:
// - Nạp đúng mã này vào firmware ESP32 của tài khoản đó (thay cho PRINTER_TOKEN cũ).
// - Server dùng mã này để biết ESP32 vừa kết nối là "thuộc về" user nào, và khi
//   user đó bấm in, lệnh chỉ gửi tới đúng ESP32 đã đăng ký mã của họ.
ensureColumn('users', 'printer_token', 'TEXT');
ensureColumn('sessions', 'device_name', 'TEXT');
ensureColumn('sessions', 'user_agent', 'TEXT');
ensureColumn('sessions', 'last_seen_at', 'INTEGER');
function generatePrinterToken() {
  return crypto.randomBytes(5).toString('hex').toUpperCase(); // vd: "A1B2C3D4E5" - đủ ngắn để gõ vào firmware
}
// Backfill: cấp mã máy in cho các tài khoản có sẵn từ trước (tạo trước khi có tính năng này).
(function backfillPrinterTokens() {
  const rows = db.prepare('SELECT id FROM users WHERE printer_token IS NULL OR printer_token = \'\'').all();
  if (!rows.length) return;
  const stmt = db.prepare('UPDATE users SET printer_token = ? WHERE id = ?');
  for (const row of rows) {
    let token;
    do { token = generatePrinterToken(); } while (db.prepare('SELECT id FROM users WHERE printer_token = ?').get(token));
    stmt.run(token, row.id);
  }
  console.log(`[Printer] Đã cấp Mã Máy In riêng cho ${rows.length} tài khoản có sẵn.`);
})();

// ====== TÀI KHOẢN ADMIN GỐC ======
// Tạo (hoặc nâng cấp) 1 tài khoản admin từ biến môi trường ADMIN_USERNAME /
// ADMIN_PASSWORD mỗi khi server khởi động, để luôn có ít nhất 1 admin quản lý
// được các tài khoản khác — kể cả khi database vừa được tạo mới hoàn toàn.
// Nếu không đặt biến môi trường, sẽ KHÔNG tự tạo admin nào (an toàn hơn để
// tài khoản admin không bị lộ mật khẩu mặc định).
(function ensureAdminAccount() {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminUsername || !adminPassword) {
    console.warn('⚠️  Chưa đặt ADMIN_USERNAME / ADMIN_PASSWORD -> chưa có tài khoản admin nào được tạo tự động.');
    console.warn('⚠️  Đặt 2 biến môi trường này rồi khởi động lại server để có tài khoản admin đầu tiên.');
    return;
  }
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(adminUsername);
  if (existing) {
    if (!existing.is_admin) {
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
      console.log(`✅ Đã nâng quyền admin cho tài khoản có sẵn: @${adminUsername}`);
    } else {
      console.log(`✅ Tài khoản admin @${adminUsername} đã sẵn sàng.`);
    }
    return;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(adminPassword, salt);
  db.prepare(
    'INSERT INTO users (username, password_hash, salt, created_at, is_admin, is_banned) VALUES (?, ?, ?, ?, 1, 0)'
  ).run(adminUsername, passwordHash, salt, Date.now());
  console.log(`✅ Đã tạo tài khoản admin đầu tiên: @${adminUsername}`);
})();

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // Phiên đăng nhập: 90 ngày

// ====== HỆ THỐNG KEY / GÓI IN PHIẾU ======
// Tài khoản vừa đăng ký (gói "free") chỉ được xem tối đa FREE_LIVE_SESSION_LIMIT
// phiên Live (mỗi lần bấm "Kết Nối" tính là 1 phiên) và KHÔNG được dùng tính
// năng in. Admin cấp gói theo tháng (hoặc vĩnh viễn) để mở khóa tính năng in
// và bỏ giới hạn số phiên Live.
const FREE_LIVE_SESSION_LIMIT = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const LICENSE_DURATIONS_MS = {
  '1m': 30 * DAY_MS,
  '3m': 90 * DAY_MS,
  '6m': 180 * DAY_MS,
  '12m': 365 * DAY_MS,
};
const LICENSE_LABELS = {
  free: 'Miễn phí',
  '1m': '1 tháng',
  '3m': '3 tháng',
  '6m': '6 tháng',
  '12m': '12 tháng',
  lifetime: 'Vĩnh viễn',
};

// Ghi lại (trong bộ nhớ) các lần 1 tài khoản bị chặn vì chưa có gói/hết gói,
// để admin có thể xem "nhật ký" ai đang bị khóa tính năng mà chưa nâng cấp.
// Không cần bền vững qua mỗi lần restart server nên không lưu xuống DB.
const LICENSE_LOG_LIMIT = 300;
const licenseLockLogs = [];
function logLicenseLock(username, feature, message) {
  licenseLockLogs.push({ username, feature, message, at: Date.now() });
  if (licenseLockLogs.length > LICENSE_LOG_LIMIT) licenseLockLogs.shift();
  console.log(`[License] 🔒 @${username} bị chặn tính năng "${feature}": ${message}`);
}

// Tính trạng thái gói hiện tại của 1 user (đọc trực tiếp từ row DB của bảng users).
function getLicenseInfo(user) {
  const now = Date.now();
  const type = user.license_type || 'free';

  if (type === 'lifetime') {
    return { type, label: LICENSE_LABELS.lifetime, canPrint: true, isExpired: false, expiresAt: null, daysLeft: null };
  }

  if (type === 'free' || !user.license_expires_at) {
    return { type: 'free', label: LICENSE_LABELS.free, canPrint: false, isExpired: false, expiresAt: null, daysLeft: null };
  }

  const isExpired = user.license_expires_at <= now;
  const daysLeft = isExpired ? 0 : Math.ceil((user.license_expires_at - now) / DAY_MS);
  return {
    type,
    label: LICENSE_LABELS[type] || type,
    canPrint: !isExpired,
    isExpired,
    expiresAt: user.license_expires_at,
    daysLeft,
  };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const deviceName = String(req?.body?.deviceName || '').trim().slice(0, 80) || null;
  const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 300) || null;
  db.prepare(`INSERT INTO sessions
    (token, user_id, created_at, expires_at, device_name, user_agent, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(token, userId, now, now + SESSION_TTL_MS, deviceName, userAgent, now);
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
// Đồng thời kiểm tra tài khoản có đang bị admin khóa hay không — nếu bị khóa
// SAU KHI đã đăng nhập từ trước (phiên/token vẫn còn hạn), thiết bị đó vẫn bị
// từ chối ngay lập tức ở lần gọi API kế tiếp, không phải đợi hết hạn 90 ngày.
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const userId = getUserIdFromToken(token);
  if (!userId) {
    return res.status(401).json({ error: 'Thiếu token đăng nhập hoặc phiên đã hết hạn, vui lòng đăng nhập lại.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(401).json({ error: 'Tài khoản không còn tồn tại, vui lòng đăng nhập lại.' });
  }
  if (user.is_banned) {
    // Xóa luôn session để buộc đăng nhập lại (và sẽ bị chặn ngay ở /api/login).
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return res.status(403).json({
      error: `Tài khoản @${user.username} đã bị khóa${user.banned_reason ? ': ' + user.banned_reason : '.'}`,
      banned: true
    });
  }
  req.userId = userId;
  req.sessionToken = token;
  req.isAdmin = !!user.is_admin;
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(Date.now(), token);
  next();
}

// Middleware phân quyền admin: phải dùng SAU requireAuth trên cùng 1 route.
function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Chỉ tài khoản admin mới được thực hiện thao tác này.' });
  }
  next();
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Mỗi tài khoản có 1 ESP32 (máy in) riêng, xác thực bằng printer_token riêng
// của chính tài khoản đó (xem cột "printer_token" trong bảng users ở trên).
// Map: userId -> ws (socket của ESP32 đang giữ kết nối cho tài khoản đó).
// Nhờ dùng Map theo userId thay vì 1 biến duy nhất, lệnh in của tài khoản A
// sẽ KHÔNG BAO GIỜ gửi nhầm sang ESP32 của tài khoản B.
const printerSockets = new Map();

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
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 8 ký tự.' });
  }
  const existed = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existed) {
    return res.status(409).json({ error: 'Username đã tồn tại.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  let printerToken;
  do { printerToken = generatePrinterToken(); } while (db.prepare('SELECT id FROM users WHERE printer_token = ?').get(printerToken));
  const info = db.prepare(
    'INSERT INTO users (username, password_hash, salt, created_at, printer_token) VALUES (?, ?, ?, ?, ?)'
  ).run(username, passwordHash, salt, Date.now(), printerToken);

  const token = createSession(info.lastInsertRowid, req);
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
  if (user.is_banned) {
    return res.status(403).json({
      error: `Tài khoản @${user.username} đã bị khóa${user.banned_reason ? ': ' + user.banned_reason : '.'}`,
      banned: true
    });
  }
  const token = createSession(user.id, req);
  res.json({ token, username: user.username });
});

// Đăng xuất
app.post('/api/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  res.json({ ok: true });
});

// Thông tin tài khoản đang đăng nhập (dùng để frontend biết có phải admin
// không, từ đó quyết định có hiện tab "Quản trị" hay không).
app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const license = getLicenseInfo(user);
  res.json({
    id: user.id,
    username: user.username,
    isAdmin: !!user.is_admin,
    createdAt: user.created_at,
    license,
    liveSessionsUsed: user.live_sessions_used || 0,
    freeLiveSessionLimit: FREE_LIVE_SESSION_LIMIT,
    printerToken: user.printer_token,
    printerConnected: printerSockets.has(user.id)
  });
});

// ====== API QUẢN TRỊ (ADMIN) ======
// Tất cả route bên dưới đều yêu cầu đăng nhập VÀ tài khoản đó phải có is_admin = 1.

// Danh sách toàn bộ tài khoản trong hệ thống (không trả về password_hash/salt).
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM users ORDER BY id ASC'
  ).all();
  res.json({
    users: rows.map(u => ({
      id: u.id,
      username: u.username,
      createdAt: u.created_at,
      isAdmin: !!u.is_admin,
      isBanned: !!u.is_banned,
      bannedReason: u.banned_reason || null,
      bannedAt: u.banned_at || null,
      license: getLicenseInfo(u),
      liveSessionsUsed: u.live_sessions_used || 0,
      freeLiveSessionLimit: FREE_LIVE_SESSION_LIMIT
    }))
  });
});

// Admin cấp / gia hạn gói cho 1 tài khoản. body: { type: 'free'|'1m'|'3m'|'6m'|'12m'|'lifetime' }
// - 'lifetime': mở khóa in vĩnh viễn, không có hạn.
// - '1m'/'3m'/'6m'/'12m': mở khóa in trong đúng số tháng tương ứng, đếm ngược
//   từ NGÀY HẾT HẠN GÓI CŨ nếu gói cũ còn hạn (gia hạn cộng dồn), hoặc từ thời
//   điểm hiện tại nếu gói cũ đã hết hạn / chưa từng có gói.
// - 'free': thu hồi gói, đưa tài khoản về lại trạng thái miễn phí (và cấp lại
//   đủ FREE_LIVE_SESSION_LIMIT phiên Live để dùng thử lại từ đầu).
app.post('/api/admin/users/:id/license', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const { type } = req.body || {};
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });

  const validTypes = ['free', '1m', '3m', '6m', '12m', 'lifetime'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Loại gói không hợp lệ.' });
  }

  const now = Date.now();
  let expiresAt = null;
  if (type === '1m' || type === '3m' || type === '6m' || type === '12m') {
    const base = (target.license_expires_at && target.license_expires_at > now) ? target.license_expires_at : now;
    expiresAt = base + LICENSE_DURATIONS_MS[type];
  }

  db.prepare(
    'UPDATE users SET license_type = ?, license_expires_at = ?, license_granted_at = ?, live_sessions_used = 0 WHERE id = ?'
  ).run(type, expiresAt, now, targetId);

  console.log(`[License] ✅ Admin đã cấp gói "${LICENSE_LABELS[type] || type}" cho tài khoản @${target.username}.`);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  res.json({
    ok: true,
    message: `Đã cấp gói "${LICENSE_LABELS[type] || type}" cho @${target.username}.`,
    license: getLicenseInfo(updated)
  });
});

// Nhật ký các lần tài khoản (bất kỳ) bị chặn tính năng in / xem live vì chưa
// có gói hoặc đã hết hạn — giúp admin biết ai đang cần được tư vấn mua gói.
app.get('/api/admin/license-logs', requireAuth, requireAdmin, (req, res) => {
  res.json({ logs: licenseLockLogs.slice(-100).reverse() });
});

// Khóa 1 tài khoản (báo tài khoản đó đã bị khóa + kick mọi phiên đang đăng
// nhập của tài khoản đó ra ngay lập tức).
app.post('/api/admin/users/:id/ban', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const { reason } = req.body || {};
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  if (target.id === req.userId) {
    return res.status(400).json({ error: 'Không thể tự khóa chính tài khoản admin đang đăng nhập.' });
  }
  db.prepare('UPDATE users SET is_banned = 1, banned_reason = ?, banned_at = ? WHERE id = ?')
    .run(reason || null, Date.now(), targetId);
  // Kick ngay: xóa hết session hiện có của tài khoản bị khóa.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
  res.json({ ok: true, message: `Đã khóa tài khoản @${target.username} và báo cáo tài khoản đã bị khóa.` });
});

// Mở khóa lại 1 tài khoản.
app.post('/api/admin/users/:id/unban', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  db.prepare('UPDATE users SET is_banned = 0, banned_reason = NULL, banned_at = NULL WHERE id = ?').run(targetId);
  res.json({ ok: true, message: `Đã mở khóa tài khoản @${target.username}.` });
});

// Xóa vĩnh viễn 1 tài khoản + toàn bộ dữ liệu liên quan (khách hàng, ID
// TikTok đã lưu, lịch sử phiên Live, các phiên đăng nhập).
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  if (target.id === req.userId) {
    return res.status(400).json({ error: 'Không thể tự xóa chính tài khoản admin đang đăng nhập.' });
  }
  const deleteAll = db.transaction((id) => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM customer_data WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM saved_tiktok_ids WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM live_session_data WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });
  deleteAll(targetId);
  res.json({ ok: true, message: `Đã xóa tài khoản @${target.username}.` });
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

// ====== V2: ĐƠN HÀNG, SẢN PHẨM, CÀI ĐẶT, BẢO MẬT & SAO LƯU ======
const ORDER_STATUSES = new Set(['new', 'confirmed', 'packing', 'shipped', 'completed', 'cancelled', 'returned']);
const PAYMENT_STATUSES = new Set(['unpaid', 'partial', 'paid', 'refunded']);

function cleanText(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function intValue(value, fallback = 0, min = 0, max = 1000000000) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function addAudit(userId, action, entityType, entityId, detail) {
  db.prepare(`INSERT INTO audit_logs
    (user_id, action, entity_type, entity_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, action, entityType || null, entityId || null,
      detail == null ? null : JSON.stringify(detail), Date.now());
}

function publicOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceCommentId: row.source_comment_id,
    sourceSessionId: row.source_session_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    productCode: row.product_code,
    productName: row.product_name,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    shippingFee: row.shipping_fee,
    total: row.total,
    phone: row.phone || '',
    address: row.address || '',
    note: row.note || '',
    status: row.status,
    paymentStatus: row.payment_status,
    printStatus: row.print_status,
    printAttempts: row.print_attempts,
    lastPrintError: row.last_print_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

app.get('/api/orders', requireAuth, (req, res) => {
  const where = ['user_id = ?', 'deleted_at IS NULL'];
  const args = [req.userId];
  if (req.query.status && ORDER_STATUSES.has(req.query.status)) {
    where.push('status = ?');
    args.push(req.query.status);
  }
  if (req.query.date) {
    const start = new Date(`${req.query.date}T00:00:00`).getTime();
    const end = new Date(`${req.query.date}T23:59:59.999`).getTime();
    if (Number.isFinite(start) && Number.isFinite(end)) {
      where.push('created_at BETWEEN ? AND ?');
      args.push(start, end);
    }
  }
  const q = cleanText(req.query.q, 100).toLowerCase();
  if (q) {
    where.push(`(lower(customer_id) LIKE ? OR lower(customer_name) LIKE ?
      OR lower(product_code) LIKE ? OR lower(product_name) LIKE ? OR lower(phone) LIKE ?)`);
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
  }
  const rows = db.prepare(`SELECT * FROM orders WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC LIMIT 5000`).all(...args);
  res.json({ orders: rows.map(publicOrder) });
});

app.post('/api/orders', requireAuth, (req, res) => {
  const b = req.body || {};
  const customerId = cleanText(b.customerId, 120);
  const customerName = cleanText(b.customerName, 160) || customerId;
  const productName = cleanText(b.productName, 240) || cleanText(b.comment, 240);
  if (!customerId || !productName) {
    return res.status(400).json({ error: 'Đơn hàng cần có khách hàng và sản phẩm.' });
  }
  const sourceCommentId = cleanText(b.sourceCommentId, 160) || null;
  if (sourceCommentId) {
    const existing = db.prepare(`SELECT * FROM orders
      WHERE user_id = ? AND source_comment_id = ? AND deleted_at IS NULL`)
      .get(req.userId, sourceCommentId);
    if (existing) return res.status(409).json({
      error: 'Bình luận này đã được tạo đơn.',
      duplicate: true,
      order: publicOrder(existing)
    });
  }
  const quantity = intValue(b.quantity, 1, 1, 9999);
  const unitPrice = intValue(b.unitPrice, 0);
  const shippingFee = intValue(b.shippingFee, 0);
  const total = quantity * unitPrice + shippingFee;
  const id = makeId('ord');
  const now = Date.now();
  db.prepare(`INSERT INTO orders
    (id, user_id, source_comment_id, source_session_id, customer_id, customer_name,
     product_code, product_name, quantity, unit_price, shipping_fee, total, phone,
     address, note, status, payment_status, print_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, 'not_printed', ?, ?)`)
    .run(id, req.userId, sourceCommentId, cleanText(b.sourceSessionId, 160) || null,
      customerId, customerName, cleanText(b.productCode, 80) || null, productName,
      quantity, unitPrice, shippingFee, total, cleanText(b.phone, 40) || null,
      cleanText(b.address, 500) || null, cleanText(b.note, 1000) || null,
      PAYMENT_STATUSES.has(b.paymentStatus) ? b.paymentStatus : 'unpaid', now, now);
  addAudit(req.userId, 'order.created', 'order', id, { sourceCommentId, total });
  res.status(201).json({ order: publicOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)) });
});

app.put('/api/orders/:id', requireAuth, (req, res) => {
  const old = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.userId);
  if (!old) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
  const b = req.body || {};
  const quantity = intValue(b.quantity, old.quantity, 1, 9999);
  const unitPrice = intValue(b.unitPrice, old.unit_price);
  const shippingFee = intValue(b.shippingFee, old.shipping_fee);
  const status = ORDER_STATUSES.has(b.status) ? b.status : old.status;
  const paymentStatus = PAYMENT_STATUSES.has(b.paymentStatus) ? b.paymentStatus : old.payment_status;
  db.prepare(`UPDATE orders SET customer_name = ?, product_code = ?, product_name = ?,
    quantity = ?, unit_price = ?, shipping_fee = ?, total = ?, phone = ?, address = ?,
    note = ?, status = ?, payment_status = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(cleanText(b.customerName, 160) || old.customer_name,
      cleanText(b.productCode, 80) || null,
      cleanText(b.productName, 240) || old.product_name,
      quantity, unitPrice, shippingFee, quantity * unitPrice + shippingFee,
      cleanText(b.phone, 40) || null, cleanText(b.address, 500) || null,
      cleanText(b.note, 1000) || null, status, paymentStatus, Date.now(),
      req.params.id, req.userId);
  addAudit(req.userId, 'order.updated', 'order', req.params.id, { status, paymentStatus });
  res.json({ order: publicOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)) });
});

app.post('/api/orders/:id/print-result', requireAuth, (req, res) => {
  const ok = !!req.body?.ok;
  const result = db.prepare(`UPDATE orders SET print_status = ?, print_attempts = print_attempts + 1,
    last_print_error = ?, updated_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .run(ok ? 'printed' : 'failed', ok ? null : cleanText(req.body?.error, 500), Date.now(),
      req.params.id, req.userId);
  if (!result.changes) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
  addAudit(req.userId, ok ? 'order.printed' : 'order.print_failed', 'order', req.params.id,
    ok ? null : { error: cleanText(req.body?.error, 500) });
  res.json({ ok: true });
});

app.delete('/api/orders/:id', requireAuth, (req, res) => {
  const result = db.prepare(`UPDATE orders SET deleted_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .run(Date.now(), Date.now(), req.params.id, req.userId);
  if (!result.changes) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
  addAudit(req.userId, 'order.deleted', 'order', req.params.id);
  res.json({ ok: true });
});

app.get('/api/products', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE user_id = ? ORDER BY active DESC, code ASC').all(req.userId);
  res.json({ products: rows.map(p => ({
    id: p.id, code: p.code, name: p.name, price: p.price, stock: p.stock,
    aliases: JSON.parse(p.aliases || '[]'), active: !!p.active,
    createdAt: p.created_at, updatedAt: p.updated_at
  })) });
});

app.post('/api/products', requireAuth, (req, res) => {
  const b = req.body || {};
  const code = cleanText(b.code, 80).toUpperCase();
  const name = cleanText(b.name, 240);
  if (!code || !name) return res.status(400).json({ error: 'Sản phẩm cần mã và tên.' });
  const id = makeId('prd');
  const now = Date.now();
  try {
    db.prepare(`INSERT INTO products
      (id, user_id, code, name, price, stock, aliases, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, req.userId, code, name, intValue(b.price, 0),
        b.stock === '' || b.stock == null ? null : intValue(b.stock, 0, 0, 9999999),
        JSON.stringify(Array.isArray(b.aliases) ? b.aliases.map(x => cleanText(x, 80)).filter(Boolean) : []),
        now, now);
  } catch (err) {
    if (String(err.code).includes('CONSTRAINT')) return res.status(409).json({ error: 'Mã sản phẩm đã tồn tại.' });
    throw err;
  }
  addAudit(req.userId, 'product.created', 'product', id, { code });
  res.status(201).json({ ok: true, id });
});

app.put('/api/products/:id', requireAuth, (req, res) => {
  const b = req.body || {};
  const result = db.prepare(`UPDATE products SET code = ?, name = ?, price = ?, stock = ?,
    aliases = ?, active = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(cleanText(b.code, 80).toUpperCase(), cleanText(b.name, 240), intValue(b.price, 0),
      b.stock === '' || b.stock == null ? null : intValue(b.stock, 0, 0, 9999999),
      JSON.stringify(Array.isArray(b.aliases) ? b.aliases.map(x => cleanText(x, 80)).filter(Boolean) : []),
      b.active === false ? 0 : 1, Date.now(), req.params.id, req.userId);
  if (!result.changes) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
  addAudit(req.userId, 'product.updated', 'product', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM products WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  if (!result.changes) return res.status(404).json({ error: 'Không tìm thấy sản phẩm.' });
  addAudit(req.userId, 'product.deleted', 'product', req.params.id);
  res.json({ ok: true });
});

app.get('/api/settings', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM user_settings WHERE user_id = ?').get(req.userId);
  res.json({ settings: row ? JSON.parse(row.data) : {} });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const allowed = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : {};
  const data = JSON.stringify(allowed).slice(0, 100000);
  db.prepare(`INSERT INTO user_settings (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(req.userId, data, Date.now());
  addAudit(req.userId, 'settings.updated', 'settings', String(req.userId));
  res.json({ ok: true });
});

app.post('/api/account/change-password', requireAuth, (req, res) => {
  const oldPassword = String(req.body?.oldPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 8) return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 8 ký tự.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (hashPassword(oldPassword, user.salt) !== user.password_hash) {
    return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
    .run(hashPassword(newPassword, salt), salt, req.userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.userId, req.sessionToken);
  addAudit(req.userId, 'account.password_changed', 'user', String(req.userId));
  res.json({ ok: true });
});

app.get('/api/account/sessions', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT token, device_name, user_agent, created_at, expires_at, last_seen_at
    FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC`).all(req.userId);
  res.json({ sessions: rows.map(s => ({
    id: crypto.createHash('sha256').update(s.token).digest('hex').slice(0, 16),
    deviceName: s.device_name || '',
    userAgent: s.user_agent || '',
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    lastSeenAt: s.last_seen_at,
    current: s.token === req.sessionToken
  })) });
});

app.delete('/api/account/sessions/:id', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT token FROM sessions WHERE user_id = ?').all(req.userId);
  const target = rows.find(s => crypto.createHash('sha256').update(s.token).digest('hex').slice(0, 16) === req.params.id);
  if (!target) return res.status(404).json({ error: 'Không tìm thấy phiên đăng nhập.' });
  db.prepare('DELETE FROM sessions WHERE token = ?').run(target.token);
  res.json({ ok: true, currentDeleted: target.token === req.sessionToken });
});

app.post('/api/account/logout-others', requireAuth, (req, res) => {
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.userId, req.sessionToken);
  res.json({ ok: true, removed: result.changes });
});

app.get('/api/backup', requireAuth, (req, res) => {
  const getJson = (table) => {
    const row = db.prepare(`SELECT data FROM ${table} WHERE user_id = ?`).get(req.userId);
    return row ? JSON.parse(row.data) : {};
  };
  const products = db.prepare('SELECT * FROM products WHERE user_id = ?').all(req.userId);
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? AND deleted_at IS NULL').all(req.userId);
  const settingsRow = db.prepare('SELECT data FROM user_settings WHERE user_id = ?').get(req.userId);
  res.setHeader('Content-Disposition', `attachment; filename="tiktok-live-backup-${Date.now()}.json"`);
  res.json({
    version: 2,
    exportedAt: new Date().toISOString(),
    customers: getJson('customer_data'),
    liveSessions: getJson('live_session_data'),
    savedTiktokIds: getJson('saved_tiktok_ids'),
    products,
    orders,
    settings: settingsRow ? JSON.parse(settingsRow.data) : {}
  });
});

app.post('/api/backup/restore', requireAuth, (req, res) => {
  const backup = req.body?.backup;
  if (!backup || backup.version !== 2 || !Array.isArray(backup.orders) || !Array.isArray(backup.products)) {
    return res.status(400).json({ error: 'Tệp sao lưu không đúng định dạng phiên bản 2.' });
  }
  if (backup.orders.length > 100000 || backup.products.length > 10000) {
    return res.status(400).json({ error: 'Bản sao lưu vượt quá giới hạn an toàn.' });
  }
  const now = Date.now();
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM orders WHERE user_id = ?').run(req.userId);
    db.prepare('DELETE FROM products WHERE user_id = ?').run(req.userId);
    const insertProduct = db.prepare(`INSERT INTO products
      (id,user_id,code,name,price,stock,aliases,active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const p of backup.products) {
      insertProduct.run(cleanText(p.id, 160) || makeId('prd'), req.userId,
        cleanText(p.code, 80).toUpperCase(), cleanText(p.name, 240), intValue(p.price, 0),
        p.stock == null ? null : intValue(p.stock, 0, 0, 9999999),
        typeof p.aliases === 'string' ? p.aliases : JSON.stringify(p.aliases || []),
        p.active === 0 || p.active === false ? 0 : 1,
        intValue(p.created_at || p.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
        intValue(p.updated_at || p.updatedAt, now, 0, Number.MAX_SAFE_INTEGER));
    }
    const insertOrder = db.prepare(`INSERT INTO orders
      (id,user_id,source_comment_id,source_session_id,customer_id,customer_name,
       product_code,product_name,quantity,unit_price,shipping_fee,total,phone,address,note,
       status,payment_status,print_status,print_attempts,last_print_error,created_at,updated_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);
    for (const o of backup.orders) {
      const quantity = intValue(o.quantity, 1, 1, 9999);
      const unitPrice = intValue(o.unit_price ?? o.unitPrice, 0);
      const shippingFee = intValue(o.shipping_fee ?? o.shippingFee, 0);
      insertOrder.run(cleanText(o.id, 160) || makeId('ord'), req.userId,
        cleanText(o.source_comment_id ?? o.sourceCommentId, 160) || null,
        cleanText(o.source_session_id ?? o.sourceSessionId, 160) || null,
        cleanText(o.customer_id ?? o.customerId, 120),
        cleanText(o.customer_name ?? o.customerName, 160),
        cleanText(o.product_code ?? o.productCode, 80) || null,
        cleanText(o.product_name ?? o.productName, 240),
        quantity, unitPrice, shippingFee, quantity * unitPrice + shippingFee,
        cleanText(o.phone, 40) || null, cleanText(o.address, 500) || null,
        cleanText(o.note, 1000) || null,
        ORDER_STATUSES.has(o.status) ? o.status : 'new',
        PAYMENT_STATUSES.has(o.payment_status ?? o.paymentStatus) ? (o.payment_status ?? o.paymentStatus) : 'unpaid',
        ['not_printed','printed','failed'].includes(o.print_status ?? o.printStatus) ? (o.print_status ?? o.printStatus) : 'not_printed',
        intValue(o.print_attempts ?? o.printAttempts, 0, 0, 100000),
        cleanText(o.last_print_error ?? o.lastPrintError, 500) || null,
        intValue(o.created_at ?? o.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
        intValue(o.updated_at ?? o.updatedAt, now, 0, Number.MAX_SAFE_INTEGER));
    }
    const saveBlob = (table, value) => db.prepare(`INSERT INTO ${table} (user_id,data,updated_at)
      VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`)
      .run(req.userId, JSON.stringify(value || {}), now);
    saveBlob('customer_data', backup.customers);
    saveBlob('live_session_data', backup.liveSessions);
    saveBlob('saved_tiktok_ids', backup.savedTiktokIds);
    saveBlob('user_settings', backup.settings);
    db.exec('COMMIT');
    addAudit(req.userId, 'backup.restored', 'backup', String(now), {
      orders: backup.orders.length, products: backup.products.length
    });
    res.json({ ok: true, orders: backup.orders.length, products: backup.products.length });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    console.error('[Backup restore]', err);
    res.status(400).json({ error: 'Không thể khôi phục bản sao lưu: ' + err.message });
  }
});

app.get('/api/audit-logs', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT action, entity_type, entity_id, detail, created_at
    FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 300`).all(req.userId);
  res.json({ logs: rows.map(x => ({
    action: x.action, entityType: x.entity_type, entityId: x.entity_id,
    detail: x.detail ? JSON.parse(x.detail) : null, createdAt: x.created_at
  })) });
});

// Endpoint gửi lệnh in: chuyển tiếp dữ liệu ESC/POS (raw bytes) sang ESP32
// đang giữ kết nối WebSocket. ESP32 sẽ tự mở TCP tới máy in trong LAN của nó.
app.post('/print', requireAuth, (req, res) => {
  // Kiểm tra gói license: tài khoản "free" (chưa từng được admin cấp gói) hoặc
  // gói đã hết hạn thì KHÔNG được dùng tính năng in — báo lỗi dạng "LOCKED:"
  // để giao diện nhận biết và bật lên khung "tạm khóa tính năng, vui lòng mua gói".
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const license = user ? getLicenseInfo(user) : null;
  if (!license || !license.canPrint) {
    logLicenseLock(
      user ? user.username : `#${req.userId}`,
      'print',
      license && license.isExpired ? `Gói "${license.label}" đã hết hạn.` : 'Tài khoản chưa có gói in phiếu.'
    );
    return res.status(403).send('LOCKED:Tính năng in phiếu đang tạm khóa. Vui lòng mua gói để tiếp tục sử dụng.');
  }

  // Lấy ĐÚNG máy in (ESP32) đã đăng ký cho riêng tài khoản này — không còn
  // dùng chung 1 máy in cho mọi tài khoản như trước nữa.
  const printerSocket = printerSockets.get(req.userId);
  if (!printerSocket || printerSocket.readyState !== WebSocket.OPEN) {
    return res.status(503).send('Chưa có máy in (ESP32) của TÀI KHOẢN NÀY kết nối tới server. Vào Menu tài khoản để xem "Mã Máy In" và kiểm tra ESP32 đã bật, có WiFi, đã nhập đúng mã đó chưa.');
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
let currentLiveUserId = null;

// Lưu tạm các comment gần đây nhất của phiên Live hiện tại (tối đa 200 dòng).
// Khi 1 thiết bị mới mở trang/kết nối lại trong lúc đang live, server gửi
// nguyên lịch sử này cho nó để đồng bộ ngay, không phải chờ có comment mới.
let commentHistory = [];
const COMMENT_HISTORY_LIMIT = 200;

// ID của phiên Live hiện tại — do CHÍNH SERVER sinh ra và phát cho MỌI thiết bị
// (kèm trong STATUS/HISTORY/COMMENT). Trước đây mỗi trình duyệt tự sinh 1 ID
// riêng (hàm startNewSession phía client) nên chỉ đúng-DUY-NHẤT trên chính
// thiết bị vừa bấm "Kết Nối": mọi comment gõ được vào lúc đó mới lưu bền vào
// DB (qua liveSessions/api/sessions). Thiết bị nào mở trang SAU (F5 lại, hoặc
// điện thoại mở lên khi laptop đã kết nối sẵn) sẽ không có sessionId này ->
// vẫn thấy comment chạy trong feed Live (do server broadcast) nhưng KHÔNG lưu
// được vào lịch sử/DB, vì client coi đó chỉ là dữ liệu "tạm" trong bộ nhớ.
// Nay server phát ra 1 sessionId DUY NHẤT dùng chung cho toàn bộ thiết bị của
// tài khoản đó trong suốt phiên Live này, để thiết bị nào cũng lưu đúng vào
// cùng 1 phiên trên DB, không bị rơi rớt dữ liệu.
let currentSessionId = null;

// Gửi 1 message tới TẤT CẢ trình duyệt đang mở trang (bỏ qua socket của ESP32),
// để mọi thiết bị (laptop, điện thoại...) luôn thấy cùng 1 luồng dữ liệu.
function broadcastToBrowsers(msgObj, targetUserId = currentLiveUserId) {
  const payload = JSON.stringify(msgObj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && !client.isPrinter &&
        targetUserId != null && client.browserUserId === targetUserId) {
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
  ws.on('close', () => {
    if (ws.isPrinter) {
      if (ws.printerUserId != null && printerSockets.get(ws.printerUserId) === ws) {
        printerSockets.delete(ws.printerUserId);
        console.log(`[Printer] ESP32 của @${ws.printerUsername || ('#' + ws.printerUserId)} đã ngắt kết nối.`);
      }
      return; // ESP32 ngắt kết nối thì không đụng gì tới phiên TikTok của trình duyệt
    }
    // Nhiều thiết bị (laptop, điện thoại...) có thể cùng xem 1 phiên Live.
    // Chỉ thực sự ngắt kết nối TikTok khi KHÔNG CÒN thiết bị trình duyệt nào
    // đang mở trang nữa — tránh việc 1 thiết bị đóng tab làm mất live của
    // các thiết bị khác đang xem.
    const conNguoiXemKhac = Array.from(wss.clients).some(
      (client) => client !== ws && client.readyState === WebSocket.OPEN && !client.isPrinter &&
        client.browserUserId === ws.browserUserId
    );
    if (conNguoiXemKhac) return;

    if (tiktokConnection) {
      shutdownTiktokConnection(tiktokConnection);
      tiktokConnection = null;
      currentLiveUsername = null;
      currentLiveUserId = null;
      commentHistory = [];
      currentSessionId = null;
    }
    tiktokConnectionGeneration++; // vô hiệu hóa mọi sự kiện cũ còn sót lại của trình duyệt này
  });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'AUTH_BROWSER') {
        const browserUserId = getUserIdFromToken(data.token);
        if (!browserUserId) return ws.close();
        ws.browserUserId = browserUserId;
        if (currentLiveUsername && currentLiveUserId === browserUserId) {
          ws.send(JSON.stringify({
            type: 'STATUS', success: true,
            msg: `Đã kết nối thành công Live của: @${currentLiveUsername}`,
            roomUsername: currentLiveUsername, sessionId: currentSessionId
          }));
          if (commentHistory.length) ws.send(JSON.stringify({
            type: 'HISTORY', roomUsername: currentLiveUsername,
            sessionId: currentSessionId, comments: commentHistory
          }));
        }
        return;
      }

      // ESP32 tự giới thiệu khi vừa kết nối — xác thực bằng printer_token
      // RIÊNG của tài khoản (mỗi tài khoản 1 mã khác nhau, xem trong Menu tài
      // khoản), để biết ESP32 này thuộc về ai và chỉ gửi lệnh in của đúng
      // tài khoản đó tới nó.
      if (data.type === 'hello' && data.role === 'printer') {
        const printerUser = data.token
          ? db.prepare('SELECT id, username FROM users WHERE printer_token = ?').get(data.token)
          : null;
        if (!printerUser) {
          console.warn('[Printer] Một thiết bị cố kết nối với Mã Máy In không hợp lệ, đã từ chối.');
          ws.close();
          return;
        }
        ws.isPrinter = true;
        ws.printerUserId = printerUser.id;
        ws.printerUsername = printerUser.username;
        printerSockets.set(printerUser.id, ws);
        console.log(`[Printer] ✅ ESP32 của @${printerUser.username} đã kết nối, sẵn sàng nhận lệnh in.`);
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
        broadcastToBrowsers({ type: 'SESSION_DELETED', sessionId: data.sessionId }, userId);
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
        }, userId);
        return;
      }

      // Người dùng chủ động bấm "Dừng xem Live" — ngắt hẳn kết nối TikTok hiện
      // tại (nếu có) và báo cho MỌI thiết bị đang mở trang biết để cập nhật
      // giao diện, khác với việc đóng tab (ws.on('close') ở trên) vốn chỉ ngắt
      // khi không còn ai xem nữa.
      if (data.type === 'STOP_TIKTOK') {
        const stopUserId = getUserIdFromToken(data.token);
        if (!stopUserId || stopUserId !== currentLiveUserId) return;
        console.log(`[TikTok] Nhận yêu cầu DỪNG xem Live (đang xem: ${currentLiveUsername ? '@' + currentLiveUsername : 'không có'})`);
        const stoppedUsername = currentLiveUsername;
        if (tiktokConnection) {
          shutdownTiktokConnection(tiktokConnection);
          tiktokConnection = null;
        }
        currentLiveUsername = null;
        currentLiveUserId = null;
        commentHistory = [];
        currentSessionId = null;
        tiktokConnectionGeneration++; // vô hiệu hóa mọi sự kiện trễ còn sót lại

        broadcastToBrowsers({
          type: 'STATUS',
          success: true,
          stopped: true,
          msg: stoppedUsername
            ? `Đã dừng xem Live của: @${stoppedUsername}`
            : 'Đã dừng xem Live.',
          roomUsername: null
        }, stopUserId);
        return;
      }

      if (data.type === 'START_TIKTOK') {
        await connectorReady; // đợi module ESM nạp xong lần đầu (nếu chưa)

        // Xác thực tài khoản trước khi cho xem Live — cần biết đây là tài
        // khoản nào để áp đúng giới hạn (free: tối đa FREE_LIVE_SESSION_LIMIT
        // phiên; đã có gói: không giới hạn).
        const requestUserId = getUserIdFromToken(data.token);
        if (!requestUserId) {
          return ws.send(JSON.stringify({
            type: 'STATUS',
            success: false,
            msg: 'Phiên đăng nhập đã hết hạn hoặc chưa đăng nhập, vui lòng đăng nhập lại.'
          }));
        }
        const requestUser = db.prepare('SELECT * FROM users WHERE id = ?').get(requestUserId);
        if (!requestUser || requestUser.is_banned) {
          return ws.send(JSON.stringify({
            type: 'STATUS',
            success: false,
            msg: 'Tài khoản không hợp lệ hoặc đã bị khóa.'
          }));
        }
        const requestLicense = getLicenseInfo(requestUser);
        ws.browserUserId = requestUserId;
        if (tiktokConnection && currentLiveUserId != null && currentLiveUserId !== requestUserId) {
          return ws.send(JSON.stringify({
            type: 'STATUS',
            success: false,
            msg: 'Bridge Server đang phục vụ một phiên Live của tài khoản khác. Hãy dùng một service riêng cho mỗi shop hoặc chờ phiên đó kết thúc.'
          }));
        }

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
        if (tiktokConnection && currentLiveUserId === requestUserId && currentLiveUsername && currentLiveUsername.toLowerCase() === username.toLowerCase()) {
          console.log(`[TikTok] @${username} đã đang kết nối sẵn -> chỉ đồng bộ lại, không nối lại.`);
          ws.send(JSON.stringify({
            type: 'STATUS',
            success: true,
            msg: `Đã kết nối thành công Live của: @${username}`,
            roomUsername: username,
            sessionId: currentSessionId
          }));
          if (commentHistory.length) {
            ws.send(JSON.stringify({ type: 'HISTORY', roomUsername: username, sessionId: currentSessionId, comments: commentHistory }));
          }
          return;
        }

        // ====== GIỚI HẠN SỐ PHIÊN LIVE CHO TÀI KHOẢN "FREE" ======
        // Chỉ tài khoản chưa từng được admin cấp gói (hoặc gói đã hết hạn) mới
        // bị đếm số lần bấm "Kết Nối" vào 1 phiên Live MỚI (khác phiên đang mở
        // sẵn — trường hợp đó đã return ở nhánh phía trên, không tính vào đây).
        // Tài khoản đang có gói còn hạn (1/3/6/12 tháng hoặc vĩnh viễn) được
        // xem Live không giới hạn số phiên.
        if (requestLicense.type === 'free' && (requestUser.live_sessions_used || 0) >= FREE_LIVE_SESSION_LIMIT) {
          logLicenseLock(
            requestUser.username,
            'live_view',
            `Đã dùng hết ${FREE_LIVE_SESSION_LIMIT} phiên Live miễn phí.`
          );
          return ws.send(JSON.stringify({
            type: 'STATUS',
            success: false,
            locked: true,
            feature: 'live_view',
            msg: `Tài khoản của bạn đã dùng hết ${FREE_LIVE_SESSION_LIMIT} phiên Live miễn phí. Vui lòng mua gói để tiếp tục sử dụng.`
          }));
        }
        if (requestLicense.type === 'free') {
          db.prepare('UPDATE users SET live_sessions_used = live_sessions_used + 1 WHERE id = ?').run(requestUserId);
          console.log(`[License] @${requestUser.username} đã dùng ${(requestUser.live_sessions_used || 0) + 1}/${FREE_LIVE_SESSION_LIMIT} phiên Live miễn phí.`);
        }

        if (tiktokConnection) {
          shutdownTiktokConnection(tiktokConnection);
          tiktokConnection = null;
        }
        currentLiveUsername = null;
        currentLiveUserId = null;
        commentHistory = [];
        tiktokConnectionGeneration++;
        const myGeneration = tiktokConnectionGeneration; // "chứng minh thư" của phiên kết nối này
        // Sinh 1 sessionId DUY NHẤT cho phiên Live này, dùng chung cho MỌI thiết
        // bị (kể cả thiết bị mở trang sau, hoặc F5 lại giữa chừng) để toàn bộ
        // comment về sau đều được lưu đúng vào 1 phiên duy nhất trên DB.
        currentSessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

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
          currentLiveUserId = requestUserId;
          broadcastToBrowsers({
            type: 'STATUS',
            success: true,
            msg: `Đã kết nối thành công Live của: @${username}`,
            roomUsername: username,
            sessionId: currentSessionId
          });
        }).catch(err => {
          if (myGeneration !== tiktokConnectionGeneration) return; // đã có phiên mới hơn thay thế, bỏ qua lỗi trễ này
          console.error(`[TikTok Error] ❌ Lỗi kết nối:`, err.message || err);
          let userMsg = `Lỗi kết nối TikTok: ${err.message || err}`;
          if (err.toString().includes('LIVE_NOT_FOUND') || err.toString().includes('offline')) {
            userMsg = `Tài khoản @${username} hiện KHÔNG PHÁT LIVE.`;
          }
          broadcastToBrowsers({ type: 'STATUS', success: false, msg: userMsg }, requestUserId);
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
            id: cleanText(data.msgId || data.commentId || data.id, 120) ||
              `c_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
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
            sessionId: currentSessionId, // để trình duyệt lưu đúng vào phiên đang lưu bền trên DB, kể cả khi vừa F5 lại trang
            comment: commentObj
          }, requestUserId);
        });

        tiktokConnection.on('streamEnd', () => {
          if (myGeneration !== tiktokConnectionGeneration) return; // sự kiện trễ từ phiên Live cũ -> bỏ qua
          console.log(`[TikTok] Phiên Live đã kết thúc.`);
          const endedUserId = requestUserId;
          currentLiveUsername = null;
          currentLiveUserId = null;
          commentHistory = [];
          currentSessionId = null;
          broadcastToBrowsers({ type: 'STATUS', success: false, msg: 'Phiên Live đã kết thúc.' }, endedUserId);
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
