/**
 * Trang quản lý: cộng/trừ xu, sổ cái, và bảo mật.
 *
 * ADMIN_PASSWORD phải đặt TRƯỚC khi nạp admin.js — module đọc biến này một lần
 * lúc khởi động để quyết định bật hay tắt hẳn trang quản lý.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

process.env.DB_FILE = ':memory:';
process.env.ADMIN_PASSWORD = 'mat-khau-quan-ly-rat-dai';

const { Store, STARTING_BALANCE } = await import('../src/server/db.js');
const { server, rooms, store } = await import('../src/server/index.js');

let base;
test.before(async () => {
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  for (const room of [...rooms.rooms.values()]) room.destroy();
  server.close();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callApi(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${base}/admin/api/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function adminToken() {
  const { data } = await callApi('login', {
    method: 'POST',
    body: { password: 'mat-khau-quan-ly-rat-dai' },
  });
  return data.token;
}

let seq = 0;
function newAccount(balance = STARTING_BALANCE) {
  const username = `qly${++seq}${Date.now().toString(36)}`;
  const acc = store.register(username, 'matkhau123', `Người ${seq}`);
  store.setBalance(acc.id, balance);
  return { ...acc, balance };
}

/* ================================================================== */
/*  LỚP CSDL                                                           */
/* ================================================================== */

test('cộng xu theo tên đăng nhập và ghi vào sổ cái', () => {
  const s = new Store(':memory:');
  s.register('minhhieu', 'matkhau123', 'Minh Hiếu');

  const r = s.adminAdjust('minhhieu', 25_000, 'nạp thẻ');
  assert.equal(r.delta, 25_000);
  assert.equal(r.balanceBefore, STARTING_BALANCE);
  assert.equal(r.balanceAfter, STARTING_BALANCE + 25_000);

  const log = s.adminLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].username, 'minhhieu');
  assert.equal(log[0].delta, 25_000);
  assert.equal(log[0].reason, 'nạp thẻ');
  s.close();
});

test('tên đăng nhập không phân biệt hoa thường', () => {
  const s = new Store(':memory:');
  s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  assert.equal(s.adminAdjust('MinhHieu', 1_000).balanceAfter, STARTING_BALANCE + 1_000);
  s.close();
});

test('tên đăng nhập không tồn tại thì báo rõ ràng', () => {
  const s = new Store(':memory:');
  assert.throws(() => s.adminAdjust('khong_co_ai', 1_000), /Không có tài khoản nào tên/);
  s.close();
});

test('trừ xu được, nhưng không trừ xuống âm', () => {
  const s = new Store(':memory:');
  s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  s.setBalance(s.findByUsername('minhhieu').id, 10_000);

  assert.equal(s.adminAdjust('minhhieu', -4_000).balanceAfter, 6_000);
  assert.throws(() => s.adminAdjust('minhhieu', -99_999), /âm mất/);
  assert.equal(s.getBalance(s.findByUsername('minhhieu').id), 6_000, 'lỗi thì không đổi gì');
  assert.equal(s.adminLog().length, 1, 'lần thất bại không được ghi sổ');
  s.close();
});

test('số xu phải là số nguyên khác 0', () => {
  const s = new Store(':memory:');
  s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  assert.throws(() => s.adminAdjust('minhhieu', 0), /khác 0/);
  assert.throws(() => s.adminAdjust('minhhieu', 'nhiều'), /khác 0/);
  s.close();
});

test('đặt lại số dư, sổ cái ghi phần chênh lệch', () => {
  const s = new Store(':memory:');
  s.register('minhhieu', 'matkhau123', 'Minh Hiếu'); // 50.000

  const r = s.adminSetBalance('minhhieu', 12_345, 'sửa lỗi');
  assert.equal(r.balanceAfter, 12_345);
  assert.equal(r.delta, 12_345 - STARTING_BALANCE);
  assert.equal(s.adminLog()[0].delta, r.delta);

  assert.throws(() => s.adminSetBalance('minhhieu', -5), /không âm/);
  s.close();
});

