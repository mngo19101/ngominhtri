'use strict';

// ====== CÁC QUY TẮC NGÀY/GIỜ DÙNG CHO TỰ ĐỘNG DỌN DỮ LIỆU ======
// File này tách riêng khỏi server.js vì đây là các hàm THUẦN (pure function):
// không đụng tới database, không đụng tới mạng — chỉ nhận đầu vào là thời
// điểm và trả về thời điểm khác. Tách riêng để có thể viết unit test độc lập
// (xem tests/date-rules.test.js) mà không cần khởi động toàn bộ server/DB.
//
// Quy tắc chung: mọi tính toán "ngày lịch" (cộng 1 tháng, cộng 3 tháng) đều
// quy đổi sang giờ Việt Nam (UTC+7) trước, để kết quả luôn đúng theo ngày
// Việt Nam bất kể server (Railway) đang chạy ở timezone nào.

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

// Cộng N tháng theo lịch, giữ nguyên ngày trong tháng (kẹp về ngày cuối cùng
// của tháng đích nếu tháng đích ngắn hơn, vd 31/01 + 1 tháng = 28 hoặc 29/02),
// rồi trả về đúng thời điểm 23:59:59.999 giờ Việt Nam của ngày đó.
function addCalendarMonthsEndOfDayVN(value, monthsToAdd) {
  // Lưu ý JS: `new Date(null)` KHÔNG phải "không hợp lệ" — nó bị hiểu thành
  // epoch (01/01/1970 00:00:00 UTC)! Nếu không chặn riêng, một giá trị null/
  // undefined/'' lọt vào đây sẽ âm thầm tính ra ngày hết hạn ở năm 1970 thay
  // vì được coi là "không có ngày hợp lệ" như mong đợi. Chặn tường minh trước.
  if (value === null || value === undefined || value === '') return null;
  const source = new Date(value);
  if (!Number.isFinite(source.getTime())) return null;
  const vietnam = new Date(source.getTime() + VN_OFFSET_MS);
  const year = vietnam.getUTCFullYear();
  const month = vietnam.getUTCMonth();
  const day = vietnam.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + monthsToAdd + 1, 0)).getUTCDate();
  const targetDay = Math.min(day, lastDayOfTargetMonth);
  // 23:59:59.999 giờ Việt Nam = 16:59:59.999 UTC (vì VN = UTC+7).
  return new Date(Date.UTC(year, month + monthsToAdd, targetDay, 16, 59, 59, 999));
}

// ====== TỰ DỌN COMMENT QUÁ HẠN ======
// Quy tắc theo ngày lịch đúng yêu cầu:
// - Comment ngày 25/07 được giữ đến hết 25/08.
// - Từ 00:00 ngày 26/08 trở đi mới bị xóa.
// Đơn hàng/giỏ khách đã chốt KHÔNG bị xóa theo tác vụ này.
function addOneCalendarMonthEndOfDay(value) {
  return addCalendarMonthsEndOfDayVN(value, 1);
}

function isCommentExpired(receivedAt, now = new Date()) {
  const expiry = addOneCalendarMonthEndOfDay(receivedAt);
  return expiry ? now.getTime() > expiry.getTime() : false;
}

// ====== TỰ DỌN KHÁCH KHÔNG MUA LẠI QUÁ 3 THÁNG ======
function addThreeCalendarMonthsEndOfDay(value) {
  return addCalendarMonthsEndOfDayVN(value, 3);
}

module.exports = {
  addCalendarMonthsEndOfDayVN,
  addOneCalendarMonthEndOfDay,
  isCommentExpired,
  addThreeCalendarMonthsEndOfDay,
};
