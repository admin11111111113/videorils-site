// Sec-MS-GEC v2 (Microsoft сменил токен Edge-TTS ~20.10.2026; старый SHA256 -> 403).
// Дословный порт edge_tts 7.3.1 drm.generate_sec_ms_gec_v2 на BigInt (как целые Python).
const M = 0xFFFFFFFFn;
const H0 = [0x6A09E667n, 0xBB67AE85n, 0x3C6EF372n, 0xA54FF53An, 0x510E527Fn, 0x9B05688Cn, 0x1F83D9ABn, 0x5BE0CD19n];
const ST = [0xFD9FBEA2n, 0x91243CE7n, 0xBE499094n, 0xCD2E1E0An, 0x6C006F49n, 0x04BD35ABn, 0xFEB0A7E4n, 0x03EFFBD2n];
const SCH = [0xEB24BF9En, 0x1558691Fn, 0xA0C09EE2n, 0x0CFA32BAn, 0xA622EE8Cn, 0xD1DD9491n, 0xC0DD25A0n, 0xF9E70AB6n, 0xF0C31573n, 0x7058CE4En, 0x7188E606n, 0x00E5AB33n, 0xD258B060n, 0x72766564n];
const K = [0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2].map(BigInt);
const ADJ = 0xC9DC06A7n;
const KB = K.slice(0, 14).concat([ADJ], K.slice(15));
const S0ADJ = 0x059C0B80n, S1ADJ = 0x000B92C0n;
const CS = [[0xE82E91B1n, 0xB32700D0n], [0x44DE24C6n, 0x88DFF51Dn], [0x3BEB65BCn, 0x29514038n], [0xC89C5933n, 0xB328CBDFn], [0x8D1EC211n, 0xD405B4D5n], [0x314EF5D5n, 0x26E55F3Cn], [0xE92491B1n, 0x607801C6n],
  [0xF0A5B9D5n, 0x82B2C1FBn], [0x06064CF3n, 0xFA51A3DAn], [0xDA79FA60n, 0x207CC464n], [0xBED20560n, 0x3C3C74F3n], [0x89F9C9F8n, 0xD2D14B61n], [0x35FA38C6n, 0xBB04A2C1n], [0xCB49E3C6n, 0xC5626167n]];
const CSF = 0x82893933n, CSA0 = 0xF2F90B1An, CSA1 = 0x0B1A0000n;

const rol16 = (v) => { v &= M; return ((v << 16n) | (v >> 16n)) & M; };
const sig0 = (v) => ((v >> 7n) ^ (v << 25n) ^ (v >> 18n) ^ (v << 14n) ^ (v >> 3n)) & M;
const sig1 = (v) => ((v >> 17n) ^ (v << 15n) ^ (v >> 19n) ^ (v << 13n) ^ (v >> 10n)) & M;
const R = 0x100000001n;

