// Preset field ID/Zone per game, biar admin gak perlu ngetik manual tiap bikin produk.
// "custom" dan "none" tetap disediakan buat produk non-game / kebutuhan lain.
// Field tanpa "type" = text bebas. Field dengan type:'select' + options = dropdown pilihan tetap
// (dipakai buat Server di game kayak Genshin/Wuwa yang server-nya cuma beberapa pilihan tetap).
// PENTING: value dropdown di bawah ini cuma perkiraan umum. Sebelum dipakai live, cek dulu
// customer_no/kode server yang benar di deskripsi SKU Digiflazz masing-masing game, karena
// format tiap publisher/game bisa beda meski nama server-nya kelihatan mirip.
const SERVER_OPTIONS_MIHOYO = [
  { value: 'os_asia', label: 'Asia' },
  { value: 'os_usa', label: 'America' },
  { value: 'os_euro', label: 'Europe' },
  { value: 'os_cht', label: 'TW / HK / MO' }
];

// Wuthering Waves punya publisher beda (Kuro Games, bukan miHoYo/Cognosphere), jadi kode
// server-nya juga beda meski nama regionnya kelihatan mirip — jangan disamain sama preset mihoyo.
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
