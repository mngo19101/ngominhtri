# TikTok Live Print & Order Manager v2.18.0

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
DATABASE_CAPACITY_MB=500
TIKTOK_SIGN_API_KEY=api_key_cua_eulerstream
```

Không đổi `PORT`; Railway tự cấp biến này.

Sau khi upload, chọn **Redeploy**. Server tự tạo/migrate bảng SQLite, không xóa dữ liệu cũ. Hãy xác nhận log có dòng:

```text
Đang lưu database tại thư mục lâu dài: /data
Bridge Server đang chạy tại cổng ...
```

## Tính năng v2.18.0

- Tab **Vận chuyển** riêng, dùng chung đơn đã chốt.
- Chỉ nhập mã vận đơn SPX: hệ thống tự tra cứu trạng thái, vị trí hiện tại, hành trình và ngày giao dự kiến, rồi lưu vào đúng đơn.
- Tự đồng bộ “Khách chưa nhận”, “Khách đã nhận” hoặc “Hoàn trả” theo trạng thái SPX; tiền COD vẫn được đối soát riêng để tránh ghi nhận nhầm.
- Máy chủ tự kiểm tra lại SPX mỗi 5 phút cho đơn chưa hoàn tất; đơn đã giao, đã hoàn hoặc đã hủy sẽ tự dừng kiểm tra. Trang đang mở đọc dữ liệu mới mỗi phút.
- Không đọc bất kỳ con số nào trong comment thành giá tiền. Giá chỉ lấy từ danh mục sản phẩm hoặc được nhập/chỉnh tại đơn.
- Comment vẫn được thêm vào khách hàng và giỏ hàng, nhưng các giá cũ từng đọc nhầm từ nội dung comment sẽ hiện **Chưa nhập giá**; không xóa comment hay khách hàng.
- Mỗi thẻ trong tab **Vận chuyển** có nút **Xóa đơn** và hộp xác nhận trước khi xóa.
- Báo cáo theo ngày có thêm **Tạm tính đơn đang giao**; doanh thu ngày, tháng và biểu đồ vẫn chỉ cộng đơn giao thành công.
- Các ô đơn giá, phí vận chuyển, phí giao, COD và giá sản phẩm để trống khi giá trị bằng 0, nên có thể nhập ngay mà không phải xóa số 0.
- Trên điện thoại, tiền và nhãn **Doanh thu/Tạm tính** của từng đơn được cố định thành một cột bên phải, tách thành hai dòng và không xô lệch theo tên sản phẩm.
- Tự nhớ tên khách, số điện thoại và địa chỉ theo ID TikTok sau lần lưu đầu tiên; đơn mới của cùng ID tự điền lại, kể cả ở phiên Live sau.
- Mỗi đơn mua mới đặt lại ngày mua gần nhất. Hồ sơ khách không mua lại quá 3 tháng tự được xóa để giảm dữ liệu; đơn hàng và báo cáo đã chốt vẫn giữ nguyên.
- Phần **Đơn hàng** đã bỏ ô và chữ **Mã sản phẩm** khỏi màn hình thêm/sửa, danh sách và file Excel để thao tác gọn hơn.
- Trong **Đơn hàng** và **Vận chuyển**, tên người mua hiển thị to, đậm ở trên; ID TikTok nhỏ hơn nằm ngay bên dưới.
- Tối ưu responsive cho laptop, iPad và điện thoại: thanh tab luôn đủ mục, bộ lọc tự xuống dòng, thẻ đơn/vận chuyển không chồng chữ, cửa sổ nhập và nút bấm không tràn màn hình.
- Giữ nguyên đơn đang hoạt động, số tiền và dữ liệu cần thiết cho báo cáo doanh thu.
- Tự dọn chi tiết hành trình/dữ liệu thô SPX của đơn đã giao, đã hoàn hoặc đã hủy quá 30 ngày.
- Tự xóa vĩnh viễn đơn đã bấm xóa quá 7 ngày cùng dữ liệu vận chuyển và mục giỏ liên quan.
- Admin có nút **Dọn & tối ưu database** để chạy dọn ngay, checkpoint WAL và thu hồi vùng trống SQLite; khách có thể phải chờ vài giây nhưng không bị đăng xuất hay mất đơn đang hoạt động.
- Admin thấy trực tiếp giới hạn database, dung lượng đã dùng thực tế, phần còn trống, phần có thể thu hồi và tỷ lệ đã dùng. Mặc định là 500 MB, có thể đổi bằng `DATABASE_CAPACITY_MB`.
- Sau khi dọn, hệ thống báo kích thước trước/sau và chính xác số byte đã giải phóng.
- Mỗi tài khoản hiển thị dung lượng dữ liệu đã lưu (ước tính) trong danh sách quản trị và bảng xếp theo dung lượng.
- Quản trị mở thành một màn hình toàn phần che toàn bộ ứng dụng, có nút đóng để trở về đúng tab trước đó.
- Trang đầu Quản trị chỉ hiện các lựa chọn **Tài khoản & gói**, **Dung lượng database** và **Nhật ký giới hạn**; nội dung chỉ tải và hiển thị sau khi Admin chọn từng mục.
- Có nút quay lại danh sách lựa chọn và hỗ trợ phím `Esc` để đóng nhanh trên laptop.
- Trình duyệt đang đăng nhập gửi tín hiệu hoạt động mỗi 5 phút; quá khoảng 6 phút không có tín hiệu sẽ hiển thị **Offline**.
- Trong **Quản trị → Tài khoản & gói**, Admin thấy trạng thái **Đang online/Offline**, lần hoạt động gần nhất và địa chỉ IP gần nhất của từng tài khoản.
- Tín hiệu chỉ cập nhật hàng phiên đăng nhập hiện có, không tạo lịch sử mới nên không làm database tăng liên tục.
- IP được lưu cố định theo lần đăng nhập gần nhất của tài khoản; chuyển Offline hoặc đăng xuất không làm mất IP.
- Lần đăng nhập tiếp theo sẽ thay IP cũ bằng IP mới và lưu thêm thời điểm đăng nhập gần nhất cho Admin xem.
- Nếu từ 2 tài khoản trở lên có cùng IP đăng nhập gần nhất, thẻ tài khoản và dòng IP chuyển màu vàng kèm cảnh báo số tài khoản trùng IP.
- Cảnh báo IP trùng chỉ giúp Admin chú ý, không tự khóa vì nhiều người dùng chung Wi‑Fi hoặc mạng di động cũng có thể chung IP.
- Nhãn **Đang online** hiển thị màu xanh lá; nhãn **Offline** hiển thị màu đỏ; cảnh báo IP trùng giữ màu vàng.
- Tab **Quản trị** mở như các tab bình thường và chỉ hiển thị các ô lựa chọn.
- Chỉ khi bấm **Tài khoản & gói**, **Dung lượng database/Dọn dữ liệu** hoặc **Nhật ký** thì nội dung chi tiết mới mở toàn màn hình.
- Đóng, quay lại hoặc bấm `Esc` ở màn chi tiết sẽ trở về trang lựa chọn của tab Quản trị.
- Đơn chưa giao chỉ cộng vào **Tạm tính**. Chỉ khi vận chuyển chuyển sang **Đã giao** mới ghi nhận **Doanh thu**, theo đúng ngày giao thành công.
- Đã bỏ tab **Sản phẩm** khỏi thanh điều hướng; dữ liệu sản phẩm cũ vẫn được giữ an toàn trong database.
- Đã bỏ nút **Hành trình** cũ trong Vận chuyển; chỉ giữ **Xem hành trình SPX**.
- Bấm vào đơn vận chuyển để xem lại hành trình SPX; có nút cập nhật lại và mở trang SPX chính thức.
- Khi SPX chưa nhận diện mã hoặc tạm thời không phản hồi, hệ thống lưu mã và báo lỗi rõ ràng, không tạo vị trí giả.
- Bổ sung SĐT, địa chỉ, khối lượng, phí giao và COD.
- Tạo mã phiếu luân chuyển riêng cho từng đơn.
- Xuất phiếu PNG khổ 100 × 150 mm và in bằng trình duyệt.
- Theo dõi: chờ lấy, đang giao, giao lỗi, giao lại, hoàn và hoàn tất.
- Lưu hành trình và số lần xuất phiếu.
- Đối soát COD thủ công: đã kiểm tra, đã nhận tiền, đặt lại.
- Báo cáo tổng phiếu, COD, phí giao và COD đang chờ.
- Sao lưu/khôi phục cả dữ liệu và lịch sử vận chuyển.
- Câu chữ trên giao diện được rút gọn.
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
