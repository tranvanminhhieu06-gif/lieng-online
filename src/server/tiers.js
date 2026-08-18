/**
 * Các mức bàn công khai.
 *
 * `minBalance` là số dư tối thiểu để được ngồi vào bàn — đúng như yêu cầu:
 * bàn 5K thì ai dưới 5K xu không vào được.
 *
 * Muốn người chơi phải có vốn dày hơn tiền sàn (chuẩn sòng bài thật là 20–50
 * lần) thì chỉ cần sửa `minBalance` ở đây, ví dụ `ante * 10`. Để nguyên như
 * dưới nghĩa là vào bàn với đúng số dư tối thiểu sẽ tất tay ngay ở tiền sàn.
 */

export const TIERS = [
  { id: 'muc1',   label: 'Bàn 1K',   ante: 1_000,   minBalance: 1_000 },
  { id: 'muc5',   label: 'Bàn 5K',   ante: 5_000,   minBalance: 5_000 },
  { id: 'muc20',  label: 'Bàn 20K',  ante: 20_000,  minBalance: 20_000 },
  { id: 'muc100', label: 'Bàn 100K', ante: 100_000, minBalance: 100_000 },
  { id: 'muc500', label: 'Bàn 500K', ante: 500_000,   minBalance: 2_500_000 },
  { id: 'muc1b',  label: 'Bàn 1B',   ante: 1_000_000,  minBalance: 5_000_000 },
  { id: 'muc5b',  label: 'Bàn 5B',   ante: 5_000_000,  minBalance: 25_000_000 },
];

/** Số ghế mỗi bàn công khai. */
export const TIER_MAX_PLAYERS = 5;

/** Vốn của bot ở bàn công khai — được bơm lại về mức này sau mỗi ván. */
export const BOT_STACK_MULTIPLIER = 10;

export function getTier(id) {
  return TIERS.find((t) => t.id === id) ?? null;
}

/** Cấu hình phòng sinh ra từ một mức bàn. */
export function tierRoomConfig(tier) {
  return {
    ante: tier.ante,
    startChips: tier.minBalance,
    maxPlayers: TIER_MAX_PLAYERS,
    maxRaises: 4,
    turnSeconds: 25,
    tiebreakBySuit: true,
    autoStart: true,
  };
}
