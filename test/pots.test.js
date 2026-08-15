import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPots, awardPots } from '../src/engine/pots.js';

const hand = (category, ...tiebreak) => ({ category, tiebreak, label: 'x' });

test('không ai tất tay: một hũ duy nhất', () => {
  const pots = buildPots([
    { id: 'a', committed: 100, folded: false },
    { id: 'b', committed: 100, folded: false },
    { id: 'c', committed: 100, folded: false },
  ]);
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 300);
  assert.deepEqual(pots[0].eligible.sort(), ['a', 'b', 'c']);
});

test('người đã úp bài vẫn góp tiền nhưng không được tranh hũ', () => {
  const pots = buildPots([
    { id: 'a', committed: 100, folded: false },
    { id: 'b', committed: 100, folded: false },
    { id: 'c', committed: 40, folded: true },
  ]);
  const total = pots.reduce((s, p) => s + p.amount, 0);
  assert.equal(total, 240);
  for (const p of pots) {
    assert.ok(!p.eligible.includes('c'), 'c đã úp bài, không được tranh hũ');
  }
});

test('tất tay ít tiền tạo ra hũ phụ', () => {
  // a tất tay 20, b và c cược tới 100
  const pots = buildPots([
    { id: 'a', committed: 20, folded: false },
    { id: 'b', committed: 100, folded: false },
    { id: 'c', committed: 100, folded: false },
  ]);
  assert.equal(pots.length, 2);

  const [main, side] = pots;
  assert.equal(main.amount, 60); // 20 x 3
  assert.deepEqual(main.eligible.sort(), ['a', 'b', 'c']);
  assert.equal(side.amount, 160); // 80 x 2
  assert.deepEqual(side.eligible.sort(), ['b', 'c']);
  assert.equal(main.amount + side.amount, 220);
});

test('LỖI CỦA BẢN OFFLINE: người tất tay 20 không được ăn trọn hũ 220', () => {
  const pots = buildPots([
    { id: 'a', committed: 20, folded: false },
    { id: 'b', committed: 100, folded: false },
    { id: 'c', committed: 100, folded: false },
  ]);
  const hands = {
    a: hand(3, 14), // a bài mạnh nhất (Sáp Á)
    b: hand(2, 10),
    c: hand(0, 5),
  };
  const { payouts } = awardPots(pots, hands, ['a', 'b', 'c']);

  assert.equal(payouts.a, 60, 'a chỉ được ăn phần hũ tương ứng tiền đã bỏ');
  assert.equal(payouts.b, 160, 'b mạnh nhì nên ăn hũ phụ');
  assert.equal(payouts.c ?? 0, 0);
  assert.equal(payouts.a + payouts.b, 220, 'tổng chia ra phải bằng tổng hũ');
});

test('ba mức tất tay khác nhau tạo ba tầng hũ', () => {
  const pots = buildPots([
    { id: 'a', committed: 10, folded: false },
    { id: 'b', committed: 50, folded: false },
    { id: 'c', committed: 200, folded: false },
    { id: 'd', committed: 200, folded: false },
  ]);
  const total = pots.reduce((s, p) => s + p.amount, 0);
  assert.equal(total, 460);
  assert.equal(pots[0].amount, 40); // 10 x 4
  assert.equal(pots[1].amount, 120); // 40 x 3
  assert.equal(pots[2].amount, 300); // 150 x 2
  assert.deepEqual(pots[2].eligible.sort(), ['c', 'd']);
});

test('hoà thì chia đều, phần lẻ trao theo thứ tự ghế', () => {
  const pots = [{ amount: 101, eligible: ['a', 'b'] }];
  const hands = { a: hand(0, 5), b: hand(0, 5) };
  const { payouts } = awardPots(pots, hands, ['b', 'a']);
  assert.equal(payouts.a + payouts.b, 101);
  assert.equal(payouts.b, 51, 'b ngồi trước nên nhận phần lẻ');
  assert.equal(payouts.a, 50);
});

test('mọi người úp hết chỉ còn một người: người đó ăn cả', () => {
  const pots = buildPots([
    { id: 'a', committed: 30, folded: false },
    { id: 'b', committed: 10, folded: true },
    { id: 'c', committed: 10, folded: true },
  ]);
  const { payouts } = awardPots(pots, { a: hand(0, 1) }, ['a', 'b', 'c']);
  assert.equal(payouts.a, 50);
});

test('tổng chia ra luôn bằng tổng tiền vào hũ (100 trường hợp ngẫu nhiên)', () => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let iter = 0; iter < 100; iter++) {
    const n = 2 + Math.floor(rnd() * 5);
    const players = [];
    for (let i = 0; i < n; i++) {
      players.push({
        id: `p${i}`,
        committed: Math.floor(rnd() * 200),
        folded: rnd() < 0.35,
      });
    }
    // đảm bảo còn ít nhất một người chưa úp
    players[0].folded = false;
    players[0].committed = Math.max(1, players[0].committed);

    const pots = buildPots(players);
    const totalIn = players.reduce((s, p) => s + p.committed, 0);
    const totalPots = pots.reduce((s, p) => s + p.amount, 0);
    assert.equal(totalPots, totalIn, 'tổng các hũ phải bằng tổng tiền vào');

    const hands = {};
    for (const p of players) hands[p.id] = hand(0, Math.floor(rnd() * 10));
    const { payouts } = awardPots(pots, hands, players.map((p) => p.id));
    const totalOut = Object.values(payouts).reduce((s, x) => s + x, 0);
    assert.equal(totalOut, totalIn, 'tổng chia ra phải bằng tổng tiền vào');
  }
});