function rounds(state, w, first = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const k = first === 14 ? KB : K;
  for (let i = first; i < 64; i++) {        // обычный порядок регистров (в Python развёрнуто по 8 — результат тот же)
    const re = e * R, ra = a * R;
    const t1 = h + ((re >> 6n) ^ (re >> 11n) ^ (re >> 25n)) + (g ^ (e & (f ^ g))) + k[i] + w[i];
    const t2 = ((ra >> 2n) ^ (ra >> 13n) ^ (ra >> 22n)) + ((a & b) | (c & (a | b)));
    h = g; g = f; f = e; e = (d + t1) & M; d = c; c = b; b = a; a = (t1 + t2) & M;
  }
  return [a, b, c, d, e, f, g, h];
}
function expand(w, first = 16) {
  for (let i = first; i < 64; i++) {
    const x = w[i - 2], y = w[i - 15];
    const s1 = (x >> 17n) ^ (x << 15n) ^ (x >> 19n) ^ (x << 13n) ^ (x >> 10n);
    const s0 = (y >> 7n) ^ (y << 25n) ^ (y >> 18n) ^ (y << 14n) ^ (y >> 3n);
    w.push((s1 + w[i - 7] + s0 + w[i - 16]) & M);
  }
}
const be = (bytes) => bytes.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
function shaInit(d7) {
  const w = new Array(14).fill(0n).concat([be(d7.slice(0, 3)), be(d7.slice(3, 7))]);
  for (let i = 16; i < 30; i++) {
    let v = SCH[i - 16];
    if (i - 2 >= 14) v += (i === 16) ? (sig1(w[i - 2]) ^ S1ADJ) : sig1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += (i === 29) ? (sig0(w[i - 15]) ^ S0ADJ) : sig0(w[i - 15]);
    w.push(v & M);
  }
  w.push((sig1(w[28]) + w[23] + sig0(w[15]) + w[14] + ADJ - K[14]) & M);
  expand(w, 31);
  const wk = rounds(ST, w, 14);
  return H0.map((x, i) => (x + wk[i]) & M);
}
function sha256(data) {
  const length = 57 + data.length;
  const pad = (55 - length) % 64; const padN = pad < 0 ? pad + 64 : pad;
  const p = [...data.slice(7), 0x80, ...new Array(padN).fill(0)];
  const L = BigInt(length * 8); for (let i = 7; i >= 0; i--) p.push(Number((L >> BigInt(i * 8)) & 0xFFn));
  let st = shaInit(data.slice(0, 7));
  for (let o = 0; o < p.length; o += 64) {
    const w = []; for (let j = 0; j < 16; j++) w.push(be(p.slice(o + j * 4, o + j * 4 + 4)));
    expand(w); const wk = rounds(st, w); st = st.map((x, i) => (x + wk[i]) & M);
  }
  const out = []; for (const x of st) for (let i = 3; i >= 0; i--) out.push(Number((x >> BigInt(i * 8)) & 0xFFn));
  return out;
}
const le32 = (b, o) => BigInt(b[o]) | (BigInt(b[o + 1]) << 8n) | (BigInt(b[o + 2]) << 16n) | (BigInt(b[o + 3]) << 24n);
function wordsLe4Even(data) {
  const p = data.concat(new Array((4 - data.length % 4) % 4).fill(0));
  if (!p.length) return [];
  const w = []; for (let i = 0; i < p.length; i += 4) w.push(le32(p, i));
  if (w.length % 2) w.push(0n);
  return w;
}
function cs64(data, digest) {
  let ka = le32(digest, 0) | 1n, kb = le32(digest, 4) | 1n;
  const fac = [(ka * CSF) & M, (kb * CSF) & M];
  const terms = CS.map(([c], i) => (c * fac[i % 2]) & M), offs = CS.map(([, o]) => o);
  wordsLe4Even([0].concat(data)).forEach((wd, i) => {
    let term = wd * (i % 2 === 0 ? ka : kb);
    let off = rol16(wd) * (i % 2 === 0 ? 0xEF0569FBn : 0xC31713DBn);
    if (i === 0) { term += CSA0 * fac[0]; off += CSA1; }
    terms.push(term & M); offs.push(off & M);
  });
  let sa = 0n, sl = 0n, st = 0n, acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offs[i] + x) & M); let q = (t * 0x76F50F34n) & M;
    sa += (rol16(q) * 0xC3EFEA97n + q) & M;
    t = rol16((offs[i + 1] + y) & M); q = (t * 0x1881CE3Cn) & M;
    sl = (rol16(q) * 0x35BD1EC9n + q) & M;
    sa = (sa + sl) & M;
    st = (st * ka + x) & M;
    st = (rol16(st) * 0xCF98B111n) & M; st = (rol16(st) * 0x87085B9Fn) & M; st = (rol16(st) * 0x12CEB96Dn) & M; st = (rol16(st) * 0x257E1D83n) & M;
    acc += st;
    t = (st * kb + y) & M; t = (rol16(t) * 0xA27416F5n) & M; t = (rol16(t) * 0xD38396FFn) & M;
    st = (rol16((rol16(t) * 0x7C932B89n) & M) * 0xBFA49F69n) & M;
    acc = (acc + st) & M;
  }
  return [sl ^ st, sa ^ acc];
}
const hx = (n, bytes) => { let s = ''; for (let i = 0; i < bytes; i++) s += Number((n >> BigInt(i * 8)) & 0xFFn).toString(16).padStart(2, '0'); return s; };   // little-endian
// ticks — уже готовая строка/число Windows file time (100 нс), округлённая до 5 минут
export function secMsGecV2FromTicks(ticksStr, trusted) {
  const data = [...new TextEncoder().encode(String(ticksStr) + trusted)];
  const dg = sha256(data);
  const [a, b] = cs64(data, dg);
  const cs = (hx(a, 4) + hx(b, 4)).toUpperCase();
  return `${cs}-${dg.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}
