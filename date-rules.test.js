'use strict';

// Chạy bằng: node --test tests/
// Dùng module test/assert có sẵn của Node (>=18), không cần cài thêm gì.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addOneCalendarMonthEndOfDay,
  isCommentExpired,
  addThreeCalendarMonthsEndOfDay,
} = require('./lib/date-rules');

// Giờ Việt Nam = UTC+7. Để test dễ đọc, dựng thời điểm bằng giờ UTC tương ứng.
// VD: 25/07/2026 10:00 giờ VN = 25/07/2026 03:00 UTC.
function vnDateTimeToUtc(y, m, d, hh = 0, mm = 0, ss = 0) {
  return new Date(Date.UTC(y, m - 1, d, hh - 7, mm, ss));
}

test('addOneCalendarMonthEndOfDay: comment ngày 25/07 hết hạn vào 23:59:59.999 ngày 25/08 (giờ VN)', () => {
  const receivedAt = vnDateTimeToUtc(2026, 7, 25, 14, 30, 0); // 25/07/2026 14:30 VN
  const expiry = addOneCalendarMonthEndOfDay(receivedAt);
  // Kỳ vọng: 25/08/2026 23:59:59.999 giờ VN = 25/08/2026 16:59:59.999 UTC.
  assert.equal(expiry.toISOString(), '2026-08-25T16:59:59.999Z');
});

test('isCommentExpired: còn giữ đến hết ngày 25/08, đúng 00:00:00 ngày 26/08 mới coi là hết hạn', () => {
  const receivedAt = vnDateTimeToUtc(2026, 7, 25, 14, 30, 0);
  const stillWithinLastMoment = vnDateTimeToUtc(2026, 8, 25, 23, 59, 59); // vẫn còn hạn
  const justExpired = vnDateTimeToUtc(2026, 8, 26, 0, 0, 1); // vừa qua hạn 1 giây

  assert.equal(isCommentExpired(receivedAt, stillWithinLastMoment), false);
  assert.equal(isCommentExpired(receivedAt, justExpired), true);
});

test('addOneCalendarMonthEndOfDay: kẹp ngày khi tháng đích ngắn hơn (31/01 -> 28/02, năm thường)', () => {
  const receivedAt = vnDateTimeToUtc(2027, 1, 31, 9, 0, 0); // 2027 không phải năm nhuận
  const expiry = addOneCalendarMonthEndOfDay(receivedAt);
  assert.equal(expiry.getUTCFullYear() + '-' + (expiry.getUTCMonth() + 1) + '-' + expiry.getUTCDate(),
    // Giờ VN 23:59:59.999 ngày 28/02 UTC là 16:59:59.999 ngày 28/02 (vẫn cùng ngày UTC).
    '2027-2-28');
});

test('addOneCalendarMonthEndOfDay: kẹp ngày đúng vào năm nhuận (31/01 -> 29/02/2028)', () => {
  const receivedAt = vnDateTimeToUtc(2028, 1, 31, 9, 0, 0); // 2028 là năm nhuận
  const expiry = addOneCalendarMonthEndOfDay(receivedAt);
  assert.equal(expiry.getUTCMonth() + 1, 2);
  assert.equal(expiry.getUTCDate(), 29);
});

test('addOneCalendarMonthEndOfDay: input không hợp lệ trả về null thay vì crash', () => {
  assert.equal(addOneCalendarMonthEndOfDay('không phải ngày tháng'), null);
  assert.equal(addOneCalendarMonthEndOfDay(undefined), null);
  assert.equal(addOneCalendarMonthEndOfDay(null), null);
});

test('addOneCalendarMonthEndOfDay: mốc 23h VN (gần nửa đêm) vẫn tính đúng ngày VN, không lệch sang hôm sau theo UTC', () => {
  // 25/07/2026 23:30 giờ VN = 25/07/2026 16:30 UTC — nếu tính nhầm theo ngày UTC
  // (vẫn là 25/07 UTC nên trường hợp này thực ra an toàn); thử thêm mốc sát nửa
  // đêm UTC để chắc chắn quy đổi timezone hoạt động đúng hướng.
  const receivedAt = vnDateTimeToUtc(2026, 7, 26, 0, 30, 0); // 26/07/2026 00:30 giờ VN
  const expiry = addOneCalendarMonthEndOfDay(receivedAt);
  // Phải hết hạn vào hết ngày 26/08, không phải 25/08.
  assert.equal(expiry.toISOString(), '2026-08-26T16:59:59.999Z');
});

test('addThreeCalendarMonthsEndOfDay: khách mua 25/07 không mua lại thì hồ sơ hết hạn hết ngày 25/10', () => {
  const lastPurchaseAt = vnDateTimeToUtc(2026, 7, 25, 12, 0, 0);
  const expiry = addThreeCalendarMonthsEndOfDay(lastPurchaseAt);
  assert.equal(expiry.toISOString(), '2026-10-25T16:59:59.999Z');
});

test('addThreeCalendarMonthsEndOfDay: kẹp ngày đúng khi cộng 3 tháng qua tháng ngắn hơn (30/11 -> so target tháng 02)', () => {
  const lastPurchaseAt = vnDateTimeToUtc(2026, 11, 30, 8, 0, 0);
  const expiry = addThreeCalendarMonthsEndOfDay(lastPurchaseAt);
  // 30/11 + 3 tháng = tháng 02/2027 (28 ngày, năm không nhuận) -> kẹp về 28/02.
  assert.equal(expiry.getUTCFullYear(), 2027);
  assert.equal(expiry.getUTCMonth() + 1, 2);
  assert.equal(expiry.getUTCDate(), 28);
});

test('addThreeCalendarMonthsEndOfDay: input không hợp lệ trả về null', () => {
  assert.equal(addThreeCalendarMonthsEndOfDay('abc'), null);
});
