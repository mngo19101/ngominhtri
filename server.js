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

const dbPath = path.join(dataDir, 'data.db');
const DATABASE_CAPACITY_MB = Math.max(1, Number(process.env.DATABASE_CAPACITY_MB) || 500);
const DATABASE_CAPACITY_BYTES = Math.floor(DATABASE_CAPACITY_MB * 1024 * 1024);
const db = new Database(dbPath);
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
ensureColumn('users', 'last_login_ip', 'TEXT');
ensureColumn('users', 'last_login_at', 'INTEGER');
ensureColumn('users', 'last_login_city', 'TEXT');
ensureColumn('users', 'last_login_region', 'TEXT');
ensureColumn('users', 'last_login_country', 'TEXT');
ensureColumn('users', 'last_login_geo_ip', 'TEXT');
ensureColumn('users', 'last_login_geo_at', 'INTEGER');
ensureColumn('users', 'last_login_geo_source', 'TEXT');

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
ensureColumn('sessions', 'ip_address', 'TEXT');

// Bản cũ đã có IP trong session nhưng chưa có cột IP cố định trên tài khoản.
// Backfill một lần để sau nâng cấp Admin thấy ngay IP và giờ đăng nhập gần nhất.
try {
  db.exec(`UPDATE users
    SET last_login_ip = (
          SELECT s.ip_address FROM sessions s
          WHERE s.user_id = users.id AND s.ip_address IS NOT NULL
          ORDER BY s.created_at DESC LIMIT 1
        ),
        last_login_at = (
          SELECT s.created_at FROM sessions s
          WHERE s.user_id = users.id
          ORDER BY s.created_at DESC LIMIT 1
        )
    WHERE last_login_ip IS NULL
      AND EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = users.id AND s.ip_address IS NOT NULL)`);
} catch (err) {
  console.warn('[Presence] Không backfill được IP phiên cũ:', err.message);
}

// ====== QUẢN LÝ VẬN CHUYỂN / PHIẾU LUÂN CHUYỂN NỘI BỘ ======
// Các cột này nằm ngay trên đơn hàng để mỗi tài khoản chỉ nhìn thấy dữ liệu
// của chính mình. Phiếu được xuất thành ảnh ở trình duyệt, không phụ thuộc
// ESP32 hay API của một hãng vận chuyển.
ensureColumn('orders', 'shipping_code', 'TEXT');
ensureColumn('orders', 'shipping_status', "TEXT NOT NULL DEFAULT 'awaiting_info'");
ensureColumn('orders', 'package_weight', 'INTEGER NOT NULL DEFAULT 500');
ensureColumn('orders', 'cod_amount', 'INTEGER');
ensureColumn('orders', 'shipping_created_at', 'INTEGER');
ensureColumn('orders', 'shipping_updated_at', 'INTEGER');
ensureColumn('orders', 'label_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'last_label_at', 'INTEGER');
ensureColumn('orders', 'delivery_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'cod_reconciled_at', 'INTEGER');
ensureColumn('orders', 'cod_paid_at', 'INTEGER');
ensureColumn('orders', 'delivered_at', 'INTEGER');

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_shipping_code
    ON orders(user_id, shipping_code)
    WHERE shipping_code IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_orders_shipping_status
    ON orders(user_id, shipping_status, shipping_updated_at DESC);
  CREATE TABLE IF NOT EXISTS shipment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    order_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT,
    note TEXT,
    location TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );
  CREATE INDEX IF NOT EXISTS idx_shipment_events_order
    ON shipment_events(user_id, order_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS shipment_tracking (
    order_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    carrier TEXT NOT NULL DEFAULT 'SPX',
    tracking_code TEXT NOT NULL,
    current_status TEXT,
    current_location TEXT,
    expected_delivery_at INTEGER,
    expected_delivery_text TEXT,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (order_id) REFERENCES orders(id)
  );
  CREATE INDEX IF NOT EXISTS idx_shipment_tracking_user_code
    ON shipment_tracking(user_id, tracking_code);
`);
ensureColumn('shipment_events', 'location', 'TEXT');
ensureColumn('shipment_tracking', 'raw_data', 'TEXT');
ensureColumn('shipment_tracking', 'last_checked_at', 'INTEGER');
ensureColumn('shipment_tracking', 'last_error', 'TEXT');
ensureColumn('shipment_tracking', 'expected_delivery_text', 'TEXT');

// ====== TỰ DỌN COMMENT QUÁ HẠN ======
// Quy tắc theo ngày lịch đúng yêu cầu:
// - Comment ngày 25/07 được giữ đến hết 25/08.
// - Từ 00:00 ngày 26/08 trở đi mới bị xóa.
// Đơn hàng/giỏ khách đã chốt KHÔNG bị xóa theo tác vụ này.
function addOneCalendarMonthEndOfDay(value) {
  const source = new Date(value);
  if (!Number.isFinite(source.getTime())) return null;
  // Railway thường chạy UTC, nên tự quy đổi cố định UTC+7 để ngày xóa luôn
  // đúng theo ngày Việt Nam, không phụ thuộc timezone của container.
  const vietnam = new Date(source.getTime() + 7 * 60 * 60 * 1000);
  const year = vietnam.getUTCFullYear();
  const month = vietnam.getUTCMonth();
  const day = vietnam.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDayOfTargetMonth);
  // 23:59:59.999 giờ Việt Nam = 16:59:59.999 UTC.
  return new Date(Date.UTC(year, month + 1, targetDay, 16, 59, 59, 999));
}

function isCommentExpired(receivedAt, now = new Date()) {
  const expiry = addOneCalendarMonthEndOfDay(receivedAt);
  return expiry ? now.getTime() > expiry.getTime() : false;
}

function cleanupExpiredComments(now = new Date()) {
  const rows = db.prepare('SELECT user_id, data FROM live_session_data').all();
  let removedComments = 0;
  let removedSessions = 0;
  let updatedUsers = 0;

  for (const row of rows) {
    let sessions;
    try {
      sessions = JSON.parse(row.data || '{}');
    } catch (err) {
      console.warn(`[Retention] Bỏ qua lịch sử lỗi JSON của user #${row.user_id}.`);
      continue;
    }
    let changed = false;
    for (const [sessionId, session] of Object.entries(sessions)) {
      const original = Array.isArray(session.comments) ? session.comments : [];
      const kept = original.filter(comment => !isCommentExpired(comment.receivedAt, now));
      if (kept.length !== original.length) {
        removedComments += original.length - kept.length;
        session.comments = kept;
        changed = true;
      }
      if (session.comments.length === 0) {
        delete sessions[sessionId];
        removedSessions++;
        changed = true;
      }
    }
    if (changed) {
      db.prepare('UPDATE live_session_data SET data = ?, updated_at = ? WHERE user_id = ?')
        .run(JSON.stringify(sessions), Date.now(), row.user_id);
      updatedUsers++;
    }
  }

  if (removedComments || removedSessions) {
    console.log(`[Retention] Đã xóa ${removedComments} comment quá 1 tháng và ${removedSessions} phiên trống của ${updatedUsers} tài khoản.`);
  } else {
    console.log('[Retention] Không có comment quá hạn cần xóa.');
  }
  return { removedComments, removedSessions, updatedUsers, checkedAt: now.toISOString() };
}

function addThreeCalendarMonthsEndOfDay(value) {
  const source = new Date(value);
  if (!Number.isFinite(source.getTime())) return null;
  const vietnam = new Date(source.getTime() + 7 * 60 * 60 * 1000);
  const year = vietnam.getUTCFullYear();
  const month = vietnam.getUTCMonth();
  const day = vietnam.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 4, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDayOfTargetMonth);
  return new Date(Date.UTC(year, month + 3, targetDay, 16, 59, 59, 999));
}

