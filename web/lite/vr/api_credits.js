// Атрибуция стоков (правила Pexels/Pixabay): кто автор клипа сцены + титры готового ролика.
import { stock_credit, stock_used_list } from './core.js';
import { Api } from './api_base.js';
const P = Api.prototype;
P.scene_credit = function (i) {
  const s = (this.reel_scenes || [])[parseInt(i)]; const p = s && s.pick;
  if (!p) return null;
  return stock_credit(p.url) || stock_credit(p.thumb) || null;
};
// титры: клипы сцен + всё, что скачано со стоков за последнюю сборку (в т.ч. нарезка)
P.get_reel_credits = function () {
  const out = [], seen = new Set();
  const add = (c) => { if (!c) return; const k = c.source + '|' + c.page; if (seen.has(k)) return; seen.add(k); out.push(c); };
  for (const s of (this.reel_scenes || [])) { const p = s && s.pick; if (p) add(stock_credit(p.url) || stock_credit(p.thumb)); }
  for (const c of stock_used_list()) add(c);
  return { credits: out.slice(0, 60) };
};
