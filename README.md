# Liêng Online

Bản online của game bài Liêng — chơi cùng bạn bè qua link mời, luật chạy hoàn toàn ở server.

Chuyển từ `lieng_prototype.html` (một file HTML chạy offline) sang kiến trúc client–server.

---

## Chạy thử trên máy

Cần Node.js phiên bản **22.5 trở lên** (dùng SQLite có sẵn trong Node, `node:sqlite`).

```bash
npm install
npm start
```

Mở http://localhost:3000 → **Đăng ký** (được tặng 50.000 xu) → **Điểm danh** → chọn một mức bàn.
Mở thêm tab ẩn danh, đăng ký tài khoản khác, vào cùng mức bàn để chơi với nhau.

Dữ liệu tài khoản nằm trong file `lieng.db` cạnh dự án — sao lưu chỉ cần copy file đó.
Đổi chỗ lưu bằng biến môi trường `DB_FILE`.

Chạy test:

```bash
npm test
```

123 test, gồm cả test đầu-cuối dựng server thật và nối nhiều WebSocket thật.

---

## Tài khoản, ví xu và điểm danh

Đăng ký bằng tên đăng nhập + mật khẩu. Mật khẩu băm bằng `scrypt` với salt riêng
cho từng tài khoản, không lưu dạng thô. Tài khoản mới được tặng **50.000 xu**.

**Điểm danh** là thẻ 7 ô từ thứ 2 tới chủ nhật, mỗi ô **10.000 xu**:

- Mỗi ngày chỉ nhận được ô của ngày hôm đó. Bỏ ngày nào mất ngày đó, không nhận bù.
- Sáng thứ 2 thẻ reset về trắng. Đi đủ cả tuần được 70.000 xu.
- Ngày được tính theo **giờ Việt Nam**, không theo giờ máy chủ — server đặt ở nước
  ngoài vẫn đổi ngày đúng lúc 0h ở Việt Nam. Đổi bằng biến `GAME_TZ`.
- Bảng `checkins` khoá theo `(tài khoản, tuần, thứ)` nên bấm điểm danh 10 lần liên
  tiếp vẫn chỉ nhận được một lần. Có test cho đúng trường hợp này.

Sửa số tiền thưởng và vốn ban đầu ở đầu file `src/server/db.js`.

---

## Bàn theo mức cược

Sảnh hiện 4 mức cố định, khai báo trong `src/server/tiers.js`:

| Bàn | Tiền sàn | Số dư tối thiểu để vào |
|---|---|---|
| Bàn 1K | 1.000 | 1.000 |
| Bàn 5K | 5.000 | 5.000 |
| Bàn 20K | 20.000 | 20.000 |
| Bàn 100K | 100.000 | 100.000 |

Bàn nào vượt quá số dư thì hiện mờ, khoá nút, và ghi rõ **còn thiếu bao nhiêu xu**.
Server kiểm tra lại lần nữa lúc ngồi vào bàn — sửa giao diện bằng DevTools không lách được.

**Chip trên bàn công khai chính là số dư tài khoản.** Không có mua chip/rút chip:
cược bao nhiêu là trừ thẳng vào ví, thắng là cộng thẳng vào ví. Sau mỗi ván server
chép chip trên bàn về CSDL. Ai tụt xuống dưới mức tối thiểu của bàn thì được mời ra
sảnh, xu còn lại giữ nguyên.

Một tài khoản chỉ ngồi được **một bàn tại một thời điểm** — nếu không thì cùng một
số dư sẽ bị đem đi cược ở hai nơi. Mở bàn mới ở tab khác thì ghế cũ tự nhả ra, trừ
khi đang chơi dở một ván.

**Phòng riêng theo mã mời không đụng tới ví** — vẫn là chip vui với vốn tự đặt, đúng
như trước. Muốn chỉnh mức bàn thì sửa `minBalance` trong `tiers.js`; đặt
`minBalance: ante * 10` nếu muốn người chơi phải có vốn dày hơn tiền sàn.

---

## Cấu trúc