function cleanupInactiveCustomers(now = new Date()) {
  const rows = db.prepare('SELECT user_id, data, updated_at FROM customer_data').all();
  const latestOrder = db.prepare(`SELECT MAX(created_at) AS last_purchase_at
    FROM orders
    WHERE user_id = ? AND deleted_at IS NULL
      AND lower(replace(customer_id, '@', '')) = lower(?)`);
  let removedCustomers = 0;
  let updatedUsers = 0;

  for (const row of rows) {
    let customersData;
    try {
      customersData = JSON.parse(row.data || '{}');
      if (!customersData || typeof customersData !== 'object' || Array.isArray(customersData)) continue;
    } catch (err) {
      console.warn(`[Customer Retention] Bỏ qua dữ liệu lỗi JSON của user #${row.user_id}.`);
      continue;
    }
    let changed = false;
    for (const [key, customer] of Object.entries(customersData)) {
      const customerId = cleanText(customer?.uniqueId || key, 120).replace(/^@/, '');
      const orderTime = Number(latestOrder.get(row.user_id, customerId)?.last_purchase_at) || 0;
      const itemTime = (Array.isArray(customer?.items) ? customer.items : []).reduce((latest, item) => {
        const timestamp = new Date(item?.time || 0).getTime();
        return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
      }, 0);
      const recordedPurchaseAt = Math.max(
        Number(customer?.lastPurchaseAt) || 0,
        orderTime,
        itemTime
      );
      const lastPurchaseAt = recordedPurchaseAt ||
        Number(customer?.profile?.updatedAt) ||
        Number(row.updated_at) ||
        0;
      const expiry = addThreeCalendarMonthsEndOfDay(lastPurchaseAt);
      if (expiry && now.getTime() > expiry.getTime()) {
        delete customersData[key];
        removedCustomers++;
        changed = true;
      } else if (lastPurchaseAt && customer.lastPurchaseAt !== lastPurchaseAt) {
        customer.lastPurchaseAt = lastPurchaseAt;
        changed = true;
      }
    }
    if (changed) {
      db.prepare('UPDATE customer_data SET data = ?, updated_at = ? WHERE user_id = ?')
        .run(JSON.stringify(customersData), Date.now(), row.user_id);
      updatedUsers++;
    }
  }

  if (removedCustomers) {
    console.log(`[Customer Retention] Đã xóa ${removedCustomers} khách không mua lại quá 3 tháng.`);
  } else {
    console.log('[Customer Retention] Không có khách quá 3 tháng cần xóa.');
  }
  return { removedCustomers, updatedUsers, checkedAt: now.toISOString() };
}

function runImmediateTransaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (rollbackError) {}
    throw err;
  }
}

function cleanupCompletedShipmentDetails(now = new Date()) {
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const orders = db.prepare(`SELECT id FROM orders
    WHERE deleted_at IS NULL
      AND shipping_status IN ('delivered', 'returned', 'cancelled')
      AND COALESCE(delivered_at, shipping_updated_at, updated_at, created_at) <= ?`).all(cutoff);
  if (!orders.length) {
    return { eligibleOrders: 0, removedEvents: 0, cleanedTrackingRows: 0 };
  }
  const deleteEvents = db.prepare('DELETE FROM shipment_events WHERE order_id = ?');
  const cleanTracking = db.prepare(`UPDATE shipment_tracking
    SET raw_data = NULL, current_location = NULL, expected_delivery_at = NULL,
        expected_delivery_text = NULL, last_error = NULL
    WHERE order_id = ?
      AND (raw_data IS NOT NULL OR current_location IS NOT NULL OR expected_delivery_at IS NOT NULL
        OR expected_delivery_text IS NOT NULL OR last_error IS NOT NULL)`);
  let removedEvents = 0;
  let cleanedTrackingRows = 0;
  runImmediateTransaction(() => {
    for (const order of orders) {
      removedEvents += deleteEvents.run(order.id).changes;
      cleanedTrackingRows += cleanTracking.run(order.id).changes;
    }
  });
  if (removedEvents || cleanedTrackingRows) {
    console.log(`[Storage] Đã dọn chi tiết SPX của ${orders.length} đơn hoàn tất quá 30 ngày.`);
  }
  return { eligibleOrders: orders.length, removedEvents, cleanedTrackingRows };
}

function removePurgedOrderItemsFromCustomers(orderIds) {
  if (!orderIds.length) return { removedCartItems: 0, updatedUsers: 0 };
  const idSet = new Set(orderIds);
  const rows = db.prepare('SELECT user_id, data FROM customer_data').all();
  let removedCartItems = 0;
  let updatedUsers = 0;
  for (const row of rows) {
    let customersData;
    try {
      customersData = JSON.parse(row.data || '{}');
      if (!customersData || typeof customersData !== 'object' || Array.isArray(customersData)) continue;
    } catch (err) {
      continue;
    }
    let changed = false;
    for (const [key, customer] of Object.entries(customersData)) {
      const original = Array.isArray(customer?.items) ? customer.items : [];
      const kept = original.filter(item => !item?.orderId || !idSet.has(item.orderId));
      if (kept.length !== original.length) {
        removedCartItems += original.length - kept.length;
        customer.items = kept;
        changed = true;
      }
      if (customer.items.length === 0 && !customer.profile) {
        delete customersData[key];
        changed = true;
      }
    }
    if (changed) {
      db.prepare('UPDATE customer_data SET data = ?, updated_at = ? WHERE user_id = ?')
        .run(JSON.stringify(customersData), Date.now(), row.user_id);
      updatedUsers++;
    }
  }
  return { removedCartItems, updatedUsers };
}

function cleanupSoftDeletedOrders(now = new Date()) {
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const orders = db.prepare('SELECT id FROM orders WHERE deleted_at IS NOT NULL AND deleted_at <= ?').all(cutoff);
  const orderIds = orders.map(order => order.id);
  if (!orderIds.length) {
    return { purgedOrders: 0, removedEvents: 0, removedTracking: 0, removedCartItems: 0 };
  }
  const deleteEvents = db.prepare('DELETE FROM shipment_events WHERE order_id = ?');
  const deleteTracking = db.prepare('DELETE FROM shipment_tracking WHERE order_id = ?');
  const deleteAudit = db.prepare(`DELETE FROM audit_logs
    WHERE entity_type = 'order' AND entity_id = ?`);
  const deleteOrder = db.prepare('DELETE FROM orders WHERE id = ? AND deleted_at IS NOT NULL');
  let removedEvents = 0;
  let removedTracking = 0;
  let purgedOrders = 0;
  let customerResult = { removedCartItems: 0, updatedUsers: 0 };
  runImmediateTransaction(() => {
    customerResult = removePurgedOrderItemsFromCustomers(orderIds);
    for (const id of orderIds) {
      removedEvents += deleteEvents.run(id).changes;
      removedTracking += deleteTracking.run(id).changes;
      deleteAudit.run(id);
      purgedOrders += deleteOrder.run(id).changes;
    }
  });
  console.log(`[Storage] Đã xóa vĩnh viễn ${purgedOrders} đơn đã nằm trong thùng xóa quá 7 ngày.`);
  return {
    purgedOrders,
    removedEvents,
    removedTracking,
    removedCartItems: customerResult.removedCartItems
  };
}

function databaseStorageBytes() {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((sum, file) => {
    try { return sum + fs.statSync(file).size; } catch (err) { return sum; }
  }, 0);
}

function databaseReclaimableBytes() {
  const pragmaNumber = name => {
    try {
      const row = db.prepare(`PRAGMA ${name}`).get();
      return Math.max(0, Number(row?.[name] ?? Object.values(row || {})[0]) || 0);
    } catch (err) {
      return 0;
    }
  };
  const pageSize = pragmaNumber('page_size') || 4096;
  const freePages = pragmaNumber('freelist_count');
  let walBytes = 0;
  try { walBytes = fs.statSync(`${dbPath}-wal`).size; } catch (err) {}
  const freePageBytes = freePages * pageSize;
  return {
    pageSize,
    freePages,
    freePageBytes,
    walBytes,
    reclaimableBytes: freePageBytes + walBytes
  };
}

// Dung lượng theo tài khoản là số byte nội dung ước tính trong từng hàng dữ
// liệu. Nó không bao gồm index, trang SQLite và vùng trống nên không cộng lại
// thành kích thước file vật lý; số liệu này dùng để Admin so sánh tài khoản nào
// đang lưu nhiều dữ liệu nhất.
function estimateUserStorageUsage() {
  const usage = new Map();
  const addRows = sql => {
    for (const row of db.prepare(sql).all()) {
      const userId = Number(row.user_id);
      if (!Number.isInteger(userId)) continue;
      usage.set(userId, (usage.get(userId) || 0) + Math.max(0, Number(row.bytes) || 0));
    }
  };
  const blobLength = column => `length(CAST(COALESCE(${column}, '') AS BLOB))`;

  addRows(`SELECT id AS user_id,
    320 + ${blobLength('username')} + ${blobLength('banned_reason')} + ${blobLength('printer_token')} + ${blobLength('last_login_ip')} AS bytes
    FROM users`);
  addRows(`SELECT user_id, SUM(180 + ${blobLength('token')} + ${blobLength('device_name')} + ${blobLength('user_agent')} + ${blobLength('ip_address')}) AS bytes
    FROM sessions GROUP BY user_id`);
  for (const table of ['customer_data', 'saved_tiktok_ids', 'live_session_data', 'user_settings']) {
    addRows(`SELECT user_id, SUM(80 + ${blobLength('data')}) AS bytes FROM ${table} GROUP BY user_id`);
  }
  addRows(`SELECT user_id, SUM(220 + ${blobLength('id')} + ${blobLength('code')} + ${blobLength('name')} + ${blobLength('aliases')}) AS bytes
    FROM products GROUP BY user_id`);
  addRows(`SELECT user_id, SUM(520
      + ${blobLength('id')} + ${blobLength('source_comment_id')} + ${blobLength('source_session_id')}
      + ${blobLength('customer_id')} + ${blobLength('customer_name')} + ${blobLength('product_code')}
      + ${blobLength('product_name')} + ${blobLength('phone')} + ${blobLength('address')}
      + ${blobLength('note')} + ${blobLength('last_print_error')} + ${blobLength('shipping_code')}
    ) AS bytes FROM orders GROUP BY user_id`);
  addRows(`SELECT user_id, SUM(190 + ${blobLength('order_id')} + ${blobLength('event_type')}
      + ${blobLength('status')} + ${blobLength('note')} + ${blobLength('location')}) AS bytes
    FROM shipment_events GROUP BY user_id`);
  addRows(`SELECT user_id, SUM(280 + ${blobLength('order_id')} + ${blobLength('carrier')}
      + ${blobLength('tracking_code')} + ${blobLength('current_status')} + ${blobLength('current_location')}
      + ${blobLength('expected_delivery_text')} + ${blobLength('raw_data')} + ${blobLength('last_error')}) AS bytes
    FROM shipment_tracking GROUP BY user_id`);
  addRows(`SELECT user_id, SUM(180 + ${blobLength('action')} + ${blobLength('entity_type')}
      + ${blobLength('entity_id')} + ${blobLength('detail')}) AS bytes
    FROM audit_logs GROUP BY user_id`);
  return usage;
}

