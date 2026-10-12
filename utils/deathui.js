'use strict';
// ═══════════════════════════════════════════════════════════════
//  DEATH UI  ·  SHADOW CORE v4
//  Zero-dependency terminal engine: boot sequence, live dashboard,
//  console capture, themes, integrated command bar.
//  Put this file in:  utils/deathui.js
// ═══════════════════════════════════════════════════════════════

const os = require('os');
const fs = require('fs');
const path = require('path');
const util = require('util');
const readline = require('readline');
const { Writable } = require('stream');

const REAL = {
    log: console.log, info: console.info, warn: console.warn,
    error: console.error, debug: console.debug
};
const STDOUT = process.stdout;
const write = (s) => { try { STDOUT.write(s); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

const COLOR = (!!STDOUT.isTTY || !!process.env.DEATH_FORCE_COLOR) && !process.env.NO_COLOR;

// ───────────────────────── themes ─────────────────────────
const BASE = {
    text: '#d7d7e0', dim: '#5d5f73', ok: '#2ee66b', warn: '#ffb52e', err: '#ff4d4d',
    info: '#7aa2ff', rx: '#35d0ff', sys: '#b76bff', sig: '#ff8c42'
};
const THEMES = {
    shadow: { logoA: '#ff2d2d', logoB: '#7a0014', border: '#5b2bd6', accent: '#00ffcc', title: '#ff3b5c' },
    blood:  { logoA: '#ff3030', logoB: '#5a0000', border: '#8a1020', accent: '#ff7a45', title: '#ff2d2d' },
    matrix: { logoA: '#5dff8a', logoB: '#00551b', border: '#0b7a3a', accent: '#b6ffcb', title: '#2ee66b' },
    ice:    { logoA: '#8ff7ff', logoB: '#1b46c8', border: '#2a5bd6', accent: '#7df3ff', title: '#8fb4ff' },
    gold:   { logoA: '#ffd34d', logoB: '#8a3f00', border: '#8a6a1a', accent: '#ffe27a', title: '#ffb52e' }
};
let T = Object.assign({}, BASE, THEMES.shadow);

// ───────────────────────── colour helpers ─────────────────────────
const _fg = new Map(), _bg = new Map();
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function fg(h) {
    let f = _fg.get(h);
    if (!f) {
        const [r, g, b] = hexRgb(h); const o = `\x1b[38;2;${r};${g};${b}m`;
        f = COLOR ? (s) => o + s + '\x1b[39m' : (s) => s; _fg.set(h, f);
    }
    return f;
}
function bg(h) {
    let f = _bg.get(h);
    if (!f) {
        const [r, g, b] = hexRgb(h); const o = `\x1b[48;2;${r};${g};${b}m`;
        f = COLOR ? (s) => o + s + '\x1b[49m' : (s) => s; _bg.set(h, f);
    }
    return f;
}
const bold = (s) => (COLOR ? '\x1b[1m' + s + '\x1b[22m' : s);
const inv = (s) => (COLOR ? '\x1b[7m' + s + '\x1b[27m' : s);
function mix(a, b, t) {
    const A = hexRgb(a), B = hexRgb(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// ───────────────────────── width-safe text helpers ─────────────────────────
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function cw(cp) {
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
    if (cp < 0x300) return 1;
    if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x483 && cp <= 0x489) || (cp >= 0x591 && cp <= 0x5bd) ||
        (cp >= 0x610 && cp <= 0x61a) || (cp >= 0x64b && cp <= 0x65f) || cp === 0x670 ||
        (cp >= 0x6d6 && cp <= 0x6dc) || (cp >= 0x6df && cp <= 0x6e4) || (cp >= 0x200b && cp <= 0x200f) ||
        (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2064) || (cp >= 0xfe00 && cp <= 0xfe0f) ||
        cp === 0xfeff) return 0;
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
    return 1;
}
function vlen(s) {
    let n = 0;
    for (const ch of s.replace(ANSI_RE, '')) n += cw(ch.codePointAt(0));
    return n;
}
// ANSI-aware truncate (keeps escape codes, cuts visible width)
function trunc(s, max) {
    let out = '', n = 0, i = 0, had = false;
    const re = /\x1b\[[0-9;?]*[A-Za-z]/y;
    while (i < s.length) {
        if (s[i] === '\x1b') {
            re.lastIndex = i; const m = re.exec(s);
            if (m) { out += m[0]; i += m[0].length; had = true; continue; }
        }
        const cp = s.codePointAt(i), ch = String.fromCodePoint(cp), w = cw(cp);
        if (n + w > max) break;
        out += ch; n += w; i += ch.length;
    }
    return had && COLOR ? out + '\x1b[0m' : out;
}
// plain-text cut with ellipsis
function cut(s, max) {
    if (max <= 0) return '';
    if (vlen(s) <= max) return s;
    let out = '', n = 0;
    for (const ch of s) { const w = cw(ch.codePointAt(0)); if (n + w > max - 1) break; out += ch; n += w; }
    return out + '…';
}
const padTo = (s, w) => s + ' '.repeat(Math.max(0, w - vlen(s)));
const padL = (s, w) => ' '.repeat(Math.max(0, w - vlen(s))) + s;
const ctr = (s, W) => ' '.repeat(Math.max(0, Math.floor((W - vlen(s)) / 2))) + s;
const lr = (a, b, iw) => a + ' '.repeat(Math.max(1, iw - vlen(a) - vlen(b))) + b;

function box(title, lines, w, meta) {
    const inner = w - 4;
    let tSeg = title ? ' ' + cut(title, Math.max(0, w - 8)) + ' ' : '';
    let mSeg = meta ? ' ' + cut(meta, Math.max(0, w - 8 - vlen(tSeg))) + ' ' : '';
    const fill = Math.max(0, w - 4 - vlen(tSeg) - vlen(mSeg));
    const B = fg(T.border);
    const out = [B('╭─') + bold(fg(T.title)(tSeg)) + B('─'.repeat(fill)) + fg(T.dim)(mSeg) + B('─╮')];
    for (const l of lines) out.push(B('│') + ' ' + padTo(trunc(l, inner), inner) + ' ' + B('│'));
    out.push(B('╰' + '─'.repeat(w - 2) + '╯'));
    return out;
}
function side(a, b, gap = 1) {
    const h = Math.max(a.length, b.length), wa = vlen(a[0]), wb = vlen(b[0]), out = [];
    for (let i = 0; i < h; i++) out.push((a[i] || ' '.repeat(wa)) + ' '.repeat(gap) + (b[i] || ' '.repeat(wb)));
    return out;
}

// ───────────────────────── visual widgets ─────────────────────────
const BLK = '▁▂▃▄▅▆▇█';
function gauge(pct, len) {
    const p = clamp(pct || 0, 0, 100), filled = Math.round((len * p) / 100);
    let s = '';
    for (let i = 0; i < len; i++) {
        if (i < filled) {
            const t = len > 1 ? i / (len - 1) : 0;
            const col = t < 0.6 ? mix(T.ok, T.warn, t / 0.6) : mix(T.warn, T.err, (t - 0.6) / 0.4);
            s += fg(col)('█');
        } else s += fg(T.dim)('░');
    }
    return s;
}
function spark(arr, width, colorFn, minMax = 1) {
    if (width <= 0) return '';
    const data = arr.slice(-width);
    const mx = Math.max(minMax, ...data, 1e-9);
    let s = fg(T.dim)('▁'.repeat(Math.max(0, width - data.length)));
    for (const v of data) {
        if (!(v > 0)) { s += fg(T.dim)('▁'); continue; }
        const idx = clamp(Math.round((v / mx) * 7), 0, 7);
        s += fg(colorFn ? colorFn(v, mx) : T.accent)(BLK[idx]);
    }
    return s;
}
const fmtUp = (sec) => {
    sec = Math.floor(sec); const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60), s = sec % 60, p = (n) => String(n).padStart(2, '0');
    return (d ? d + 'd ' : '') + `${p(h)}:${p(m)}:${p(s)}`;
};
const fmtMs = (ms) => (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's');
const fmtB = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + 'G' : Math.round(n / 1048576) + 'M');
const clock = (t) => new Date(t).toTimeString().slice(0, 8);

// ───────────────────────── logo ─────────────────────────
const GL = {
    D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
    E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
    A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
    T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
    H: ['██╗  ██╗', '██║  ██║', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝']
};
const LOGO = [0, 1, 2, 3, 4, 5].map((r) => 'DEATH'.split('').map((c) => GL[c][r]).join(''));
const LOGO_W = LOGO[0].length;
const NOISE_CH = '█▓▒░╳╬#@%&01<>/\\';

function logoLines(shimmer, reveal) {
    return LOGO.map((row, r) => {
        const base = mix(T.logoA, T.logoB, r / 5), edge = mix(base, '#000000', 0.5);
        let s = '';
        for (let i = 0; i < row.length; i++) {
            const ch = row[i];
            if (reveal != null && i >= reveal) {
                if (i < reveal + 6 && ch !== ' ') s += fg(T.dim)(NOISE_CH[Math.floor(Math.random() * NOISE_CH.length)]);
                else s += ' ';
                continue;
            }
            if (ch === ' ') { s += ' '; continue; }
            let col = ch === '█' ? base : edge;
            if (shimmer != null) {
                const d = Math.abs(i - shimmer + r);
                if (d < 3) col = mix(col, '#ffffff', 0.85 - d * 0.28);
            }
            s += fg(col)(ch);
        }
        return s;
    });
}
function miniLogo() {
    const letters = 'DEATH'.split('').map((c, i) => bold(fg(mix(T.logoA, T.logoB, i / 4))(c))).join(' ');
    return fg(T.border)('▓▒░ ') + letters + fg(T.border)(' ░▒▓');
}

// ───────────────────────── state ─────────────────────────
const S = {
    enabled: false, force: false, mode: 'boot', frame: 0, name: 'DEATH', version: '4.0',
    state: 'BOOTING', user: null, retryAt: 0,
    stats: { messages: 0, commands: 0, errors: 0, decryptFail: 0, reconnects: 0, startTime: Date.now(), activeChats: new Set() },
    feed: [], feedOffset: 0, feedFull: false, feedRows: 10,
    hist: { cpu: [], ram: [], act: [], lat: [] },
    cpu: { sys: null, proc: 0 }, ram: { total: 1, used: 0 }, lag: 0, fb: null,
    actBucket: 0, msgTimes: [], latSum: 0, latN: 0, latLast: 0, latPeak: 0, apiCmd: false,
    boot: null, ask: null, askResolve: null, pair: null, busy: '', paused: false,
    rl: null, cmdHandler: null, timer: null, sampler: null, opts: { arabic: 'shape' }, theme: 'shadow',
    renderErrors: 0, tick2: 0, lastSample: Date.now()
};
let prevLines = [], prevCols = 0, prevRows = 0, restored = false, altOn = false;

const COLS = () => STDOUT.columns || 80;
const ROWS = () => STDOUT.rows || (S.force ? 40 : 24);

// ───────────────────────── metrics ─────────────────────────
const safeCpus = () => { try { return os.cpus() || []; } catch (_) { return []; } };
let lastCpus = safeCpus(), lastProc = process.cpuUsage(), lastT = process.hrtime.bigint();
function sampleCpu() {
    let sys = null; const cur = safeCpus();
    if (cur.length && lastCpus.length === cur.length) {
        let idle = 0, total = 0;
        for (let i = 0; i < cur.length; i++) {
            const c = cur[i].times, l = lastCpus[i].times;
            total += (c.user + c.nice + c.sys + c.idle + c.irq) - (l.user + l.nice + l.sys + l.idle + l.irq);
            idle += c.idle - l.idle;
        }
        if (total > 0) sys = clamp((1 - idle / total) * 100, 0, 100);
    }
    lastCpus = cur;
    const pu = process.cpuUsage(lastProc); lastProc = process.cpuUsage();
    const now = process.hrtime.bigint(), dt = Number(now - lastT) / 1e3; lastT = now;
    const proc = dt > 0 ? clamp(((pu.user + pu.system) / dt) * 100, 0, 100) : 0;
    return { sys, proc };
}
function readMem() {
    try {
        const t = fs.readFileSync('/proc/meminfo', 'utf8');
        const tot = /MemTotal:\s+(\d+)/.exec(t), av = /MemAvailable:\s+(\d+)/.exec(t);
        if (tot && av) return { total: +tot[1] * 1024, used: (+tot[1] - +av[1]) * 1024 };
    } catch (_) {}
    const total = os.totalmem(); return { total, used: total - os.freemem() };
}
function sample() {
    const now = Date.now();
    S.lag = Math.max(0, now - S.lastSample - 1000); S.lastSample = now;
    S.cpu = sampleCpu(); S.ram = readMem();
    const push = (a, v) => { a.push(v); if (a.length > 150) a.shift(); };
    push(S.hist.cpu, S.cpu.sys != null ? S.cpu.sys : S.cpu.proc);
    push(S.hist.ram, (S.ram.used / S.ram.total) * 100);
    if (++S.tick2 % 2 === 0) { push(S.hist.act, S.actBucket); S.actBucket = 0; }
    const cutT = now - 60000; while (S.msgTimes.length && S.msgTimes[0] < cutT) S.msgTimes.shift();
}
function pushLat(ms) {
    if (!(ms >= 0)) return;
    S.hist.lat.push(ms); if (S.hist.lat.length > 80) S.hist.lat.shift();
    S.latSum += ms; S.latN++; S.latLast = ms; if (ms > S.latPeak) S.latPeak = ms;
}

// ───────────────────────── feed / ingest ─────────────────────────
const MAXFEED = 1000;
const EMOJI_RE = /\p{Extended_Pictographic}|\uFE0F|\u200D/gu;
function clean(t) {
    return String(t).slice(0, 600).replace(ANSI_RE, '').replace(EMOJI_RE, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
}
function fmtArg(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    if (a && typeof a === 'object') { try { return util.inspect(a, { depth: 0, breakLength: Infinity }).slice(0, 160); } catch (_) { return '[object]'; } }
    return String(a);
}
function feedPush(lvl, msg, key, raw) {
    const last = S.feed[S.feed.length - 1];
    if (last && ((key && last.key === key) || (!key && last.msg === msg && last.lvl === lvl))) { last.n++; last.t = Date.now(); return; }
    S.feed.push({ t: Date.now(), lvl, msg, n: 1, key, raw });
    if (S.feed.length > MAXFEED) S.feed.splice(0, S.feed.length - MAXFEED);
    if (S.feedOffset > 0) S.feedOffset++;
}
const NOISE = [
    { re: /Bad MAC|Session error|MessageCounterError|No matching sessions/i, drop: true },
    { re: /Failed to decrypt message/i, key: 'decrypt', lvl: 'sig', msg: 'Signal: decrypt failed (Bad MAC - session desync)', stat: 'decryptFail' },
    { re: /Closing (open )?session|Removing old closed session|Opening session|Migrating session/i, key: 'session', lvl: 'sig', msg: 'Signal: session rotated' }
];
function ingest(lvl, text, raw) {
    let msg = clean(text);
    if (!msg || /^at /.test(msg)) return;
    for (const r of NOISE) {
        if (r.re.test(msg)) {
            if (r.drop) return;
            if (r.stat) S.stats[r.stat] = (S.stats[r.stat] || 0) + 1;
            feedPush(r.lvl, r.msg, r.key, raw || text); requestRender(); return;
        }
    }
    if (!S.apiCmd && lvl === 'ok') {
        const cm = /\[COMMAND\][^]*?([\d.]+)\s*ms/i.exec(msg);
        if (cm) { S.stats.commands++; pushLat(parseFloat(cm[1])); }
    }
    if (lvl === 'err') S.stats.errors++;
    if (!msg) return;
    feedPush(lvl, msg, null, raw || text);
    if (!S.enabled) REAL.log(`[${clock(Date.now())}] ${lvl.toUpperCase().padEnd(4)} ${msg}`);
    else requestRender();
}
const LVLMAP = { info: 'info', success: 'ok', ok: 'ok', warn: 'warn', warning: 'warn', error: 'err', debug: 'dbg', log: 'info', system: 'sys' };
function hookLogger(logger) {
    for (const m in logger) {
        if (typeof logger[m] !== 'function') continue;
        const orig = logger[m].bind(logger), lvl = LVLMAP[m] || 'info';
        logger[m] = (...args) => {
            try { ingest(lvl, args.map(fmtArg).join(' '), args.map((a) => (a instanceof Error ? a.stack : fmtArg(a))).join(' ')); } catch (_) {}
            if (!S.enabled) { try { orig(...args); } catch (_) {} }
        };
    }
}
function captureConsole() {
    const map = { log: 'info', info: 'info', warn: 'warn', error: 'err', debug: 'dbg' };
    for (const m of Object.keys(map)) {
        console[m] = (...a) => {
            if (!S.enabled) { REAL[m].apply(console, a); return; }
            try {
                const full = a.map((x) => (x instanceof Error ? x.stack || x.message : fmtArg(x))).join(' ');
                ingest(map[m], full.split('\n')[0], full);
            } catch (_) {}
        };
    }
}
function log(lvl, msg) { ingest(lvl, msg, msg); }

// ───────────────────────── Arabic display engine ─────────────────────────
// Termux لا يدعم العربي RTL: يعرض الحروف من اليسار لليمين. الحل مرحلتين:
//  1) shape: تحويل الحروف إلى أشكالها المتصلة (Presentation Forms) عشان تنوصل بدون مساعدة الطرفية
//  2) reorder: عكس ترتيب كل مقطع عربي ليقرأ بشكل صحيح (مع حفظ الأرقام والإنجليزي)
const AR_MODES = ['shape', 'rtl', 'off', 'hide'];
const AR = {};
[
    [0x621, 0xFE80], [0x622, 0xFE81, 0xFE82], [0x623, 0xFE83, 0xFE84], [0x624, 0xFE85, 0xFE86],
    [0x625, 0xFE87, 0xFE88], [0x626, 0xFE89, 0xFE8A, 0xFE8B, 0xFE8C], [0x627, 0xFE8D, 0xFE8E],
    [0x628, 0xFE8F, 0xFE90, 0xFE91, 0xFE92], [0x629, 0xFE93, 0xFE94], [0x62A, 0xFE95, 0xFE96, 0xFE97, 0xFE98],
    [0x62B, 0xFE99, 0xFE9A, 0xFE9B, 0xFE9C], [0x62C, 0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0],
    [0x62D, 0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4], [0x62E, 0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8],
    [0x62F, 0xFEA9, 0xFEAA], [0x630, 0xFEAB, 0xFEAC], [0x631, 0xFEAD, 0xFEAE], [0x632, 0xFEAF, 0xFEB0],
    [0x633, 0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4], [0x634, 0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8],
    [0x635, 0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC], [0x636, 0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0],
    [0x637, 0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4], [0x638, 0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8],
    [0x639, 0xFEC9, 0xFECA, 0xFECB, 0xFECC], [0x63A, 0xFECD, 0xFECE, 0xFECF, 0xFED0],
    [0x641, 0xFED1, 0xFED2, 0xFED3, 0xFED4], [0x642, 0xFED5, 0xFED6, 0xFED7, 0xFED8],
    [0x643, 0xFED9, 0xFEDA, 0xFEDB, 0xFEDC], [0x644, 0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0],
    [0x645, 0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4], [0x646, 0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8],
    [0x647, 0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC], [0x648, 0xFEED, 0xFEEE], [0x649, 0xFEEF, 0xFEF0],
    [0x64A, 0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4]
].forEach(([cp, ...forms]) => { AR[cp] = forms; }); // [isolated, final, initial, medial]
const LAM_ALEF = { 0x622: [0xFEF5, 0xFEF6], 0x623: [0xFEF7, 0xFEF8], 0x625: [0xFEF9, 0xFEFA], 0x627: [0xFEFB, 0xFEFC] };
const isArMark = (cp) => (cp >= 0x64B && cp <= 0x65F) || cp === 0x670;

function arShape(str) {
    const cps = Array.from(str, (c) => c.codePointAt(0));
    const joinsNext = (cp) => (AR[cp] && AR[cp].length === 4) || cp === 0x640;
    const canJoinPrev = (cp) => (AR[cp] && cp !== 0x621) || cp === 0x640;
    const out = [];
    for (let i = 0; i < cps.length; i++) {
        const cp = cps[i], f = AR[cp];
        if (!f) { out.push(cp); continue; }
        let j = i - 1; while (j >= 0 && isArMark(cps[j])) j--;
        const prevJoins = canJoinPrev(cp) && j >= 0 && joinsNext(cps[j]);
        let k = i + 1; while (k < cps.length && isArMark(cps[k])) k++;
        const nextCp = k < cps.length ? cps[k] : 0;
        if (cp === 0x644 && k === i + 1 && LAM_ALEF[nextCp]) {
            out.push(prevJoins ? LAM_ALEF[nextCp][1] : LAM_ALEF[nextCp][0]);
            i++; continue;
        }
        const joinNext = f.length === 4 && canJoinPrev(nextCp);
        out.push(prevJoins && joinNext ? f[3] : prevJoins ? f[1] : joinNext ? f[2] : f[0]);
    }
    return String.fromCodePoint(...out);
}

const AR_LETTER = /[\u0600-\u065F\u066A-\u06EF\u06FA-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const AR_ANY = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
const AR_NEUTRAL = /[\s\u00A0.,:;!?'"()[\]{}<>\-_/\\@#$%^&*+=~`،؛؟…]/;
const AR_MIRROR = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };
const isArL = (ch) => !AR_LETTER.test(ch) && !AR_NEUTRAL.test(ch); // لاتيني/أرقام: يبقى بترتيبه

function reverseClusters(chars) {
    const clusters = [];
    for (const ch of chars) {
        const cp = ch.codePointAt(0);
        if (isArMark(cp) && clusters.length) clusters[clusters.length - 1] += ch; else clusters.push(ch);
    }
    return clusters.reverse().map((c) => AR_MIRROR[c] || c).join('');
}
function reorderRun(chars) {
    const units = []; let cur = null;
    for (const ch of chars) {
        const t = isArL(ch) ? 'L' : 'R';
        if (cur && cur.t === t) cur.s.push(ch); else { cur = { t, s: [ch] }; units.push(cur); }
    }
    return units.reverse().map((u) => (u.t === 'L' ? u.s.join('') : reverseClusters(u.s))).join('');
}
function reorderPart(part) {
    const chars = Array.from(part);
    let a = chars.findIndex((c) => AR_LETTER.test(c));
    if (a < 0) return part;
    let b = chars.length - 1; while (b > a && !AR_LETTER.test(chars[b])) b--;
    while (a > 0 && /[{(["'<]/.test(chars[a - 1])) a--;
    while (b < chars.length - 1 && /[})\]"'>…]/.test(chars[b + 1])) b++;
    return chars.slice(0, a).join('') + reorderRun(chars.slice(a, b + 1)) + chars.slice(b + 1).join('');
}
function arabicDisplay(str, mode) {
    if (!mode || mode === 'off' || !AR_ANY.test(str)) return str;
    if (mode === 'hide') return str.replace(/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g, '').replace(/\s{2,}/g, ' ').trim();
    const shaped = mode === 'shape' ? arShape(str) : str;
    // المقاطع تنفصل عند فواصل السجل (| ← → ·) عشان البيانات الإنجليزية تبقى بترتيبها
    return shaped.split(/([|│←→·])/).map((p, i) => (i % 2 ? p : reorderPart(p))).join('');
}
function displayText(e, room) {
    const mode = S.opts.arabic, key = mode + ':' + room;
    if (e._k === key) return e._d;
    const d = arabicDisplay(cut(e.msg, room), mode);
    e._k = key; e._d = d;
    return d;
}

// ───────────────────────── frame builders ─────────────────────────
const LV = {
    info: ['INFO', 'info'], ok: ['OK  ', 'ok'], warn: ['WARN', 'warn'], err: ['ERR ', 'err'],
    rx: ['RX  ', 'rx'], sys: ['SYS ', 'sys'], dbg: ['DBG ', 'dim'], sig: ['SIG ', 'sig'], cmd: ['CMD ', 'accent']
};
const SOLID = { ok: 1, warn: 1, err: 1 };
function feedLine(e, iw) {
    const [badge, ck] = LV[e.lvl] || LV.info, col = T[ck] || T.text;
    const b = SOLID[e.lvl] ? bg(col)(fg('#0b0b0f')(bold(badge))) : bold(fg(col)(badge));
    const suffix = e.n > 1 ? ' ×' + e.n : '';
    const room = iw - 14 - suffix.length;
    const m = displayText(e, room);
    const txt = e.lvl === 'err' ? bold(fg(col)(m)) : e.lvl === 'warn' ? fg(col)(m) : e.lvl === 'dbg' ? fg(T.dim)(m) : fg(T.text)(m);
    return fg(T.dim)(clock(e.t)) + ' ' + b + ' ' + txt + (suffix ? fg(T.dim)(suffix) : '');
}

const STATE_COL = () => ({ ONLINE: T.ok, CONNECTING: T.warn, RECONNECTING: T.warn, 'LOGGED OUT': T.err, PAIRING: T.accent, BOOTING: T.dim });
function statusLine(W) {
    const col = STATE_COL()[S.state] || T.dim;
    const pulse = S.state === 'ONLINE' ? (S.frame % 8 < 4 ? '●' : '○') : (S.frame % 4 < 2 ? '◆' : '◇');
    let label = S.state;
    if (S.state === 'RECONNECTING' && S.retryAt > Date.now()) label += ' ' + Math.ceil((S.retryAt - Date.now()) / 1000) + 's';
    const parts = [
        fg(col)(pulse) + ' ' + bg(col)(fg('#0b0b0f')(bold(' ' + label + ' '))),
        fg(T.text)(S.user ? '+' + S.user : 'awaiting auth'),
        fg(T.dim)('UP ') + fg(T.accent)(fmtUp(process.uptime())),
        fg(T.text)(clock(Date.now()))
    ];
    const sep = fg(T.dim)('  ·  ');
    let line = parts[0];
    for (let i = 1; i < parts.length; i++) { const nxt = line + sep + parts[i]; if (vlen(nxt) > W) break; line = nxt; }
    return ctr(line, W);
}
function scanner(W) {
    const pos = ((S.frame * 3) % (W + 14)) - 7;
    let s = '';
    const lo = clamp(pos - 3, 0, W), hi = clamp(pos + 4, 0, W);
    s += fg(T.dim)('─'.repeat(lo));
    for (let i = lo; i < hi; i++) s += fg(mix(T.accent, T.border, Math.abs(i - pos) / 4))('━');
    s += fg(T.dim)('─'.repeat(W - hi));
    return s;
}
function headerLines(W, big, shimmer, reveal) {
    const L = [];
    if (big) {
        logoLines(shimmer, reveal).forEach((l) => L.push(ctr(l, W)));
        const sub = fg(T.dim)('S H A D O W   C O R E   ') + fg(T.border)(':: ') + bold(fg(T.accent)('V ' + S.version.split('').join(' ')));
        L.push(ctr(sub, W));
    } else L.push(ctr(miniLogo() + fg(T.dim)('  SHADOW CORE v' + S.version), W));
    return L;
}
function kv(label, val, color) { return fg(T.dim)(label.padEnd(8)) + bold(fg(color || T.accent)(String(val))); }
function pctTxt(v) { return padL(Math.round(v) + '%', 4); }

function metricRow(label, pct, histArr, iw) {
    const r = iw - 9;
    let bar, sp = 0;
    if (r >= 18) { bar = 12; sp = r - 13; } else bar = Math.max(4, r);
    const base = fg(T.dim)(label.padEnd(4)) + gauge(pct, bar) + ' ' + fg(T.text)(pctTxt(pct));
    return sp > 3 ? base + ' ' + spark(histArr, sp, (v) => (v > 80 ? T.err : v > 55 ? T.warn : T.accent), 100) : base;
}
function panelsBlock(W) {
    const cpuPct = S.cpu.sys != null ? S.cpu.sys : S.cpu.proc;
    const cpuLabel = S.cpu.sys != null ? 'CPU' : 'BOT';
    const ramPct = (S.ram.used / S.ram.total) * 100;
    const heap = fmtB(process.memoryUsage().heapUsed);
    const st = S.stats, rate = S.msgTimes.length, avg = S.latN ? S.latSum / S.latN : 0;
    const lagTxt = (S.lag > 200 ? fg(T.err) : S.lag > 60 ? fg(T.warn) : fg(T.ok))(Math.round(S.lag) + 'ms');
    const fbTxt = S.fb != null ? fg(T.text)(Math.round(S.fb) + 'ms') : fg(T.dim)('--');
    if (W >= 60) {
        const lw = Math.floor((W - 1) / 2), rw = W - 1 - lw, liw = lw - 4, riw = rw - 4;
        const L = [
            metricRow(cpuLabel, cpuPct, S.hist.cpu, liw),
            metricRow('RAM', ramPct, S.hist.ram, liw),
            lr(kv('HEAP', heap, T.text), fg(T.text)(fmtB(S.ram.used) + '/' + fmtB(S.ram.total)), liw),
            lr(fg(T.dim)('LAG   ') + lagTxt, fg(T.dim)('FB ') + fbTxt, liw)
        ];
        const R = [
            lr(kv('MSGS', st.messages), fg(T.dim)(rate + '/min'), riw),
            lr(kv('CMDS', st.commands, T.sys), fg(T.dim)('avg ' + (S.latN ? fmtMs(avg) : '--')), riw),
            lr(kv('CHATS', st.activeChats.size, T.rx), fg(T.dim)('ERR ') + fg(st.errors ? T.err : T.ok)(String(st.errors)), riw),
            lr(kv('DECRYPT', st.decryptFail || 0, st.decryptFail ? T.sig : T.ok), fg(T.dim)('RECONN ') + fg(T.text)(String(st.reconnects || 0)), riw)
        ];
        return side(box('HARDWARE', L, lw), box('TELEMETRY', R, rw));
    }
    const iw = W - 4;
    return box('SYSTEM', [
        metricRow(cpuLabel, cpuPct, S.hist.cpu, iw),
        metricRow('RAM', ramPct, S.hist.ram, iw),
        lr(kv('MSGS', st.messages) + ' ' + kv('CMDS', st.commands, T.sys), fg(T.dim)('ERR ') + fg(st.errors ? T.err : T.ok)(String(st.errors)), iw),
        lr(fg(T.dim)('LAG ') + lagTxt + fg(T.dim)('  HEAP ') + fg(T.text)(heap), fg(T.dim)('FB ') + fbTxt, iw)
    ], W);
}
function trafficBlock(W) {
    const iw = W - 4, sw = Math.max(6, iw - 9 - 12), rate = S.msgTimes.length;
    const latCol = (v) => (v > 3000 ? T.err : v > 1500 ? T.warn : T.ok);
    return box('TRAFFIC', [
        fg(T.dim)('ACTIVITY ') + spark(S.hist.act, sw, null, 3) + ' ' + padL(fg(T.text)(rate + '/min'), 11),
        fg(T.dim)('LATENCY  ') + spark(S.hist.lat, sw, latCol, 1000) + ' ' + padL(fg(S.latLast ? latCol(S.latLast) : T.dim)(S.latLast ? 'last ' + fmtMs(S.latLast) : '--'), 11)
    ], W, S.latPeak ? 'peak ' + fmtMs(S.latPeak) : '');
}
function inputLine(W) {
    const txt = S.rl && S.rl.line ? S.rl.line : '';
    const cur = S.frame % 6 < 3 ? inv(' ') : ' ';
    const body = txt ? fg(T.text)(txt) : fg(T.dim)('type a command…  (help)');
    return fg(T.accent)('❯ ') + (txt ? body + cur : cur + body);
}
function hintLine(W) {
    const a = fg(T.dim)('help · stats · logs · theme · clear · stop'), b = fg(T.dim)('PGUP/PGDN');
    return W > 60 ? lr(a, b, W) : a;
}

function buildDash(cols, rows) {
    const W = Math.max(36, Math.min(cols - 2, 100));
    const full = [
        { big: true, traffic: true, panels: true }, { big: true, traffic: false, panels: true },
        { big: false, traffic: true, panels: true }, { big: false, traffic: false, panels: true },
        { big: false, traffic: false, panels: false }
    ];
    const combos = S.feedFull ? [{ big: false, traffic: false, panels: false }] : full;
    let top = null;
    for (let i = 0; i < combos.length; i++) {
        const c = combos[i];
        if (c.big && W < 44) continue;
        const t = [].concat(headerLines(W, c.big, shimmerPos(), null), [statusLine(W), scanner(W)],
            c.panels ? panelsBlock(W) : [], c.traffic ? trafficBlock(W) : []);
        if (rows - t.length - 4 >= 6 || i === combos.length - 1) { top = t; break; }
    }
    const feedRows = Math.max(1, rows - top.length - 4);
    S.feedRows = feedRows;
    const iw = W - 4, n = S.feed.length;
    const end = Math.max(0, n - S.feedOffset), start = Math.max(0, end - feedRows);
    const body = S.feed.slice(start, end).map((e) => feedLine(e, iw));
    if (!n) body.push(fg(T.dim)('awaiting data streams' + '.'.repeat(1 + (S.frame % 12 >> 2))));
    const meta = S.feedOffset > 0 ? '↑' + S.feedOffset + ' · END = live' : n + ' events';
    const out = top.concat(box('LIVE FEED', body.concat(Array(Math.max(0, feedRows - body.length)).fill('')), W, meta));
    out.push(inputLine(W), hintLine(W));
    return finalize(out, cols, rows, W);
}

function shimmerPos() {
    const cyc = S.frame % 60; // sweep ~ every 9s at 150ms
    return cyc < 20 ? cyc * 3 - 8 : null;
}
function finalize(lines, cols, rows, W) {
    const maxW = cols - 2, margin = Math.max(0, Math.floor((cols - 2 - W) / 2));
    const out = lines.slice(0, rows).map((l) => ' '.repeat(margin) + trunc(l, maxW - margin));
    while (out.length < rows) out.push('');
    return out;
}
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const spin = () => SPIN[S.frame % SPIN.length];

function buildBoot(cols, rows) {
    const W = Math.max(36, Math.min(cols - 2, 100));
    const B = S.boot, big = rows >= 24 && W >= 44;
    const L = headerLines(W, big, B.shimmer, B.reveal);
    L.push('');
    const bw = Math.min(W, 62), padLeft = ' '.repeat(Math.floor((W - bw) / 2));
    const maxSteps = Math.max(2, rows - L.length - 5);
    const shown = B.steps.slice(-maxSteps);
    for (const st of shown) {
        const icon = st.status === 'run' ? fg(T.accent)(spin()) : st.status === 'ok' ? fg(T.ok)('✓') : st.status === 'warn' ? fg(T.warn)('!') : fg(T.err)('✗');
        const labW = 16;
        const det = cut(st.detail || '', bw - labW - 6);
        L.push(padLeft + ' ' + icon + '  ' + padTo(fg(st.status === 'run' ? T.text : T.dim)(st.label), labW) + ' ' +
            fg(st.status === 'warn' ? T.warn : st.status === 'fail' ? T.err : T.dim)(det));
    }
    L.push('');
    const pb = Math.max(10, bw - 16), pct = Math.round(B.progress * 100);
    if (B.flash) {
        L.push(ctr(bg(T.accent)(fg('#0b0b0f')(bold('  ACCESS GRANTED  '))), W));
    } else {
        L.push(padLeft + ' ' + fg(T.dim)('SYSTEM CHECK ') + gauge(pct, pb) + ' ' + fg(T.text)(padL(pct + '%', 4)));
    }
    return finalize(L, cols, rows, W);
}

function recentFeed(W, n) {
    return S.feed.slice(-n).map((e) => feedLine(e, W));
}
function buildCard(cols, rows) {
    const W = Math.max(36, Math.min(cols - 2, 100)), big = rows >= 28 && W >= 44;
    const L = headerLines(W, big, null, null);
    L.push(ctr(fg(T.dim)('─── ') + bold(fg(T.accent)(S.state)) + fg(T.dim)(' ───'), W), '');
    const cwid = Math.min(W, 58), inner = cwid - 4;
    const lines = [];
    let title = 'LINK DEVICE';
    if (S.mode === 'ask' && S.ask) {
        title = S.ask.title || 'INPUT';
        (S.ask.lines || []).forEach((t) => lines.push(fg(T.text)(t)));
        lines.push('');
        const txt = S.rl && S.rl.line ? S.rl.line : '';
        lines.push(fg(T.accent)('❯ ') + bold(fg('#ffffff')(txt)) + (S.frame % 6 < 3 ? inv(' ') : ' '));
    } else if (S.mode === 'busy') {
        lines.push('', fg(T.accent)(spin()) + ' ' + fg(T.text)(S.busy), '');
    } else if (S.mode === 'pair' && S.pair) {
        title = 'PAIRING CODE';
        lines.push(fg(T.text)('WhatsApp → Linked devices → Link a device'), fg(T.text)('→ "Link with phone number instead"'), '');
        const caps = S.pair.code.split('').map((ch) => (ch === '-' ? fg(T.dim)(' – ') : bg(T.accent)(fg('#0b0b0f')(bold(' ' + ch + ' '))) + ' ')).join('');
        lines.push(vlen(caps) <= inner ? ctr(caps, inner) : bold(fg(T.accent)(S.pair.code)));
        lines.push('', ctr(fg(T.dim)(spin() + ' waiting for link… ' + Math.floor((Date.now() - S.pair.t0) / 1000) + 's'), inner));
    }
    const card = box(title, lines, cwid).map((l) => ctr(l, W));
    L.push(...card, '');
    const room = rows - L.length - 1;
    if (room > 2 && S.feed.length) { L.push(fg(T.dim)('recent')); recentFeed(W, Math.min(6, room - 1)).forEach((l) => L.push(l)); }
    return finalize(L, cols, rows, W);
}
function buildFrame(cols, rows) {
    if (S.mode === 'boot' && S.boot) return buildBoot(cols, rows);
    if (S.mode === 'ask' || S.mode === 'pair' || S.mode === 'busy') return buildCard(cols, rows);
    return buildDash(cols, rows);
}

// ───────────────────────── painter ─────────────────────────
function paint(lines) {
    const cols = COLS(), rows = ROWS();
    let out = '';
    if (cols !== prevCols || rows !== prevRows) { out += '\x1b[2J'; prevLines = []; prevCols = cols; prevRows = rows; }
    for (let i = 0; i < rows; i++) {
        const l = lines[i] || '';
        if (prevLines[i] !== l) { out += `\x1b[${i + 1};1H${l}\x1b[0m\x1b[K`; prevLines[i] = l; }
    }
    if (out) write(out);
}
function render() {
    if (!S.enabled) return;
    try { paint(buildFrame(COLS(), ROWS())); S.renderErrors = 0; }
    catch (e) {
        if (++S.renderErrors > 5) { restore(); S.enabled = false; REAL.error('[deathui] render disabled:', e && e.stack); }
    }
}
let rq = false;
function requestRender() { if (!S.enabled || rq) return; rq = true; setImmediate(() => { rq = false; render(); }); }
function restartTimer() {
    if (S.timer) clearInterval(S.timer);
    const ms = S.mode === 'boot' ? 60 : S.mode === 'dash' ? 150 : 120;
    S.timer = setInterval(() => { S.frame++; if (S.paused && S.mode === 'dash') return; render(); }, ms);
    if (S.timer.unref) S.timer.unref();
}
function setMode(m) { S.mode = m; if (S.enabled) { restartTimer(); render(); } }

// ───────────────────────── terminal lifecycle ─────────────────────────
function restore() {
    if (restored || !altOn) return;
    restored = true;
    write('\x1b[?25h\x1b[0m\x1b[?1049l');
    if (process.env.DEATH_DUMP_FRAME) { try { fs.writeFileSync(process.env.DEATH_DUMP_FRAME, prevLines.join('\n')); } catch (_) {} }
}
function dumpErrors() {
    const errs = S.feed.filter((e) => e.lvl === 'err').slice(-8);
    if (errs.length) { REAL.error('\n[DEATH] last errors:'); errs.forEach((e) => REAL.error(' - ' + String(e.raw || e.msg).slice(0, 600))); }
}
function stop(code = 0) {
    restore();
    process.exit(code);
}

// ───────────────────────── input / commands ─────────────────────────
let cfgPath = path.join(__dirname, '..', '.deathui.json');
function loadCfg() {
    try {
        const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (c.theme && THEMES[c.theme]) setTheme(c.theme, true);
        if (c.arabic && AR_MODES.includes(c.arabic)) S.opts.arabic = c.arabic;
    } catch (_) {}
}
function saveCfg() {
    try { fs.writeFileSync(cfgPath, JSON.stringify({ theme: S.theme || 'shadow', arabic: S.opts.arabic })); } catch (_) {}
}
function setTheme(name, silent) {
    if (!THEMES[name]) return false;
    T = Object.assign({}, BASE, THEMES[name]); S.theme = name;
    if (!silent) saveCfg();
    prevLines = []; requestRender(); return true;
}
async function runCommand(line) {
    const [cmd, ...args] = line.trim().split(/\s+/), c = (cmd || '').toLowerCase();
    if (!c) return;
    feedPush('cmd', line.trim(), null, line);
    switch (c) {
        case 'help':
            log('sys', 'help · stats · logs (fullscreen feed) · theme <' + Object.keys(THEMES).join('|') + '> · arabic <shape|rtl|off|hide> · pause · clear · stop');
            log('sys', 'PGUP/PGDN scroll feed · END jump to live · eval <js>');
            break;
        case 'arabic': {
            const m = (args[0] || '').toLowerCase();
            if (AR_MODES.includes(m)) { S.opts.arabic = m; saveCfg(); S.feed.forEach((e) => { e._k = null; }); log('ok', 'arabic display -> ' + m); }
            else log('info', 'arabic mode: ' + S.opts.arabic + '  (usage: arabic shape | rtl | off | hide)');
            break;
        }
        case 'clear': S.feed.length = 0; S.feedOffset = 0; break;
        case 'logs': S.feedFull = !S.feedFull; log('sys', 'fullscreen feed ' + (S.feedFull ? 'ON' : 'OFF')); break;
        case 'pause': S.paused = !S.paused; log('sys', 'dashboard ' + (S.paused ? 'frozen' : 'live')); break;
        case 'theme':
            if (args[0] && setTheme(args[0].toLowerCase())) log('ok', 'theme → ' + args[0].toLowerCase());
            else log('warn', 'themes: ' + Object.keys(THEMES).join(', '));
            break;
        case 'stats': {
            const st = S.stats;
            log('info', `msgs ${st.messages} · cmds ${st.commands} · errors ${st.errors} · chats ${st.activeChats.size} · decrypt-fail ${st.decryptFail || 0} · reconnects ${st.reconnects || 0}`);
            if (S.latN) log('info', `latency avg ${fmtMs(S.latSum / S.latN)} · last ${fmtMs(S.latLast)} · peak ${fmtMs(S.latPeak)}`);
            break;
        }
        case 'stop': case 'exit': case 'quit': stop(0); break;
        default: {
            let handled = false;
            if (S.cmdHandler) { try { handled = await S.cmdHandler(c, args, line); } catch (e) { log('err', e.message); handled = true; } }
            if (!handled) log('warn', 'unknown command: ' + c + ' (try help)');
        }
    }
    requestRender();
}
function onLine(line) {
    if (S.askResolve) { const r = S.askResolve; S.askResolve = null; r(line); requestRender(); return; }
    runCommand(line).catch(() => {});
}
function onKey(str, key) {
    if (key) {
        const half = Math.max(3, S.feedRows - 1);
        if (key.name === 'pageup') S.feedOffset = Math.min(Math.max(0, S.feed.length - 1), S.feedOffset + half);
        else if (key.name === 'pagedown') S.feedOffset = Math.max(0, S.feedOffset - half);
        else if (key.name === 'end') S.feedOffset = 0;
        else if (key.name === 'home') S.feedOffset = Math.max(0, S.feed.length - 1);
        else if (key.ctrl && key.name === 'l') prevLines = [];
    }
    requestRender();
}
function setupInput() {
    if (S.enabled) {
        const mute = new Writable({ write(c, e, cb) { cb(); } });
        S.rl = readline.createInterface({ input: process.stdin, output: mute, terminal: true, prompt: '' });
        readline.emitKeypressEvents(process.stdin);
        process.stdin.on('keypress', onKey);
        S.rl.on('SIGINT', () => stop(0));
    } else {
        S.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }
    S.rl.on('line', onLine);
}

// ───────────────────────── public API ─────────────────────────
function init(opts = {}) {
    if (opts.stats) S.stats = opts.stats;
    if (opts.name) S.name = opts.name;
    if (opts.version) S.version = String(opts.version);
    if (opts.arabic && AR_MODES.includes(opts.arabic)) S.opts.arabic = opts.arabic;
    if (opts.stripArabic) S.opts.arabic = 'hide';
    S.force = !!(opts.force || process.env.DEATH_UI_FORCE);
    S.enabled = (!!STDOUT.isTTY || S.force) && !process.env.DEATH_PLAIN;
    loadCfg();
    if (S.enabled) {
        altOn = true;
        write('\x1b[?1049h\x1b[?25l\x1b[2J');
        STDOUT.on('resize', () => requestRender());
        captureConsole();
        restartTimer();
    }
    setupInput();
    sample();
    S.sampler = setInterval(sample, 1000); if (S.sampler.unref) S.sampler.unref();
    process.on('exit', (code) => { restore(); if (code) dumpErrors(); });
    process.on('SIGTERM', () => stop(0));
    process.on('uncaughtException', (e) => {
        restore(); REAL.error('\n[DEATH] uncaught exception:\n' + (e && e.stack ? e.stack : e)); process.exit(1);
    });
    process.on('unhandledRejection', (e) => { log('err', 'unhandled rejection: ' + (e && e.message ? e.message : e)); });
    return module.exports;
}

async function boot(steps, opts = {}) {
    if (!S.enabled) {
        LOGO.forEach((l) => REAL.log(l));
        for (const st of steps) {
            try {
                const r = await st.run(); const d = typeof r === 'string' ? r : (r && r.detail) || '';
                REAL.log(`[ OK ] ${st.label} ${d}`);
            } catch (e) { REAL.log(`[ ${st.critical ? 'FAIL' : 'WARN'} ] ${st.label} ${e.message}`); if (st.critical) throw e; }
        }
        return;
    }
    S.boot = { reveal: 0, shimmer: null, steps: [], progress: 0, flash: false };
    setMode('boot');
    if (opts.onLogo) { try { opts.onLogo(); } catch (_) {} }
    for (let p = 0; p <= LOGO_W + 8; p += 2) { S.boot.reveal = p; render(); await sleep(32); }
    S.boot.reveal = null;
    for (let p = -4; p < LOGO_W + 12; p += 3) { S.boot.shimmer = p; render(); await sleep(22); }
    S.boot.shimmer = null;
    let failed = null;
    for (let i = 0; i < steps.length; i++) {
        const st = { label: steps[i].label, status: 'run', detail: '' };
        S.boot.steps.push(st); render();
        const t0 = Date.now();
        try {
            const r = await steps[i].run();
            if (typeof r === 'string') st.detail = r;
            else if (r) { st.detail = r.detail || ''; st.status = r.status || 'ok'; }
            if (st.status === 'run') st.status = 'ok';
        } catch (e) {
            st.status = steps[i].critical ? 'fail' : 'warn'; st.detail = (e && e.message) || String(e);
            if (steps[i].critical) failed = e;
        }
        const el = Date.now() - t0; if (el < 170) await sleep(170 - el);
        S.boot.progress = (i + 1) / steps.length; render();
        if (failed) break;
    }
    if (failed) { await sleep(1500); throw failed; }
    S.boot.flash = true; render(); await sleep(650);
    S.boot = null; setMode('dash');
}

function setState(state, info = {}) {
    S.state = state;
    if (info.user) S.user = String(info.user).split(':')[0].split('@')[0];
    if (state === 'RECONNECTING') S.retryAt = Date.now() + (info.retryIn || 5) * 1000;
    if (state === 'ONLINE' && S.mode !== 'boot') { S.pair = null; S.ask = null; if (S.mode !== 'dash') setMode('dash'); }
    requestRender();
}
function ask(opts = {}) {
    if (!S.enabled) return new Promise((res) => S.rl.question((opts.title || 'Input') + ' > ', res));
    S.ask = opts; setMode('ask');
    return new Promise((res) => { S.askResolve = (v) => { S.ask = null; res(v); }; });
}
function busy(msg) { S.busy = msg; if (S.enabled) setMode('busy'); else REAL.log(msg); }
function showPairing(code) {
    S.pair = { code: String(code), t0: Date.now() };
    if (S.enabled) setMode('pair');
    else REAL.log('\n [!] PAIRING CODE: ' + code + '\n');
}
function noteMessage() { S.actBucket++; S.msgTimes.push(Date.now()); }
function recordCommand(info = {}) { S.apiCmd = true; S.stats.commands++; if (info.ms != null) pushLat(info.ms); }
function setMetric(name, val) { if (name === 'fb') S.fb = val; }
function onCommand(fn) { S.cmdHandler = fn; }

module.exports = {
    init, boot, hookLogger, captureConsole, log, setState, ask, busy, showPairing,
    noteMessage, recordCommand, setMetric, onCommand, stop, setTheme,
    get enabled() { return S.enabled; },
    get rl() { return S.rl; },
    _test: { arabicDisplay, arShape, S, buildFrame, buildDash, buildBoot, buildCard, ingest, vlen, trunc, feedPush, THEMES, setMode, sample, pushLat, restore }
};
