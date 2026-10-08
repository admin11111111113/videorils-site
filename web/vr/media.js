// Порт app.py стр. 1278–2205 (подбор стоковых клипов) + media_providers.py — 1:1.
import { C, re, log, sleep, now, requests, sha1Hex, vfs, path, TEMP_DIR, sortedBy, maxBy, pystrip, isupper } from './core.js';

// ------------------------------------------------------------- Pixabay -------
export function _pick_hit(hits, used) {
  if (!hits || !hits.length) return null;
  const avail = used == null ? hits : hits.filter(h => !used.has(h.id));
  if (!avail.length) return null;
  const good = avail.filter(h => Number(h.duration || 0) >= 4.0);
  if (good.length) return good[0];
  return maxBy(avail, h => Number(h.duration || 0));
}
export function _hit_orientation_score(w, h) {
  w = parseInt(w || 0) || 0; h = parseInt(h || 0) || 0;
  if (!(w && h)) return 0.4;
  const ar = h / w;
  const orient = ar >= 1 ? Math.min(ar / (16 / 9), 1.0) : Math.max(0.15, ar);
  const res = Math.min(Math.min(w, h) / 1080.0, 1.0);
  return Math.round((0.6 * orient + 0.4 * res) * 1000) / 1000;
}
export function _best_variant(vids) {
  const vs = Object.values(vids || {}).filter(v => v && typeof v === 'object');
  return maxBy(vs, v => (v.width || 0) * (v.height || 0), {});
}
export function _q_tokens(text) {
  return new Set(re.split('[^a-z0-9]+', (text || '').toLowerCase()).filter(w => w.length >= 3 && !C._STOP_QUERY_WORDS.has(w)));
}
export function _rel_tokens(topic) { const s = _q_tokens(topic); for (const w of C._WEAK_REL) s.delete(w); return s; }
export function _hit_rel(h, toks) {
  if (!toks || !toks.size) return false;
  const tags = (h.tags || '').toLowerCase();
  if (!tags) return false;
  const tag_words = _q_tokens(tags);
  for (const t of toks) {
    if (t.includes(' ')) { if (tags.includes(t)) return true; }
    else if (tag_words.has(t)) return true;
  }
  return false;
}
export function _tag_relevance(tags, dom, qtok) {
  const low = (tags || '').toLowerCase(); const tt = _q_tokens(low);
  const dom_hit = (dom && low.includes(dom)) ? 1.0 : 0.0;
  const q_hit = (qtok && qtok.size && [...qtok].some(x => tt.has(x))) ? 1.0 : 0.0;
  return [dom_hit, q_hit];
}
export function _is_weak_pick(tags, domain = '', query = '') {
  const qtok = _q_tokens(query);
  if (!qtok.size) return false;
  const [d, q] = _tag_relevance(tags, (domain || '').toLowerCase().trim(), qtok);
  return d === 0.0 && q === 0.0;
}
export function _rank_video_hits(hits, domain = '', want_dur = 0.0, query = '') {
  const dom = (domain || '').toLowerCase().trim(); const qtok = _q_tokens(query);
  const score = (h) => {
    const best = _best_variant(h.videos);
    const orient = _hit_orientation_score(best.width, best.height);
    const d = Number(h.duration || 0);
    const dur_ok = (want_dur <= 0 || d >= want_dur) ? 1.0 : Math.max(0.0, d / want_dur);
    const [dom_hit, q_hit] = _tag_relevance(h.tags || '', dom, qtok);
    return 0.4 * orient + 0.25 * dur_ok + 0.15 * dom_hit + 0.20 * q_hit;
  };
  return sortedBy(hits || [], score, true);
}
export function _rank_photo_hits(hits, domain = '', query = '') {
  const dom = (domain || '').toLowerCase().trim(); const qtok = _q_tokens(query);
  const score = (h) => {
    const orient = _hit_orientation_score(h.imageWidth, h.imageHeight);
    const [dom_hit, q_hit] = _tag_relevance(h.tags || '', dom, qtok);
    return 0.6 * orient + 0.15 * dom_hit + 0.25 * q_hit;
  };
  return sortedBy(hits || [], score, true);
}
export function _merge_query(detail, topic) {
  const tw = (topic || '').trim().split(/\s+/).filter(Boolean);
  const dw = (detail || '').trim().split(/\s+/).filter(Boolean);
  const out = [], seen = new Set();
  for (const w of [...tw.slice(0, 2), ...dw]) { const wl = w.toLowerCase(); if (!seen.has(wl)) { seen.add(wl); out.push(w); } }
  return out.slice(0, 4).join(' ');
}
export function _domain_fallbacks(topic, query = '') {
  const dom = _topic_domain(topic) || _topic_domain(query);
  return [...(C._DOMAIN_FALLBACKS[dom] || [])];
}
export function _topic_domain(topic) {
  const t = (topic || '').toLowerCase();
  for (const [trig, anchor] of Object.entries(C._PLACE_ANCHORS)) if (t.includes(trig)) return anchor;
  const toks = new Set(re.split('[^a-z0-9]+', t));
  for (const [keys, dom] of C._DOMAIN_ANCHORS) if (keys.some(k => toks.has(k) || (k.includes(' ') && t.includes(k)))) return dom;
  return '';
}
export function _stock_keywords(q, maxw = 5) {
  q = (q || '').trim();
  if (!q) return q;
  const words = re.findall('[A-Za-z][A-Za-z\\-]*', q);
  if (words.length <= maxw && !q.includes('?')) return pystrip(pystrip(q, ' .?!,;:')) || q;
  let core = words.filter(w => !C._Q_STOP.has(w.toLowerCase()) && !isupper(w.slice(0, 1)));
  if (!core.length) { core = words.filter(w => !C._Q_STOP.has(w.toLowerCase())); if (!core.length) core = words; }
  return core.slice(0, maxw).join(' ');
}
export function _normalize_slang(text) {
  if (!text) return text;
  let out = text;
  for (const [k, v] of Object.entries(C._SLANG_MAP)) out = re.sub('(?i)\\b' + re.escape(k) + '\\b', () => v, out);
  return out;
}
export function _query_variants(query, topic = '') {
  const q = _stock_keywords(_normalize_slang((query || '').trim()));
  const t = _normalize_slang((topic || '').trim());
  const dom = _topic_domain(t) || _topic_domain(q);
  const place = Object.values(C._PLACE_ANCHORS).includes(dom) ? dom : '';
  const words = q.split(/\s+/).filter(Boolean);
  const out = [];
  if (t) {
    const merged = _merge_query(q, t);
    if (place && !(merged || '').toLowerCase().includes(place.toLowerCase())) out.push(q ? `${place} ${q}`.trim() : place);
    if (merged) out.push(merged);
    if (dom && q && !q.toLowerCase().includes(dom.toLowerCase())) out.push(`${dom} ${q}`.trim());
    out.push(t);
    if (q) { out.push(q); if (words.length > 2) out.push(words.slice(0, 2).join(' ')); }
    if (dom) out.push(dom);
  } else {
    if (q) { out.push(q); if (words.length > 2) out.push(words.slice(0, 2).join(' ')); if (words.length >= 2) out.push(words[0]); }
    if (dom) out.push(dom);
  }
  out.push('cinematic dark background');
  const seen = new Set(); let res = [];
  for (const v of out) { const vl = (v || '').toLowerCase().trim(); if (v && !seen.has(vl)) { seen.add(vl); res.push(v); } }
  const latin = res.filter(v => !/[А-Яа-яЁё]/.test(v));
  if (latin.some(v => v.toLowerCase().trim() !== 'cinematic dark background')) res = latin;
  return res;
}

