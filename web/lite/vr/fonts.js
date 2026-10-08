// Шрифты. Десктоп берёт системные Windows-шрифты (Arial Black, Segoe Script,
// Consolas) — их нельзя раздавать с сайта (лицензия Microsoft). Свободные (OFL)
// аналоги с кириллицей, близкие по метрике (замер: «ПРИВЕТ МИР» 582px vs 598px):
//   Arial Black  -> Montserrat Black
//   Segoe Script -> Marck Script
//   Consolas     -> JetBrains Mono Bold
//   Impact       -> Oswald Bold (обложка-хук Лайта)
export const FONT_MAP = {
  'Arial Black': { family: 'VR Arial Black', file: 'MontserratBlack.ttf', weight: '900' },
  'Segoe Script': { family: 'VR Segoe Script', file: 'MarckScript.ttf', weight: '400' },
  'Consolas': { family: 'VR Consolas', file: 'JetBrainsMonoBold.ttf', weight: '700' },
  'Impact': { family: 'VR Impact', files: [['OswaldBold-cyr.woff2', 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'], ['OswaldBold-lat.woff2', 'U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, U+20AC, U+2122, U+2212']], weight: '700' },
};
const BASE = new URL('../fonts/', import.meta.url).href;
let loaded = null;
export function loadFonts() {
  if (loaded) return loaded;
  loaded = Promise.all(Object.values(FONT_MAP).flatMap(f => (f.files || [[f.file, null]]).map(async ([file, range]) => {
    const ff = new FontFace(f.family, `url(${BASE}${file})`, Object.assign({ weight: 'normal', style: 'normal' }, range ? { unicodeRange: range } : {}));
    await ff.load();
    (self.document ? document.fonts : self.fonts).add(ff);
  }))).catch(e => { console.warn('fonts', e); });
  return loaded;
}
export function cssFont(name, size, { bold = false, italic = false } = {}) {
  const f = FONT_MAP[name] || FONT_MAP['Arial Black'];
  // Шрифты одноначертательные: «жирность» Arial Black уже в самом файле. Синтетический
  // bold/italic ASS (\b1/\i1) имитирует libass — рисуем italic синтетически (skew) в рендере.
  return `${size}px "${f.family}"`;
}
let _mctx = null;
export function measureText(text, fontName, size, bboxRight = false) {
  if (!_mctx) _mctx = new OffscreenCanvas(8, 8).getContext('2d');
  _mctx.font = cssFont(fontName, size);
  const m = _mctx.measureText(text);
  // PIL getbbox()[2] = правая граница чернил; measureText.actualBoundingBoxRight — то же
  return bboxRight && m.actualBoundingBoxRight ? Math.max(m.width * 0.9, m.actualBoundingBoxRight) : m.width;
}
