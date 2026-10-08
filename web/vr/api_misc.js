// Порт Api: «Идеи дня», SFX, музыка, прослушка голоса, позиция/размер субтитров, язык,
// буфер обмена (app.py 8198–8800).
import { C, log, re, requests, webbrowser, vfs, pickFiles, path, VR_SERVER_URL, choice, now, TEMP_DIR } from './core.js';
import * as A from './audio.js';
import { Api } from './api_base.js';

const P = Api.prototype;
const MUSIC_DIR = 'assets/user/music';
const AUDIO_EXTS = C['Api.AUDIO_EXTS'];
const _DUR = new Map();
async function dur(p) { if (_DUR.has(p)) return _DUR.get(p); const d = await A.duration(p); _DUR.set(p, d); return d; }

// ================= ИДЕИ ДНЯ =================
P.get_trending_ideas = async function () {
  try {
    const url = VR_SERVER_URL.replace(/\/+$/, '') + '/trending-ideas?machine_id=' + await this.get_machine_id() + '&lang=ru';
    const r = await requests.get(url, { timeout: [10, 55] });
    if (r.status_code === 200) { const d = r.json(); return { ok: true, date: d.date, stale: !!d.stale, ideas: d.ideas || [] }; }
  } catch (e) { }
  return { ok: false, ideas: [] };
};
P.use_trending_idea = async function (idea) {
  if (!this._has_access()) return { ok: false, code: 'no_license', msg: this._t('lic_need') };
  idea = idea || {};
  const title = (idea.title || '').trim();
  const base = (idea.adapted_text || idea.adapted_title || title).trim();
  let text = base, unique = false;
  if ((this.claude_key || this.gemini_key) && title) {
    const prompt = `Трендовая тема из TikTok/Shorts: «${title}».\nБазовая идея: ${base}\nПридумай УНИКАЛЬНЫЙ короткий вариант ТЕМЫ для вертикального ролика (1–2 предложения, на русском): другой угол, другие акценты и примеры, но та же общая тема тренда. Ролик снимается БЕЗ лица в кадре — только стоковые видео и закадровый голос. Верни ТОЛЬКО текст темы, без пояснений и кавычек.`;
    try {
      const [ok, out] = await this._ai_call(prompt, null, 800);
      const cand = (out || '').trim().replace(/^["«»]+|["«»]+$/g, '').trim();
      const _cyr = [...cand].filter(c => { const l = c.toLowerCase(); return (l >= 'а' && l <= 'я') || l === 'ё'; }).length;
      if (ok && cand.length >= 15 && cand.includes(' ') && !cand.includes('\n') && _cyr >= 5 && !cand.trimEnd().endsWith('*') && !cand.includes('.*')) { text = cand; unique = true; }
    } catch (e) { }
  }
  this._server_post('/trending-used', { id: idea.id || '', title }).catch(() => { });
  return { ok: true, text, unique };
};