function getAdminStorageInfo() {
  const usedBytes = databaseStorageBytes();
  const remainingBytes = Math.max(0, DATABASE_CAPACITY_BYTES - usedBytes);
  const reclaimable = databaseReclaimableBytes();
  const usage = estimateUserStorageUsage();
  const users = db.prepare('SELECT id, username FROM users ORDER BY id ASC').all()
    .map(user => ({
      id: user.id,
      username: user.username,
      bytes: usage.get(Number(user.id)) || 0
    }))
    .sort((a, b) => b.bytes - a.bytes || a.id - b.id);
  return {
    capacityBytes: DATABASE_CAPACITY_BYTES,
    usedBytes,
    remainingBytes,
    usedPercent: DATABASE_CAPACITY_BYTES
      ? Math.min(100, Number(((usedBytes / DATABASE_CAPACITY_BYTES) * 100).toFixed(2)))
      : 0,
    ...reclaimable,
    userUsage: users
  };
}

function runDatabaseMaintenance(now = new Date()) {
  const beforeBytes = databaseStorageBytes();
  const comments = cleanupExpiredComments(now);
  const customers = cleanupInactiveCustomers(now);
  const shipmentDetails = cleanupCompletedShipmentDetails(now);
  const deletedOrders = cleanupSoftDeletedOrders(now);
  let vacuumError = null;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('VACUUM');
    db.exec('PRAGMA optimize');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    vacuumError = cleanText(err?.message, 500) || 'Không thể thu gọn database lúc này.';
    console.warn('[Storage] Không thể VACUUM database:', vacuumError);
  }
  const afterBytes = databaseStorageBytes();
  return {
    beforeBytes,
    afterBytes,
    freedBytes: Math.max(0, beforeBytes - afterBytes),
    comments,
    customers,
    shipmentDetails,
    deletedOrders,
    vacuumError
  };
}

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
  trial: 'Trải nghiệm',
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
    return { type, label: LICENSE_LABELS.lifetime, canPrint: true, canLive: true, isExpired: false, expiresAt: null, daysLeft: null, remainingMs: null };
  }

  if (type === 'free' || !user.license_expires_at) {
    return { type: 'free', label: LICENSE_LABELS.free, canPrint: false, canLive: true, isExpired: false, expiresAt: null, daysLeft: null, remainingMs: null };
  }

  const isExpired = user.license_expires_at <= now;
  const daysLeft = isExpired ? 0 : Math.ceil((user.license_expires_at - now) / DAY_MS);
  return {
    type,
    label: LICENSE_LABELS[type] || type,
    canPrint: !isExpired,
    canLive: !isExpired,
    isExpired,
    expiresAt: user.license_expires_at,
    daysLeft,
    remainingMs: isExpired ? 0 : user.license_expires_at - now,
  };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function getClientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = forwarded || String(req?.socket?.remoteAddress || '').trim();
  return raw.replace(/^::ffff:/, '').slice(0, 80) || null;
}

const ipGeoPending = new Map();

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
  }
  if (net.isIP(ip) === 6) {
    const value = ip.toLowerCase();
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb');
  }
  return true;
}