// ---- троттлинг/кэш Pixabay (глобальное состояние модуля, как в Python) ----
export const PIX = { LAST: 0, COUNT: 0, DL: 0, LIMITED: {}, LIMIT_HIT: false, QCACHE: new Map() };
const _PIX_QCACHE_TTL = C._PIX_QCACHE_TTL, _PIX_LIMIT_COOLDOWN = C._PIX_LIMIT_COOLDOWN, _PIX_MIN_INTERVAL = C._PIX_MIN_INTERVAL;
export async function _pix_key_hash(key) { return (await sha1Hex((key || '').trim())).slice(0, 8); }
function _pix_cache_get(ck) {
  const ent = PIX.QCACHE.get(ck);
  if (ent && ent[0] > now()) return ent[1];
  if (ent) PIX.QCACHE.delete(ck);
  return null;
}
export function _pix_reset_counters() { PIX.COUNT = 0; PIX.DL = 0; PIX.LIMIT_HIT = false; PIX.LIMITED = {}; }
let _pixChain = Promise.resolve();
export function _pix_throttle() {       // глобальная очередь (вместо Lock)
  const p = _pixChain.then(async () => {
    const wait = _PIX_MIN_INTERVAL - (now() - PIX.LAST);
    if (wait > 0) await sleep(wait);
    PIX.LAST = now(); PIX.COUNT += 1;
  });
  _pixChain = p.catch(() => { });
  return p;
}
export async function _pixabay_query(api_url, key, q, pp, photo, timeout = 15, order = 'popular') {
  const kh = await _pix_key_hash(key);
  const ck = JSON.stringify([api_url, q, pp, photo, order, kh]);
  const cached = _pix_cache_get(ck);
  if (cached !== null) { log(`  🗄 Media «${q}»: из кэша 24ч (${cached.length} рез., без запроса)`); return [[...cached], false]; }
  const _ex = PIX.LIMITED[kh];
  if (_ex !== undefined) { if (now() < _ex) return [null, true]; delete PIX.LIMITED[kh]; }
  const kind = photo ? 'photo' : 'video';
  const params = { key, q, per_page: pp, order };
  if (photo) params.image_type = 'photo';
  else { params.video_type = 'film'; params.min_width = 720; params.min_height = 720; }
  for (let attempt = 0; attempt < 3; attempt++) {
    await _pix_throttle();
    const t0 = now(); let r;
    try { r = await requests.get(api_url, { params, timeout }); }
    catch (e) { log(`  🖼 Media ${kind} «${q}»: сеть/таймаут — ${String(e.message || e).slice(0, 60)} (${(now() - t0).toFixed(1)}s)`); throw e; }
    const dt = now() - t0;
    if (r.status_code === 429) {
      const ra = r.headers.get('Retry-After');
      let back = parseInt(ra); if (!ra || Number.isNaN(back)) back = 2 ** (attempt + 1);
      back = Math.min(back, 20);
      if (attempt < 2) { log(`  🖼 Media ${kind} «${q}»: HTTP 429 — backoff ${back}s (Retry-After=${ra})`); await sleep(back); continue; }
      let reset = parseInt(r.headers.get('X-RateLimit-Reset') || 0) || 0;
      const cd = reset ? Math.min(Math.max(reset, 30), 120) : _PIX_LIMIT_COOLDOWN;
      log(`  🖼 Media ${kind} «${q}»: HTTP 429 (сервер, минутный лимит ключа) — пауза ${cd}s (Reset=${r.headers.get('X-RateLimit-Reset')})`);
      PIX.LIMITED[kh] = now() + cd; PIX.LIMIT_HIT = true;
      return [null, true];
    }
    if (r.status_code === 401 || r.status_code === 403) { log(`  🖼 Media ${kind} «${q}»: HTTP ${r.status_code} (ключ неверный/нет прав) ${dt.toFixed(1)}s`); return [[], false]; }
    if (r.status_code !== 200) { log(`  🖼 Media ${kind} «${q}»: HTTP ${r.status_code} ${dt.toFixed(1)}s`); return [[], false]; }
    const hits = (r.json() || {}).hits || [];
    PIX.QCACHE.set(ck, [now() + _PIX_QCACHE_TTL, hits]);
    log(`  🖼 Media ${kind} «${q}»: HTTP 200, ${hits.length} рез. ${dt.toFixed(1)}s [#${PIX.COUNT}]`);
    return [hits, false];
  }
  return [null, true];
}

