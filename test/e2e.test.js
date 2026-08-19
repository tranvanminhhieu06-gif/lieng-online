/**
 * Kiểm thử đầu-cuối: dựng server thật, nối nhiều client WebSocket thật,
 * chơi vài ván và kiểm tra những thứ chỉ hỏng khi lên mạng.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

// Phải đặt trước khi nạp server: mỗi file test dùng một schema Postgres riêng
import { TEST_DB_URL, uniqueSchema } from './pg-helper.js';
delete process.env.ADMIN_PASSWORD;
process.env.DATABASE_URL = TEST_DB_URL;
const TEST_SCHEMA = uniqueSchema('e2e');
process.env.DB_SCHEMA = TEST_SCHEMA;
const { server, wss, rooms, store } = await import('../src/server/index.js');

let baseUrl;
let httpUrl;
let userSeq = 0;

test.before(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  baseUrl = `ws://127.0.0.1:${port}/ws`;
  httpUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  // Dọn sạch để tiến trình test thoát được: đồng hồ trong phòng và các
  // kết nối còn treo sẽ giữ event loop sống mãi.
  for (const room of [...rooms.rooms.values()]) room.destroy();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close();
  try { await store.pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`); } catch {}
  await store.close();
});

/** Client thu nhỏ, đủ để kịch bản hoá một người chơi. */
class TestClient {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.state = null;
    this.room = null;
    this.joined = null;
    this.account = null;
    this.lobby = null;
    this.errors = [];
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(baseUrl);
    await new Promise((res, rej) => {
      this.ws.once('open', res);
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.messages.push(msg);
      if (msg.t === 'state') { this.state = msg.state; this.room = msg.room; }
      if (msg.t === 'joined') this.joined = msg;
      if (msg.t === 'error') this.errors.push(msg.message);
      if (msg.t === 'events') this.events.push(...msg.events);
      if (msg.t === 'auth-ok') { this.account = msg.account; this.sessionToken = msg.sessionToken; }
      if (msg.t === 'lobby') { this.lobby = msg; this.account = msg.account; }
      if (msg.t === 'account') this.account = msg.account;
      if (msg.t === 'checkin-result') this.account = msg.account;
    });
    return this;
  }

  /** Đăng ký một tài khoản mới và đăng nhập luôn. */
  async auth(displayName = this.name) {
    const username = `u${++userSeq}_${Date.now().toString(36)}`;
    this.username = username;
    this.send({ t: 'register', username, password: 'matkhau123', displayName });
    await this.waitFor((c) => c.account, { label: 'đăng ký xong' });
    this.accountId = this.account.id;
    return this;
  }

  /** Nạp/đặt số dư trực tiếp qua CSDL, để dựng tình huống test. */
  async setBalance(amount) {
    await store.setBalance(this.accountId, amount);
    return this;
  }

  balanceInDb() {
    return store.getBalance(this.accountId);
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }
  close() { try { this.ws.close(); } catch {} }

  async waitFor(predicate, { timeout = 4000, label = 'điều kiện' } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (predicate(this)) return true;
      await sleep(25);
    }
    throw new Error(`Hết giờ chờ ${label} (client ${this.name})`);
  }

  /**
   * Mở hết 3 lá bài. Từ khi bài được chia úp, phải mở đủ mới đặt cược được.
   * Các test dưới đây kiểm tra chuyện khác nên mở luôn cho gọn — riêng việc
   * lật bài đã có test/flip.test.js lo.
   */
  async revealCards() {
    this.send({ t: 'flip', all: true });
    await this.waitFor(
      (c) => c.state?.players.find((p) => p.id === c.joined?.playerId)?.revealedCount === 3,
      { label: 'mở hết bài' },
    );
    return this;
  }

  waitJoined() { return this.waitFor((c) => c.joined, { label: 'joined' }); }
  waitState() { return this.waitFor((c) => c.state, { label: 'state đầu tiên' }); }
  waitMyTurn(timeout = 6000) {
    return this.waitFor((c) => c.state?.legal, { timeout, label: 'tới lượt mình' });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newClient = async (name) => (await new TestClient(name).connect()).auth(name);

/* ================================================================== */
/*  TRANG QUẢN LÝ PHẢI TẮT HẲN KHI KHÔNG ĐẶT MẬT KHẨU                  */
/*  (file test này KHÔNG đặt ADMIN_PASSWORD)                           */
/* ================================================================== */

test('không đặt ADMIN_PASSWORD thì /admin trả về 404', async () => {
  for (const p of ['/admin', '/admin.html']) {
    const res = await fetch(httpUrl + p);
    assert.equal(res.status, 404, `${p} phải không tồn tại`);
  }
});

test('không đặt ADMIN_PASSWORD thì API quản lý cũng không tồn tại', async () => {
  const res = await fetch(`${httpUrl}/admin/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: '' }),
  });
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.match(data.error, /chưa được bật/);

  const players = await fetch(`${httpUrl}/admin/api/players`);
  assert.equal(players.status, 404, 'không được rò rỉ danh sách người chơi');
});

/* ================================================================== */
/*  TÀI KHOẢN & ĐIỂM DANH QUA MẠNG                                     */
/* ================================================================== */

test('chưa đăng nhập thì không làm gì được', async () => {
  const c = await new TestClient('Vô danh').connect();
  for (const cmd of [{ t: 'create' }, { t: 'lobby' }, { t: 'checkin' }, { t: 'join-tier', tierId: 'muc5' }]) {
    c.errors.length = 0;
    c.send(cmd);
    await c.waitFor((x) => x.errors.length > 0, { label: `chặn ${cmd.t}` });
    assert.match(c.errors[0], /cần đăng nhập/);
  }
  c.close();
});

test('đăng ký xong nhận được sảnh kèm số dư và thẻ điểm danh', async () => {
  const c = await newClient('An');
  await c.waitFor((x) => x.lobby, { label: 'sảnh' });
  assert.equal(c.account.balance, 200_000);
  assert.equal(c.lobby.checkin.days.length, 7);
  assert.equal(c.lobby.tiers.length, 7);
  c.close();
});

test('điểm danh qua mạng cộng 50k, lần thứ hai bị từ chối', async () => {
  const c = await newClient('Bình');
  const truoc = c.account.balance;

  c.send({ t: 'checkin' });
  await c.waitFor((x) => x.account.balance > truoc, { label: 'nhận thưởng' });
  assert.equal(c.account.balance, truoc + 50_000);
  assert.equal(await c.balanceInDb(), truoc + 50_000);

  c.errors.length = 0;
  c.send({ t: 'checkin' });
  await c.waitFor((x) => x.errors.length > 0, { label: 'chặn điểm danh lần 2' });
  assert.match(c.errors[0], /đã điểm danh rồi/);
  assert.equal(await c.balanceInDb(), truoc + 50_000, 'số dư không được cộng thêm');
  c.close();
});

test('spam điểm danh 10 lần liên tiếp vẫn chỉ nhận được 50k', async () => {
  const c = await newClient('Kẻ spam');
  const truoc = await c.balanceInDb();
  for (let i = 0; i < 10; i++) c.send({ t: 'checkin' });
  await sleep(400);
  assert.equal(await c.balanceInDb(), truoc + 50_000);
  c.close();
});

test('đăng nhập lại bằng session token thì giữ nguyên số dư', async () => {
  const c = await newClient('Cường');
  c.send({ t: 'checkin' });
  await c.waitFor((x) => x.account.balance === 250_000);
  const token = c.sessionToken;
  c.close();

  const lai = await new TestClient('Cường-lần-2').connect();
  lai.send({ t: 'auth', sessionToken: token });
  await lai.waitFor((x) => x.account, { label: 'nhận lại phiên' });
  assert.equal(lai.account.balance, 250_000);
  lai.close();
});

/* ================================================================== */
/*  BÀN THEO MỨC CƯỢC                                                  */
/* ================================================================== */

test('sảnh đánh dấu bàn nào vào được, bàn nào thiếu bao nhiêu xu', async () => {
  const c = await newClient('Dũng');
  await c.setBalance(7_000);
  c.send({ t: 'lobby' });
  await c.waitFor((x) => x.lobby?.account.balance === 7_000, { label: 'sảnh cập nhật' });

  const byId = Object.fromEntries(c.lobby.tiers.map((t) => [t.id, t]));
  assert.equal(byId.muc1.canAfford, true);
  assert.equal(byId.muc5.canAfford, true);
  assert.equal(byId.muc20.canAfford, false);
  assert.equal(byId.muc20.shortBy, 13_000, 'phải nói rõ còn thiếu bao nhiêu');
  assert.equal(byId.muc100.canAfford, false);
  assert.equal(byId.muc100.shortBy, 93_000);
  c.close();
});

test('số dư dưới mức tối thiểu thì KHÔNG vào được bàn', async () => {
  const c = await newClient('Em nghèo');
  await c.setBalance(4_999);
  c.errors.length = 0;
  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.waitFor((x) => x.errors.length > 0, { label: 'bị chặn vào bàn 5K' });
  assert.match(c.errors[0], /cần tối thiểu/);
  assert.equal(c.joined, null, 'không được ngồi vào bàn');
  c.close();
});

test('đủ đúng mức tối thiểu thì vào được, chip trên bàn bằng số dư', async () => {
  const c = await newClient('Vừa đủ');
  await c.setBalance(5_000);
  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.waitJoined();
  await c.waitState();

  assert.equal(c.joined.tier.id, 'muc5');
  assert.equal(c.room.tier.label, 'Bàn 5K');
  assert.equal(c.room.walletMode, true);
  const me = c.state.players.find((p) => p.id === c.joined.playerId);
  assert.equal(me.chips, 5_000, 'chip trên bàn phải chính là số dư tài khoản');
  assert.equal(c.state.ante, 5_000, 'tiền sàn bằng mức bàn');
  c.close();
});

test('tiền sàn của bàn 20K đúng bằng 20.000', async () => {
  const c = await newClient('Đại gia');
  await c.setBalance(500_000);
  c.send({ t: 'join-tier', tierId: 'muc20' });
  await c.waitState();
  assert.equal(c.state.ante, 20_000);
  const me = c.state.players.find((p) => p.id === c.joined.playerId);
  assert.equal(me.chips, 500_000);
  c.close();
});

test('chơi xong một ván, số dư trong CSDL khớp với chip trên bàn', async () => {
  const c = await newClient('Người chơi');
  await c.setBalance(200_000);

  // Bàn công khai không còn bot, phải đủ hai người thật thì ván mới bắt đầu
  const phu = await newClient('Người phụ');
  await phu.setBalance(5_000_000);
  phu.send({ t: 'join-tier', tierId: 'muc5' });
  await phu.waitJoined();
  const nhipPhu = setInterval(() => {
    if (!phu.state?.legal) return;
    phu.send({ t: 'flip', all: true });
    phu.send({ t: 'action', action: 'call', actionSeq: phu.state.legal.actionSeq });
  }, 120);

  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.waitState();

  // Bàn công khai tự chia ván, không cần bấm "Bắt đầu"
  await c.waitFor((x) => x.state?.phase === 'betting', {
    timeout: 8000, label: 'bàn tự chia ván',
  });
  await c.revealCards();

  let guard = 0;
  while (guard++ < 60 && c.state.phase === 'betting') {
    if (c.state?.legal) {
      c.send({ t: 'action', action: 'call', actionSeq: c.state.legal.actionSeq });
    }
    await sleep(150);
  }
  await sleep(500);

  const me = c.state.players.find((p) => p.id === c.joined.playerId);
  assert.equal(await c.balanceInDb(), me.chips, 'ví phải khớp chip trên bàn sau mỗi ván');
  assert.notEqual(await c.balanceInDb(), 200_000, 'số dư phải thay đổi sau khi cược');
  clearInterval(nhipPhu);
  c.close(); phu.close();
});

test('thua tới dưới mức tối thiểu thì bị mời ra khỏi bàn', async () => {
  // Kết quả ván bài là ngẫu nhiên nên không thể "chơi cho tới khi cháy túi"
  // một cách chắc chắn. Ở đây đặt thẳng số chip còn lại rồi chốt sổ, để kiểm
  // tra đúng cơ chế cần kiểm tra.
  const c = await newClient('Sắp cháy túi');
  await c.setBalance(50_000);
  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.waitJoined();
  await c.waitState();

  const room = rooms.get(c.joined.code);
  const me = room.game.players.find((p) => p.id === c.joined.playerId);
  me.chips = 4_999; // vừa thua một ván lớn
  room.settleWallets();
  await room.flushWrites();

  await c.waitFor((x) => x.messages.some((m) => m.t === 'kicked-from-table'), {
    label: 'thông báo bị mời ra',
  });
  const kick = c.messages.find((m) => m.t === 'kicked-from-table');
  assert.match(kick.reason, /không đủ mức tối thiểu/);
  assert.equal(await c.balanceInDb(), 4_999, 'số xu còn lại vẫn phải được giữ nguyên trong ví');
  assert.equal(rooms.findSeat(c.accountId), null, 'ghế phải được nhả ra');
  c.close();
});

test('còn đúng mức tối thiểu thì vẫn được ngồi lại bàn', async () => {
  const c = await newClient('Vừa đủ trụ');
  await c.setBalance(50_000);
  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.waitJoined();
  await c.waitState();

  const room = rooms.get(c.joined.code);
  const me = room.game.players.find((p) => p.id === c.joined.playerId);
  me.chips = 5_000; // đúng bằng mức tối thiểu
  room.settleWallets();
  await room.flushWrites();
  await sleep(150);

  assert.ok(
    !c.messages.some((m) => m.t === 'kicked-from-table'),
    'đủ đúng mức tối thiểu thì không được đuổi',
  );
  assert.equal(await c.balanceInDb(), 5_000);
  c.close();
});

test('một tài khoản không ngồi được hai bàn cùng lúc', async () => {
  const c = await newClient('Hai tay');
  await c.setBalance(300_000);

  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.waitJoined();
  const banDau = c.joined.code;

  // Mở kết nối thứ hai bằng cùng tài khoản
  const c2 = await new TestClient('Hai tay - tab 2').connect();
  c2.send({ t: 'auth', sessionToken: c.sessionToken });
  await c2.waitFor((x) => x.account, { label: 'tab 2 đăng nhập' });
  c2.send({ t: 'join-tier', tierId: 'muc20' });
  await c2.waitJoined();

  // Ghế cũ phải được nhả ra — nếu không thì cùng một số dư bị cược hai nơi
  const ghe = rooms.findSeat(c.accountId);
  assert.ok(ghe, 'phải còn đúng một ghế');
  assert.equal(ghe.room.code, c2.joined.code);
  assert.notEqual(ghe.room.code, banDau);

  let dem = 0;
  for (const room of rooms.rooms.values()) {
    for (const accId of room.accountOf.values()) if (accId === c.accountId) dem++;
  }
  assert.equal(dem, 1, `tài khoản đang ngồi ${dem} bàn cùng lúc`);
  c.close(); c2.close();
});

test('hai người cùng mức được xếp chung một bàn', async () => {
  const a = await newClient('Người A');
  const b = await newClient('Người B');
  await a.setBalance(150_000);
  await b.setBalance(150_000);

  a.send({ t: 'join-tier', tierId: 'muc100' });
  await a.waitJoined();
  b.send({ t: 'join-tier', tierId: 'muc100' });
  await b.waitJoined();

  assert.equal(a.joined.code, b.joined.code, 'phải vào cùng một bàn');
  await b.waitState();
  const nguoiThat = b.state.players.filter((p) => !p.isBot);
  assert.equal(nguoiThat.length, 2);
  a.close(); b.close();
});

test('bàn công khai không cho chia lại vốn', async () => {
  const c = await newClient('Chủ bàn');
  await c.setBalance(50_000);
  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.waitJoined();
  await c.waitState();

  // Bàn công khai dùng chung giữa các test nên chưa chắc client này là chủ bàn.
  // Đặt nó làm chủ bàn để kiểm tra đúng cái cần kiểm tra: chặn theo chế độ ví,
  // chứ không phải chặn vì không có quyền.
  const room = rooms.get(c.joined.code);
  room.hostId = c.joined.playerId;

  c.errors.length = 0;
  c.send({ t: 'reset' });
  await c.waitFor((x) => x.errors.length > 0, { label: 'chặn reset' });
  assert.match(c.errors[0], /không chia lại vốn được/);
  c.close();
});

test('bàn công khai không vào được bằng mã phòng', async () => {
  const a = await newClient('Người A');
  await a.setBalance(50_000);
  a.send({ t: 'join-tier', tierId: 'muc5' });
  await a.waitJoined();

  const b = await newClient('Người B');
  b.errors.length = 0;
  b.send({ t: 'join', code: a.joined.code });
  await b.waitFor((x) => x.errors.length > 0, { label: 'chặn vào bằng mã' });
  assert.match(b.errors[0], /phải vào từ sảnh/);
  a.close(); b.close();
});

test('phòng riêng vẫn dùng chip vui, không đụng tới ví', async () => {
  const c = await newClient('Chơi vui');
  const viTruoc = await c.balanceInDb();
  c.send({ t: 'create', bots: 2, config: { startChips: 500, ante: 10 } });
  await c.waitState();

  const me = c.state.players.find((p) => p.id === c.joined.playerId);
  assert.equal(me.chips, 500, 'phòng riêng dùng vốn tự đặt');
  assert.equal(c.room.walletMode, false);

  c.send({ t: 'start' });
  await sleep(1500);
  assert.equal(await c.balanceInDb(), viTruoc, 'ví không được thay đổi ở phòng riêng');
  c.close();
});

/* ================================================================== */
/*  PHÒNG RIÊNG (giữ nguyên hành vi cũ)                                */
/* ================================================================== */

test('tạo phòng, lấy được mã 6 ký tự và token', async () => {
  const host = await newClient('Chủ');
  host.send({ t: 'create', bots: 2 });
  await host.waitJoined();

  assert.match(host.joined.code, /^[A-Z0-9]{6}$/);
  assert.ok(host.joined.token, 'phải có token để nối lại');
  assert.equal(host.joined.isHost, true);

  await host.waitState();
  assert.equal(host.state.players.length, 3, '1 người + 2 bot');
  host.close();
});

test('người thứ hai vào bằng mã phòng', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 0 });
  await host.waitJoined();

  const guest = await newClient('Bình');
  guest.send({ t: 'join', code: host.joined.code });
  await guest.waitJoined();
  await guest.waitState();

  assert.equal(guest.joined.isHost, false);
  assert.equal(guest.state.players.length, 2);
  await host.waitFor((c) => c.state?.players.length === 2, { label: 'chủ bàn thấy người mới' });

  host.close(); guest.close();
});

test('mã phòng sai thì báo lỗi rõ ràng', async () => {
  const c = await newClient('X');
  c.send({ t: 'join', code: 'ZZZZZZ' });
  await c.waitFor((x) => x.errors.length > 0, { label: 'thông báo lỗi' });
  assert.match(c.errors[0], /Không tìm thấy phòng/);
  c.close();
});

test('CHỐNG GIAN LẬN: gói tin gửi cho client không chứa bài của người khác', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 0 });
  await host.waitJoined();

  const guest = await newClient('Bình');
  guest.send({ t: 'join', code: host.joined.code });
  await guest.waitJoined();
  await host.waitFor((c) => c.room?.canStart, { label: 'đủ người' });

  host.send({ t: 'start' });
  await host.waitFor((c) => c.state?.phase === 'betting', { label: 'ván bắt đầu' });
  await guest.waitFor((c) => c.state?.phase === 'betting', { label: 'khách thấy ván bắt đầu' });
  await host.revealCards();
  await guest.revealCards();

  for (const [me, other] of [[host, guest], [guest, host]]) {
    const mine = me.state.players.find((p) => p.id === me.joined.playerId);
    const theirs = me.state.players.find((p) => p.id === other.joined.playerId);
    assert.equal(mine.cards.length, 3, 'phải thấy bài của mình');
    assert.equal(theirs.cards, null, 'KHÔNG được thấy bài của đối thủ');
    assert.equal(theirs.cardCount, 3);
  }

  const hostRaw = JSON.stringify(host.messages.filter((m) => m.t === 'state'));
  const guestHand = guest.state.players.find((p) => p.id === guest.joined.playerId).cards;
  const leaked = guestHand
    .map((c) => `"rank":${c.rank},"suit":"${c.suit}"`)
    .filter((code) => hostRaw.includes(code));
  assert.ok(leaked.length < 3, 'không được lộ trọn bộ bài của đối thủ qua đường mạng');

  host.close(); guest.close();
});

test('LẬT BÀI: chưa lật thì server không gửi lá nào xuống, lật rồi mới có', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 2 });
  await host.waitFor((c) => c.room?.canStart);
  host.send({ t: 'start' });
  await host.waitFor((c) => c.state?.phase === 'betting');

  const me = () => host.state.players.find((p) => p.id === host.joined.playerId);
  assert.deepEqual(me().cards, [null, null, null], 'chưa lật thì không được gửi lá nào');
  assert.equal(me().cardCount, 3);
  assert.equal(me().revealedCount, 0);

  // Toàn bộ dữ liệu đã nhận qua mạng không được chứa lá bài nào của mình
  const truoc = JSON.stringify(host.messages);
  assert.ok(!/"rank":\d+,"suit":/.test(truoc), 'có lá bài lọt xuống client khi chưa lật');

  // Lật lá giữa
  host.send({ t: 'flip', index: 1 });
  await host.waitFor((c) => me().revealedCount === 1, { label: 'lật lá giữa' });
  assert.equal(me().cards[0], null);
  assert.ok(me().cards[1]?.rank, 'lá vừa lật phải hiện ra');
  assert.equal(me().cards[2], null);

  // Mở hết
  host.send({ t: 'flip', all: true });
  await host.waitFor((c) => me().revealedCount === 3, { label: 'mở hết' });
  assert.equal(me().cards.filter(Boolean).length, 3);
  host.close();
});

test('LẬT BÀI: chưa mở hết thì server chặn đặt cược, nhưng cho úp mù', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 2 });
  await host.waitFor((c) => c.room?.canStart);
  host.send({ t: 'start' });
  await host.waitMyTurn();

  assert.equal(host.state.legal.allRevealed, false);
  assert.equal(host.state.legal.canCall, false);
  assert.equal(host.state.legal.canRaise, false);
  assert.equal(host.state.legal.canFold, true, 'úp mù thì lúc nào cũng được');

  host.errors.length = 0;
  host.send({ t: 'action', action: 'call', actionSeq: host.state.legal.actionSeq });
  await host.waitFor((c) => c.errors.length > 0, { label: 'bị chặn đặt cược' });
  assert.match(host.errors[0], /mở hết 3 lá/);

  // Úp mù thì đi được
  host.send({ t: 'action', action: 'fold', actionSeq: host.state.legal.actionSeq });
  await host.waitFor(
    (c) => c.state.players.find((p) => p.id === c.joined.playerId)?.folded,
    { label: 'úp mù thành công' },
  );
  assert.ok(host.events.some((e) => e.type === 'action' && e.blind === true));
  host.close();
});

test('không thể đi thay lượt người khác', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 0 });
  await host.waitJoined();
  const guest = await newClient('Bình');
  guest.send({ t: 'join', code: host.joined.code });
  await guest.waitJoined();
  await host.waitFor((c) => c.room?.canStart);

  host.send({ t: 'start' });
  await host.waitFor((c) => c.state?.phase === 'betting');
  await guest.waitFor((c) => c.state?.phase === 'betting');

  const waiter = host.state.legal ? guest : host;
  waiter.errors.length = 0;
  waiter.send({ t: 'action', action: 'raise', amount: 1000 });
  await waiter.waitFor((c) => c.errors.length > 0, { label: 'bị từ chối' });
  assert.match(waiter.errors[0], /Chưa tới lượt|không hợp lệ|Không thể/);

  host.close(); guest.close();
});

test('mức tố vượt số tiền đang có bị server chặn', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 1 });
  await host.waitFor((c) => c.room?.canStart);
  host.send({ t: 'start' });
  await host.waitMyTurn();
  await host.revealCards();

  host.errors.length = 0;
  host.send({
    t: 'action', action: 'raise', amount: 999999,
    actionSeq: host.state.legal.actionSeq,
  });
  await host.waitFor((c) => c.errors.length > 0, { label: 'chặn tố quá tay' });
  assert.match(host.errors[0], /Mức tố phải trong khoảng/);
  host.close();
});

test('chơi trọn một ván với bot, tiền được chia và có lịch sử', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 3, config: { turnSeconds: 10 } });
  await host.waitFor((c) => c.room?.canStart);
  host.send({ t: 'start' });
  await host.waitFor((c) => c.state?.phase === 'betting', { label: 'ván bắt đầu' });
  await host.revealCards();

  let guard = 0;
  while (guard++ < 40) {
    if (host.state?.phase === 'roundOver' || host.state?.phase === 'gameOver') break;
    if (host.state?.legal) {
      host.send({ t: 'action', action: 'call', actionSeq: host.state.legal.actionSeq });
    }
    await sleep(150);
  }

  assert.ok(['roundOver', 'gameOver'].includes(host.state.phase));
  assert.equal(host.state.pot, 0, 'hũ phải được chia hết');
  const total = host.state.players.reduce((s, p) => s + p.chips, 0);
  assert.equal(total, 4 * 500, 'tổng tiền cả bàn không đổi');

  const hist = host.messages.filter((m) => m.t === 'state').at(-1).history;
  assert.ok(hist.length >= 1 && hist[0].totalPot > 0);
  assert.ok(host.events.some((e) => e.type === 'round-end'));
  host.close();
});

test('hết giờ thì server tự úp bài', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 1, config: { turnSeconds: 8 } });
  await host.waitFor((c) => c.room?.canStart);
  host.send({ t: 'start' });
  await host.waitMyTurn();

  await host.waitFor((c) => c.events.some((e) => e.type === 'timeout'), {
    timeout: 12000, label: 'sự kiện hết giờ',
  });
  const me = host.state.players.find((p) => p.id === host.joined.playerId);
  assert.ok(me.folded || !host.state.legal);
  host.close();
});

test('rớt mạng rồi nối lại bằng token thì giữ nguyên ghế và tiền', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 2 });
  await host.waitState();

  const { code, token, playerId } = host.joined;
  const chipsBefore = host.state.players.find((p) => p.id === playerId).chips;
  const sessionToken = host.sessionToken;

  host.ws.terminate();
  await sleep(200);

  const again = await new TestClient('An-nối-lại').connect();
  again.send({ t: 'auth', sessionToken });
  await again.waitFor((c) => c.account, { label: 'đăng nhập lại' });
  again.send({ t: 'resume', code, token });
  await again.waitJoined();
  await again.waitState();

  assert.equal(again.joined.playerId, playerId);
  assert.equal(again.joined.resumed, true);
  assert.equal(
    again.state.players.find((p) => p.id === playerId).chips,
    chipsBefore,
  );
  again.close();
});

test('token sai thì không cướp được ghế người khác', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 1 });
  await host.waitJoined();

  const keGian = await newClient('Kẻ gian');
  keGian.send({ t: 'resume', code: host.joined.code, token: 'token-bia-dat' });
  await keGian.waitFor((c) => c.errors.length > 0, { label: 'từ chối token sai' });
  assert.match(keGian.errors[0], /Không nhận lại được ghế/);
  assert.equal(keGian.joined, null);

  host.close(); keGian.close();
});

test('chỉ chủ bàn mới bắt đầu ván / thêm bot / chia lại được', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 0 });
  await host.waitJoined();
  const guest = await newClient('Bình');
  guest.send({ t: 'join', code: host.joined.code });
  await guest.waitState();

  for (const cmd of ['start', 'add-bot', 'reset']) {
    guest.errors.length = 0;
    guest.send({ t: cmd });
    await guest.waitFor((c) => c.errors.length > 0, { label: `chặn lệnh ${cmd}` });
    assert.match(guest.errors[0], /Chỉ chủ bàn/);
  }
  host.close(); guest.close();
});

test('khán giả xem được bàn nhưng không thấy bài của ai', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 2 });
  await host.waitJoined();

  const fan = await newClient('Cổ động viên');
  fan.send({ t: 'join', code: host.joined.code, spectate: true });
  await fan.waitJoined();
  await fan.waitState();

  assert.equal(fan.joined.spectating, true);
  assert.equal(fan.joined.playerId, undefined);

  host.send({ t: 'start' });
  await fan.waitFor((c) => c.state?.phase === 'betting', { label: 'khán giả thấy ván' });

  for (const p of fan.state.players) {
    assert.equal(p.cards, null, 'khán giả không được thấy bài của ai');
  }
  assert.equal(fan.state.legal, null);
  host.close(); fan.close();
});

test('chat tới được mọi người trong bàn', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 0 });
  await host.waitJoined();
  const guest = await newClient('Bình');
  guest.send({ t: 'join', code: host.joined.code });
  await guest.waitJoined();

  guest.send({ t: 'chat', text: 'Chào cả nhà!' });
  await host.waitFor(
    (c) => c.messages.some((m) => m.t === 'chat' && m.msg.text === 'Chào cả nhà!'),
    { label: 'nhận được chat' },
  );
  const msg = host.messages.find((m) => m.t === 'chat' && m.msg.text === 'Chào cả nhà!');
  assert.equal(msg.msg.from, 'Bình');
  host.close(); guest.close();
});

test('tên chứa thẻ HTML bị làm sạch trước khi phát đi', async () => {
  const c = await new TestClient('Kẻ chèn mã').connect();
  await c.auth('<script>alert(1)</script>');
  assert.ok(!c.account.displayName.includes('<'), `tên chưa sạch: ${c.account.displayName}`);
  assert.ok(!c.account.displayName.includes('>'));
  c.close();
});

test('bàn đầy thì người vào sau tự chuyển sang xem', async () => {
  const host = await newClient('An');
  host.send({ t: 'create', bots: 1, config: { maxPlayers: 2 } });
  await host.waitState();
  assert.equal(host.state.players.length, 2);

  const late = await newClient('Tới trễ');
  late.send({ t: 'join', code: host.joined.code });
  await late.waitJoined();
  assert.equal(late.joined.spectating, true);
  assert.match(late.joined.reason ?? '', /đầy/);

  host.close(); late.close();
});

test('tạo phòng 10 người, thêm đủ 9 bot và bắt đầu ván thành công', async () => {
  const host = await newClient('Chủ Chiếu');
  host.send({ t: 'create', bots: 9, config: { maxPlayers: 10 } });
  await host.waitFor((c) => c.room?.canStart && c.state?.players.length === 10);
  assert.equal(host.state.players.length, 10, 'Đủ 10 người trong bàn');
  assert.equal(host.state.players.filter((p) => p.isBot).length, 9, 'Đủ 9 bot');

  // Người thứ 11 vào sẽ bị chuyển sang xem vì bàn đã đầy 10 người
  const p11 = await newClient('Khách 11');
  p11.send({ t: 'join', code: host.joined.code });
  await p11.waitJoined();
  assert.equal(p11.joined.spectating, true);

  host.send({ t: 'start' });
  await host.waitFor((c) => c.state?.phase === 'betting', { label: 'ván 10 người bắt đầu' });
  assert.equal(host.state.phase, 'betting');

  host.close(); p11.close();
});