```
src/engine/     ← luật chơi thuần, không biết gì về mạng hay giao diện
  cards.js        bộ bài, xáo bài (nhận bộ sinh ngẫu nhiên từ ngoài vào)
  evaluate.js     xếp hạng Sáp / Liêng / Ảnh / Điểm, so bài
  pots.js         chia hũ chính và hũ phụ (side pot)
  game.js         máy trạng thái một ván — startRound, applyAction, publicView
  bot.js          AI nhà cái ảo

src/server/     ← lớp mạng
  db.js           SQLite: tài khoản, ví xu, điểm danh, sổ cái
  rng.js          chia bài bằng CSPRNG, sinh mã phòng và token
  tiers.js        khai báo các mức bàn công khai
  room.js         phòng chơi: đồng hồ lượt, bot, kết nối lại, chat, lịch sử
  admin.js        API trang quản lý (tắt hẳn nếu không đặt ADMIN_PASSWORD)
  index.js        HTTP tĩnh + WebSocket, kiểm tra quyền từng lệnh

public/
  index.html      client — chỉ vẽ và gửi ý định, không giữ luật nào
  admin.html      trang quản lý

test/
  evaluate.test.js  xếp hạng bài và tiêu chí phụ
  pots.test.js      hũ phụ, gồm test bảo toàn tiền với 100 tình huống ngẫu nhiên
  game.test.js      luồng ván, chống đi sai lượt, chip không âm
  flip.test.js      lật bài, chặn đặt cược khi chưa mở, úp mù
  account.test.js   tài khoản, mật khẩu, điểm danh theo giờ Việt Nam
  admin.test.js     cộng/trừ xu, sổ cái, bảo mật trang quản lý
  e2e.test.js       server + nhiều client thật
```

---

## Khác gì so với bản offline

| | Prototype offline | Bản online |
|---|---|---|
| Nơi giữ luật | Trình duyệt | Server (client không tự quyết gì) |
| Chia bài | `Math.random()` ở client | `crypto.randomInt()` ở server |
| Bài của đối thủ | Gửi hết cho client, giấu bằng CSS | Không rời server tới lúc ngửa bài |
| Bài của chính mình | Chia xong thấy ngay cả 3 lá | Chia úp, tự bấm lật từng lá |
| Vòng cược | `await` chờ người chơi bấm nút | Máy trạng thái, không chặn |
| Hết giờ | Không có, treo vô hạn | Đồng hồ 25s, hết giờ tự úp/giữ |
| Rớt mạng | Mất sạch | Nối lại bằng token, giữ nguyên ghế và tiền |
| Tất tay | Ăn trọn hũ dù bỏ vào ít | Hũ phụ đúng luật |
| Hoà điểm | Chia đôi tiền | So lá cao nhất rồi so chất |
| Số người | Cố định 4 ghế | 2–6 ghế, xếp động quanh bàn |
| Bot | Chạy ở client | Chạy ở server, lấp ghế trống |

---

## Trang quản lý — cộng xu cho người chơi

Trang này in ra tiền, nên **mặc định tắt hẳn**. Chỉ bật khi chạy server có đặt
`ADMIN_PASSWORD`:

```bash
# Linux / macOS
ADMIN_PASSWORD='mot-mat-khau-that-dai' npm start

# Windows PowerShell
$env:ADMIN_PASSWORD='mot-mat-khau-that-dai'; npm start
```

Rồi mở http://localhost:3000/admin

Không đặt biến đó thì `/admin` và mọi API `/admin/api/*` trả về **404 y như không
tồn tại** — có test kiểm tra đúng điều này, kể cả không rò rỉ danh sách người chơi.

Trang có:

- **Cộng / trừ xu theo tên đăng nhập.** Nhập số âm để trừ. Có nút nhanh +10K / +50K /
  +100K / +500K. Không trừ xuống âm được.
- **Đặt lại số dư** về một con số cụ thể, cho khi lỡ tay cộng nhầm.
- **Danh sách người chơi** kèm ô tìm kiếm theo tên đăng nhập hoặc tên hiển thị.
  Bấm vào một dòng là tự điền tên vào ô cộng xu, khỏi gõ sai.