// ---- Wikimedia Commons ----
let _WM_LAST = 0;
export function _query_content_tokens(q) {
  return new Set(re.findall('[a-z]{3,}', (q || '').toLowerCase()).filter(w => !C._WM_QSTOP.has(w)));
}
export async function _wikimedia_search(query, limit = 20, min_side = 600) {
  const q = (query || '').trim();
  if (!q) return [];
  const wait = 1.0 - (now() - _WM_LAST); if (wait > 0) await sleep(wait); _WM_LAST = now();
  // origin=* — обязательный параметр CORS для Action API из браузера
  const params = { action: 'query', generator: 'search', gsrsearch: q, gsrnamespace: 6, gsrlimit: Math.min(50, Math.max(1, limit)),
    prop: 'imageinfo', iiprop: 'url|extmetadata|size|mime', iiurlwidth: 1600, format: 'json', origin: '*' };
  let pages;
  try {
    const r = await requests.get('https://commons.wikimedia.org/w/api.php', { params, timeout: 20 });
    if (r.status_code >= 400) throw new Error('HTTP ' + r.status_code);
    pages = ((r.json() || {}).query || {}).pages || {};
  } catch (e) { log(`     ⚠ Wikimedia: ${String(e.message || e).slice(0, 60)}`); return []; }
  const out = [];
  for (const p of sortedBy(Object.values(pages), x => x.index ?? 999)) {
    const ii = (p.imageinfo || [])[0] || {};
    const ext = ii.extmetadata || {};
    const code = (ext.License || {}).value || '', short = (ext.LicenseShortName || {}).value || '';
    if (!(re.match(C._WM_LIC_OK, code || '') || re.match(C._WM_LIC_OK, short || ''))) continue;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(ii.mime || '')) continue;
    const w = ii.width || 0, h = ii.height || 0;
    if (w && h && Math.min(w, h) < min_side) continue;
    const dl = ii.thumburl || ii.url;
    if (!dl) continue;
    out.push({ id: p.pageid, is_video: false, url: dl, thumb: ii.thumburl || dl, source: 'wikimedia', license: short || code, tags: (p.title || '').replace('File:', '') });
  }
  return out;
}

