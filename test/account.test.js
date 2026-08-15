import test from 'node:test';
import assert from 'node:assert/strict';

import { Store, gameDay, STARTING_BALANCE, CHECKIN_REWARD } from '../src/server/db.js';

const newStore = () => new Store(':memory:');

/* Mốc thời gian dùng chung — 14/08/2026 là thứ Sáu, tuần bắt đầu 10/08. */
const FRI = Date.parse('2026-08-14T03:00:00Z');   // 10:00 giờ VN, thứ 6
const SAT = Date.parse('2026-08-15T03:00:00Z');
const SUN = Date.parse('2026-08-16T03:00:00Z');
const NEXT_MON = Date.parse('2026-08-17T03:00:00Z');

/* ================= NGÀY THEO GIỜ VIỆT NAM ================= */

test('gameDay: thứ 2 là ô số 0, chủ nhật là ô số 6', () => {
  assert.deepEqual(gameDay(Date.parse('2026-08-10T03:00:00Z')), {
    date: '2026-08-10', dayIndex: 0, weekStart: '2026-08-10',
  });
  assert.equal(gameDay(FRI).dayIndex, 4);
  assert.equal(gameDay(SUN).dayIndex, 6);
  assert.equal(gameDay(SUN).weekStart, '2026-08-10');
});

test('gameDay: sang tuần mới thì weekStart nhảy sang thứ 2 kế tiếp', () => {
  assert.equal(gameDay(SUN).weekStart, '2026-08-10');
  assert.equal(gameDay(NEXT_MON).weekStart, '2026-08-17');
  assert.equal(gameDay(NEXT_MON).dayIndex, 0);
});

test('gameDay: đổi ngày theo giờ Việt Nam, không theo giờ máy chủ', () => {
  // 17:30 UTC thứ 5 = 00:30 thứ 6 ở Việt Nam -> đã là ngày mới
  assert.equal(gameDay(Date.parse('2026-08-13T17:30:00Z')).date, '2026-08-14');
  // 16:00 UTC thứ 5 = 23:00 thứ 5 ở Việt Nam -> vẫn ngày cũ
  assert.equal(gameDay(Date.parse('2026-08-13T16:00:00Z')).date, '2026-08-13');
});

/* ================= TÀI KHOẢN ================= */

test('đăng ký xong có sẵn vốn ban đầu', () => {
  const s = newStore();
  const acc = s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  assert.equal(acc.username, 'minhhieu');
  assert.equal(acc.displayName, 'Minh Hiếu');
  assert.equal(acc.balance, STARTING_BALANCE);
  s.close();
});

test('không đăng ký trùng tên, kể cả viết hoa khác nhau', () => {
  const s = newStore();
  s.register('minhhieu', 'matkhau123', 'A');
  assert.throws(() => s.register('MinhHieu', 'matkhau456', 'B'), /đã có người dùng/);
  s.close();
});

test('chặn tên đăng nhập và mật khẩu không hợp lệ', () => {
  const s = newStore();
  assert.throws(() => s.register('ab', 'matkhau123', 'X'), /từ 3 ký tự/);
  assert.throws(() => s.register('co dau', 'matkhau123', 'X'), /chữ thường, số/);
  assert.throws(() => s.register('hople', '123', 'X'), /từ 6 ký tự/);
  s.close();
});

test('đăng nhập sai mật khẩu bị từ chối, không lộ là tên có tồn tại hay không', () => {
  const s = newStore();
  s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  const saiMatKhau = (() => { try { s.login('minhhieu', 'saibet'); } catch (e) { return e.message; } })();
  const khongTonTai = (() => { try { s.login('aikhongco', 'saibet'); } catch (e) { return e.message; } })();
  assert.equal(saiMatKhau, khongTonTai, 'hai lỗi phải giống hệt nhau');
  assert.ok(s.login('minhhieu', 'matkhau123'));
  s.close();
});

test('mật khẩu không được lưu dạng thô', () => {
  const s = newStore();
  s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  const row = s.findByUsername('minhhieu');
  assert.ok(!JSON.stringify(row).includes('matkhau123'), 'mật khẩu bị lưu nguyên văn!');
  assert.ok(row.salt && row.pass_hash);
  s.close();
});

test('phiên đăng nhập: token đúng vào được, token sai thì không', () => {
  const s = newStore();
  const acc = s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  const token = s.createSession(acc.id);
  assert.equal(s.resolveSession(token).id, acc.id);
  assert.equal(s.resolveSession('token-bia-dat'), null);
  s.destroySession(token);
  assert.equal(s.resolveSession(token), null);
  s.close();
});

test('số dư không bao giờ âm', () => {
  const s = newStore();
  const acc = s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  assert.equal(s.addBalance(acc.id, -1000), STARTING_BALANCE - 1000);
  assert.throws(() => s.addBalance(acc.id, -999_999_999), /không đủ/);
  assert.throws(() => s.setBalance(acc.id, -1), /không hợp lệ/);
  assert.equal(s.getBalance(acc.id), STARTING_BALANCE - 1000);
  s.close();
});

