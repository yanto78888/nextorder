// Konfigurasi tier membership (bukan role login admin/user, terpisah dari itu).
// Setiap tier punya harga upgrade dan potongan harga per-item saat checkout produk.
export const MEMBERSHIP_TIERS = {
  reguler: {
    key: 'reguler',
    label: 'Reguler',
    price: 0,
    discount: 0,
    icon: '⚪',
    order: 0
  },
  gold: {
    key: 'gold',
    label: 'Gold',
    price: 10000,
    discount: 2000,
    icon: '🥇',
    order: 1
  },
  platinum: {
    key: 'platinum',
    label: 'Platinum',
    price: 20000,
    discount: 4000,
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

// Harga produk setelah dipotong diskon member, tidak pernah minus
export function applyMemberDiscount(price, membershipKey) {
  const tier = getMembershipTier(membershipKey);
  return Math.max(0, Number(price) - tier.discount);
}