// ================= SFX (вшитые звуки: assets/sfx/index.json) =================
let _SFX = null;
async function sfxManifest() {
  if (_SFX) return _SFX;
  try { _SFX = await (await fetch(new URL('../assets/sfx/index.json', import.meta.url))).json(); } catch (e) { _SFX = {}; }
  return _SFX;
}
export async function sfxPreload() { await sfxManifest(); }
P._sfx_all = function () {
  const out = [], seen = new Set();
  for (const [cat, files] of Object.entries(_SFX || {})) {
    if (cat.startsWith('_')) continue;
    for (const f of files) { const key = path.splitext(f)[0].toLowerCase(); if (!seen.has(key)) { seen.add(key); out.push(`assets/sfx/${cat}/${f}`); } }
  }
  return out.sort();
};
P._sfx_by_category = function () { const cats = {}; for (const p of this._sfx_all()) { const parts = p.split('/'); if (parts.length < 4) continue; (cats[parts[2].toLowerCase()] = cats[parts[2].toLowerCase()] || []).push(p); } return cats; };
P._sfx_random_from_category = function (cat) { if (!cat) return null; const files = this._sfx_by_category()[cat.trim().toLowerCase()]; return files && files.length ? choice(files) : null; };
P._resolve_sfx = function (token) { if (!token) return null; let t = token.trim().toLowerCase(); if (t.startsWith('sfx:')) t = t.slice(4).trim(); return this._sfx_random_from_category(t) || this._sfx_path(token); };
P._sfx_names = function () { const seen = new Set(), names = []; for (const p of this._sfx_all()) { const b = path.splitext(path.basename(p))[0]; if (!seen.has(b.toLowerCase())) { seen.add(b.toLowerCase()); names.push(b); } } return names; };
P._sfx_path = function (name) {
  if (!name) return null; name = name.trim().toLowerCase().replace(/\\/g, '/');
  for (const p of this._sfx_all()) {
    const base = path.splitext(path.basename(p))[0].toLowerCase(), fn = path.basename(p).toLowerCase();
    const rel = p.slice('assets/sfx/'.length).toLowerCase(), relbase = path.splitext(rel)[0];
    if ([base, fn, rel, relbase].includes(name)) return p;
  }
  return null;
};
P.get_sfx_enabled = function () { return { enabled: this.sfx_enabled }; };
P.set_sfx_enabled = function (on) { this.sfx_enabled = !!on; this._persist(); return { enabled: this.sfx_enabled }; };
P.get_sfx_list = async function () {
  await sfxManifest();
  const cats = {}, loose = [];
  for (const p of this._sfx_all()) {
    const rel = p.slice('assets/sfx/'.length); const parts = rel.split('/');
    const item = { name: path.basename(p), base: path.splitext(path.basename(p))[0], url: 'assets/sfx/' + rel };
    if (parts.length > 1) (cats[parts[0]] = cats[parts[0]] || []).push(item); else loose.push(item);
  }
  return { categories: cats, loose, count: this._sfx_all().length };
};
P.open_sfx_folder = function () { return false; };
P.import_sfx_from_downloads = function () { return { ok: true, count: 0 }; };

