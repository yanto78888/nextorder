// Konfigurasi tier membership (bukan role login admin/user, terpisah dari itu).
// Setiap tier punya harga upgrade dan potongan harga PERSENTASE (%) per-item saat checkout produk.
export const MEMBERSHIP_TIERS = {
  reguler: {
    key: 'reguler',
    label: 'Reguler',
    price: 0,
    discountPercent: 0,
    icon: '⚪',
    order: 0
  },
  gold: {
    key: 'gold',
    label: 'Gold',
    price: 10000,
    discountPercent: 2,
    icon: '🥇',
    order: 1
  },
  platinum: {
    key: 'platinum',
    label: 'Platinum',
    price: 20000,
    discountPercent: 3,
    icon: '💎',
    order: 2
  }
};

export function getMembershipTier(key) {
  return MEMBERSHIP_TIERS[key] || MEMBERSHIP_TIERS.reguler;
}

export function getMembershipList() {
  return Object.values(MEMBERSHIP_TIERS).sort((a, b) => a.order - b.order);
}

// Nominal potongan (Rp) untuk harga produk tertentu berdasarkan tier membership
export function getDiscountAmount(price, membershipKey) {
  const tier = getMembershipTier(membershipKey);
  return Math.round(Number(price) * (tier.discountPercent / 100));
}

// Harga produk setelah dipotong diskon persentase member, tidak pernah minus
export function applyMemberDiscount(price, membershipKey) {
  const cut = getDiscountAmount(price, membershipKey);
  return Math.max(0, Number(price) - cut);
}