// ---- download_media (умный каскад) ----
export async function download_media(query, tag, key, used = null, topic = '', degrade = () => { }) {
  if (!key) return [null, null, 'none'];
  const pp = used !== null ? 20 : 12;
  const variants = _query_variants(query, topic);
  const curated = _domain_fallbacks(topic, query);
  const dom = _topic_domain(topic) || _topic_domain(query);
  const rel = _rel_tokens(topic);
  const dom_rel = C._DOMAIN_REL[dom] || new Set();
  const full = variants.length ? variants[0] : query;
  let dup_video = null, dup_image = null, loose_video = null, loose_image = null;
  const _vurl = (h) => { const v = h.videos; return (v.medium || v.small || v.large || v.tiny).url; };
  const _relevant = (h) => !rel.size || _hit_rel(h, rel);
  const vdst = path.join(TEMP_DIR, `src_${tag}.mp4`), idst = path.join(TEMP_DIR, `src_${tag}.jpg`);
  for (const v of variants) {
    let hits, limited;
    try { [hits, limited] = await _pixabay_query('https://pixabay.com/api/videos/', key, v, pp, false); if (limited) return [null, null, 'limit']; }
    catch (e) { log(`     ⚠ видео «${v}»: ${e.message || e}`); continue; }
    if (!hits || !hits.length) { log(`     · видео «${v}»: 0 — упрощаю запрос`); continue; }
    const ranked = _rank_video_hits(hits, dom, 0.0, v);
    const h = _pick_hit(ranked.filter(_relevant), used);
    if (h) {
      if (used !== null) used.add(h.id);
      await _download(_vurl(h), vdst);
      log(`     🎬 видео: ${hits.length} рез.${v === full ? '' : ` (упрощён до «${v}»)`} → беру id ${h.id}`);
      return [vdst, true, 'ok'];
    }
    if (loose_video === null) { const lh = _pick_hit(ranked, used); if (lh) loose_video = [lh, v]; }
    if (dup_video === null) dup_video = hits[0];
  }
  for (const v of curated) {
    let hits, limited;
    try { [hits, limited] = await _pixabay_query('https://pixabay.com/api/videos/', key, v, pp, false); if (limited) return [null, null, 'limit']; }
    catch (e) { continue; }
    if (!hits || !hits.length) continue;
    const ranked = _rank_video_hits(hits, dom, 0.0, v);
    const cand = dom_rel.size ? ranked.filter(x => _hit_rel(x, dom_rel)) : ranked;
    const h = _pick_hit(cand, used);
    if (h) {
      if (used !== null) used.add(h.id);
      await _download(_vurl(h), vdst);
      log(`     🎬 видео (домен-фолбэк «${v}»): ${hits.length} рез. → id ${h.id}`);
      return [vdst, true, 'ok'];
    }
  }
  for (const [_pool, _filt] of [[variants, true], [curated, false]]) {
    for (const v of _pool) {
      let hits, limited;
      try { [hits, limited] = await _pixabay_query('https://pixabay.com/api/', key, v, pp, true); if (limited) return [null, null, 'limit']; }
      catch (e) { log(`     ⚠ фото «${v}»: ${e.message || e}`); continue; }
      if (!hits || !hits.length) continue;
      const ranked = _rank_photo_hits(hits, dom, v);
      const cand = _filt ? ranked.filter(_relevant) : (dom_rel.size ? ranked.filter(x => _hit_rel(x, dom_rel)) : ranked);
      const h = _pick_hit(cand, used);
      if (h) {
        if (used !== null) used.add(h.id);
        await _download(h.largeImageURL || h.webformatURL, idst);
        log(`     🖼 картинка${_filt ? '' : ' (домен-фолбэк)'}: ${hits.length} рез. → беру id ${h.id}`);
        return [idst, false, 'ok'];
      }
      if (_filt && loose_image === null) { const lh = _pick_hit(ranked, used); if (lh) loose_image = [lh, v]; }
      if (dup_image === null) dup_image = hits[0];
    }
  }
  if (loose_video !== null) {
    const [h, v] = loose_video; if (used !== null) used.add(h.id);
    await _download(_vurl(h), vdst);
    log(`     🎬 видео (по слову сцены «${v}», не строго в теме) → id ${h.id}`);
    degrade(`Клип сцены подобран не строго по теме (по слову «${v}») — проверь кадр в раскадровке`);
    return [vdst, true, 'ok'];
  }
  if (loose_image !== null) {
    const [h, v] = loose_image; if (used !== null) used.add(h.id);
    await _download(h.largeImageURL || h.webformatURL, idst);
    log(`     🖼 картинка (по слову сцены «${v}») → id ${h.id}`);
    degrade(`Картинка сцены подобрана не строго по теме (по слову «${v}») — проверь кадр в раскадровке`);
    return [idst, false, 'ok'];
  }
  if (dup_video !== null) {
    if (used !== null) used.add(dup_video.id);
    await _download(_vurl(dup_video), vdst);
    log(`     🎬 видео: уникального нет → похожий id ${dup_video.id}`);
    degrade('Уникального клипа по теме не нашлось — взят похожий (возможен повтор кадра)');
    return [vdst, true, 'ok'];
  }
  if (dup_image !== null) {
    if (used !== null) used.add(dup_image.id);
    await _download(dup_image.largeImageURL || dup_image.webformatURL, idst);
    log(`     🖼 картинка: уникального нет → похожая id ${dup_image.id}`);
    degrade('Уникальной картинки по теме не нашлось — взята похожая (возможен повтор кадра)');
    return [idst, false, 'ok'];
  }
  log('     ⚠ по теме ничего не нашлось — будет нейтральный фон');
  return [null, null, 'empty'];
}

