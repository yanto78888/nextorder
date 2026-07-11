// Preset field ID/Zone per game, biar admin gak perlu ngetik manual tiap bikin produk.
// "custom" dan "none" tetap disediakan buat produk non-game / kebutuhan lain.
export const GAME_PRESETS = {
  none: {
    key: 'none',
    label: 'Tanpa ID Tujuan (voucher/akun)',
    icon: '🎁',
    fields: []
  },
  mobile_legends: {
    key: 'mobile_legends',
    label: 'Mobile Legends',
    icon: '🎮',
    fields: [
      { key: 'userId', label: 'User ID', placeholder: 'Contoh: 123456789', required: true },
      { key: 'zoneId', label: 'Zone ID', placeholder: 'Contoh: 1234', required: true }
    ]
  },
  free_fire: {
    key: 'free_fire',
    label: 'Free Fire',
    icon: '🔥',
    fields: [
      { key: 'userId', label: 'User ID', placeholder: 'Contoh: 123456789', required: true },
      { key: 'zoneId', label: 'Zone/Server (opsional)', placeholder: 'Kosongkan jika tidak ada', required: false }
    ]
  },
  genshin_impact: {
    key: 'genshin_impact',
    label: 'Genshin Impact',
    icon: '⚔️',
    fields: [
      { key: 'uid', label: 'UID', placeholder: 'Contoh: 800123456', required: true },
      { key: 'server', label: 'Server', placeholder: 'Asia / America / Europe / TW-HK-MO', required: true }
    ]
  },
  pubg_mobile: {
    key: 'pubg_mobile',
    label: 'PUBG Mobile',
    icon: '🪖',
    fields: [
      { key: 'userId', label: 'Character ID', placeholder: 'Contoh: 5123456789', required: true }
    ]
  },
  honkai_star_rail: {
    key: 'honkai_star_rail',
    label: 'Honkai: Star Rail',
    icon: '🚂',
    fields: [
      { key: 'uid', label: 'UID', placeholder: 'Contoh: 600123456', required: true },
      { key: 'server', label: 'Server', placeholder: 'Asia / America / Europe / TW-HK-MO', required: true }
    ]
  },
  valorant: {
    key: 'valorant',
    label: 'Valorant',
    icon: '🎯',
    fields: [
      { key: 'riotId', label: 'Riot ID#Tag', placeholder: 'Contoh: Nama#1234', required: true }
    ]
  },
  custom: {
    key: 'custom',
    label: 'Custom (atur sendiri)',
    icon: '🛠',
    fields: []
  }
};

export function getGamePreset(key) {
  return GAME_PRESETS[key] || GAME_PRESETS.none;
}

export function getGamePresetList() {
  return Object.values(GAME_PRESETS);
}

// Ikon buat ditampilin di katalog berdasarkan gamePreset produk
export function getGameIcon(gamePresetKey) {
  return getGamePreset(gamePresetKey).icon;
}