// ================= МУЗЫКА =================
P.set_music_db = function (n) { const v = Math.round(parseFloat(n)); this.music_db = Number.isNaN(v) ? -22 : Math.max(-40, Math.min(-6, v)); this._persist_music(); return this.music_db; };
P.set_music_track = function (p) {
  if (p === '__random__') this.music_track = '__random__';
  else { const tracks = this._collect_tracks().map(t => t.toLowerCase()); this.music_track = (p && tracks.includes(String(p).toLowerCase())) ? p : ''; }
  this._persist_music(); return this.music_track;
};
async function importAudioFile(file, dstDir) {
  let fn = file.name; let base = path.splitext(fn)[0], ext = path.splitext(fn)[1].toLowerCase();
  let blob = file;
  if (C['Api.MEDIA_VID'].includes(ext)) { blob = await A.toWav(file, 44100, 2); ext = '.wav'; fn = base + ext; }  // видео -> звук
  let dst = `${dstDir}/${fn}`; let n = 2;
  while (vfs.exists(dst)) { dst = `${dstDir}/${base}_${n}${ext}`; n++; }
  vfs.write(dst, blob); await vfs.flush(dst);
  return dst;
}
P.add_music_folder = function () {
  // аналог «папки с музыкой»: выбираем несколько файлов сразу
  return pickFiles('audio/*,video/*', true).then(async (files) => {
    if (!files) return { ok: false, msg: this._t('folder_not_selected') };
    for (const f of files) if ([...AUDIO_EXTS, ...C['Api.MEDIA_VID']].some(e => f.name.toLowerCase().endsWith(e))) await importAudioFile(f, MUSIC_DIR);
    this._persist_music();
    return { ok: true, folders: this.music_folders };
  });
};
P.choose_music_file = function () {
  return pickFiles('audio/*,video/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.mp4,.webm,.mkv,.mov').then(async (files) => {
    if (!files) return { ok: false, msg: this._t('file_not_selected') };
    try {
      const final = await importAudioFile(files[0], MUSIC_DIR);
      this.music_track = final; this._persist_music();
      return { ok: true, name: path.basename(final), dur: Math.round((await dur(final)) * 10) / 10 };
    } catch (e) { return { ok: false, msg: String(e.message || e) }; }
  });
};
P.remove_music_folder = function (folder) { this.music_folders = this.music_folders.filter(f => f !== folder); this._persist_music(); return { ok: true, folders: this.music_folders }; };
P.get_music_settings = async function () {
  const tracks = this._collect_tracks(); const items = [];
  for (const p of tracks) items.push({ path: p, name: path.basename(p), folder: 'music', dur: Math.round((await dur(p)) * 10) / 10, removable: true });
  return { on: !!this.music_track, db: this.music_db, track: this.music_track, has: !!tracks.length, folders: this.music_folders, tracks: items };
};
P.delete_music_track = function (p) {
  if (!p) return { ok: false, msg: this._t('track_not_found') };
  vfs.remove(p); _DUR.delete(p);
  if (this.music_track && this.music_track.toLowerCase() === String(p).toLowerCase()) this.music_track = '';
  this._persist_music();
  return { ok: true, action: 'deleted' };
};
P.preview_mix = async function (p) {
  if (!(p && vfs.exists(p))) return { ok: false, msg: this._t('track_not_found') };
  try {
    const text = 'Привет! Это мой голос для канала. Выбирай меня.';
    const vo = 'temp/mix_voice.mp3';
    await this._synth_one(text, vo);
    const vbuf = await A.decode(vo); const vlen = vbuf.duration || 4.0; const fade = Math.max(0, vlen - 2.0);
    const mbuf = await A.decode(p);
    const sr = 44100; const oc = new OfflineAudioContext(2, Math.ceil(vlen * sr), sr);
    const v = oc.createBufferSource(); v.buffer = vbuf; v.connect(oc.destination); v.start();
    const m = oc.createBufferSource(); m.buffer = mbuf; m.loop = true;
    const g = oc.createGain(); g.gain.value = A.dbToGain(this.music_db);
    g.gain.setValueAtTime(A.dbToGain(this.music_db), fade); g.gain.linearRampToValueAtTime(0, fade + 2);
    m.connect(g); g.connect(oc.destination); m.start();
    vfs.write('temp/mix_preview.mp3', A.wav(await oc.startRendering())); await vfs.flush('temp/mix_preview.mp3');
    return { ok: true, url: 'temp/mix_preview.mp3' };
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
P.get_play_url = function (p) { if (!(p && vfs.exists(p))) return { ok: false }; return { ok: true, url: vfs.url(p) }; };
P.open_music_folder = function () { return false; };
P.open_music_sources = function () { webbrowser.open('https://pixabay.com/music/'); webbrowser.open('https://studio.youtube.com'); return true; };
P.import_music_from_downloads = function () { return this.add_music_folder().then(r => ({ ok: !!r.ok, count: r.ok ? 1 : 0 })); };
P.play_music_file = function () { return false; };
P.get_track_duration = async function (p) { return { ok: !!(p && vfs.exists(p)), dur: p ? Math.round((await dur(p)) * 10) / 10 : 0 }; };
async function cut(p, s, e) { const b = await A.decode(p); return A.wav(A.slice(b, s, e)); }
P.preview_track_segment = async function (p, start, end) {
  if (!(p && vfs.exists(p))) return { ok: false, msg: this._t('track_not_found') };
  try {
    const s = parseFloat(start), e = parseFloat(end);
    if (e <= s) return { ok: false, msg: this._t('end_after_start') };
    vfs.write('temp/segment_preview.mp3', await cut(p, s, e)); await vfs.flush('temp/segment_preview.mp3');
    return { ok: true, url: 'temp/segment_preview.mp3' };
  } catch (ex) { return { ok: false, msg: String(ex.message || ex) }; }
};
P.save_track_segment = async function (p, start, end) {
  if (!(p && vfs.exists(p))) return { ok: false, msg: this._t('track_not_found') };
  try {
    const s = parseFloat(start), e = parseFloat(end);
    if (e <= s) return { ok: false, msg: this._t('end_after_start') };
    const out_name = 'trimmed_' + path.splitext(path.basename(p))[0] + '.wav';
    const out = `${MUSIC_DIR}/${out_name}`;
    vfs.write(out, await cut(p, s, e)); await vfs.flush(out); _DUR.delete(out);
    this.music_track = out; this._persist_music();
    return { ok: true, name: out_name, dur: Math.round((await dur(out)) * 10) / 10 };
  } catch (ex) { return { ok: false, msg: String(ex.message || ex) }; }
};
P.play_voice_preview_external = function () { return false; };
P._pick_music = function () {
  const tracks = this._collect_tracks();
  if (!(this.music_track && tracks.length)) return null;
  if (this.music_track === '__random__') return choice(tracks);
  const low = {}; for (const t of tracks) low[t.toLowerCase()] = t;
  return low[this.music_track.toLowerCase()] || null;
};

// ================= ПРОСЛУШИВАНИЕ ГОЛОСА =================
P.preview_voice = async function () {
  if (this.busy) return { ok: false, msg: this._t('processing') };
  try {
    const out = 'temp/voice_preview.mp3';
    await this._synth_one('Привет! Это мой голос для канала. Выбирай меня.', out);
    await vfs.flush(out);
    const res = { ok: true, url: out };
    if (this.tts_engine === 'eleven' && this.licensed) res.credits = await this.get_eleven_credits();
    return res;
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
};
P.set_subtitle_xy = function (x, y) { const a = parseFloat(x), b = parseFloat(y); if (!Number.isNaN(a) && !Number.isNaN(b)) { this.sub_xpct = Math.max(0, Math.min(1, a)); this.sub_ypct = Math.max(0, Math.min(1, b)); this._persist(); } return { xpct: this.sub_xpct, ypct: this.sub_ypct }; };
P.set_subtitle_fontsize = function (pct) { const v = parseFloat(pct); if (!Number.isNaN(v)) { this.sub_fontpct = Math.max(0.025, Math.min(0.10, v)); this._persist(); } return { fontpct: this.sub_fontpct }; };
P.get_subtitle_pos = function () { return { xpct: this.sub_xpct, ypct: this.sub_ypct, fontpct: this.sub_fontpct }; };
P._sub_align_marginv = function (h, size = null) {
  const y = this.sub_ypct; const safe = Math.trunc(h * 0.05); const half = size ? Math.trunc(size * 1.25 / 2) : 0;
  if (y <= 0.5) return [8, Math.max(safe, Math.trunc(h * y) - half)];
  return [2, Math.max(safe, Math.trunc(h * (1.0 - y)) - half)];
};
P.set_no_subs = function (on) { this.no_subs = !!on; this._persist(); return { no_subs: this.no_subs }; };
P.set_video_lang = function (lang) {
  this.video_lang = lang === 'en' ? 'en' : 'ru'; this.video_lang_label = this.video_lang === 'en' ? 'ENGLISH' : 'РУССКИЙ';
  if (this.video_lang === 'en' && this.tts_engine === 'piper') this.tts_engine = 'edge';
  this._persist(); return { lang: this.video_lang, engine: this.tts_engine };
};
P.copy_text = async function (text) { try { await navigator.clipboard.writeText(text || ''); return true; } catch (e) { try { const t = document.createElement('textarea'); t.value = text || ''; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); return true; } catch (e2) { return false; } } };
P.read_clipboard = async function () { try { return await navigator.clipboard.readText(); } catch (e) { return ''; } };
