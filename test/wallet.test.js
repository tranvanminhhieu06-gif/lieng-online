/**
 * Cơ chế cộng tiền thắng vào tài khoản.
 *
 * Ở bàn công khai, chip trên bàn chính là số dư. Câu hỏi là: khi ván kết thúc,
 * tiền thắng về tới ví thế nào, và có gì có thể làm nó sai lệch không.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { TEST_DB_URL, uniqueSchema } from './pg-helper.js';

process.env.DATABASE_URL = TEST_DB_URL;
const TEST_SCHEMA = uniqueSchema('vi');
process.env.DB_SCHEMA = TEST_SCHEMA;

const { server, wss, rooms, store } = await import('../src/server/index.js');

let base;
let wsUrl;
let seq = 0;

test.before(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});

test.after(async () => {
  for (const room of [...rooms.rooms.values()]) room.destroy();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close();
  try { await store.pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`); } catch {}
  await store.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bàn công khai được dùng chung giữa các lượt vào. Dọn sạch trước mỗi test để
// người chơi của test trước (đã đóng kết nối nhưng còn giữ ghế) không làm ván
// của test sau treo tới hết giờ đếm lượt.
test.beforeEach(() => {
  for (const room of [...rooms.rooms.values()]) room.destroy();
  rooms.rooms.clear();
});

/** Client tối giản. */
class C {
  constructor() { this.msgs = []; this.state = null; this.joined = null; this.account = null; this.errors = []; }
  async open() {
    this.ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      this.msgs.push(m);
      if (m.t === 'state') this.state = m.state;
      if (m.t === 'joined') this.joined = m;
      if (m.t === 'error') this.errors.push(m.message);
      if (m.t === 'auth-ok') { this.account = m.account; this.token = m.sessionToken; }
      if (m.t === 'lobby' || m.t === 'account' || m.t === 'checkin-result') this.account = m.account;
    });
    return this;
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch {} }
  async wait(fn, { timeout = 6000, label = 'điều kiện' } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (fn(this)) return true; await sleep(20); }
    throw new Error(`Hết giờ chờ ${label}`);
  }
  async auth() {
    this.username = `vi${++seq}_${Date.now().toString(36)}`;
    this.send({ t: 'register', username: this.username, password: 'matkhau123', displayName: `Người ${seq}` });
    await this.wait((c) => c.account, { label: 'đăng ký' });
    this.id = this.account.id;
    return this;
  }
  db() { return store.getBalance(this.id); }
}

const newC = async () => (await new C().open()).auth();

/**
 * Chơi trọn một ván, đo theo trạng thái THẬT của server.
 *
 * Không dùng `c.state.phase` để biết ván đã xong chưa: trạng thái client nhận
 * được có thể lệch nhịp vài chục mili giây so với server, khiến test đọc số dư
 * đúng vào lúc server chưa kịp chốt sổ.
 */
async function choiHetVan(c, room) {
  const me = () => room.game.players.find((p) => p.id === c.joined.playerId);

  // Chờ tới khi mình thật sự có mặt trong một ván đang chạy
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (room.game.phase === 'betting' && me()?.inHand) break;
    await sleep(50);
  }
  assert.ok(me()?.inHand, 'phải vào được một ván');

  c.send({ t: 'flip', all: true });
  let guard = 0;
  while (guard++ < 120 && room.game.phase === 'betting') {
    if (c.state?.legal) {
      c.send({ t: 'action', action: 'call', actionSeq: c.state.legal.actionSeq });
    }
    await sleep(100);
  }
  assert.notEqual(room.game.phase, 'betting', 'ván phải kết thúc');
  await room.flushWrites();
}

/* ================================================================== */

test('tiền thắng/thua về đúng ví sau mỗi ván', async () => {
  const c = await newC();
  await store.setBalance(c.id, 200_000);
  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.wait((x) => x.joined, { label: 'vào bàn' });

  const room = rooms.get(c.joined.code);
  await choiHetVan(c, room);

  const chip = room.game.players.find((p) => p.id === c.joined.playerId).chips;
  assert.equal(await c.db(), chip, 'ví phải khớp chip trên bàn');
  assert.notEqual(await c.db(), 200_000, 'số dư phải đổi sau khi cược');
  c.close();
});

