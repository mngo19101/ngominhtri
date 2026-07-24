# TikTok Live Print & Order Manager v2

Bộ mã này chạy trực tiếp trên Railway và phục vụ giao diện tại:

`https://ngominhtri-production.up.railway.app/`

## Cấu trúc cần upload

```text
server.js
package.json
package-lock.json
public/
  index.html
```

Không upload `node_modules`, `test-data` hoặc database cục bộ.

## Cấu hình Railway

1. Đặt Start Command là `npm start` (Railway thường tự đọc script này).
2. Dùng Node.js 22 trở lên. `package.json` đã khai báo `node >=22`.
3. Tạo Railway Volume và mount tại `/data`.
4. Đặt biến môi trường:

```text
DATA_DIR=/data
ADMIN_USERNAME=ten_admin_cua_ban
ADMIN_PASSWORD=mat_khau_admin_manh
```

Tùy chọn:

```text
TIKTOK_SIGN_API_KEY=api_key_cua_eulerstream
```

Không đổi `PORT`; Railway tự cấp biến này.

Sau khi upload, chọn **Redeploy**. Server tự tạo/migrate bảng SQLite, không xóa dữ liệu cũ. Hãy xác nhận log có dòng:

```text
Đang lưu database tại thư mục lâu dài: /data
Bridge Server đang chạy tại cổng ...
```

## Tính năng v2

- Xác nhận/chỉnh sửa đơn trước khi lưu hoặc in.
- Nút **In & thêm đơn** trên comment: tự gom theo TikTok ID, tạo đơn nội bộ và in phiếu dán sản phẩm; không cần giỏ hàng TikTok.
- Chống tạo đơn trùng bằng ID comment do server cấp.
- Trạng thái đơn, thanh toán, in và lịch sử lỗi in.
- Danh mục sản phẩm, giá, tồn kho và bí danh nhận diện comment.
- Tìm kiếm/lọc/xuất Excel đơn hàng.
- Tìm khách hàng tức thời theo tên TikTok hoặc `@ID TikTok`.
- Cấu hình khổ giấy 58/80 mm, số bản và tên shop.
- In thử, khóa lệnh in khi lệnh trước chưa hoàn tất.
- Đổi mật khẩu và đăng xuất các thiết bị khác.
- Admin cấp trải nghiệm full tính năng theo số phút, giờ hoặc ngày tùy ý; tự khóa khi hết hạn.
- Admin đặt mật khẩu mới cho tài khoản khách hàng và thu hồi toàn bộ phiên đăng nhập cũ.
- Admin tìm nhanh tài khoản theo tên hoặc `@username` để cấp/nâng cấp gói.
- Giao diện nền Strawberry Milk hồng pastel với họa tiết caro, nơ, hoa và trái tim.
- Sao lưu/khôi phục dữ liệu JSON.
- Nhật ký thao tác.
- WebSocket xác thực và chỉ phát dữ liệu cho đúng tài khoản.
- Giữ nguyên đăng nhập, gói sử dụng, admin, lịch sử Live, báo cáo và ESP32.
- Tự xóa comment lịch sử quá một tháng theo giờ Việt Nam: comment ngày 25/7 được giữ hết 25/8 và xóa từ 26/8; đơn hàng đã chốt không bị xóa.

## Lưu ý nâng cấp

- Bản v2 dùng `node:sqlite`, có sẵn từ Node 22; không còn cần `better-sqlite3` hay Visual Studio C++.
- Tài khoản mới yêu cầu mật khẩu tối thiểu 8 ký tự. Tài khoản cũ vẫn đăng nhập bình thường.
- Bridge hiện phục vụ một kết nối TikTok Live tại một thời điểm. Nếu nhiều shop cần Live đồng thời, nên tạo một Railway service riêng cho mỗi shop.
- Trước khi Redeploy lần đầu, nên tải hoặc sao chép file `/data/data.db` làm bản dự phòng.

## Thử ESP32 và máy in giả

Hai tệp trong thư mục `tools/` dùng để thử toàn bộ đường truyền mà không cần phần cứng.

Terminal 1:

```powershell
$env:PRINTER_PORT="9100"
node tools/gia-lap-may-in.js
```

Terminal 2, thay mã bằng **Mã Máy In** trong Menu tài khoản:

```powershell
$env:WS_URL="wss://ngominhtri-production.up.railway.app"
$env:PRINTER_TOKEN="MA_MAY_IN_CUA_TAI_KHOAN"
$env:PRINTER_HOST="127.0.0.1"
$env:PRINTER_PORT="9100"
node tools/gia-lap-esp32.js
```

Sau đó đăng nhập web, bấm **In & thêm đơn** tại một comment. Phiếu giả được lưu trong `tools/phieu-in-ao/`.

Kết quả kiểm thử trước khi bàn giao:

- Web → Bridge Server: thành công.
- Bridge Server → ESP32 giả qua WebSocket: thành công.
- ESP32 giả → máy in TCP giả cổng 9100: thành công.
- Dữ liệu ESC/POS raster: 18.160 byte.
- Phiếu thử: khách `@khach_aothun`, 2 áo × 99.000đ, tổng 198.000đ.
