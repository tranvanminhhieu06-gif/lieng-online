import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateHand, compareHands, CATEGORY, pointValue } from '../src/engine/evaluate.js';

/** Cú pháp gọn để tạo bài: h('A♥','2♠','3♦') */
const RANKS = { A: 1, J: 11, Q: 12, K: 13 };
function c(str) {
  const suit = str.slice(-1);
  const r = str.slice(0, -1);
  const rank = RANKS[r] ?? Number(r);
  return { rank, suit };
}
const h = (...cards) => cards.map(c);

test('pointValue: A=1, 2-9 tính số, 10/J/Q/K = 0', () => {
  assert.equal(pointValue(1), 1);
  assert.equal(pointValue(5), 5);
  assert.equal(pointValue(9), 9);
  assert.equal(pointValue(10), 0);
  assert.equal(pointValue(11), 0);
  assert.equal(pointValue(13), 0);
});

test('nhận diện Sáp', () => {
  const r = evaluateHand(h('7♠', '7♥', '7♦'));
  assert.equal(r.category, CATEGORY.SAP);
  assert.equal(r.label, 'Sáp 7');
});

test('Sáp Á là sáp cao nhất', () => {
  const sapA = evaluateHand(h('A♠', 'A♥', 'A♦'));
  const sapK = evaluateHand(h('K♠', 'K♥', 'K♦'));
  assert.ok(compareHands(sapA, sapK) > 0, 'Sáp Á phải thắng Sáp K');
});

test('Sáp thắng Liêng, Liêng thắng Ảnh, Ảnh thắng Điểm', () => {
  const sap = evaluateHand(h('2♠', '2♥', '2♦'));
  const lieng = evaluateHand(h('Q♠', 'K♥', 'A♦'));
  const anh = evaluateHand(h('J♠', 'J♥', 'Q♦'));
  const diem = evaluateHand(h('9♠', '9♥', '9♦')); // thực ra là sáp, đổi lá
  const diem9 = evaluateHand(h('9♠', '5♥', '5♦')); // 9 điểm

  assert.ok(compareHands(sap, lieng) > 0);
  assert.ok(compareHands(lieng, anh) > 0);
  assert.ok(compareHands(anh, diem9) > 0);
  assert.equal(diem.category, CATEGORY.SAP);
});

test('Q-K-A là Liêng mạnh nhất, A-2-3 là Liêng yếu nhất', () => {
  const qka = evaluateHand(h('Q♠', 'K♥', 'A♦'));
  const a23 = evaluateHand(h('A♠', '2♥', '3♦'));
  const mid = evaluateHand(h('10♠', 'J♥', 'Q♦'));

  assert.equal(qka.category, CATEGORY.LIENG);
  assert.equal(qka.label, 'Liêng Q-K-A');
  assert.equal(a23.category, CATEGORY.LIENG);
  assert.ok(compareHands(qka, mid) > 0, 'Q-K-A phải thắng 10-J-Q');
  assert.ok(compareHands(mid, a23) > 0, '10-J-Q phải thắng A-2-3');
});

test('J-Q-K KHÔNG phải Liêng mà là Ảnh', () => {
  const r = evaluateHand(h('J♠', 'Q♥', 'K♦'));
  assert.equal(r.category, CATEGORY.ANH);
  assert.equal(r.label, 'Ảnh');
});

test('K-A-2 không phải Liêng', () => {
  const r = evaluateHand(h('K♠', 'A♥', '2♦'));
  assert.equal(r.category, CATEGORY.DIEM);
});

test('tính điểm lấy hàng đơn vị', () => {
  assert.equal(evaluateHand(h('9♠', '9♥', '6♦')).score, 4); // 24 -> 4 (7-8-9 sẽ là Liêng nên không dùng)
  assert.equal(evaluateHand(h('A♠', 'K♥', '10♦')).score, 1); // 1+0+0
  assert.equal(evaluateHand(h('5♠', '5♥', 'K♦')).score, 0); // 10 -> 0 (bù)
  assert.equal(evaluateHand(h('9♠', '9♥', '2♦')).score, 0); // 20 -> 0
});

test('hoà điểm: so lá cao nhất', () => {
  // Cả hai đều 9 điểm
  const a = evaluateHand(h('K♠', '9♥', '10♦')); // 0+9+0 = 9
  const b = evaluateHand(h('4♠', '5♥', '10♦')); // 4+5+0 = 9
  assert.equal(a.score, 9);
  assert.equal(b.score, 9);
  assert.ok(compareHands(a, b) > 0, 'bộ có K phải thắng bộ có 10 là lá cao nhất');
});

test('hoà điểm và hoà lá cao: so chất (Cơ > Rô > Chuồn > Bích)', () => {
  const co = evaluateHand(h('K♥', '9♠', '10♦'));
  const bich = evaluateHand(h('K♠', '9♥', '10♦'));
  assert.ok(compareHands(co, bich) > 0, 'K Cơ phải thắng K Bích');
});

test('tắt so chất thì hai bộ cùng số là hoà tuyệt đối', () => {
  const opts = { tiebreakBySuit: false };
  const a = evaluateHand(h('K♥', '9♠', '10♦'), opts);
  const b = evaluateHand(h('K♠', '9♥', '10♦'), opts);
  assert.equal(compareHands(a, b), 0);
});

test('Liêng cùng bộ số thì so chất lá cao nhất', () => {
  const a = evaluateHand(h('5♠', '6♥', '7♥'));
  const b = evaluateHand(h('5♥', '6♠', '7♠'));
  assert.equal(a.category, CATEGORY.LIENG);
  assert.equal(b.category, CATEGORY.LIENG);
  assert.ok(compareHands(a, b) > 0, '7 Cơ phải thắng 7 Bích');
});

test('bài không đủ 3 lá thì báo lỗi', () => {
  assert.throws(() => evaluateHand(h('5♠', '6♥')), /3 lá/);
});