async function refreshIpLocation(ip) {
  ip = String(ip || '').trim();
  if (!ip || !net.isIP(ip)) return null;
  if (ipGeoPending.has(ip)) return ipGeoPending.get(ip);
  const task = (async () => {
    let location = { city: null, region: null, country: null, source: null };
    try {
      if (isPrivateIp(ip)) {
        location = { city: 'Mạng nội bộ', region: null, country: null, source: 'local' };
      } else {
        // WhatIsMyIPAddress không cung cấp API JSON công khai, nhưng có trang
        // chi tiết ổn định /ip/{IP}. Đọc đúng ba trường hiển thị trên trang.
        const detailsResponse = await fetch(`https://whatismyipaddress.com/ip/${encodeURIComponent(ip)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TikTokLiveAdmin/1.0)' },
          signal: AbortSignal.timeout(6000)
        });
        if (detailsResponse.ok) {
          const html = await detailsResponse.text();
          const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '\n')
            .replace(/<style[\s\S]*?<\/style>/gi, '\n')
            .replace(/<[^>]+>/g, '\n')
            .replace(/&nbsp;|&#160;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;|&apos;/gi, "'")
            .split(/\r?\n/)
            .map(line => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\n');
          const readField = label => {
            const match = text.match(new RegExp(`(?:^|\\n)${label}:?\\s*(?:\\n)?([^\\n]+)`, 'i'));
            return cleanText(match?.[1], 100) || null;
          };
          location = {
            city: readField('City'),
            region: readField('State/Region'),
            country: readField('Country'),
            source: 'whatismyipaddress'
          };
        }
        // Dự phòng khi trang HTML thay đổi hoặc chặn yêu cầu từ máy chủ.
        if (!location.city && !location.region && !location.country) {
          const fallbackResponse = await fetch(
            `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country`,
            { signal: AbortSignal.timeout(4500) }
          );
          const data = await fallbackResponse.json();
          if (fallbackResponse.ok && data?.success !== false) {
            location = {
              city: cleanText(data.city, 100) || null,
              region: cleanText(data.region, 100) || null,
              country: cleanText(data.country, 100) || null,
              source: 'ipwhois-fallback'
            };
          }
        }
      }
    } catch (err) {
      console.warn(`[Presence] Chưa tra được thành phố cho IP ${ip}:`, err.message);
    }
    db.prepare(`UPDATE users
      SET last_login_city = ?, last_login_region = ?, last_login_country = ?,
          last_login_geo_ip = ?, last_login_geo_at = ?, last_login_geo_source = ?
      WHERE last_login_ip = ?`)
      .run(location.city, location.region, location.country, ip, Date.now(), location.source, ip);
    return location;
  })().finally(() => ipGeoPending.delete(ip));
  ipGeoPending.set(ip, task);
  return task;
}

function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const deviceName = String(req?.body?.deviceName || '').trim().slice(0, 80) || null;
  const userAgent = String(req?.headers?.['user-agent'] || '').slice(0, 300) || null;
  const ipAddress = getClientIp(req);
  db.prepare(`INSERT INTO sessions
    (token, user_id, created_at, expires_at, device_name, user_agent, last_seen_at, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(token, userId, now, now + SESSION_TTL_MS, deviceName, userAgent, now, ipAddress);
  // IP đăng nhập gần nhất thuộc về tài khoản, không phụ thuộc vòng đời session.
  // Vì vậy đăng xuất hoặc chuyển Offline không làm mất IP này.
  const previous = db.prepare(`SELECT last_login_ip, last_login_city, last_login_region,
    last_login_country, last_login_geo_ip, last_login_geo_at, last_login_geo_source
    FROM users WHERE id = ?`).get(userId);
  const changedIp = previous?.last_login_ip !== ipAddress;
  db.prepare(`UPDATE users
    SET last_login_ip = ?, last_login_at = ?,
        last_login_city = ?, last_login_region = ?, last_login_country = ?,
        last_login_geo_ip = ?, last_login_geo_at = ?, last_login_geo_source = ?
    WHERE id = ?`)
    .run(
      ipAddress, now,
      changedIp ? null : previous?.last_login_city,
      changedIp ? null : previous?.last_login_region,
      changedIp ? null : previous?.last_login_country,
      changedIp ? null : previous?.last_login_geo_ip,
      changedIp ? null : previous?.last_login_geo_at,
      changedIp ? null : previous?.last_login_geo_source,
      userId
    );
  if (ipAddress && (changedIp || !previous?.last_login_geo_at)) {
    refreshIpLocation(ipAddress).catch(() => {});
  }
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
  db.prepare('UPDATE sessions SET last_seen_at = ?, ip_address = ? WHERE token = ?')
    .run(Date.now(), getClientIp(req), token);
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

// Kích thước file là số thực tế trên Volume; dung lượng từng tài khoản là ước
// tính theo nội dung các hàng để Admin biết tài khoản nào dùng nhiều nhất.
app.get('/api/admin/storage', requireAuth, requireAdmin, (req, res) => {
  res.json(getAdminStorageInfo());
});

// Trình duyệt gọi định kỳ mỗi 5 phút. Chỉ cập nhật cùng một hàng phiên đăng
// nhập, không tạo lịch sử mới nên dung lượng database không tăng theo thời gian.
app.post('/api/account/heartbeat', requireAuth, (req, res) => {
  res.json({ ok: true, serverTime: Date.now() });
});

// Cho phép admin chạy dọn ngay mà không cần chờ lịch tự động.
app.post('/api/admin/cleanup-comments', requireAuth, requireAdmin, (req, res) => {
  res.json({ ok: true, ...cleanupExpiredComments(new Date()) });
});

// Dọn dữ liệu hết hạn rồi thu hồi vùng trống của SQLite. VACUUM có thể làm
// các yêu cầu khác chờ trong vài giây, vì vậy chỉ admin mới được chủ động chạy.
app.post('/api/admin/database-maintenance', requireAuth, requireAdmin, (req, res) => {
  const result = runDatabaseMaintenance(new Date());
  addAudit(req.userId, 'admin.database_maintenance', 'database', null, {
    beforeBytes: result.beforeBytes,
    afterBytes: result.afterBytes,
    purgedOrders: result.deletedOrders.purgedOrders,
    cleanedTrackingRows: result.shipmentDetails.cleanedTrackingRows,
    vacuumError: result.vacuumError
  });
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (err) {}
  res.json({
    ok: !result.vacuumError,
    ...result,
    message: result.vacuumError
      ? `Đã dọn dữ liệu hết hạn nhưng chưa thu gọn được file: ${result.vacuumError}`
      : 'Đã dọn dữ liệu hết hạn và thu gọn database thành công.'
  });
});

// Danh sách toàn bộ tài khoản trong hệ thống (không trả về password_hash/salt).
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  let rows = db.prepare(
    'SELECT * FROM users ORDER BY id ASC'
  ).all();
  const latestSessions = new Map();
  for (const session of db.prepare(`SELECT user_id, created_at, last_seen_at, ip_address, device_name
    FROM sessions ORDER BY last_seen_at DESC`).all()) {
    if (!latestSessions.has(Number(session.user_id))) {
      latestSessions.set(Number(session.user_id), session);
    }
  }
  const ipAccountCounts = new Map();
  for (const user of rows) {
    const ip = String(user.last_login_ip || latestSessions.get(Number(user.id))?.ip_address || '').trim();
    if (ip) ipAccountCounts.set(ip, (ipAccountCounts.get(ip) || 0) + 1);
  }
  const now = Date.now();
  const onlineWindowMs = 6 * 60 * 1000;
  const geoRefreshMs = 30 * 24 * 60 * 60 * 1000;
  const ipsToLookup = [...new Set(rows
    .filter(user => user.last_login_ip && (
      user.last_login_geo_ip !== user.last_login_ip ||
      !user.last_login_geo_at ||
      !user.last_login_geo_source ||
      now - user.last_login_geo_at > geoRefreshMs
    ))
    .map(user => user.last_login_ip))];
  if (ipsToLookup.length) {
    try {
      await Promise.all(ipsToLookup.map(ip => refreshIpLocation(ip)));
    } catch (err) {
      console.warn('[Presence] Tra cứu vị trí IP chưa hoàn tất:', err.message);
    }
    rows = db.prepare('SELECT * FROM users ORDER BY id ASC').all();
  }
  res.json({
    presenceRefreshMs: 5 * 60 * 1000,
    users: rows.map(u => {
      const presence = latestSessions.get(Number(u.id));
      const lastSeenAt = Number(presence?.last_seen_at) || null;
      const savedIp = u.last_login_ip || presence?.ip_address || null;
      const ipAccountCount = savedIp ? (ipAccountCounts.get(savedIp) || 1) : 0;
      return {
        id: u.id,
        username: u.username,
        createdAt: u.created_at,
        isAdmin: !!u.is_admin,
        isBanned: !!u.is_banned,
        bannedReason: u.banned_reason || null,
        bannedAt: u.banned_at || null,
        license: getLicenseInfo(u),
        liveSessionsUsed: u.live_sessions_used || 0,
        freeLiveSessionLimit: FREE_LIVE_SESSION_LIMIT,
        isOnline: !!lastSeenAt && now - lastSeenAt <= onlineWindowMs,
        lastSeenAt,
        ipAddress: savedIp,
        ipAccountCount,
        hasDuplicateIp: ipAccountCount >= 2,
        lastLoginAt: u.last_login_at || presence?.created_at || null,
        ipCity: u.last_login_city || null,
        ipRegion: u.last_login_region || null,
        ipCountry: u.last_login_country || null,
        ipGeoSource: u.last_login_geo_source || null,
        deviceName: presence?.device_name || null
      };
    })
  });
});

// Admin cấp / gia hạn gói cho 1 tài khoản.
// Gói trải nghiệm: { type:'trial', duration:15, unit:'minute'|'hour'|'day' }.
// - 'lifetime': mở khóa in vĩnh viễn, không có hạn.
// - '1m'/'3m'/'6m'/'12m': mở khóa in trong đúng số tháng tương ứng, đếm ngược
//   từ NGÀY HẾT HẠN GÓI CŨ nếu gói cũ còn hạn (gia hạn cộng dồn), hoặc từ thời
//   điểm hiện tại nếu gói cũ đã hết hạn / chưa từng có gói.
// - 'free': thu hồi gói, đưa tài khoản về lại trạng thái miễn phí (và cấp lại
//   đủ FREE_LIVE_SESSION_LIMIT phiên Live để dùng thử lại từ đầu).
app.post('/api/admin/users/:id/license', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const { type, duration, unit } = req.body || {};
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });

  const validTypes = ['free', 'trial', '1m', '3m', '6m', '12m', 'lifetime'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Loại gói không hợp lệ.' });
  }

  const now = Date.now();
  let expiresAt = null;
  let grantLabel = LICENSE_LABELS[type] || type;
  if (type === 'trial') {
    const amount = Number(duration);
    const unitMs = { minute: 60 * 1000, hour: 60 * 60 * 1000, day: DAY_MS };
    const unitLabels = { minute: 'phút', hour: 'giờ', day: 'ngày' };
    if (!Number.isInteger(amount) || amount < 1 || amount > 10000 || !unitMs[unit]) {
      return res.status(400).json({ error: 'Thời gian trải nghiệm không hợp lệ.' });
    }
    const durationMs = amount * unitMs[unit];
    if (durationMs > 365 * DAY_MS) {
      return res.status(400).json({ error: 'Gói trải nghiệm tối đa 365 ngày.' });
    }
    expiresAt = now + durationMs;
    grantLabel = `Trải nghiệm ${amount} ${unitLabels[unit]}`;
  } else if (type === '1m' || type === '3m' || type === '6m' || type === '12m') {
    const base = (target.license_expires_at && target.license_expires_at > now) ? target.license_expires_at : now;
    expiresAt = base + LICENSE_DURATIONS_MS[type];
  }

  db.prepare(
    'UPDATE users SET license_type = ?, license_expires_at = ?, license_granted_at = ?, live_sessions_used = 0 WHERE id = ?'
  ).run(type, expiresAt, now, targetId);

  console.log(`[License] ✅ Admin đã cấp gói "${grantLabel}" cho tài khoản @${target.username}.`);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  res.json({
    ok: true,
    message: `Đã cấp gói "${grantLabel}" cho @${target.username}.`,
    license: getLicenseInfo(updated),
    grantLabel
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

// Admin đặt mật khẩu mới cho tài khoản khách hàng. Tất cả phiên đăng nhập cũ
// của khách bị thu hồi ngay để mật khẩu cũ không còn dùng tiếp được.
app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const newPassword = String(req.body?.newPassword || '');
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  if (target.is_admin) {
    return res.status(403).json({ error: 'Không thể đổi mật khẩu của tài khoản admin khác tại đây.' });
  }
  if (newPassword.length < 8 || newPassword.length > 200) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có từ 8 đến 200 ký tự.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?')
    .run(hashPassword(newPassword, salt), salt, targetId);
  const removedSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId).changes;
  addAudit(req.userId, 'admin.password_reset', 'user', String(targetId), {
    username: target.username, removedSessions
  });
  console.log(`[Admin] Đã đặt mật khẩu mới cho @${target.username} và thu hồi ${removedSessions} phiên.`);
  res.json({
    ok: true,
    message: `Đã đổi mật khẩu @${target.username} và đăng xuất ${removedSessions} thiết bị.`,
    removedSessions
  });
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
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM customer_data WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM saved_tiktok_ids WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM live_session_data WHERE user_id = ?').run(targetId);
    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (e) {}
    throw err;
  }
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
const SHIPPING_STATUSES = new Set([
  'awaiting_info', 'ready', 'label_created', 'awaiting_pickup', 'delivering',
  'delivery_failed', 'delivered', 'returning', 'returned', 'cancelled'
]);

function cleanText(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function intValue(value, fallback = 0, min = 0, max = 1000000000) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function rememberCustomerProfile(userId, profile, options = {}) {
  const customerId = cleanText(profile?.customerId, 120).replace(/^@/, '');
  if (!customerId) return;
  const row = db.prepare('SELECT data FROM customer_data WHERE user_id = ?').get(userId);
  let data = {};
  try {
    data = row?.data ? JSON.parse(row.data) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  } catch (err) {
    data = {};
  }
  const key = Object.keys(data).find(item =>
    item.replace(/^@/, '').toLowerCase() === customerId.toLowerCase()
  ) || customerId;
  const current = data[key] && typeof data[key] === 'object' ? data[key] : {};
  const oldProfile = current.profile && typeof current.profile === 'object' ? current.profile : {};
  const customerName = cleanText(profile?.customerName, 160);
  const phone = cleanText(profile?.phone, 40);
  const address = cleanText(profile?.address, 500);
  const nextProfile = {
    customerName: customerName || oldProfile.customerName || current.nickname || customerId,
    phone: phone || oldProfile.phone || '',
    address: address || oldProfile.address || '',
    updatedAt: Date.now()
  };
  const now = Date.now();
  data[key] = {
    ...current,
    uniqueId: current.uniqueId || customerId,
    nickname: current.nickname || nextProfile.customerName,
    items: Array.isArray(current.items) ? current.items : [],
    profile: nextProfile,
    lastPurchaseAt: options.markPurchase ? now : (current.lastPurchaseAt || null)
  };
  db.prepare(`INSERT INTO customer_data (user_id, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .run(userId, JSON.stringify(data), now);
}

function getRememberedCustomerProfile(userId, customerId) {
  const normalized = cleanText(customerId, 120).replace(/^@/, '').toLowerCase();
  if (!normalized) return {};
  const row = db.prepare('SELECT data FROM customer_data WHERE user_id = ?').get(userId);
  try {
    const data = row?.data ? JSON.parse(row.data) : {};
    const key = Object.keys(data || {}).find(item =>
      item.replace(/^@/, '').toLowerCase() === normalized
    );
    return key && data[key]?.profile && typeof data[key].profile === 'object'
      ? data[key].profile
      : {};
  } catch (err) {
    return {};
  }
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

function addShipmentEvent(userId, orderId, eventType, status, note, location, createdAt) {
  db.prepare(`INSERT INTO shipment_events
    (user_id, order_id, event_type, status, note, location, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, orderId, eventType, status || null, cleanText(note, 500) || null,
      cleanText(location, 300) || null,
      intValue(createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER));
}

function makeShippingCode(userId) {
  const date = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const code = `LC${yy}${mm}${dd}${suffix}`;
    const exists = db.prepare('SELECT 1 FROM orders WHERE user_id = ? AND shipping_code = ?')
      .get(userId, code);
    if (!exists) return code;
  }
  return `LC${Date.now()}${userId}`;
}

function valueAt(source, pathParts) {
  let value = source;
  for (const part of pathParts) {
    if (value == null || typeof value !== 'object') return undefined;
    value = value[part];
  }
  return value;
}

function firstValue(source, paths) {
  for (const pathParts of paths) {
    const value = valueAt(source, pathParts);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function parseSpxTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const number = Number(value);
    return Number.isFinite(number) ? (number < 100000000000 ? number * 1000 : number) : null;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function mapSpxToShippingStatus(tracking) {
  const text = [
    tracking?.currentStatus,
    ...(tracking?.journey || []).slice(0, 3).flatMap(event => [event.status, event.note])
  ].filter(Boolean).join(' ').toLowerCase();
  if (!text) return null;
  if (/(đã hoàn|hoàn trả thành công|returned|return completed)/i.test(text)) return 'returned';
  if (/(đang hoàn|chuyển hoàn|returning|return to sender)/i.test(text)) return 'returning';
  if (/(giao thành công|đã giao|đã nhận|delivered|delivery successful)/i.test(text)) return 'delivered';
  if (/(giao thất bại|giao không thành công|delivery failed|unsuccessful delivery)/i.test(text)) return 'delivery_failed';
  if (/(đã hủy|cancelled|canceled)/i.test(text)) return 'cancelled';
  if (/(chờ lấy|chưa lấy|awaiting pickup|pickup pending|ready for pickup)/i.test(text)) return 'awaiting_pickup';
  if (/(đang giao|đang vận chuyển|đã lấy hàng|in transit|out for delivery|picked up|transporting)/i.test(text)) {
    return 'delivering';
  }
  return null;
}

function normalizeSpxTracking(payload, requestedCode) {
  const root = payload?.data?.data || payload?.data || {};
  const recordLists = [
    valueAt(root, ['sls_tracking_info', 'records']),
    valueAt(root, ['tracking_info', 'records']),
    valueAt(root, ['tracking_info', 'tracking_list']),
    valueAt(root, ['tracking_list']),
    valueAt(root, ['status_list'])
  ].filter(Array.isArray);
  const seen = new Set();
  const journey = [];
  for (const list of recordLists) {
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const status = cleanText(firstValue(item, [
        ['status_name'], ['milestone_name'], ['tracking_code_group_name'],
        ['status'], ['milestone_code'], ['code']
      ]), 160);
      const note = cleanText(firstValue(item, [
        ['message'], ['description'], ['status_desc'], ['tracking_message'],
        ['event_description'], ['status_name']
      ]), 500);
      const location = cleanText(firstValue(item, [
        ['location_name'], ['current_location'], ['station_name'], ['hub_name'],
        ['location'], ['address']
      ]), 300);
      const timestamp = parseSpxTime(firstValue(item, [
        ['timestamp'], ['event_time'], ['update_time'], ['ctime'], ['created_at'], ['time']
      ])) || Date.now();
      if (!status && !note && !location) continue;
      const key = `${timestamp}|${status}|${note}|${location}`;
      if (seen.has(key)) continue;
      seen.add(key);
      journey.push({ status, note: note || status, location, createdAt: timestamp });
    }
  }
  journey.sort((a, b) => b.createdAt - a.createdAt);

  const currentStatus = cleanText(firstValue(root, [
    ['order_info', 'tracking_code_group_name'], ['order_info', 'current_status'],
    ['order_info', 'status_name'], ['tracking_info', 'current_status'],
    ['current_status']
  ]), 160) || journey[0]?.status || journey[0]?.note || 'Đang cập nhật';
  const currentLocation = cleanText(firstValue(root, [
    ['order_info', 'current_location'], ['tracking_info', 'current_location'],
    ['current_location']
  ]), 300) || journey[0]?.location || '';
  const expectedRaw = firstValue(root, [
    ['edd_info', 'expected_delivery_time'], ['edd_info', 'estimated_delivery_time'],
    ['edd_info', 'expected_delivery_date'], ['edd_info', 'estimated_delivery_date'],
    ['edd_info', 'delivery_date'], ['edd_info', 'edd'], ['expected_delivery_time']
  ]);
  const expectedDeliveryAt = parseSpxTime(expectedRaw);
  const expectedDeliveryText = cleanText(
    expectedDeliveryAt ? new Date(expectedDeliveryAt).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
      : (typeof expectedRaw === 'object' ? JSON.stringify(expectedRaw) : expectedRaw), 160);
  const trackingCode = cleanText(firstValue(root, [
    ['order_info', 'spx_tn'], ['order_info', 'sls_tn'], ['tracking_number']
  ]), 80) || requestedCode;
  return { trackingCode, currentStatus, currentLocation, expectedDeliveryAt, expectedDeliveryText, journey, raw: root };
}

async function fetchSpxTracking(trackingCode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const url = new URL('https://spx.vn/shipment/order/open/order/get_order_info');
    url.searchParams.set('spx_tn', trackingCode);
    url.searchParams.set('language_code', 'vi');
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'vi-VN,vi;q=0.9',
        Referer: `https://spx.vn/track?${encodeURIComponent(trackingCode)}`,
        'User-Agent': 'Mozilla/5.0 TikTok-Live-Order-Manager/2.6'
      }
    });
    if (!response.ok) throw new Error(`SPX HTTP ${response.status}`);
    const payload = await response.json();
    if (Number(payload?.retcode) !== 0 || !payload?.data) {
      const error = new Error('SPX chưa trả về dữ liệu cho mã này.');
      error.code = 'SPX_NOT_FOUND';
      throw error;
    }
    return normalizeSpxTracking(payload, trackingCode);
  } finally {
    clearTimeout(timer);
  }
}

function saveSpxTrackingSuccess(userId, orderId, tracking, now, auditAction = null) {
  const order = db.prepare(`SELECT shipping_status FROM orders
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(orderId, userId);
  if (!order) return null;
  const syncedShippingStatus = mapSpxToShippingStatus(tracking);
  db.prepare(`INSERT INTO shipment_tracking
    (order_id,user_id,carrier,tracking_code,current_status,current_location,
     expected_delivery_at,expected_delivery_text,raw_data,last_checked_at,last_error,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)
    ON CONFLICT(order_id) DO UPDATE SET carrier=excluded.carrier,
      tracking_code=excluded.tracking_code,current_status=excluded.current_status,
      current_location=excluded.current_location,
      expected_delivery_at=excluded.expected_delivery_at,
      expected_delivery_text=excluded.expected_delivery_text,
      raw_data=excluded.raw_data,last_checked_at=excluded.last_checked_at,
      last_error=NULL,updated_at=excluded.updated_at`)
    .run(orderId, userId, 'SPX', tracking.trackingCode, tracking.currentStatus,
      tracking.currentLocation || null, tracking.expectedDeliveryAt,
      tracking.expectedDeliveryText || null, null, now, now);
  if (syncedShippingStatus && syncedShippingStatus !== order.shipping_status) {
    const syncedOrderStatus = syncedShippingStatus === 'delivered' ? 'completed'
      : ['returning','returned'].includes(syncedShippingStatus) ? 'returned'
        : syncedShippingStatus === 'cancelled' ? 'cancelled'
          : ['delivering','delivery_failed'].includes(syncedShippingStatus) ? 'shipped' : null;
    db.prepare(`UPDATE orders SET shipping_status = ?, shipping_updated_at = ?,
      delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
      status = COALESCE(?, status), updated_at = ?
      WHERE id = ? AND user_id = ?`)
      .run(syncedShippingStatus, now, syncedShippingStatus, now, syncedOrderStatus,
        now, orderId, userId);
  }
  db.prepare(`DELETE FROM shipment_events
    WHERE user_id = ? AND order_id = ? AND event_type = 'spx_tracking'`).run(userId, orderId);
  for (const event of tracking.journey.slice(0, 300)) {
    addShipmentEvent(userId, orderId, 'spx_tracking', event.status,
      event.note, event.location, event.createdAt);
  }
  if (!tracking.journey.length) {
    addShipmentEvent(userId, orderId, 'spx_tracking', tracking.currentStatus,
      tracking.currentStatus, tracking.currentLocation, now);
  }
  if (syncedShippingStatus && syncedShippingStatus !== order.shipping_status) {
    addShipmentEvent(userId, orderId, 'carrier_status_sync', syncedShippingStatus,
      'Tự đồng bộ theo trạng thái SPX', tracking.currentLocation, now);
  }
  if (auditAction) {
    addAudit(userId, auditAction, 'order', orderId, {
      trackingCode: tracking.trackingCode,
      status: tracking.currentStatus,
      syncedShippingStatus
    });
  }
  return syncedShippingStatus;
}

function saveSpxTrackingError(userId, orderId, trackingCode, message, now) {
  const existing = db.prepare(`SELECT tracking_code FROM shipment_tracking
    WHERE order_id = ? AND user_id = ?`).get(orderId, userId);
  if (existing && existing.tracking_code === trackingCode) {
    db.prepare(`UPDATE shipment_tracking SET last_checked_at = ?, last_error = ?, updated_at = ?
      WHERE order_id = ? AND user_id = ?`).run(now, message, now, orderId, userId);
    return;
  }
  db.prepare(`INSERT INTO shipment_tracking
    (order_id,user_id,carrier,tracking_code,current_status,current_location,
     expected_delivery_at,expected_delivery_text,raw_data,last_checked_at,last_error,updated_at)
    VALUES (?,?, 'SPX', ?,NULL,NULL,NULL,NULL,NULL,?,?,?)
    ON CONFLICT(order_id) DO UPDATE SET carrier='SPX',
      tracking_code=excluded.tracking_code,current_status=NULL,current_location=NULL,
      expected_delivery_at=NULL,expected_delivery_text=NULL,raw_data=NULL,
      last_checked_at=excluded.last_checked_at,last_error=excluded.last_error,
      updated_at=excluded.updated_at`)
    .run(orderId, userId, trackingCode, now, message, now);
}

let spxAutoRefreshRunning = false;
async function refreshPendingSpxTracking() {
  if (spxAutoRefreshRunning) return;
  spxAutoRefreshRunning = true;
  try {
    const pending = db.prepare(`SELECT t.user_id, t.order_id, t.tracking_code
      FROM shipment_tracking t
      JOIN orders o ON o.id = t.order_id AND o.user_id = t.user_id
      WHERE o.deleted_at IS NULL
        AND o.shipping_status NOT IN ('delivered','returned','cancelled')
        AND t.carrier = 'SPX' AND length(t.tracking_code) >= 6
      ORDER BY COALESCE(t.last_checked_at, 0) ASC
      LIMIT 500`).all();
    for (const item of pending) {
      const now = Date.now();
      try {
        const tracking = await fetchSpxTracking(item.tracking_code);
        saveSpxTrackingSuccess(item.user_id, item.order_id, tracking, now);
      } catch (err) {
        const message = err?.name === 'AbortError'
          ? 'SPX phản hồi quá chậm. Hệ thống sẽ tự thử lại.'
          : err?.code === 'SPX_NOT_FOUND'
            ? 'SPX chưa tìm thấy mã này.'
            : 'Không kết nối được SPX. Hệ thống sẽ tự thử lại.';
        saveSpxTrackingError(item.user_id, item.order_id, item.tracking_code, message, now);
      }
    }
  } catch (err) {
    console.error('[SPX Auto] Không thể cập nhật:', err?.message || err);
  } finally {
    spxAutoRefreshRunning = false;
  }
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
    shippingCode: row.shipping_code || '',
    shippingStatus: row.shipping_status || 'awaiting_info',
    packageWeight: row.package_weight || 500,
    codAmount: row.cod_amount == null ? row.total : row.cod_amount,
    shippingCreatedAt: row.shipping_created_at,
    shippingUpdatedAt: row.shipping_updated_at,
    labelCount: row.label_count || 0,
    lastLabelAt: row.last_label_at,
    deliveryAttempts: row.delivery_attempts || 0,
    codReconciledAt: row.cod_reconciled_at,
    codPaidAt: row.cod_paid_at,
    deliveredAt: row.delivered_at,
    carrier: row.carrier_name || row.carrier || '',
    externalTrackingCode: row.external_tracking_code || row.tracking_code || '',
    carrierStatus: row.carrier_status || row.current_status || '',
    currentLocation: row.carrier_location || row.current_location || '',
    expectedDeliveryAt: row.expected_delivery_at || null,
    expectedDeliveryText: row.expected_delivery_text || '',
    trackingUpdatedAt: row.tracking_updated_at || row.last_checked_at || null,
    trackingError: row.tracking_error || row.last_error || '',
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
  const rememberedProfile = getRememberedCustomerProfile(req.userId, customerId);
  const requestedCustomerName = cleanText(b.customerName, 160);
  const customerName = b.useSavedCustomerProfile && rememberedProfile.customerName
    ? cleanText(rememberedProfile.customerName, 160)
    : requestedCustomerName || cleanText(rememberedProfile.customerName, 160) || customerId;
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
  const phone = cleanText(b.phone, 40) || cleanText(rememberedProfile.phone, 40);
  const address = cleanText(b.address, 500) || cleanText(rememberedProfile.address, 500);
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
      quantity, unitPrice, shippingFee, total, phone || null,
      address || null, cleanText(b.note, 1000) || null,
      PAYMENT_STATUSES.has(b.paymentStatus) ? b.paymentStatus : 'unpaid', now, now);
  rememberCustomerProfile(req.userId, { customerId, customerName, phone, address }, { markPurchase: true });
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
  const customerName = cleanText(b.customerName, 160) || old.customer_name;
  const phone = cleanText(b.phone, 40);
  const address = cleanText(b.address, 500);
  db.prepare(`UPDATE orders SET customer_name = ?, product_code = ?, product_name = ?,
    quantity = ?, unit_price = ?, shipping_fee = ?, total = ?, phone = ?, address = ?,
    note = ?, status = ?, payment_status = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(customerName,
      cleanText(b.productCode, 80) || null,
      cleanText(b.productName, 240) || old.product_name,
      quantity, unitPrice, shippingFee, quantity * unitPrice + shippingFee,
      phone || null, address || null,
      cleanText(b.note, 1000) || null, status, paymentStatus, Date.now(),
      req.params.id, req.userId);
  rememberCustomerProfile(req.userId, {
    customerId: old.customer_id, customerName, phone, address
  });
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

// Danh sách vận chuyển dùng chung dữ liệu đơn hàng, nhưng chỉ trả về đơn thuộc
// tài khoản đang đăng nhập. Đơn chưa đủ SĐT/địa chỉ vẫn xuất hiện ở "Cần xử lý".
app.get('/api/shipments', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT o.*, t.carrier AS carrier_name,
      t.tracking_code AS external_tracking_code, t.current_status AS carrier_status,
      t.current_location AS carrier_location, t.expected_delivery_at,
      t.expected_delivery_text,
      t.last_checked_at AS tracking_updated_at, t.last_error AS tracking_error
    FROM orders o
    LEFT JOIN shipment_tracking t ON t.order_id = o.id AND t.user_id = o.user_id
    WHERE o.user_id = ? AND o.deleted_at IS NULL
    ORDER BY COALESCE(o.shipping_updated_at, o.updated_at) DESC LIMIT 5000`)
    .all(req.userId);
  res.json({ shipments: rows.map(publicOrder) });
});

app.get('/api/shipments/:id/events', requireAuth, (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.userId);
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn vận chuyển.' });
  const events = db.prepare(`SELECT event_type, status, note, location, created_at
    FROM shipment_events WHERE user_id = ? AND order_id = ?
    ORDER BY created_at DESC LIMIT 200`).all(req.userId, req.params.id);
  res.json({ events: events.map(e => ({
    eventType: e.event_type, status: e.status, note: e.note || '',
    location: e.location || '', createdAt: e.created_at
  })) });
});

app.post('/api/shipments/:id/spx-track', requireAuth, async (req, res) => {
  const order = db.prepare('SELECT id FROM orders WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.userId);
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
  const trackingCode = cleanText(req.body?.trackingCode, 80).toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9-]{6,80}$/.test(trackingCode)) {
    return res.status(400).json({ error: 'Mã vận đơn SPX không hợp lệ.' });
  }
  const now = Date.now();
  try {
    const tracking = await fetchSpxTracking(trackingCode);
    const syncedShippingStatus = saveSpxTrackingSuccess(
      req.userId, order.id, tracking, now, 'shipment.spx_tracked'
    );
    res.json({
      ok: true,
      tracking: {
        carrier: 'SPX', trackingCode: tracking.trackingCode,
        currentStatus: tracking.currentStatus, currentLocation: tracking.currentLocation,
        expectedDeliveryAt: tracking.expectedDeliveryAt,
        expectedDeliveryText: tracking.expectedDeliveryText,
        checkedAt: now, shippingStatus: syncedShippingStatus, journey: tracking.journey
      }
    });
  } catch (err) {
    const message = err?.name === 'AbortError'
      ? 'SPX phản hồi quá chậm. Hãy thử lại.'
      : err?.code === 'SPX_NOT_FOUND'
        ? 'SPX chưa tìm thấy mã này.'
        : 'Không kết nối được SPX. Hãy thử lại.';
    saveSpxTrackingError(req.userId, order.id, trackingCode, message, now);
    addAudit(req.userId, 'shipment.spx_track_failed', 'order', order.id, { trackingCode });
    res.status(err?.code === 'SPX_NOT_FOUND' ? 404 : 502).json({ error: message, saved: true });
  }
});

app.post('/api/shipments/:id/prepare', requireAuth, (req, res) => {
  const old = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.userId);
  if (!old) return res.status(404).json({ error: 'Không tìm thấy đơn hàng.' });
  const b = req.body || {};
  const phone = cleanText(b.phone ?? old.phone, 40);
  const address = cleanText(b.address ?? old.address, 500);
  const customerName = cleanText(b.customerName ?? old.customer_name, 160) || old.customer_name;
  if ((phone.match(/\d/g) || []).length < 8) {
    return res.status(400).json({ error: 'Số điện thoại người nhận cần có ít nhất 8 chữ số.' });
  }
  if (address.length < 8) {
    return res.status(400).json({ error: 'Vui lòng nhập địa chỉ giao hàng đầy đủ.' });
  }
  const now = Date.now();
  const code = old.shipping_code || makeShippingCode(req.userId);
  const weight = intValue(b.packageWeight, old.package_weight || 500, 1, 100000);
  const codAmount = intValue(b.codAmount, old.cod_amount == null ? old.total : old.cod_amount, 0, 1000000000);
  const shippingFee = intValue(b.shippingFee, old.shipping_fee, 0, 1000000000);
  const note = cleanText(b.note ?? old.note, 1000) || null;
  const nextStatus = old.shipping_code && SHIPPING_STATUSES.has(old.shipping_status)
    ? old.shipping_status : 'ready';
  const nextOrderStatus = ['new'].includes(old.status) ? 'confirmed' : old.status;
  db.prepare(`UPDATE orders SET customer_name = ?, phone = ?, address = ?, note = ?,
    shipping_fee = ?, total = quantity * unit_price + ?, shipping_code = ?,
    shipping_status = ?, package_weight = ?, cod_amount = ?,
    shipping_created_at = COALESCE(shipping_created_at, ?), shipping_updated_at = ?,
    status = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(customerName, phone, address, note, shippingFee, shippingFee, code,
      nextStatus, weight, codAmount, now, now, nextOrderStatus, now, old.id, req.userId);
  rememberCustomerProfile(req.userId, {
    customerId: old.customer_id, customerName, phone, address
  });
  addShipmentEvent(req.userId, old.id, old.shipping_code ? 'details_updated' : 'shipment_created',
    nextStatus, old.shipping_code ? 'Cập nhật thông tin người nhận/kiện hàng' : 'Đã tạo phiếu luân chuyển');
  addAudit(req.userId, old.shipping_code ? 'shipment.updated' : 'shipment.created',
    'order', old.id, { shippingCode: code, status: nextStatus });
  res.json({ order: publicOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(old.id)) });
});

app.post('/api/shipments/:id/status', requireAuth, (req, res) => {
  const old = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.userId);
  if (!old) return res.status(404).json({ error: 'Không tìm thấy đơn vận chuyển.' });
  if (!old.shipping_code) return res.status(400).json({ error: 'Hãy tạo phiếu luân chuyển trước.' });
  const status = cleanText(req.body?.status, 40);
  if (!SHIPPING_STATUSES.has(status) || status === 'awaiting_info') {
    return res.status(400).json({ error: 'Trạng thái vận chuyển không hợp lệ.' });
  }
  const orderStatusMap = {
    ready: 'confirmed', label_created: 'packing', awaiting_pickup: 'packing',
    delivering: 'shipped', delivery_failed: 'shipped', delivered: 'completed',
    returning: 'returned', returned: 'returned', cancelled: 'cancelled'
  };
  const note = cleanText(req.body?.note, 500);
  const now = Date.now();
  const addAttempt = status === 'delivering' && old.shipping_status !== 'delivering' ? 1 : 0;
  db.prepare(`UPDATE orders SET shipping_status = ?, shipping_updated_at = ?,
    delivery_attempts = delivery_attempts + ?,
    delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
    status = ?, updated_at = ?
    WHERE id = ? AND user_id = ?`)
    .run(status, now, addAttempt, status, now, orderStatusMap[status] || old.status,
      now, old.id, req.userId);
  addShipmentEvent(req.userId, old.id, 'status_changed', status, note);
  addAudit(req.userId, 'shipment.status_changed', 'order', old.id, { status, note });
  res.json({ order: publicOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(old.id)) });
});