- **Sổ cái** 20 giao dịch gần nhất: lúc nào, cho ai, cộng/trừ bao nhiêu, còn lại bao
  nhiêu, lý do. Mỗi lần cộng/trừ đều bị ghi lại, không tắt được.

**Người chơi đang ngồi bàn thì sao.** Ở bàn công khai, sau mỗi ván server ghi đè số
dư bằng số chip trên bàn. Nếu chỉ sửa trong CSDL, xu vừa cộng sẽ bay sạch khi ván
đang chơi kết thúc. Nên trang này cộng xu vào **cả CSDL lẫn chip trên bàn**, và báo
rõ *"(đang ngồi Bàn 5K, chip trên bàn đã cập nhật)"*. Có test riêng cho đúng cái bẫy
này. Riêng thao tác *đặt lại số dư* thì bị chặn khi người đó đang ngồi bàn — lúc ấy
tiền đang nằm trong hũ nên đặt số tuyệt đối sẽ lệch.

**Bảo mật:** mật khẩu so bằng `timingSafeEqual`, sai 8 lần thì khoá 5 phút. Đăng nhập
xong nhận một token sống 8 tiếng, mọi API sau đó phải kèm token. Mật khẩu không được
nhúng vào trang HTML.

---

## Lật bài

Cả 3 lá được chia **úp**. Bấm vào từng lá để tự mở, cho hồi hộp.

**Server giấu bài thật.** Lá nào chưa lật thì server không gửi xuống client — trong
gói tin nó là `null`, mở DevTools cũng không xem trước được. Có test kiểm tra chuỗi
JSON thật sự đi qua đường mạng không chứa lá bài nào khi chưa lật.

- **Phải mở đủ 3 lá mới được Tố / Theo.** Chưa mở thì hai nút đó khoá lại, kèm dòng
  chữ *"mở nốt 2 lá rồi mới đặt cược được"*.
- **Úp mù thì lúc nào cũng được.** Nút đổi thành "Úp mù" khi chưa xem bài, và diễn
  biến ghi *"úp bài mù, không thèm xem"*.
- **Hết giờ suy nghĩ** thì server lật hết bài ra cho bạn thấy vừa bỏ lỡ cái gì, rồi
  mới tự úp/giữ như trước.
- **Hết ván** thì ai cũng được xem lại bài của chính mình, kể cả lá chưa kịp lật hay
  vừa úp mù.
- Nút **"Mở hết 3 lá"** cho ai không muốn bấm ba lần mỗi ván.
- Nút 🃏 trên thanh trên **tắt hẳn tính năng này** — bài tự mở sẵn như kiểu cũ. Lựa
  chọn được nhớ lại cho các ván sau.

Bot tự "nhìn" bài ngay khi chia, vì bài của bot vốn không bao giờ gửi xuống client
trước lúc ngửa bài nên không có gì để giấu.

---

## Chống gian lận

Điểm quan trọng nhất khi lên online. Những lớp đang có:

1. **Lọc dữ liệu gửi đi.** `publicView(game, viewerId)` trong `src/engine/game.js` chỉ đính bài của chính người xem. Có test kiểm tra chuỗi JSON thật sự gửi qua mạng không chứa bài đối thủ.
2. **Server tự kiểm tra mọi hành động.** `getLegalActions()` quyết định cái gì hợp lệ, `applyAction()` từ chối mọi thứ ngoài khoảng đó. Mức tố ngoài `[minRaise, maxRaise]` bị chặn.
3. **Đúng lượt mới được đi.** Người khác gửi hành động sẽ nhận `Chưa tới lượt của bạn`.
4. **`actionSeq` chống phát lại.** Mỗi hành động hợp lệ tăng số thứ tự; gói tin cũ gửi lại bị bỏ.
5. **Token bí mật để nối lại.** Không đoán được ghế của người khác.
6. **Chia bài bằng CSPRNG** trên server, không phải `Math.random()` ở client.
7. **Làm sạch tên và chat** trước khi phát đi, client cũng escape khi hiển thị.
8. **Giới hạn 25 gói tin mỗi giây** cho mỗi kết nối.