test('sổ cái xếp mới nhất lên đầu và giới hạn số dòng', () => {
  const s = new Store(':memory:');
  s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  for (let i = 1; i <= 25; i++) s.adminAdjust('minhhieu', 1_000, `lần ${i}`);
  const log = s.adminLog(20);
  assert.equal(log.length, 20);
  assert.equal(log[0].reason, 'lần 25');
  assert.equal(log[19].reason, 'lần 6');
  s.close();
});

test('danh sách người chơi tìm được theo cả tên đăng nhập lẫn tên hiển thị', () => {
  const s = new Store(':memory:');
  s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  s.register('binhan', 'matkhau123', 'Bình An');
  s.register('cuongdz', 'matkhau123', 'Cường');

  assert.equal(s.countAccounts(), 3);
  assert.equal(s.listAccounts().length, 3);
  assert.equal(s.listAccounts({ q: 'hieu' })[0].username, 'minhhieu');
  assert.equal(s.listAccounts({ q: 'Bình' })[0].username, 'binhan');
  assert.equal(s.listAccounts({ q: 'khong-co-gi' }).length, 0);
  s.close();
});

test('danh sách không để lộ mật khẩu', () => {
  const s = new Store(':memory:');
  s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  const raw = JSON.stringify(s.listAccounts());
  assert.ok(!raw.includes('pass'), 'không được lộ trường mật khẩu');
  assert.ok(!raw.includes('salt'));
  s.close();
});

/* ================================================================== */
/*  BẢO MẬT                                                            */
/* ================================================================== */

test('không có token thì mọi API quản lý đều bị chặn', async () => {
  for (const [path, method] of [['players','GET'], ['log','GET'], ['adjust','POST']]) {
    const { status, data } = await callApi(path, {
      method,
      body: method === 'POST' ? {} : undefined,
    });
    assert.equal(status, 401, `${path} phải bị chặn`);
    assert.match(data.error, /hết hạn|đăng nhập/);
  }
});

test('token bịa đặt cũng bị chặn', async () => {
  const { status } = await callApi('players', { token: 'token-bia-dat' });
  assert.equal(status, 401);
});

test('sai mật khẩu không lấy được token', async () => {
  const { status, data } = await callApi('login', {
    method: 'POST', body: { password: 'doan-mo' },
  });
  assert.equal(status, 401);
  assert.match(data.error, /Sai mật khẩu/);
  assert.equal(data.token, undefined);
});

test('đúng mật khẩu thì vào được và gọi API được', async () => {
  const token = await adminToken();
  assert.ok(token);
  const { status, data } = await callApi('players', { token });
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.players));
});

test('trang /admin có tồn tại khi đã đặt ADMIN_PASSWORD', async () => {
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('QUẢN LÝ LIÊNG'));
  assert.ok(!html.includes(process.env.ADMIN_PASSWORD), 'mật khẩu không được nhúng vào trang');
});

/* ================================================================== */
/*  CỘNG XU QUA API                                                    */
/* ================================================================== */

test('cộng xu qua API cho người chơi đang không ngồi bàn', async () => {
  const token = await adminToken();
  const acc = newAccount(30_000);

  const { status, data } = await callApi('adjust', {
    method: 'POST', token,
    body: { username: acc.username, mode: 'add', amount: 70_000, reason: 'nạp thẻ' },
  });

  assert.equal(status, 200);
  assert.equal(data.balanceAfter, 100_000);
  assert.equal(data.seated, null);
  assert.equal(store.getBalance(acc.id), 100_000);
});

test('điền sai tên đăng nhập thì báo lỗi, không cộng nhầm cho ai', async () => {
  const token = await adminToken();
  const tongTruoc = store.totalBalance();
  const { status, data } = await callApi('adjust', {
    method: 'POST', token,
    body: { username: 'ten_khong_ton_tai', mode: 'add', amount: 999_999 },
  });
  assert.equal(status, 400);
  assert.match(data.error, /Không có tài khoản nào tên/);
  assert.equal(store.totalBalance(), tongTruoc, 'tổng xu toàn hệ thống không được đổi');
});

test('bỏ trống tên đăng nhập bị từ chối', async () => {
  const token = await adminToken();
  const { status, data } = await callApi('adjust', {
    method: 'POST', token, body: { username: '  ', mode: 'add', amount: 1000 },
  });
  assert.equal(status, 400);
  assert.match(data.error, /Chưa điền tên đăng nhập/);
});

