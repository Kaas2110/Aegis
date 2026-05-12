/**
 * Статическая карта агрессивности/масштаба героев Dota 2.
 *
 * Ключ — OpenDota hero_id.
 * aggression: 0=чистый лейт/пассив → 1=ранняя агрессия/харасс
 * scale:      0=выпадает в лейт → 1=хайпер-керри
 *
 * Используется в market-моделях (train + inference).
 * Зеркало: artifacts/api-server/src/lib/heroDraftScores.ts
 */

export interface HeroDraftScore {
  aggression: number;
  scale: number;
}

const SCORES: Record<number, HeroDraftScore> = {
  1:   { aggression: 0.20, scale: 0.95 }, // Anti-Mage
  2:   { aggression: 0.85, scale: 0.50 }, // Axe
  3:   { aggression: 0.50, scale: 0.40 }, // Bane
  4:   { aggression: 0.65, scale: 0.70 }, // Bloodseeker
  5:   { aggression: 0.40, scale: 0.45 }, // Crystal Maiden
  6:   { aggression: 0.35, scale: 0.80 }, // Drow Ranger
  7:   { aggression: 0.75, scale: 0.55 }, // Earthshaker
  8:   { aggression: 0.60, scale: 0.75 }, // Juggernaut
  9:   { aggression: 0.55, scale: 0.55 }, // Mirana
  10:  { aggression: 0.30, scale: 0.95 }, // Morphling
  11:  { aggression: 0.75, scale: 0.70 }, // Shadow Fiend
  12:  { aggression: 0.20, scale: 0.90 }, // Phantom Lancer
  13:  { aggression: 0.80, scale: 0.65 }, // Puck
  14:  { aggression: 0.75, scale: 0.40 }, // Pudge
  15:  { aggression: 0.60, scale: 0.65 }, // Razor
  16:  { aggression: 0.75, scale: 0.55 }, // Sand King
  17:  { aggression: 0.85, scale: 0.70 }, // Storm Spirit
  18:  { aggression: 0.50, scale: 0.85 }, // Sven
  19:  { aggression: 0.85, scale: 0.70 }, // Tiny
  20:  { aggression: 0.65, scale: 0.40 }, // Vengeful Spirit
  21:  { aggression: 0.60, scale: 0.60 }, // Windranger
  22:  { aggression: 0.85, scale: 0.55 }, // Zeus
  23:  { aggression: 0.80, scale: 0.65 }, // Kunkka
  25:  { aggression: 0.80, scale: 0.60 }, // Lina
  26:  { aggression: 0.70, scale: 0.40 }, // Lion
  27:  { aggression: 0.65, scale: 0.50 }, // Shadow Shaman
  28:  { aggression: 0.80, scale: 0.55 }, // Slardar
  29:  { aggression: 0.65, scale: 0.55 }, // Tidehunter
  30:  { aggression: 0.60, scale: 0.45 }, // Witch Doctor
  31:  { aggression: 0.60, scale: 0.45 }, // Lich
  32:  { aggression: 0.55, scale: 0.70 }, // Riki
  33:  { aggression: 0.60, scale: 0.55 }, // Enigma
  34:  { aggression: 0.75, scale: 0.60 }, // Tinker
  35:  { aggression: 0.40, scale: 0.80 }, // Sniper
  36:  { aggression: 0.70, scale: 0.50 }, // Necrophos
  37:  { aggression: 0.55, scale: 0.45 }, // Warlock
  38:  { aggression: 0.80, scale: 0.50 }, // Beastmaster
  39:  { aggression: 0.85, scale: 0.60 }, // Queen of Pain
  40:  { aggression: 0.70, scale: 0.45 }, // Venomancer
  41:  { aggression: 0.30, scale: 0.90 }, // Faceless Void
  42:  { aggression: 0.50, scale: 0.80 }, // Wraith King
  43:  { aggression: 0.70, scale: 0.60 }, // Death Prophet
  44:  { aggression: 0.45, scale: 0.80 }, // Phantom Assassin
  45:  { aggression: 0.75, scale: 0.45 }, // Pugna
  46:  { aggression: 0.75, scale: 0.70 }, // Templar Assassin
  47:  { aggression: 0.80, scale: 0.50 }, // Viper
  48:  { aggression: 0.35, scale: 0.85 }, // Luna
  49:  { aggression: 0.70, scale: 0.65 }, // Dragon Knight
  50:  { aggression: 0.50, scale: 0.40 }, // Dazzle
  51:  { aggression: 0.80, scale: 0.50 }, // Clockwerk
  52:  { aggression: 0.80, scale: 0.60 }, // Leshrac
  53:  { aggression: 0.65, scale: 0.65 }, // Nature's Prophet
  54:  { aggression: 0.55, scale: 0.80 }, // Lifestealer
  55:  { aggression: 0.70, scale: 0.55 }, // Dark Seer
  56:  { aggression: 0.65, scale: 0.65 }, // Clinkz
  57:  { aggression: 0.50, scale: 0.45 }, // Omniknight
  58:  { aggression: 0.50, scale: 0.45 }, // Enchantress
  59:  { aggression: 0.90, scale: 0.60 }, // Huskar
  60:  { aggression: 0.85, scale: 0.60 }, // Night Stalker
  61:  { aggression: 0.80, scale: 0.65 }, // Broodmother
  62:  { aggression: 0.65, scale: 0.50 }, // Bounty Hunter
  63:  { aggression: 0.40, scale: 0.80 }, // Weaver
  64:  { aggression: 0.60, scale: 0.45 }, // Jakiro
  65:  { aggression: 0.85, scale: 0.55 }, // Batrider
  66:  { aggression: 0.65, scale: 0.40 }, // Chen
  67:  { aggression: 0.20, scale: 1.00 }, // Spectre
  68:  { aggression: 0.55, scale: 0.40 }, // Ancient Apparition
  69:  { aggression: 0.80, scale: 0.60 }, // Doom
  70:  { aggression: 0.80, scale: 0.70 }, // Ursa
  71:  { aggression: 0.85, scale: 0.50 }, // Spirit Breaker
  72:  { aggression: 0.45, scale: 0.85 }, // Gyrocopter
  73:  { aggression: 0.45, scale: 0.90 }, // Alchemist
  74:  { aggression: 0.55, scale: 0.85 }, // Invoker
  75:  { aggression: 0.70, scale: 0.60 }, // Silencer
  76:  { aggression: 0.60, scale: 0.70 }, // Outworld Destroyer
  77:  { aggression: 0.75, scale: 0.70 }, // Lycan
  78:  { aggression: 0.70, scale: 0.55 }, // Brewmaster
  79:  { aggression: 0.45, scale: 0.55 }, // Shadow Demon
  80:  { aggression: 0.40, scale: 0.85 }, // Lone Druid
  81:  { aggression: 0.60, scale: 0.80 }, // Chaos Knight
  82:  { aggression: 0.40, scale: 0.95 }, // Meepo
  83:  { aggression: 0.55, scale: 0.45 }, // Treant Protector
  84:  { aggression: 0.70, scale: 0.45 }, // Ogre Magi
  85:  { aggression: 0.80, scale: 0.45 }, // Undying
  86:  { aggression: 0.60, scale: 0.50 }, // Rubick
  87:  { aggression: 0.60, scale: 0.45 }, // Disruptor
  88:  { aggression: 0.75, scale: 0.45 }, // Nyx Assassin
  89:  { aggression: 0.35, scale: 0.90 }, // Naga Siren
  90:  { aggression: 0.55, scale: 0.40 }, // Keeper of the Light
  91:  { aggression: 0.35, scale: 0.60 }, // Io
  92:  { aggression: 0.70, scale: 0.60 }, // Visage
  93:  { aggression: 0.55, scale: 0.85 }, // Slark
  94:  { aggression: 0.15, scale: 1.00 }, // Medusa
  95:  { aggression: 0.55, scale: 0.80 }, // Troll Warlord
  96:  { aggression: 0.80, scale: 0.55 }, // Centaur Warrunner
  97:  { aggression: 0.70, scale: 0.60 }, // Magnus
  98:  { aggression: 0.85, scale: 0.60 }, // Timbersaw
  99:  { aggression: 0.75, scale: 0.55 }, // Bristleback
  100: { aggression: 0.85, scale: 0.45 }, // Tusk
  101: { aggression: 0.80, scale: 0.45 }, // Skywrath Mage
  102: { aggression: 0.50, scale: 0.55 }, // Abaddon
  103: { aggression: 0.70, scale: 0.50 }, // Elder Titan
  104: { aggression: 0.85, scale: 0.65 }, // Legion Commander
  105: { aggression: 0.45, scale: 0.50 }, // Techies
  106: { aggression: 0.85, scale: 0.70 }, // Ember Spirit
  107: { aggression: 0.85, scale: 0.50 }, // Earth Spirit
  108: { aggression: 0.65, scale: 0.55 }, // Underlord
  109: { aggression: 0.25, scale: 1.00 }, // Terrorblade
  110: { aggression: 0.70, scale: 0.50 }, // Phoenix
  111: { aggression: 0.55, scale: 0.40 }, // Oracle
  112: { aggression: 0.55, scale: 0.45 }, // Winter Wyvern
  113: { aggression: 0.30, scale: 0.90 }, // Arc Warden
  114: { aggression: 0.75, scale: 0.75 }, // Monkey King
  119: { aggression: 0.75, scale: 0.45 }, // Dark Willow
  120: { aggression: 0.80, scale: 0.60 }, // Pangolier
  121: { aggression: 0.65, scale: 0.45 }, // Grimstroke
  123: { aggression: 0.60, scale: 0.50 }, // Hoodwink
  126: { aggression: 0.85, scale: 0.70 }, // Void Spirit
  128: { aggression: 0.65, scale: 0.45 }, // Snapfire
  129: { aggression: 0.85, scale: 0.55 }, // Mars
  135: { aggression: 0.80, scale: 0.60 }, // Dawnbreaker
  136: { aggression: 0.85, scale: 0.55 }, // Marci
  137: { aggression: 0.90, scale: 0.55 }, // Primal Beast
  138: { aggression: 0.55, scale: 0.75 }, // Muerta
  145: { aggression: 0.60, scale: 0.45 }, // Ringmaster
  148: { aggression: 0.80, scale: 0.75 }, // Kez
};

const DEFAULT_SCORE: HeroDraftScore = { aggression: 0.5, scale: 0.5 };

export function getHeroDraftScore(heroId: number): HeroDraftScore {
  return SCORES[heroId] ?? DEFAULT_SCORE;
}

/**
 * Вычисляет средние aggression/scale для списка героев.
 * Если список пустой — возвращает нейтральные 0.5.
 */
export function teamDraftScores(picks: number[]): { aggression: number; scale: number } {
  if (picks.length === 0) return DEFAULT_SCORE;
  let totalAggr = 0;
  let totalScale = 0;
  for (const id of picks) {
    const s = getHeroDraftScore(id);
    totalAggr += s.aggression;
    totalScale += s.scale;
  }
  return {
    aggression: totalAggr / picks.length,
    scale: totalScale / picks.length,
  };
}