---

## Đưa lên mạng bằng Render — từng bước

### Bước 0. Điều quan trọng nhất phải biết trước

Trên Render, **ổ đĩa thường bị xoá sạch mỗi lần deploy hoặc khởi động lại**. Toàn bộ
tài khoản, số dư, lịch sử điểm danh của người chơi nằm trong file `lieng.db`, nên nếu
để mặc định thì cứ mỗi lần sửa code là mọi người mất sạch xu.

Cách duy nhất để giữ dữ liệu là gắn **ổ đĩa lưu trữ (Persistent Disk)** và trỏ
`DB_FILE` vào đó. Ổ đĩa chỉ gắn được từ gói **Starter** trở lên (khoảng 7 USD/tháng,
cộng thêm khoảng 0,25 USD/GB cho đĩa). Gói Free ngoài việc không gắn được đĩa còn
**ngủ đông sau 15 phút không ai vào** — người chơi sẽ bị rớt kết nối và phải chờ gần
một phút cho server dậy.

File `render.yaml` trong repo đã cấu hình sẵn đúng như trên.

### Bước 1. Đưa mã nguồn lên GitHub

Mở PowerShell trong thư mục dự án:

```powershell
cd "$HOME\Desktop\Liêng\lieng-online"

git init
git branch -M main
git add .
git commit -m "Liêng online: game bài Liêng nhiều người chơi"
```

Kiểm tra lại trước khi đẩy đi — lệnh này phải **không** in ra `lieng.db` hay `.env`:

```powershell
git ls-files
```

Đúng ra sẽ có 26 file. Nếu thấy `lieng.db` thì dừng lại, vì trong đó có tài khoản và
mã băm mật khẩu của người chơi.

Sau đó vào https://github.com/new tạo một repo **riêng tư** tên `lieng-online`,
**không** tích "Add a README file", rồi chạy hai lệnh GitHub hiện ra:

```powershell
git remote add origin https://github.com/TEN_CUA_BAN/lieng-online.git
git push -u origin main
```

Lần đầu push, Git sẽ mở cửa sổ đăng nhập GitHub.

### Bước 2. Dựng dịch vụ trên Render

1. Đăng ký tại https://render.com, chọn đăng nhập bằng GitHub.
2. Bấm **New +** → **Blueprint**.
3. Chọn repo `lieng-online`. Render tự đọc `render.yaml` và hiện sẵn một dịch vụ web
   kèm ổ đĩa 1GB.
4. Bấm **Apply**. Render sẽ hỏi giá tiền của gói Starter — xác nhận.

Lần deploy đầu mất khoảng 2–4 phút.

### Bước 3. Đặt mật khẩu trang quản lý

`render.yaml` cố ý **không** chứa mật khẩu. Vào dịch vụ vừa tạo →
**Environment** → **Add Environment Variable**:

| Key | Value |
|---|---|
| `ADMIN_PASSWORD` | một mật khẩu dài do bạn tự đặt |

Lưu lại, Render tự deploy lại. Xong thì `https://<tên>.onrender.com/admin` mới vào
được. Không đặt biến này thì `/admin` trả về 404.

### Bước 4. Kiểm tra

Mở `https://<tên>.onrender.com/health` — phải thấy `{"ok":true,...}`.

Rồi mở trang chính, đăng ký một tài khoản, điểm danh, vào một bàn. WebSocket chạy qua
`wss://` tự động vì client chọn giao thức theo `location.protocol` — không cần cấu
hình gì thêm.

**Kiểm tra dữ liệu có thật sự được giữ không** (đây là chỗ dễ sai nhất): đăng ký một
tài khoản, ghi lại số dư, rồi vào Render bấm **Manual Deploy → Deploy latest commit**.
Deploy xong đăng nhập lại — nếu tài khoản còn và số dư đúng thì ổ đĩa đã hoạt động.
Nếu phải đăng ký lại từ đầu thì `DB_FILE` chưa trỏ vào `/data`.