test('chơi liên tiếp nhiều ván, ví và chip không bao giờ trôi khỏi nhau', async () => {
  // Cơ chế cộng phần chênh lệch dễ sai ở chỗ tích luỹ: chỉ cần một ván tính
  // sai mốc là các ván sau lệch theo và càng lúc càng xa.
  const c = await newC();
  await store.setBalance(c.id, 500_000);
  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.wait((x) => x.joined, { label: 'vào bàn' });
  const room = rooms.get(c.joined.code);
  const me = () => room.game.players.find((p) => p.id === c.joined.playerId);

  for (let van = 1; van <= 3; van++) {
    await choiHetVan(c, room);

    assert.equal(
      await c.db(), me().chips,
      `hết ván ${van}: ví phải khớp chip trên bàn`,
    );
    assert.equal(
      me().walletBase, me().chips,
      `hết ván ${van}: mốc tính lãi/lỗ phải được đặt lại bằng số dư mới`,
    );

    // Chờ ván sau tự bắt đầu
    if (van < 3) {
      await c.wait((x) => x.state?.phase !== 'betting', { timeout: 8000, label: 'hết ván' })
        .catch(() => {});
      await sleep(200);
    }
  }
  c.close();
});

test('rời bàn xong, số dư client nhận được là số dư ĐÃ chốt sổ', async () => {
  const c = await newC();
  await store.setBalance(c.id, 200_000);
  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.wait((x) => x.joined, { label: 'vào bàn' });
  const room = rooms.get(c.joined.code);
  await choiHetVan(c, room);

  const chipSauVan = room.game.players.find((p) => p.id === c.joined.playerId).chips;

  // Rời bàn ngay lập tức, không chờ gì cả
  c.msgs.length = 0;
  c.send({ t: 'leave' });
  await c.wait((x) => x.msgs.some((m) => m.t === 'account'), { label: 'nhận số dư mới' });

  const guiVeClient = c.msgs.find((m) => m.t === 'account').account.balance;
  assert.equal(
    guiVeClient, chipSauVan,
    'số dư gửi về client phải là số đã chốt sổ, không phải số cũ trước ván',
  );
  c.close();
});

test('xu được cộng từ nơi khác lúc đang chơi thì không bị ván bài xoá mất', async () => {
  // Tình huống: người chơi đang ngồi bàn, cùng lúc có xu cộng vào tài khoản từ
  // chỗ khác — điểm danh ở tab thứ hai, hoặc admin cộng tay. Nếu lúc chốt sổ
  // server GHI ĐÈ số dư bằng chip trên bàn thì khoản cộng đó bay sạch.
  //
  // Test đặt thẳng tình huống thay vì canh thời điểm, để không phụ thuộc may rủi.
  const c = await newC();
  await store.setBalance(c.id, 200_000);
  c.send({ t: 'join-tier', tierId: 'muc5' });
  await c.wait((x) => x.joined, { label: 'vào bàn' });
  await c.wait((x) => x.state?.phase === 'betting', { timeout: 10000, label: 'ván bắt đầu' });

  const room = rooms.get(c.joined.code);
  const me = room.game.players.find((p) => p.id === c.joined.playerId);

  // Mốc ví lúc ngồi vào bàn, và chip hiện tại (đã trừ tiền sàn)
  const mocVi = me.walletBase;
  me.chips += 30_000; // giả lập vừa thắng thêm 30.000 chip
  const laiLoCuaVan = me.chips - mocVi;

  // Đồng thời có 10.000 xu cộng vào tài khoản từ ngoài ván bài
  const viTruoc = await c.db();
  await store.addBalance(c.id, 10_000);

  room.settleWallets();
  await room.flushWrites();

  assert.equal(
    await c.db(), viTruoc + 10_000 + laiLoCuaVan,
    'phải giữ cả 10.000 cộng từ ngoài lẫn phần lãi của ván',
  );
  assert.equal(
    me.chips, await c.db(),
    'chip trên bàn phải được đồng bộ lại theo ví cho ván sau',
  );
  c.close();
});