/* ================================================================== */
/*  NGƯỜI CHƠI ĐANG NGỒI BÀN                                           */
/* ================================================================== */

/** Nối một client, đăng nhập bằng tài khoản có sẵn, rồi vào bàn theo mức. */
async function seatAt(acc, tierId) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));

  const sessionToken = store.createSession(acc.id);
  ws.send(JSON.stringify({ t: 'auth', sessionToken }));
  ws.send(JSON.stringify({ t: 'join-tier', tierId }));

  const started = Date.now();
  while (Date.now() - started < 4000) {
    const joined = inbox.find((m) => m.t === 'joined');
    if (joined) return { ws, inbox, joined };
    await sleep(25);
  }
  throw new Error('Không vào được bàn: ' + JSON.stringify(inbox.map((m) => m.t + (m.message ? `(${m.message})` : ''))));
}

test('cộng xu cho người ĐANG NGỒI BÀN thì chip trên bàn cũng tăng theo', async () => {
  const token = await adminToken();
  const acc = newAccount(60_000);
  const { ws, joined } = await seatAt(acc, 'muc5');

  const room = rooms.get(joined.code);
  const player = room.game.players.find((p) => p.id === joined.playerId);
  const chipTruoc = player.chips;

  const { status, data } = await callApi('adjust', {
    method: 'POST', token,
    body: { username: acc.username, mode: 'add', amount: 40_000, reason: 'nạp thẻ' },
  });

  assert.equal(status, 200);
  assert.equal(data.seated, 'Bàn 5K', 'phải báo là người này đang ngồi bàn nào');
  assert.equal(player.chips, chipTruoc + 40_000, 'chip trên bàn phải tăng theo');
  ws.close();
});

test('LỖI TIỀM ẨN: xu vừa cộng KHÔNG bị ghi đè khi ván kết thúc', async () => {
  const token = await adminToken();
  const acc = newAccount(60_000);
  const { ws, joined } = await seatAt(acc, 'muc5');

  const room = rooms.get(joined.code);
  const player = room.game.players.find((p) => p.id === joined.playerId);

  await callApi('adjust', {
    method: 'POST', token,
    body: { username: acc.username, mode: 'add', amount: 100_000, reason: 'nạp thẻ' },
  });
  const chipSauKhiCong = player.chips;

  // Chốt sổ cuối ván — đây chính là lúc số dư bị ghi đè bằng chip trên bàn.
  // Nếu chỉ sửa trong CSDL mà quên sửa chip, 100.000 xu vừa cộng sẽ bay sạch.
  room.settleWallets();

  assert.equal(
    store.getBalance(acc.id), chipSauKhiCong,
    'xu vừa cộng phải còn nguyên sau khi chốt sổ',
  );
  assert.ok(store.getBalance(acc.id) >= 100_000, 'phải giữ được khoản vừa nạp');
  ws.close();
});

test('không cho đặt lại số dư khi người chơi đang ngồi bàn', async () => {
  const token = await adminToken();
  const acc = newAccount(80_000);
  const { ws, joined } = await seatAt(acc, 'muc20');

  const { status, data } = await callApi('adjust', {
    method: 'POST', token,
    body: { username: acc.username, mode: 'set', amount: 1_000_000 },
  });

  assert.equal(status, 400);
  assert.match(data.error, /đang ngồi ở bàn/);
  assert.match(data.error, /cộng\/trừ/, 'phải gợi ý cách làm thay thế');
  assert.notEqual(store.getBalance(acc.id), 1_000_000);
  ws.close();
  assert.ok(joined.code);
});

test('trừ xu không làm chip trên bàn xuống âm', async () => {
  const token = await adminToken();
  const acc = newAccount(60_000);
  const { ws, joined } = await seatAt(acc, 'muc5');

  const room = rooms.get(joined.code);
  const player = room.game.players.find((p) => p.id === joined.playerId);

  await callApi('adjust', {
    method: 'POST', token,
    body: { username: acc.username, mode: 'add', amount: -55_000 },
  });

  assert.ok(player.chips >= 0, `chip trên bàn bị âm: ${player.chips}`);
  ws.close();
});