### Bước 5. Về sau, mỗi lần sửa code

```powershell
git add .
git commit -m "mô tả thay đổi"
git push
```

Render tự deploy lại khi thấy commit mới trên nhánh `main`.

### Các biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 3000 | Render tự đặt, không cần điền |
| `DB_FILE` | `lieng.db` | Đường dẫn CSDL. Trên Render phải là `/data/lieng.db` |
| `GAME_TZ` | `Asia/Bangkok` | Múi giờ tính ngày điểm danh |
| `ADMIN_PASSWORD` | (trống) | Trống thì `/admin` trả về 404 |

### Sao lưu

Toàn bộ dữ liệu nằm trong một file duy nhất. Vào tab **Shell** của dịch vụ trên Render
rồi chạy `sqlite3 /data/lieng.db ".backup /data/backup.db"`, hoặc đơn giản hơn là bật
tính năng snapshot ổ đĩa của Render.

---

## Cách khác

### Fly.io

```bash
fly launch --no-deploy
fly deploy
```

`fly.toml` cần `internal_port = 3000`, bật `force_https`, và gắn volume cho `/data`
giống như trên.

### VPS tự quản (Nginx)

Chạy app bằng pm2 hoặc systemd, rồi đặt Nginx phía trước:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

Hai dòng `Upgrade` / `Connection` là bắt buộc, thiếu là WebSocket không nối được.

**Lưu ý khi chạy nhiều tiến trình:** trạng thái phòng đang nằm trong RAM của một tiến
trình, và SQLite cũng chỉ một tiến trình ghi. Nên để **đúng một instance** (Render mặc
định là vậy). Muốn scale ngang thì phải bật sticky session và chuyển trạng thái phòng
sang Redis, CSDL sang Postgres.

---

## Tuỳ chỉnh luật

Khi tạo bàn, mở **⚙ Tuỳ chỉnh luật chơi** để đổi tiền sàn, vốn ban đầu, số người tối đa, giây mỗi lượt, số lần tố tối đa, và cách xử lý hoà điểm.

Mặc định nằm ở `ROOM_DEFAULTS` trong `src/server/room.js`. Server luôn kẹp giá trị người dùng gửi lên về khoảng an toàn trong `sanitizeConfig()` (`src/server/index.js`), nên không thể tạo bàn với tiền sàn âm hay 1000 người.

---

## Chưa có (nếu muốn làm tiếp)

- **Sổ cái mới chỉ ghi thao tác của trang quản lý**, chưa ghi tiền thắng thua trong
  từng ván. Muốn đối soát đầy đủ thì phải ghi thêm mỗi lần chốt sổ cuối ván.
- **Bot ở bàn công khai làm sinh/tiêu xu.** Bot không phải tài khoản thật, vốn của
  chúng được bơm lại sau mỗi ván. Thắng bot là xu được tạo ra từ hư không, thua bot
  là xu biến mất. Chấp nhận được với game chơi vui; muốn kinh tế khép kín thì phải
  bỏ bot ở bàn công khai.
- **Lịch sử ván lưu lâu dài.** Hiện chỉ giữ 50 ván gần nhất trong RAM, phòng đóng là mất.
- **Ghép người ngẫu nhiên có hàng đợi.** Hiện chỉ xếp vào bàn đông nhất còn ghế trống.
- **Chống thông đồng.** Hai người cùng bàn gọi điện cho nhau xem bài của nhau — không có giải pháp kỹ thuật thuần, thường phải phát hiện qua thống kê.
- **Chống cày tài khoản ảo.** Tài khoản mới được 50.000 xu và mỗi ngày 10.000 xu, nên
  tạo hàng loạt tài khoản là cày được xu. Cần xác thực email/SĐT nếu muốn chặn thật.

---

## Lưu ý pháp lý

Bản này chơi bằng chip ảo, không quy đổi ra tiền thật. Nếu cho cược tiền thật thì đó là kinh doanh cờ bạc trực tuyến — bị cấm hoặc phải có giấy phép ở hầu hết các nước, gồm cả Việt Nam.