// Скачивание с жёстким потолком по времени (wall-clock ×3 от timeout), 0 байт -> ошибка.
export async function _download(url, dst, timeout = 15) {
  PIX.DL += 1;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(timeout, 5) * 3 * 1000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} Client Error for url: ${url}`);
    const b = await r.blob();
    if (!b.size) throw new Error('пустой файл (0 байт)');
    vfs.write(dst, b);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('таймаут скачивания (wall-clock)');
    throw e;
  } finally { clearTimeout(timer); }
}

// =========================== media_providers.py ===========================
const PEXELS_VIDEO_URL = 'https://api.pexels.com/videos/search';
const GOOD_ENOUGH = 0.5, PEXELS_LOW_REMAINING = 20, SWITCH_MARGIN = 0.05;
export function _norm_pexels_video(v) {
  const files = v.video_files || []; let best = null;
  for (const f of files) {
    if ((f.file_type || '').toLowerCase() !== 'video/mp4') continue;
    const w = f.width || 0;
    if (w && w <= 1280) if (best === null || w > (best.width || 0)) best = f;
  }
  if (best === null) best = files.find(f => f.link) || null;
  if (!best || !best.link) return null;
  return { id: `px_${v.id}`, is_video: true, url: best.link, thumb: v.image || '', source: 'pexels', w: best.width || v.width || 0, h: best.height || v.height || 0 };
}
export function score_clips(clips) {
  clips = clips || [];
  if (!clips.length) return { score: 0.0, res: 0, vert_frac: 0.0, n: 0 };
  let best_res = 0, vert = 0;
  for (const c of clips) { const w = parseInt(c.w || 0) || 0, h = parseInt(c.h || 0) || 0; if (w && h) { best_res = Math.max(best_res, Math.min(w, h)); if (h >= w) vert++; } }
  const n = clips.length;
  const hit_score = Math.min(n, 10) / 10.0, res_score = best_res ? Math.min(best_res / 1080.0, 1.0) : 0.35, vert_frac = vert / n;
  const score = 0.35 * hit_score + 0.35 * res_score + 0.30 * vert_frac;
  return { score: Math.round(score * 1000) / 1000, res: best_res, vert_frac: Math.round(vert_frac * 100) / 100, n };
}
export class MediaProviderChain {
  constructor(pexels_key = '', pixabay_search = null, logger = null, timeout = 15) {
    this.pexels_key = (pexels_key || '').trim(); this.pixabay_search = pixabay_search; this.timeout = timeout;
    this.log = logger || (() => { }); this.pexels_remaining = null; this.pexels_limit = null; this.pexels_limited = false;
  }
  async fetch_video(query, per_page = 20) {
    let clips = [], limited = false;
    if (this.pixabay_search !== null) {
      try { [clips, limited] = await this.pixabay_search(query, per_page); clips = clips || []; }
      catch (e) { this.log(`  ⚠ Pixabay-поиск «${query}»: ${String(e.message || e).slice(0, 60)}`); }
    }
    if (clips.length) return { source: 'pixabay', clips, limited: false };
    if (this.pexels_key) {
      this.log(`  🔁 Pixabay ${limited ? '429' : 'пусто'} → Pexels «${query}»`);
      const pex = await this.pexels_videos(query, per_page);
      if (pex.length) return { source: 'pexels', clips: pex, limited };
    }
    return { source: 'pixabay', clips, limited };
  }
  pexels_low() { return this.pexels_remaining !== null && this.pexels_remaining < PEXELS_LOW_REMAINING; }
  async choose_video(query, pixabay_clips, pixabay_limited = false, per_page = 20) {
    pixabay_clips = pixabay_clips || [];
    const pj = score_clips(pixabay_clips);
    this.log(`  📊 Pixabay «${query}»: n=${pj.n} score=${pj.score} (res=${pj.res}, vert=${pj.vert_frac})` + (pixabay_limited ? ' [429]' : ''));
    const pick = (source, clips, reason, pex_score = null) => {
      this.log(`  🏁 выбран ${source.toUpperCase()} «${query}» — ${reason} (pix=${pj.score}` + (pex_score !== null ? `, pex=${pex_score}` : '') + ')');
      return { source, clips, reason, pixabay: pj.score, pexels: pex_score };
    };
    if (pixabay_clips.length && pj.score >= GOOD_ENOUGH && !pixabay_limited) return pick('pixabay', pixabay_clips, 'pixabay_good_enough');
    if (!this.pexels_key) return pick('pixabay', pixabay_clips, 'no_pexels_key');
    if (this.pexels_low() && pixabay_clips.length && !pixabay_limited) return pick('pixabay', pixabay_clips, 'pexels_limit_low');
    const pex = await this.pexels_videos(query, per_page);
    const ej = score_clips(pex);
    this.log(`  📊 Pexels «${query}»: n=${ej.n} score=${ej.score} (res=${ej.res}, vert=${ej.vert_frac})` + (this.pexels_remaining !== null ? ` [осталось ${this.pexels_remaining}]` : ''));
    if (pixabay_limited || !pixabay_clips.length) {
      if (pex.length) return pick('pexels', pex, 'pixabay_limited_or_empty', ej.score);
      return pick('pixabay', pixabay_clips, 'both_empty', ej.score);
    }
    if (pex.length && ej.score > pj.score + SWITCH_MARGIN) return pick('pexels', pex, 'pexels_better_quality', ej.score);
    return pick('pixabay', pixabay_clips, 'pixabay_better_or_tie', ej.score);
  }
  async pexels_videos(query, per_page = 20) {
    if (!this.pexels_key) return [];
    this.pexels_limited = false;
    let r;
    try {
      r = await requests.get(PEXELS_VIDEO_URL, { params: { query, per_page: Math.max(1, Math.min(per_page, 80)), orientation: 'portrait', size: 'medium' }, headers: { Authorization: this.pexels_key }, timeout: this.timeout });
    } catch (e) { this.log(`  ⚠ Pexels «${query}»: сеть/таймаут — ${String(e.message || e).slice(0, 60)}`); return []; }
    const rem = r.headers.get('X-Ratelimit-Remaining'), lim = r.headers.get('X-Ratelimit-Limit');
    if (rem !== null && !Number.isNaN(parseInt(rem))) this.pexels_remaining = parseInt(rem);
    if (lim !== null && !Number.isNaN(parseInt(lim))) this.pexels_limit = parseInt(lim);
    if (r.status_code === 429) { this.pexels_remaining = 0; this.pexels_limited = true; this.log(`  ⚠ Pexels «${query}»: HTTP 429 (лимит Pexels)`); return []; }
    if (r.status_code === 401 || r.status_code === 403) { this.pexels_limited = true; this.log(`  ⚠ Pexels «${query}»: HTTP ${r.status_code} (ключ неверный)`); return []; }
    if (r.status_code !== 200) { this.log(`  ⚠ Pexels «${query}»: HTTP ${r.status_code}`); return []; }
    const out = [];
    for (const v of ((r.json() || {}).videos || [])) { const n = _norm_pexels_video(v); if (n) out.push(n); }
    return out;
  }
}
