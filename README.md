# Liêng Online

Bản online của game bài Liêng — chơi cùng bạn bè qua link mời, luật chạy hoàn toàn ở server.

Chuyển từ `lieng_prototype.html` (một file HTML chạy offline) sang kiến trúc client–server.

---

## Chạy thử trên máy

Cần Node.js 20 trở lên và một **PostgreSQL**. Không cần cài Postgres trên máy —
cách nhanh nhất là tạo một cơ sở dữ liệu miễn phí ở [Neon](https://neon.tech)
(xem mục triển khai bên dưới) rồi dùng chung chuỗi kết nối đó cho cả máy mình
lẫn bản chạy thật.

```powershell
npm install

# Windows PowerShell
$env:DATABASE_URL='postgresql://user:matkhau@ep-xxx.neon.tech/dbname?sslmode=require'
npm start
```

```bash
# macOS / Linux
export DATABASE_URL='postgresql://...'
npm start
```

Mở http://localhost:3000 → **Đăng ký** (được tặng 50.000 xu) → **Điểm danh** → chọn một mức bàn.
Mở thêm tab ẩn danh, đăng ký tài khoản khác, vào cùng mức bàn để chơi với nhau.

### Chạy test

```powershell
$env:TEST_DATABASE_URL='postgresql://...'
npm test
```

143 test, gồm cả test đầu-cuối dựng server thật và nối nhiều WebSocket thật.

Mỗi file test tự tạo một **schema riêng** rồi xoá sạch khi xong (xem
`test/pg-helper.js`), nên chĩa vào cùng cơ sở dữ liệu đang dùng thật cũng không
đụng tới dữ liệu người chơi. Dù vậy vẫn nên tạo một cơ sở dữ liệu riêng cho test
nếu bạn muốn chắc chắn.

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

**Bàn công khai KHÔNG có bot.** Đây là bàn ăn tiền thật, mà bot thì được bơm lại
vốn sau mỗi ván — thắng bot là xu sinh ra từ hư không, thua bot là xu biến mất. Bỏ
bot đi thì kinh tế khép kín: xu chỉ chuyển từ người này sang người kia. Đổi lại, vào
bàn một mình thì phải **chờ người thứ hai** mới chia bài được.

Phòng riêng theo mã mời vẫn có bot như cũ, vì chip ở đó là chip vui.

**Chip trên bàn công khai chính là số dư tài khoản.** Không có mua chip/rút chip:
cược bao nhiêu là trừ thẳng vào ví, thắng là cộng thẳng vào ví. Ai tụt xuống dưới
mức tối thiểu của bàn thì được mời ra sảnh, xu còn lại giữ nguyên.

### Tiền thắng về ví thế nào

Mỗi người ngồi bàn mang theo một mốc `walletBase` — số dư mà chip trên bàn được lấy
ra từ đó. Hết ván, server **cộng đúng phần chênh lệch** `chips - walletBase` vào tài
khoản, rồi lấy số dư mới về làm chip cho ván sau. Chip và ví vì thế luôn gặp lại nhau
ở giữa hai ván.

Điểm mấu chốt là **cộng chênh lệch chứ không ghi đè** số dư bằng chip. Nếu ghi đè thì
mọi khoản xu vào tài khoản từ ngoài ván bài trong lúc đang chơi — điểm danh ở tab thứ
hai, admin cộng tay — đều bị xoá sạch khi ván kết thúc. Có test dựng đúng tình huống
đó (`test/wallet.test.js`).

Hai chỗ đi kèm, thiếu là sai tiền:

- **Trang quản lý cộng xu cho người đang ngồi bàn** phải dời `walletBase` theo đúng
  khoản vừa cộng. Không thì khoản đó bị tính hai lần: một lần vào CSDL, một lần nữa
  lúc chốt sổ coi như "thắng được trên bàn".
- **Đọc lại số dư để gửi cho client** phải chờ lệnh ghi chạy xong (`flushWrites()`).
  Không thì người chơi rời bàn sẽ thấy số dư của *trước* ván và tưởng tiền thắng chưa
  được cộng.

Ván mới cũng chờ ghi xong mới chia, để không bao giờ chơi bằng số chip chưa khớp ví.

### Tiền gốc và chip trên bàn

Ngồi vào bàn là mang **toàn bộ số dư** vào đánh. Thanh trên cùng hiện hai con số:

```
Gốc 50k · Bàn 70k +20k
```

- **Gốc** — số dư lúc bạn ngồi vào bàn. Đứng yên suốt phiên chơi, dù đánh bao nhiêu ván.
- **Bàn** — chip đang cầm, thay đổi sau mỗi ván.
- Số màu cuối là **lãi/lỗ của cả phiên**: xanh khi lãi, đỏ khi lỗ.

Rời bàn thì hiện thông báo chốt sổ — *"Rời bàn với 70k xu — lãi 20k. Đã cộng vào
tiền gốc."* Bị mời ra vì hết xu cũng có thông báo tương tự.

Một điểm về mặt kỹ thuật đáng biết: **Gốc chỉ là mốc hiển thị**, không phải một
khoản tiền riêng được cất đi. Bên dưới, chip vẫn được ghi vào cơ sở dữ liệu **sau
mỗi ván** chứ không đợi tới lúc thoát. Nếu đợi thật thì server sập hay Render ngủ
dậy giữa chừng là kết quả chơi bay sạch. Vì bạn mang toàn bộ số dư vào bàn nên
không có phần nào nằm ngoài để bảo vệ — ghi sổ sớm chỉ có lợi, và người chơi không
thấy khác gì.

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
  db.js           PostgreSQL: tài khoản, ví xu, điểm danh, sổ cái
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
  wallet.test.js    cộng tiền thắng vào ví, không ghi đè khoản cộng từ ngoài
  bonus.test.js     thứ tự chất, úp bài tự do, thưởng nhân Sáp / Liêng đồng chất
  pg-helper.js      tiện ích: mỗi file test một schema Postgres riêng
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
| Lưu trữ | Không lưu gì, đóng tab là mất | PostgreSQL, sống độc lập với server |
| Vòng cược | `await` chờ người chơi bấm nút | Máy trạng thái, không chặn |
| Hết giờ | Không có, treo vô hạn | Đồng hồ 25s, hết giờ tự úp/giữ |
| Rớt mạng | Mất sạch | Nối lại bằng token, giữ nguyên ghế và tiền |
| Tất tay | Ăn trọn hũ dù bỏ vào ít | Hũ phụ đúng luật |
| Hoà điểm | Chia đôi tiền | So lá cao nhất, rồi so chất Rô > Cơ > Tép > Bích |
| Số người | Cố định 4 ghế | 2–6 ghế, xếp động quanh bàn |
| Bot | Chạy ở client | Chỉ có ở phòng riêng; bàn công khai không có bot |
| Bài đẹp | Không có thưởng | Sáp ăn đôi, Liêng đồng chất ăn gấp rưỡi |

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
- **Úp bài lúc nào cũng được**, kể cả khi chưa ai tố và không có gì phải theo — xem
  bài xấu ngay vòng đầu là bỏ được luôn. Chưa xem bài mà úp thì gọi là "Úp mù", diễn
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

## Thưởng bài đẹp

| Bài thắng | Hệ số |
|---|---|
| **Sáp** (3 lá cùng số) | ăn **gấp đôi** |
| **Liêng đồng chất** (3 lá liên tiếp cùng chất) | ăn **gấp rưỡi** |

Phần thưởng **do người thua trả thêm**, không phải hệ thống bù. Mỗi người thua trả
thêm phần tương ứng với số tiền chính họ đã bỏ vào hũ: thua Sáp thì trả thêm đúng
bằng số đã cược, thua Liêng đồng chất thì trả thêm một nửa. Không ai bị trừ quá số
chip còn lại của mình.

Làm vậy để **tổng xu toàn hệ thống không phình lên**. Nếu để game tự bù phần nhân
thêm thì mỗi ván có Sáp là một lần xu được tạo ra từ hư không, chơi lâu sẽ lạm phát.
Có test kiểm tra tổng chip cả bàn không đổi sau mỗi ván có thưởng.

Hai trường hợp **không** tính thưởng:

- **Mọi người úp bài hết.** Bài không lộ ra nên không ai biết người thắng cầm gì —
  trả thưởng lúc đó vừa vô lý vừa dễ bị lợi dụng.
- **Hoà**, nhiều người cùng thắng một hũ.

---

## Hiệu ứng và độ mượt

**Chia bài.** Ba lá bay từ giữa bàn ra từng ghế, lệch nhau một nhịp, kèm tiếng "xoẹt"
cho mỗi lá. Số lá phát ra khớp đúng số người đang chơi.

**Lật bài.** Tự lật lá nào thì lá đó xoay mở ra kèm tiếng. Người khác lật bài thì bạn
cũng thấy lá úp của họ nhúc nhích — biết ai đang xem bài tới đâu, nhưng vẫn không
thấy lá gì.

**Ngửa bài cuối ván** lật lần lượt từng người theo hiệu ứng dây chuyền, không hiện
cả bàn cùng lúc.

**Tiền chạy số.** Chip và hũ đếm tăng/giảm dần thay vì nhảy cóc, ai vừa ăn tiền thì ô
chip nảy lên loé vàng. Xu rơi vào hũ có hoạt ảnh riêng.

**Ghế** trượt mượt khi có người vào/ra, ghế tới lượt thở sáng nhẹ theo nhịp.

### Vì sao không bị giật

Trước đây mỗi lần nhận trạng thái từ server, client dựng lại toàn bộ HTML của mọi
ghế. Làm vậy thì mọi hoạt ảnh CSS bị khởi động lại từ đầu, nhìn như lag dù mạng
không hề chậm.

Giờ client **cập nhật tại chỗ**: chỉ ghi vào DOM khi giá trị thật sự đổi, và hàng bài
chỉ dựng lại khi bộ bài đổi (đo bằng một chữ ký gồm số lá và lá nào đã lật). Đo bằng
`MutationObserver` trong trình duyệt thật: cả một ván chỉ dựng lại hàng bài **4 lần**
thay vì mỗi lần nhận gói tin.

Thời gian nghỉ giữa hai ván cũng rút từ 6 giây xuống 4 giây.

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

### Bước 0. Vì sao cơ sở dữ liệu phải nằm ngoài Render

Ổ đĩa của Render bị xoá sạch mỗi lần deploy, và gói **free** còn **ngủ đông sau 15
phút không ai truy cập** — khi dậy thì container được dựng lại từ đầu. Nếu để cơ sở
dữ liệu trên chính máy đó thì cứ 15 phút không ai chơi là toàn bộ tài khoản và số dư
bay sạch.

Nên cơ sở dữ liệu đặt ở **Neon** (PostgreSQL, miễn phí vĩnh viễn 0,5GB — thừa cho
vài nghìn tài khoản). Nó sống độc lập với server, nên Render ngủ hay deploy lại bao
nhiêu lần cũng không ảnh hưởng.

Cái giá còn lại của gói free: người đầu tiên vào sau khi server ngủ phải chờ khoảng
**50 giây**. Muốn hết ngủ thì sửa `plan: free` thành `plan: starter` trong
`render.yaml` (~7 USD/tháng).

### Bước 0b. Tạo cơ sở dữ liệu ở Neon

1. Vào https://neon.tech → **Sign up** (đăng nhập bằng GitHub cho nhanh).
2. **Create project**: đặt tên `lieng`, chọn region **Asia Pacific (Singapore)** cho
   gần Render.
3. Xong sẽ hiện **Connection string** dạng:

   ```
   postgresql://lieng_owner:matkhau@ep-xxx-yyy.ap-southeast-1.aws.neon.tech/lieng?sslmode=require
   ```

4. Bấm copy và **lưu lại** — lát nữa dán vào Render. Đây là chìa khoá vào toàn bộ dữ
   liệu người chơi, đừng đưa lên git hay gửi cho ai.

Không cần tạo bảng gì cả — server tự tạo lúc khởi động lần đầu.

### Bước 1. Đưa mã nguồn lên GitHub

Mở PowerShell trong thư mục dự án:

```powershell
cd "$HOME\Desktop\Liêng\lieng-online"

git init
git branch -M main
git add .
git commit -m "Liêng online: game bài Liêng nhiều người chơi"
```

Kiểm tra lại trước khi đẩy đi — lệnh này phải **không** in ra `.env` hay file `.db` nào:

```powershell
git ls-files
```

Chuỗi kết nối Neon và mật khẩu quản lý chỉ được nằm ở biến môi trường, tuyệt đối
không nằm trong repo.

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
   chạy gói free.
4. Bấm **Apply**.

Lần deploy đầu mất khoảng 2–4 phút.

### Bước 3. Điền hai biến bí mật

`render.yaml` cố ý **không** chứa chuỗi kết nối và mật khẩu. Vào dịch vụ vừa tạo →
**Environment** → **Add Environment Variable**, thêm hai biến:

| Key | Value |
|---|---|
| `DATABASE_URL` | chuỗi kết nối Neon đã copy ở bước 0b |
| `ADMIN_PASSWORD` | một mật khẩu dài do bạn tự đặt |

Lưu lại, Render tự deploy lại.

Thiếu `DATABASE_URL` thì server không khởi động được và log sẽ ghi rõ
*"Thiếu DATABASE_URL"*. Thiếu `ADMIN_PASSWORD` thì server vẫn chạy bình thường,
chỉ là `/admin` trả về 404.

### Bước 4. Kiểm tra

Mở `https://<tên>.onrender.com/health` — phải thấy `{"ok":true,...}`.

Rồi mở trang chính, đăng ký một tài khoản, điểm danh, vào một bàn. WebSocket chạy qua
`wss://` tự động vì client chọn giao thức theo `location.protocol` — không cần cấu
hình gì thêm.

**Kiểm tra dữ liệu có thật sự được giữ không** (đây là chỗ dễ sai nhất): đăng ký một
tài khoản, ghi lại số dư, rồi vào Render bấm **Manual Deploy → Deploy latest commit**.
Deploy xong đăng nhập lại — tài khoản còn và số dư đúng thì Neon đã hoạt động. Nếu
phải đăng ký lại từ đầu thì `DATABASE_URL` chưa được đặt đúng.

Muốn xem tận mắt: vào Neon → **Tables** → bảng `accounts`, sẽ thấy tài khoản vừa tạo
nằm đó.

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
| `DATABASE_URL` | (bắt buộc) | Chuỗi kết nối PostgreSQL. Thiếu thì server không chạy |
| `DB_SCHEMA` | `public` | Schema Postgres. Chỉ cần khi nhiều môi trường dùng chung một CSDL |
| `GAME_TZ` | `Asia/Bangkok` | Múi giờ tính ngày điểm danh |
| `ADMIN_PASSWORD` | (trống) | Trống thì `/admin` trả về 404 |

### Sao lưu

Neon tự sao lưu và cho phép khôi phục về một thời điểm bất kỳ trong 7 ngày gần nhất
(mục **Restore** trong bảng điều khiển Neon). Muốn tải về máy thì chạy
`pg_dump "$DATABASE_URL" > backup.sql`.

---

## Cách khác

### Fly.io

```bash
fly launch --no-deploy
fly deploy
```

`fly.toml` cần `internal_port = 3000` và bật `force_https`. Đặt chuỗi kết nối bằng
`fly secrets set DATABASE_URL=...`.

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

**Lưu ý khi chạy nhiều tiến trình:** cơ sở dữ liệu thì chịu được nhiều instance, nhưng
**trạng thái phòng vẫn nằm trong RAM của một tiến trình** — hai instance sẽ có hai bàn
khác nhau cùng một mã phòng. Nên để **đúng một instance** (Render mặc định là vậy).
Muốn scale ngang thì phải chuyển trạng thái phòng sang Redis và bật sticky session.

---

## Tuỳ chỉnh luật

Khi tạo bàn, mở **⚙ Tuỳ chỉnh luật chơi** để đổi tiền sàn, vốn ban đầu, số người tối đa, giây mỗi lượt, số lần tố tối đa, và cách xử lý hoà điểm.

Mặc định nằm ở `ROOM_DEFAULTS` trong `src/server/room.js`. Server luôn kẹp giá trị người dùng gửi lên về khoảng an toàn trong `sanitizeConfig()` (`src/server/index.js`), nên không thể tạo bàn với tiền sàn âm hay 1000 người.

---

## Chưa có (nếu muốn làm tiếp)

- **Sổ cái mới chỉ ghi thao tác của trang quản lý**, chưa ghi tiền thắng thua trong
  từng ván. Muốn đối soát đầy đủ thì phải ghi thêm mỗi lần chốt sổ cuối ván.
- **Lịch sử ván lưu lâu dài.** Hiện chỉ giữ 50 ván gần nhất trong RAM, phòng đóng là mất.
- **Ghép người ngẫu nhiên có hàng đợi.** Hiện chỉ xếp vào bàn đông nhất còn ghế trống.
- **Chống thông đồng.** Hai người cùng bàn gọi điện cho nhau xem bài của nhau — không có giải pháp kỹ thuật thuần, thường phải phát hiện qua thống kê.
- **Chống cày tài khoản ảo.** Tài khoản mới được 50.000 xu và mỗi ngày 10.000 xu, nên
  tạo hàng loạt tài khoản là cày được xu. Cần xác thực email/SĐT nếu muốn chặn thật.

---

## Lưu ý pháp lý

Bản này chơi bằng chip ảo, không quy đổi ra tiền thật. Nếu cho cược tiền thật thì đó là kinh doanh cờ bạc trực tuyến — bị cấm hoặc phải có giấy phép ở hầu hết các nước, gồm cả Việt Nam.
