// Preset field ID/Zone per game, biar admin gak perlu ngetik manual tiap bikin produk.
// "custom" dan "none" tetap disediakan buat produk non-game / kebutuhan lain.
// Field tanpa "type" = text bebas. Field dengan type:'select' + options = dropdown pilihan tetap

// PENTING: Cek kembali customer_no/kode server di deskripsi SKU Digiflazz masing-masing game.
const SERVER_OPTIONS_MIHOYO = [
  { value: 'os_asia', label: 'Asia' },
  { value: 'os_usa', label: 'America' },
  { value: 'os_euro', label: 'Europe' },
  { value: 'os_cht', label: 'TW / HK / MO' }
];

// Wuthering Waves (Kuro Games), kode server berbeda dengan miHoYo.
const SERVER_OPTIONS_WUWA = [
  { value: 'wr_asia', label: 'Asia' },
  { value: 'wr_na', label: 'America' },
  { value: 'wr_eu', label: 'Europe' },
  { value: 'wr_hmt', label: 'HMT (HK / Macau / Taiwan)' },
  { value: 'wr_sea', label: 'SEA' }
];

export const GAME_PRESETS = {
  none: {
    key: 'none',
    label: 'Tanpa ID Tujuan (voucher/akun)',
    icon: 'fa-gift',
    fields: []
  },
  mobile_legends: {
    key: 'mobile_legends',
    label: 'Mobile Legends',
    icon: 'fa-chess-knight',
    fields: [
      { key: 'userId', label: 'User ID', placeholder: 'Contoh: 123456789', required: true },
      { key: 'zoneId', label: 'Zone ID', placeholder: 'Contoh: 1234', required: true }
    ]
  },
  free_fire: {
    key: 'free_fire',
    label: 'Free Fire',
    icon: 'fa-fire',
    fields: [
      { key: 'userId', label: 'User ID', placeholder: 'Contoh: 123456789', required: true }
    ]
  },
  genshin_impact: {
    key: 'genshin_impact',
    label: 'Genshin Impact',
    icon: 'fa-hat-wizard',
    fields: [
      { key: 'uid', label: 'UID', placeholder: 'Contoh: 800123456', required: true },
      { key: 'server', label: 'Server', type: 'select', options: SERVER_OPTIONS_MIHOYO, required: true }
    ]
  },
  wuthering_waves: {
    key: 'wuthering_waves',
    label: 'Wuthering Waves',
    icon: 'fa-water',
    fields: [
      { key: 'uid', label: 'Union Level ID (UID)', placeholder: 'Contoh: 100123456', required: true },
      { key: 'server', label: 'Server', type: 'select', options: SERVER_OPTIONS_WUWA, required: true }
    ]
  },
  pubg_mobile: {
    key: 'pubg_mobile',
    label: 'PUBG Mobile',
    icon: 'fa-crosshairs',
    fields: [
      { key: 'userId', label: 'Character ID', placeholder: 'Contoh: 5123456789', required: true }
    ]
  },
  honkai_star_rail: {
    key: 'honkai_star_rail',
    label: 'Honkai: Star Rail',
    icon: 'fa-train',
    fields: [
      { key: 'uid', label: 'UID', placeholder: 'Contoh: 600123456', required: true },
      { key: 'server', label: 'Server', type: 'select', options: SERVER_OPTIONS_MIHOYO, required: true }
    ]
  },
  valorant: {
    key: 'valorant',
    label: 'Valorant',
    icon: 'fa-bullseye',
    fields: [
      { key: 'riotId', label: 'Riot ID#Tag', placeholder: 'Contoh: Nama#1234', required: true }
    ]
  },
  id_only: {
    key: 'id_only',
    label: 'Game dengan ID Saja (tanpa server)',
    icon: 'fa-id-badge',
    fields: [
      { key: 'userId', label: 'User ID', placeholder: 'Masukkan ID akun tujuan', required: true }
    ]
  },
  custom: {
    key: 'custom',
    label: 'Custom (atur sendiri)',
    icon: 'fa-sliders',
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

/**
 * Fungsi untuk memformat data input dari customer menjadi format string
 * yang siap dikirimkan ke API (seperti Digiflazz).
 * 
 * @param {string} gamePresetKey - Key dari game (contoh: 'mobile_legends')
 * @param {Object} inputs - Objek berisi data input dari form pembeli
 * @returns {string} - Hasil format string tujuan (contoh: "1234567891234" atau "800123456|os_asia")
 */
export function formatGameTarget(gamePresetKey, inputs = {}) {
  switch (gamePresetKey) {
    case 'mobile_legends': {
      // Digabung langsung tanpa titik atau spasi
      const userId = inputs.userId ? String(inputs.userId).trim() : '';
      const zoneId = inputs.zoneId ? String(inputs.zoneId).trim() : '';
      return `${userId}${zoneId}`;
    }

    case 'genshin_impact':
    case 'honkai_star_rail':
    case 'wuthering_waves': {
      // Menggunakan pembatas pipa |
      const uid = inputs.uid ? String(inputs.uid).trim() : '';
      const server = inputs.server ? String(inputs.server).trim() : '';
      return `${uid}|${server}`;
    }

    case 'valorant':
      return inputs.riotId ? String(inputs.riotId).trim() : '';

    case 'free_fire':
    case 'pubg_mobile':
    case 'id_only':
      return inputs.userId ? String(inputs.userId).trim() : '';

    default:
      // Fallback: Gabungkan semua value yang ada dengan pipa jika tidak ada aturan khusus
      return Object.values(inputs)
        .map(val => (val ? String(val).trim() : ''))
        .filter(Boolean)
        .join('|');
  }
}