/* ================= ĐIỂM DANH ================= */

test('thẻ điểm danh có đúng 7 ô từ T2 tới CN', () => {
  const s = newStore();
  const acc = s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  const card = s.getCheckinCard(acc.id, FRI);
  assert.equal(card.days.length, 7);
  assert.deepEqual(card.days.map((d) => d.label), ['T2','T3','T4','T5','T6','T7','CN']);
  assert.equal(card.todayIndex, 4);
  assert.equal(card.days[4].today, true);
  assert.equal(card.days[5].future, true, 'thứ 7 chưa tới');
  assert.equal(card.days[0].missed, true, 'thứ 2 đã bỏ lỡ');
  assert.equal(card.canClaimToday, true);
  s.close();
});

test('điểm danh nhận đúng 10k xu', () => {
  const s = newStore();
  const acc = s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  const res = s.claimCheckin(acc.id, FRI);
  assert.equal(res.amount, CHECKIN_REWARD);
  assert.equal(res.balance, STARTING_BALANCE + CHECKIN_REWARD);
  assert.equal(s.getBalance(acc.id), STARTING_BALANCE + CHECKIN_REWARD);
  assert.equal(res.card.days[4].claimed, true);
  assert.equal(res.card.canClaimToday, false);
  s.close();
});

test('một ngày chỉ điểm danh được một lần', () => {
  const s = newStore();
  const acc = s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  s.claimCheckin(acc.id, FRI);
  assert.throws(() => s.claimCheckin(acc.id, FRI), /đã điểm danh rồi/);
  // Gửi lại nhiều lần trong cùng ngày cũng không ăn thêm được
  for (let i = 0; i < 5; i++) {
    try { s.claimCheckin(acc.id, FRI + i * 1000); } catch {}
  }
  assert.equal(s.getBalance(acc.id), STARTING_BALANCE + CHECKIN_REWARD);
  s.close();
});

test('sang ngày mới thì điểm danh lại được', () => {
  const s = newStore();
  const acc = s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  s.claimCheckin(acc.id, FRI);
  s.claimCheckin(acc.id, SAT);
  s.claimCheckin(acc.id, SUN);
  assert.equal(s.getBalance(acc.id), STARTING_BALANCE + 3 * CHECKIN_REWARD);
  const card = s.getCheckinCard(acc.id, SUN);
  assert.equal(card.claimedThisWeek, 3);
  assert.equal(card.totalThisWeek, 3 * CHECKIN_REWARD);
  s.close();
});

test('sáng thứ 2 thẻ reset, điểm danh cả tuần được tối đa 70k', () => {
  const s = newStore();
  const acc = s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  s.claimCheckin(acc.id, SUN);
  const cuoiTuan = s.getCheckinCard(acc.id, SUN);
  assert.equal(cuoiTuan.claimedThisWeek, 1);

  const tuanMoi = s.getCheckinCard(acc.id, NEXT_MON);
  assert.equal(tuanMoi.weekStart, '2026-08-17');
  assert.equal(tuanMoi.claimedThisWeek, 0, 'thẻ phải reset sạch');
  assert.equal(tuanMoi.canClaimToday, true);

  // Điểm danh đủ 7 ngày của tuần mới
  const MON = Date.parse('2026-08-17T03:00:00Z');
  for (let d = 0; d < 7; d++) s.claimCheckin(acc.id, MON + d * 86_400_000);
  const full = s.getCheckinCard(acc.id, MON + 6 * 86_400_000);
  assert.equal(full.claimedThisWeek, 7);
  assert.equal(full.totalThisWeek, 70_000);
  assert.ok(full.days.every((d) => d.claimed));
  s.close();
});

test('bỏ một ngày là mất ngày đó, không nhận bù được', () => {
  const s = newStore();
  const acc = s.register('minhhieu', 'matkhau123', 'Minh Hiếu');
  const MON = Date.parse('2026-08-10T03:00:00Z');
  const WED = Date.parse('2026-08-12T03:00:00Z');
  s.claimCheckin(acc.id, MON);
  s.claimCheckin(acc.id, WED); // bỏ thứ 3

  const card = s.getCheckinCard(acc.id, WED);
  assert.equal(card.days[1].missed, true, 'thứ 3 phải hiện là đã bỏ lỡ');
  assert.equal(card.days[1].claimed, false);
  assert.equal(s.getBalance(acc.id), STARTING_BALANCE + 2 * CHECKIN_REWARD);
  s.close();
});

test('điểm danh của người này không ảnh hưởng người kia', () => {
  const s = newStore();
  const a = s.register('nguoi_a', 'matkhau123', 'A');
  const b = s.register('nguoi_b', 'matkhau123', 'B');
  s.claimCheckin(a.id, FRI);
  assert.equal(s.getCheckinCard(b.id, FRI).canClaimToday, true);
  assert.equal(s.getBalance(b.id), STARTING_BALANCE);
  s.close();
});
