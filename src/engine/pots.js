/**
 * Chia hũ chính và các hũ phụ (side pot).
 *
 * Bản prototype offline gộp tất cả vào một hũ duy nhất — nghĩa là một người
 * tất tay 20 tiền vẫn có thể ăn trọn hũ 500. Online thì đó là lỗi tiền bạc
 * nghiêm trọng, nên phần này tính đúng theo luật:
 *
 *   Mỗi người chỉ được ăn phần hũ tương ứng với số tiền mình đã bỏ vào.
 */

import { compareHands } from './evaluate.js';

/**
 * Dựng danh sách hũ từ số tiền mỗi người đã bỏ vào trong cả ván.
 *
 * @param {{id:string, committed:number, folded:boolean}[]} players
 * @returns {{amount:number, eligible:string[]}[]}
 *   `eligible` là danh sách id được quyền tranh hũ đó (người đã úp bài vẫn
 *   góp tiền vào hũ nhưng không nằm trong danh sách này).
 */
export function buildPots(players) {
  const contributors = players.filter((p) => p.committed > 0);
  if (contributors.length === 0) return [];

  // Các mốc tiền, tăng dần. Mỗi mốc tạo ra một tầng hũ.
  const levels = [...new Set(contributors.map((p) => p.committed))].sort(
    (a, b) => a - b,
  );

  const pots = [];
  let prevLevel = 0;

  for (const level of levels) {
    let amount = 0;
    const eligible = [];
    const contributors = [];
    for (const p of players) {
      // Phần tiền của p nằm trong tầng (prevLevel, level]
      const contrib =
        Math.min(p.committed, level) - Math.min(p.committed, prevLevel);
      if (contrib > 0) {
        amount += contrib;
        contributors.push(p.id);
      }
      if (!p.folded && p.committed >= level) eligible.push(p.id);
    }
    if (amount > 0) {
      if (eligible.length === 0) {
        // Không còn ai đủ tư cách tranh tầng này (mọi người góp tiền vào đây
        // đều đã úp bài). Tiền cược thừa được trả lại cho người đã bỏ vào —
        // trong một tầng thì ai cũng góp đúng bằng nhau nên chia đều là đúng.
        pots.push({ amount, eligible: contributors, refund: true });
      } else {
        pots.push({ amount, eligible, refund: false });
      }
    }
    prevLevel = level;
  }

  // Gộp các tầng liền nhau có cùng danh sách người tranh — cho gọn.
  const merged = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    if (last && last.refund === pot.refund && sameMembers(last.eligible, pot.eligible)) {
      last.amount += pot.amount;
    } else {
      merged.push({ amount: pot.amount, eligible: pot.eligible.slice(), refund: pot.refund });
    }
  }
  return merged;
}

function sameMembers(a, b) {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

/**
 * Chia tiền cho người thắng từng hũ.
 *
 * @param {{amount:number, eligible:string[]}[]} pots
 * @param {Record<string, object>} handsById  kết quả evaluateHand theo id
 * @param {string[]} seatOrder  thứ tự ghế, dùng để trao phần lẻ khi chia không hết
 * @returns {{
 *   payouts: Record<string, number>,
 *   details: {amount:number, eligible:string[], winners:string[], perWinner:number, remainder:number}[]
 * }}
 */
export function awardPots(pots, handsById, seatOrder = []) {
  const payouts = {};
  const details = [];

  for (const pot of pots) {
    if (pot.eligible.length === 0) continue;

    let winners;
    if (pot.refund) {
      // Tiền cược thừa: trả lại cho chính người đã bỏ vào, không so bài.
      winners = pot.eligible.slice();
    } else if (pot.eligible.length === 1) {
      winners = [pot.eligible[0]];
    } else {
      let best = null;
      winners = [];
      for (const id of pot.eligible) {
        const hand = handsById[id];
        if (!hand) continue;
        if (best === null) {
          best = hand;
          winners = [id];
          continue;
        }
        const cmp = compareHands(hand, best);
        if (cmp > 0) {
          best = hand;
          winners = [id];
        } else if (cmp === 0) {
          winners.push(id);
        }
      }
    }

    if (winners.length === 0) continue;

    const perWinner = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount - perWinner * winners.length;

    for (const id of winners) {
      payouts[id] = (payouts[id] ?? 0) + perWinner;
    }

    // Phần lẻ (do chia không hết) trao cho người ngồi sớm nhất theo thứ tự ghế.
    if (remainder > 0) {
      const ordered = seatOrder.filter((id) => winners.includes(id));
      const lucky = ordered[0] ?? winners[0];
      payouts[lucky] = (payouts[lucky] ?? 0) + remainder;
    }

    details.push({
      amount: pot.amount,
      eligible: pot.eligible.slice(),
      winners: winners.slice(),
      perWinner,
      remainder,
    });
  }

  return { payouts, details };
}