app.post('/api/shipments/:id/label', requireAuth, (req, res) => {
  const old = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.userId);
  if (!old) return res.status(404).json({ error: 'Không tìm thấy đơn vận chuyển.' });
  if (!old.shipping_code) return res.status(400).json({ error: 'Hãy tạo phiếu luân chuyển trước.' });
  const now = Date.now();
  const nextStatus = ['ready', 'label_created'].includes(old.shipping_status) ? 'label_created' : old.shipping_status;
  db.prepare(`UPDATE orders SET label_count = label_count + 1, last_label_at = ?,
    shipping_status = ?, shipping_updated_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?`)
    .run(now, nextStatus, now, now, old.id, req.userId);
  addShipmentEvent(req.userId, old.id, 'label_exported', nextStatus, 'Đã xuất phiếu PNG');
  res.json({ order: publicOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(old.id)) });
});

app.post('/api/shipments/:id/reconcile', requireAuth, (req, res) => {
  const old = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.userId);
  if (!old) return res.status(404).json({ error: 'Không tìm thấy đơn vận chuyển.' });
  if (old.shipping_status !== 'delivered') {
    return res.status(400).json({ error: 'Chỉ đối soát đơn đã giao thành công.' });
  }
  const action = cleanText(req.body?.action, 30);
  const now = Date.now();
  let reconciledAt = old.cod_reconciled_at;
  let paidAt = old.cod_paid_at;
  if (action === 'reconciled') {
    reconciledAt = reconciledAt || now;
  } else if (action === 'paid') {
    reconciledAt = reconciledAt || now;
    paidAt = paidAt || now;
  } else if (action === 'reset') {
    reconciledAt = null;
    paidAt = null;
  } else {
    return res.status(400).json({ error: 'Thao tác đối soát không hợp lệ.' });
  }
  db.prepare(`UPDATE orders SET cod_reconciled_at = ?, cod_paid_at = ?,
    shipping_updated_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`)
    .run(reconciledAt, paidAt, now, now, old.id, req.userId);
  addShipmentEvent(req.userId, old.id, `cod_${action}`, 'delivered',
    action === 'paid' ? 'Đã nhận tiền COD' : action === 'reconciled' ? 'Đã đối soát COD' : 'Đặt lại đối soát');
  addAudit(req.userId, `shipment.cod_${action}`, 'order', old.id);
  res.json({ order: publicOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(old.id)) });
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
  const shipmentEvents = db.prepare('SELECT * FROM shipment_events WHERE user_id = ? ORDER BY created_at').all(req.userId);
  const shipmentTracking = db.prepare('SELECT * FROM shipment_tracking WHERE user_id = ?').all(req.userId);
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
    shipmentEvents,
    shipmentTracking,
    settings: settingsRow ? JSON.parse(settingsRow.data) : {}
  });
});

