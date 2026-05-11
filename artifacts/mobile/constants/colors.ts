// Dota 2 epic dark theme — золото Reborn UI поверх тёмно-коричневого фона.
// Палитра калибрована по реальным цветам клиента Dota 2:
//   - background — тёмно-чёрно-кофейный (#0a0703)
//   - card       — чуть светлее (#15100a) с тёплой подсветкой
//   - gold       — главный акцент Reborn UI (#C8AA6E классический), мы используем
//                  чуть более насыщенный янтарный #E6B453 — он лучше читается
//                  на ретина-экранах
//   - goldHi/goldLo — для линейных золотых градиентов (рамки, кнопки)
//   - radiant/dire — фракционные цвета зелёный/багровый
const colors = {
  light: {
    // База
    text: "#F0E4CC",
    foreground: "#F0E4CC",
    background: "#0a0703",
    card: "#15100a",
    cardForeground: "#F0E4CC",

    // Акценты — золотая палитра
    primary: "#E6B453",          // основное золото
    primaryForeground: "#1a1208",
    tint: "#E6B453",
    accent: "#FFCD42",           // яркое золото-выделение
    accentForeground: "#1a1208",
    goldHi: "#FFD278",           // блик золота (верх градиента)
    goldLo: "#8a6420",           // тень золота (низ градиента)
    goldDeep: "#3d2a0e",         // тёмная подложка под золотом

    // Подложки
    secondary: "#1f1810",
    secondaryForeground: "#C9B690",
    muted: "#15110b",
    mutedForeground: "#B5A586",
    border: "#3a2c1a",           // тёмно-коричневый
    borderGold: "#6e5226",       // золотая рамка карточек
    input: "#1f1810",
    // mutedForeground поднят с #8a7a5e до #B5A586 — это даёт >=4.5:1 контраст
    // на тёмно-коричневых поверхностях card/background для мелкого 10-12px текста.

    // Семантические
    destructive: "#D44A3A",
    destructiveForeground: "#FFFFFF",
    positive: "#5DE8A0",
    positiveForeground: "#080604",
    warning: "#FFB347",
    warningForeground: "#080604",
    stale: "#FF8C42",
    staleForeground: "#080604",

    // Фракции
    radiant: "#5DE8A0",          // зелёный сторонник Radiant
    radiantDeep: "#1f4e35",
    dire: "#D44A3A",             // багровый Dire
    direDeep: "#5a1c14",

    // Графики
    chart1: "#E6B453",
    chart2: "#D44A3A",
    chart3: "#FFB347",
    chart4: "#5DE8A0",
    chart5: "#C47AFF",

    // Свечения для тенейглоу-эффектов
    glow: "#E6B453",
    glowDire: "#D44A3A",
    glowRadiant: "#5DE8A0",
  },
  radius: 4, // Dota UI использует жёсткие угловатые формы, не закруглённые
};

export default colors;
