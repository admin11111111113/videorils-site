// Edge-TTS (бесплатные голоса Microsoft Edge «Read aloud») — порт python-пакета
// edge_tts 7.2.8: тот же websocket, Sec-MS-GEC, speech.config и SSML. Из браузера
// работает напрямую (Origin не проверяется — проверено 2026-10-08).
const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const CHROMIUM_FULL_VERSION = '143.0.3650.75';
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`;
const WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const WIN_EPOCH = 11644473600;
let clockSkew = 0;

export class NoAudioReceived extends Error { constructor(m) { super(m || 'No audio was received.'); this.name = 'NoAudioReceived'; } }

async function secMsGec() {
  let ticks = Date.now() / 1000 + clockSkew + WIN_EPOCH;
  ticks -= ticks % 300;
  ticks *= 1e9 / 100;
  // f"{ticks:.0f}" — целое без экспоненты
  const s = BigInt(Math.round(ticks)).toString() + TRUSTED_CLIENT_TOKEN;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}
const hex = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, '');
function dateToString() {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${mon[d.getUTCMonth()]} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}
function removeIncompatible(s) { return [...s].map(ch => { const c = ch.codePointAt(0); return (c <= 8 || c === 11 || c === 12 || (c >= 14 && c <= 31)) ? ' ' : ch; }).join(''); }
function xmlEscape(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function voiceName(v) {
  const m = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(v);
  if (!m) return v;
  let [, lang, region, name] = m;
  if (name.includes('-')) { region = `${region}-${name.slice(0, name.indexOf('-'))}`; name = name.slice(name.indexOf('-') + 1); }
  return `Microsoft Server Speech Text to Speech Voice (${lang}-${region}, ${name})`;
}
function splitBytes(text, limit = 4096) {
  const enc = new TextEncoder(); const out = [];
  let t = text;
  while (enc.encode(t).length > limit) {
    let cut = t.length; while (cut > 0 && enc.encode(t.slice(0, cut)).length > limit) cut = Math.floor(cut * 0.9);
    const sp = Math.max(t.lastIndexOf(' ', cut), t.lastIndexOf('\n', cut)); if (sp > 0) cut = sp;
    const amp = t.lastIndexOf('&', cut); if (amp >= 0 && t.indexOf(';', amp) > cut) cut = amp;
    const c = t.slice(0, cut).trim(); if (c) out.push(c); t = t.slice(cut > 0 ? cut : 1);
  }
  if (t.trim()) out.push(t.trim());
  return out;
}

// -> {audio: Blob(audio/mpeg), words: [{offset, duration, text}]} (offset/duration в сек)
export async function edgeSynthesize(text, voice, { rate = '+0%', pitch = '+0Hz', volume = '+0%', boundary = 'SentenceBoundary', timeout = 60 } = {}) {
  const chunks = splitBytes(xmlEscape(removeIncompatible(text)), 4096);
  const audio = []; const words = []; let offsetBase = 0;
  for (const chunk of chunks) {
    const { bytes, meta, audioBytes } = await streamOnce(chunk, voice, { rate, pitch, volume, boundary, timeout });
    for (const m of meta) words.push({ offset: m.offset + offsetBase, duration: m.duration, text: m.text });
    audio.push(...bytes);
    offsetBase += audioBytes * 8 / 48000;          // CBR 48 кбит/с — как __compensate_offset
  }
  if (!audio.length) throw new NoAudioReceived();
  return { audio: new Blob(audio, { type: 'audio/mpeg' }), words };
}

async function streamOnce(chunk, voice, { rate, pitch, volume, boundary, timeout }) {
  const url = `${WSS_URL}&ConnectionId=${hex()}&Sec-MS-GEC=${await secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
  return await new Promise((resolve, reject) => {
    let ws; try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
    ws.binaryType = 'arraybuffer';
    const bytes = []; const meta = []; let audioBytes = 0; let got = false; let done = false;
    const timer = setTimeout(() => finish(new Error('Edge-TTS: таймаут')), timeout * 1000);
    function finish(err) {
      if (done) return; done = true; clearTimeout(timer);
      try { ws.close(); } catch (e) { }
      if (err) reject(err); else if (!got) reject(new NoAudioReceived()); else resolve({ bytes, meta, audioBytes });
    }
    ws.onopen = () => {
      const wd = boundary === 'WordBoundary' ? 'true' : 'false', sq = boundary === 'WordBoundary' ? 'false' : 'true';
      ws.send(`X-Timestamp:${dateToString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"${sq}","wordBoundaryEnabled":"${wd}"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
      const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voiceName(voice)}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${chunk}</prosody></voice></speak>`;
      ws.send(`X-RequestId:${hex()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateToString()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const i = ev.data.indexOf('\r\n\r\n'); const head = ev.data.slice(0, i); const body = ev.data.slice(i + 4);
        const path = (/Path:([^\r\n]+)/.exec(head) || [])[1];
        if (path === 'audio.metadata') {
          try {
            for (const m of (JSON.parse(body).Metadata || [])) {
              if (m.Type === 'WordBoundary' || m.Type === 'SentenceBoundary') meta.push({ offset: m.Data.Offset / 1e7, duration: m.Data.Duration / 1e7, text: (m.Data.text || {}).Text || '' });
            }
          } catch (e) { }
        } else if (path === 'turn.end') finish(null);
      } else {
        const dv = new DataView(ev.data); if (dv.byteLength < 2) return;
        const hl = dv.getUint16(0);
        const head = new TextDecoder().decode(new Uint8Array(ev.data, 2, hl));
        if (!/Path:audio/.test(head)) return;
        const data = new Uint8Array(ev.data, 2 + hl);
        if (!/Content-Type:audio\/mpeg/.test(head)) return;
        if (data.length) { got = true; bytes.push(data.slice()); audioBytes += data.length; }
      }
    };
    ws.onerror = () => finish(new Error('Edge-TTS: ошибка соединения'));
    ws.onclose = (e) => { if (!done) finish(got ? null : new NoAudioReceived(`No audio received (ws ${e.code})`)); };
  });
}