app.post('/api/backup/restore', requireAuth, (req, res) => {
  const backup = req.body?.backup;
  if (!backup || backup.version !== 2 || !Array.isArray(backup.orders) || !Array.isArray(backup.products)) {
    return res.status(400).json({ error: 'Tệp sao lưu không đúng định dạng phiên bản 2.' });
  }
  if (backup.orders.length > 100000 || backup.products.length > 10000 ||
      (Array.isArray(backup.shipmentEvents) && backup.shipmentEvents.length > 500000) ||
      (Array.isArray(backup.shipmentTracking) && backup.shipmentTracking.length > 100000)) {
    return res.status(400).json({ error: 'Bản sao lưu vượt quá giới hạn an toàn.' });
  }
  const now = Date.now();
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM shipment_events WHERE user_id = ?').run(req.userId);
    db.prepare('DELETE FROM shipment_tracking WHERE user_id = ?').run(req.userId);
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
       status,payment_status,print_status,print_attempts,last_print_error,
       shipping_code,shipping_status,package_weight,cod_amount,shipping_created_at,
       shipping_updated_at,label_count,last_label_at,delivery_attempts,cod_reconciled_at,cod_paid_at,
       delivered_at,created_at,updated_at,deleted_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`);
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
        cleanText(o.shipping_code ?? o.shippingCode, 80) || null,
        SHIPPING_STATUSES.has(o.shipping_status ?? o.shippingStatus) ? (o.shipping_status ?? o.shippingStatus) : 'awaiting_info',
        intValue(o.package_weight ?? o.packageWeight, 500, 1, 100000),
        intValue(o.cod_amount ?? o.codAmount, quantity * unitPrice + shippingFee, 0, 1000000000),
        o.shipping_created_at ?? o.shippingCreatedAt ?? null,
        o.shipping_updated_at ?? o.shippingUpdatedAt ?? null,
        intValue(o.label_count ?? o.labelCount, 0, 0, 100000),
        o.last_label_at ?? o.lastLabelAt ?? null,
        intValue(o.delivery_attempts ?? o.deliveryAttempts, 0, 0, 100000),
        o.cod_reconciled_at ?? o.codReconciledAt ?? null,
        o.cod_paid_at ?? o.codPaidAt ?? null,
        o.delivered_at ?? o.deliveredAt ?? null,
        intValue(o.created_at ?? o.createdAt, now, 0, Number.MAX_SAFE_INTEGER),
        intValue(o.updated_at ?? o.updatedAt, now, 0, Number.MAX_SAFE_INTEGER));
    }
    const restoredOrderIds = new Set(backup.orders.map(o => cleanText(o.id, 160)).filter(Boolean));
    const insertShipmentTracking = db.prepare(`INSERT INTO shipment_tracking
      (order_id,user_id,carrier,tracking_code,current_status,current_location,
       expected_delivery_at,expected_delivery_text,raw_data,last_checked_at,last_error,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const t of (Array.isArray(backup.shipmentTracking) ? backup.shipmentTracking : [])) {
      const orderId = cleanText(t.order_id ?? t.orderId, 160);
      if (!restoredOrderIds.has(orderId)) continue;
      insertShipmentTracking.run(orderId, req.userId, cleanText(t.carrier, 30) || 'SPX',
        cleanText(t.tracking_code ?? t.trackingCode, 80),
        cleanText(t.current_status ?? t.currentStatus, 160) || null,
        cleanText(t.current_location ?? t.currentLocation, 300) || null,
        t.expected_delivery_at ?? t.expectedDeliveryAt ?? null,
        cleanText(t.expected_delivery_text ?? t.expectedDeliveryText, 160) || null,
        cleanText(t.raw_data ?? t.rawData, 500000) || null,
        t.last_checked_at ?? t.lastCheckedAt ?? null,
        cleanText(t.last_error ?? t.lastError, 500) || null,
        intValue(t.updated_at ?? t.updatedAt, now, 0, Number.MAX_SAFE_INTEGER));
    }
    const insertShipmentEvent = db.prepare(`INSERT INTO shipment_events
      (user_id,order_id,event_type,status,note,location,created_at) VALUES (?,?,?,?,?,?,?)`);
    for (const e of (Array.isArray(backup.shipmentEvents) ? backup.shipmentEvents : [])) {
      const orderId = cleanText(e.order_id ?? e.orderId, 160);
      if (!restoredOrderIds.has(orderId)) continue;
      insertShipmentEvent.run(req.userId, orderId,
        cleanText(e.event_type ?? e.eventType, 80) || 'restored',
        cleanText(e.status, 40) || null, cleanText(e.note, 500) || null,
        cleanText(e.location, 300) || null,
        intValue(e.created_at ?? e.createdAt, now, 0, Number.MAX_SAFE_INTEGER));
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
let liveAccessExpiryTimer = null;

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

function clearLiveAccessExpiry() {
  if (liveAccessExpiryTimer) clearTimeout(liveAccessExpiryTimer);
  liveAccessExpiryTimer = null;
}

function scheduleLiveAccessExpiry(userId, expiresAt) {
  clearLiveAccessExpiry();
  if (!expiresAt) return;
  const check = () => {
    if (currentLiveUserId !== userId) return;
    const remaining = expiresAt - Date.now();
    if (remaining > 0) {
      liveAccessExpiryTimer = setTimeout(check, Math.min(remaining, 24 * 60 * 60 * 1000));
      return;
    }
    const endedUsername = currentLiveUsername;
    shutdownTiktokConnection(tiktokConnection);
    tiktokConnection = null;
    currentLiveUsername = null;
    currentLiveUserId = null;
    commentHistory = [];
    currentSessionId = null;
    tiktokConnectionGeneration++;
    liveAccessExpiryTimer = null;
    broadcastToBrowsers({
      type: 'STATUS', success: false, locked: true, feature: 'live_view',
      stopped: true,
      msg: `Gói trải nghiệm của bạn đã hết hạn${endedUsername ? ` khi đang xem @${endedUsername}` : ''}.`
    }, userId);
  };
  check();
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
      clearLiveAccessExpiry();
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
          if (customersData[data.customerId].items.length === 0 && !customersData[data.customerId].profile) {
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
        clearLiveAccessExpiry();
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
        if (requestLicense.isExpired) {
          const expiredMsg = `Gói "${requestLicense.label}" đã hết hạn. Vui lòng gia hạn để tiếp tục xem Live.`;
          logLicenseLock(requestUser.username, 'live_view', expiredMsg);
          return ws.send(JSON.stringify({
            type: 'STATUS', success: false, locked: true,
            feature: 'live_view', msg: expiredMsg
          }));
        }
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
        clearLiveAccessExpiry();
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
          scheduleLiveAccessExpiry(requestUserId, requestLicense.expiresAt);
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
          clearLiveAccessExpiry();
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
  // Dọn ngay khi khởi động, sau đó kiểm tra lại mỗi 6 giờ.
  cleanupExpiredComments(new Date());
  cleanupInactiveCustomers(new Date());
  cleanupCompletedShipmentDetails(new Date());
  cleanupSoftDeletedOrders(new Date());
  const retentionTimer = setInterval(() => {
    cleanupExpiredComments(new Date());
    cleanupInactiveCustomers(new Date());
    cleanupCompletedShipmentDetails(new Date());
    cleanupSoftDeletedOrders(new Date());
  }, 6 * 60 * 60 * 1000);
  retentionTimer.unref();
  // Mỗi 5 phút chỉ tra lại các mã SPX của đơn chưa giao xong/chưa hoàn xong.
  const spxAutoRefreshTimer = setInterval(refreshPendingSpxTracking, 5 * 60 * 1000);
  spxAutoRefreshTimer.unref();
  console.log('[SPX Auto] Tự cập nhật đơn đang vận chuyển mỗi 5 phút.');
});
