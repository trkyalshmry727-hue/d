'use strict';
/* ترجمان الألعاب
   - قراءة أي نص يظهر في الكاميرا أو الفيديو وترجمته (كامل الشاشة أو مربع محدد)
   - سماع كلام الشخصيات (بالمايك مع الكاميرا، أو من صوت الفيديو مباشرة) وترجمته ونطقه بالعربي
   - كل شخصية لها صوت عربي، والنبرة تتطابق مع طبقة صوت الشخصية الأصلي */

const $ = s => document.querySelector(s);
const video = $('#cam');
const cv = $('#cv');
const ctx = cv.getContext('2d', { willReadFrequently: true });
const KEY = 'tarjuman_v2_';

/* ---------- الحفظ ---------- */
const DEF = { region: null, interval: 1200, textMode: 'white', thr: 175, font: 22, showEn: true, hideCam: false,
  ocrOn: true, voiceOn: false, speakOn: true, speaker: 'jason', match: true, muteOrig: true };
function load(k) { try { return JSON.parse(localStorage.getItem(KEY + k)); } catch (e) { return null; } }
function save() {
  try {
    localStorage.setItem(KEY + 'set', JSON.stringify(S));
    localStorage.setItem(KEY + 'chars', JSON.stringify(chars));
  } catch (e) {}
}
let S = Object.assign({}, DEF, load('set') || {});
let chars = load('chars') || {
  narrator: { key: 'narrator', en: '', ar: 'الراوي', voice: '', gender: 'm', pitch: 1, rate: 1 },
  jason: { key: 'jason', en: 'Jason', ar: 'جيسون', voice: '', gender: 'm', pitch: 0.85, rate: 1 }
};
if (!chars[S.speaker]) S.speaker = 'narrator';
const cache = new Map(Object.entries(load('cache') || {}));
function saveCache() {
  try { localStorage.setItem(KEY + 'cache', JSON.stringify(Object.fromEntries([...cache.entries()].slice(-500)))); } catch (e) {}
}

/* ---------- أدوات ---------- */
let stTimer = null;
function status(t, keep) {
  const el = $('#status');
  el.textContent = t; el.classList.remove('fade');
  clearTimeout(stTimer);
  if (!keep) stTimer = setTimeout(() => el.classList.add('fade'), 3500);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function color(k) { return k === 'narrator' ? '#ffd400' : `hsl(${hash(k) % 360},85%,65%)`; }
function norm(s) { return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function sim(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > Math.max(m, n) * 0.5) return 0;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- التشغيل ---------- */
let mode = null, stream = null, fileURL = null;
function primeTTS() { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch (e) {} }

function enterApp() {
  $('#start').classList.add('hide');
  $('#app').classList.remove('hide');
  $('#app').classList.toggle('filemode', mode === 'file');
  applySettings(); updateBtns(); renderSpk(); keepAwake();
  if (!worker && !ocrLoading) initOCR();
  setTimeout(showRegion, 500);
}
function stopCam() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }

async function startCam() {
  primeTTS();
  let s;
  try {
    s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false
    });
  } catch (e) {
    alert('ما قدرت أفتح الكاميرا. اسمح للموقع باستخدام الكاميرا من إعدادات المتصفح ثم حدّث الصفحة.');
    return;
  }
  resetVideoMode();
  stream = s; mode = 'cam';
  if (fileURL) { URL.revokeObjectURL(fileURL); fileURL = null; }
  video.removeAttribute('src'); video.srcObject = stream;
  video.muted = true; video.controls = false;
  try { await video.play(); } catch (e) {}
  enterApp();
  if (S.voiceOn) startRec();
  status(S.region ? 'جاهز — يقرأ المربع المحدد' : 'وجّه الكاميرا على أي نص في اللعبة');
}

async function startFile(file) {
  if (!file) return;
  primeTTS();
  stopRec(); stopCam(); resetVideoMode();
  mode = 'file';
  if (fileURL) URL.revokeObjectURL(fileURL);
  fileURL = URL.createObjectURL(file);
  video.srcObject = null; video.src = fileURL;
  video.muted = false; video.controls = true; video.autoplay = false;
  enterApp();
  prepareVoice(file);
}

$('#btnCam').onclick = startCam;
$('#btnFile').onclick = () => { primeTTS(); $('#fileIn').click(); };
$('#bCam').onclick = startCam;
$('#bFile').onclick = () => { primeTTS(); $('#fileIn').click(); };
$('#fileIn').onchange = e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; startFile(f); };

/* ---------- إبقاء الشاشة شغالة ---------- */
let wl = null;
async function keepAwake() { try { if ('wakeLock' in navigator) wl = await navigator.wakeLock.request('screen'); } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

/* ---------- تحديد منطقة (اختياري) ---------- */
let selecting = false, sel = null;
function contentRect() {
  const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
  const b = video.getBoundingClientRect();
  const s = Math.min(b.width / vw, b.height / vh);
  const w = vw * s, h = vh * s;
  return { x: b.left + (b.width - w) / 2, y: b.top + (b.height - h) / 2, w, h };
}
function showRegion() {
  const el = $('#region');
  if (!S.region || !video.videoWidth) { el.classList.add('hide'); return; }
  const c = contentRect(), r = S.region;
  Object.assign(el.style, { left: c.x + r.x * c.w + 'px', top: c.y + r.y * c.h + 'px', width: r.w * c.w + 'px', height: r.h * c.h + 'px' });
  el.classList.remove('hide');
}
function beginSelect() {
  selecting = true; closePanels();
  $('#app').classList.add('selecting');
  $('#draw').classList.remove('hide');
  $('#box').classList.add('hide');
}
function endSelect() {
  selecting = false; sel = null;
  $('#app').classList.remove('selecting');
  $('#draw').classList.add('hide');
}
const draw = $('#draw'), box = $('#box');
function boxRect(e) {
  const x1 = Math.min(sel.x, e.clientX), y1 = Math.min(sel.y, e.clientY);
  return { x: x1, y: y1, w: Math.max(sel.x, e.clientX) - x1, h: Math.max(sel.y, e.clientY) - y1 };
}
draw.addEventListener('pointerdown', e => {
  if (e.target.id === 'bCancelSel') return;
  sel = { x: e.clientX, y: e.clientY };
  try { draw.setPointerCapture(e.pointerId); } catch (er) {}
  box.classList.remove('hide');
  Object.assign(box.style, { left: e.clientX + 'px', top: e.clientY + 'px', width: '0px', height: '0px' });
});
draw.addEventListener('pointermove', e => {
  if (!sel) return;
  const r = boxRect(e);
  Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
});
draw.addEventListener('pointerup', e => {
  if (!sel) return;
  const r = boxRect(e), c = contentRect();
  if (r.w < 30 || r.h < 15) { sel = null; box.classList.add('hide'); status('المربع صغير، اسحب مرة ثانية'); return; }
  const x = clamp((r.x - c.x) / c.w, 0, 1), y = clamp((r.y - c.y) / c.h, 0, 1);
  S.region = { x, y, w: clamp((r.x + r.w - c.x) / c.w, 0, 1) - x, h: clamp((r.y + r.h - c.y) / c.h, 0, 1) - y };
  save(); endSelect(); showRegion();
  lastDone = ''; pending = '';
  status('تم — يقرأ المربع المحدد بس');
});
$('#bCancelSel').onclick = e => { e.stopPropagation(); endSelect(); };
window.addEventListener('resize', () => setTimeout(showRegion, 300));
video.addEventListener('loadedmetadata', () => setTimeout(showRegion, 100));
$('#bRegion').onclick = beginSelect;
$('#bFull').onclick = () => { S.region = null; save(); showRegion(); lastDone = ''; pending = ''; status('يقرأ أي نص في الشاشة كاملة'); };

/* ---------- قراءة النصوص ---------- */
let worker = null, ocrLoading = false, curPsm = '';
async function initOCR() {
  ocrLoading = true;
  status('جاري تجهيز قارئ النصوص… أول مرة تاخذ شوي', true);
  try {
    worker = await Tesseract.createWorker('eng', 1, {
      logger: m => { if (m.status && m.status.includes('load') && m.progress) status('تحميل قارئ النصوص ' + Math.round(m.progress * 100) + '٪', true); }
    });
    await worker.setParameters({ preserve_interword_spaces: '1' });
    status('قارئ النصوص جاهز ✓');
    ocrLoop();
  } catch (e) {
    status('تعذّر تحميل قارئ النصوص، تأكد من الإنترنت وحدّث الصفحة', true);
  }
  ocrLoading = false;
}
async function setPsm(p) { if (p !== curPsm) { await worker.setParameters({ tessedit_pageseg_mode: p }); curPsm = p; } }

function grab(full) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw) return false;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (!full) { const r = S.region; sx = r.x * vw; sy = r.y * vh; sw = Math.max(8, r.w * vw); sh = Math.max(8, r.h * vh); }
  const scale = full ? clamp(1600 / sw, 0.5, 2) : clamp(1500 / sw, 1, 3);
  cv.width = Math.round(sw * scale); cv.height = Math.round(sh * scale);
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  const img = ctx.getImageData(0, 0, cv.width, cv.height), d = img.data;
  const thr = S.thr, tm = full ? 'auto' : S.textMode;
  let mean = 0;
  if (tm === 'auto') { let n = 0; for (let i = 0; i < d.length; i += 40) { mean += d[i] * .3 + d[i + 1] * .59 + d[i + 2] * .11; n++; } mean /= n; }
  for (let i = 0; i < d.length; i += 4) {
    const R = d[i], G = d[i + 1], B = d[i + 2];
    const g = R * .3 + G * .59 + B * .11;
    let v;
    if (tm === 'white') v = (g > thr && Math.max(R, G, B) - Math.min(R, G, B) < 70) ? 0 : 255;
    else if (tm === 'yellow') v = (R > thr && G > thr - 30 && B < R - 40) ? 0 : 255;
    else if (tm === 'black') v = g < 255 - thr ? 0 : 255;
    else { const x = mean < 128 ? 255 - g : g; v = clamp((x - 128) * 1.6 + 128, 0, 255); }
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return true;
}

function wordsOf(t) { return t.split(' ').filter(w => /[A-Za-z]{2,}/.test(w)).length; }
function clean(raw) {
  let t = String(raw || '').replace(/[|_~`^<>{}\[\]\\@#*=«»]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^[^A-Za-z"'(]+/, '');
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (t.length < 3 || letters / t.length < 0.55 || wordsOf(t) < 1) return '';
  return t;
}
function extract(data, full) {
  if (!full) return (data.confidence || 0) >= 45 ? clean(data.text) : '';
  if (!data.lines) return (data.confidence || 0) >= 55 ? clean(data.text) : '';
  return data.lines
    .filter(l => l.confidence >= 60)
    .map(l => clean(l.text))
    .filter(t => t && wordsOf(t) >= 2)
    .join(' ').slice(0, 400);
}
function splitSpeaker(t) {
  const m = t.match(/^([A-Z][A-Za-z.'\- ]{1,22}?)\s*[:;]\s*(.{2,})$/);
  if (m && m[1].trim().split(/\s+/).length <= 3) return { name: m[1].trim(), line: m[2].trim() };
  return { name: null, line: t };
}

let pending = '', pendingCount = 0, lastDone = '';
async function ocrLoop() {
  if (S.ocrOn && worker && video.readyState >= 2 && !selecting && !(mode === 'file' && video.paused && lastDone && pendingCount > 1)) {
    try {
      const full = !S.region;
      if (grab(full)) {
        await setPsm(full ? '3' : '6');
        const { data } = await worker.recognize(cv);
        onOCR(extract(data, full));
      }
    } catch (e) {}
  }
  setTimeout(ocrLoop, S.interval);
}
function onOCR(t) {
  if (!t) { pending = ''; pendingCount = 0; return; }
  // ننتظر النص يثبت (بعض الألعاب تكتب الحروف وحدة وحدة)
  if (sim(t, pending) > 0.9) pendingCount++;
  else { pending = t; pendingCount = 0; return; }
  if (pendingCount !== 1) return;
  if (sim(t, lastDone) > 0.85) return;
  lastDone = t;
  const { name, line } = splitSpeaker(t);
  handleLine(line, name ? getChar(name) : chars[S.speaker], 'text');
}

/* ---------- الترجمة ---------- */
async function translate(text) {
  const k = text.trim();
  if (cache.has(k)) return cache.get(k);
  let out = null;
  try {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ar&dt=t&q=' + encodeURIComponent(k);
    const j = await (await fetch(u)).json();
    out = j[0].map(x => x[0]).join('');
  } catch (e) {}
  if (!out) {
    try {
      const u = 'https://api.mymemory.translated.net/get?langpair=en|ar&q=' + encodeURIComponent(k);
      const j = await (await fetch(u)).json();
      out = j && j.responseData && j.responseData.translatedText;
    } catch (e) {}
  }
  if (!out) throw new Error('translate');
  cache.set(k, out); saveCache();
  return out;
}

/* ---------- عرض الترجمة ---------- */
const hideT = {};
function showSub(kind, ch, ar, en) {
  const el = kind === 'text' ? $('#subT') : $('#subV');
  el.classList.remove('hide');
  const who = el.querySelector('.who');
  who.textContent = ch && ch.key !== 'narrator' ? ch.ar : '';
  who.style.color = ch ? color(ch.key) : '#fff';
  el.querySelector('.ar').textContent = ar;
  el.querySelector('.en').textContent = S.showEn ? en : '';
  clearTimeout(hideT[kind]);
  hideT[kind] = setTimeout(() => el.classList.add('hide'), 8000 + ar.length * 60);
}
const seqs = { text: 0, voice: 0 };
async function handleLine(en, ch, kind) {
  ch = ch || chars.narrator;
  const id = ++seqs[kind];
  showSub(kind, ch, '…', en);
  let ar;
  try { ar = await translate(en); }
  catch (e) { if (id === seqs[kind]) status('الترجمة ما اشتغلت، تأكد من الإنترنت'); return; }
  if (id !== seqs[kind]) return;
  showSub(kind, ch, ar, en);
  if (!S.speakOn) return;
  // في وضع الفيديو الصوت العربي للكلام المسموع، والنص يظهر مكتوب بس
  if (kind === 'text' && mode === 'file' && segs.length) return;
  speak(ar, ch);
}

/* ---------- الشخصيات ---------- */
function getChar(name) {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'narrator';
  if (!chars[key]) {
    const h = hash(key);
    chars[key] = { key, en: name, ar: name, voice: '', gender: 'm', pitch: +(0.75 + (h % 7) * 0.07).toFixed(2), rate: 1 };
    save(); renderSpk();
    translate(name).then(a => { chars[key].ar = a; save(); renderSpk(); if (!$('#pChars').classList.contains('hide')) renderChars(); }).catch(() => {});
    status('شخصية جديدة: ' + name);
  }
  return chars[key];
}

/* ---------- النطق العربي ---------- */
const MALE = /maged|tarik|naayf|hamed|shakir|majed|male/i;
const FEMALE = /laila|mariam|hoda|zeina|salma|amina|female/i;
function arVoices() { try { return speechSynthesis.getVoices().filter(v => /^ar/i.test(v.lang)); } catch (e) { return []; } }
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { if (!$('#pChars').classList.contains('hide')) renderChars(); };
function pickVoice(ch) {
  const vs = arVoices();
  if (!vs.length) return null;
  if (ch.voice) { const v = vs.find(v => v.voiceURI === ch.voice); if (v) return v; }
  const want = ch.gender === 'm' ? MALE : FEMALE;
  return vs.find(v => want.test(v.name)) || vs.find(v => /SA/i.test(v.lang)) || vs[0];
}
let speaking = false, spkTok = 0;
function speak(text, ch, o = {}) {
  if (!('speechSynthesis' in window)) return;
  const tok = ++spkTok;
  try { speechSynthesis.cancel(); } catch (e) {}
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ar-SA';
  const v = pickVoice(ch);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.pitch = o.pitch ?? ch.pitch; u.rate = o.rate ?? ch.rate; u.volume = 1;
  const done = () => { if (tok !== spkTok) return; speaking = false; resumeRec(); if (o.onend) o.onend(); };
  u.onend = done; u.onerror = done;
  speaking = true; pauseRec();
  speechSynthesis.speak(u);
}
function stopSpeak() { spkTok++; speaking = false; try { speechSynthesis.cancel(); } catch (e) {} }

/* ---------- سماع الشخصيات بالمايك (وضع الكاميرا) ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, recOn = false;
function startRec() {
  if (mode !== 'cam') return;
  if (!SR) {
    S.voiceOn = false; save(); updateBtns();
    status('سماع الأصوات غير مدعوم هنا — استخدم «سفاري» في الآيفون أو «كروم» في الأندرويد', true);
    return;
  }
  if (!rec) {
    rec = new SR();
    rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onstart = () => { recOn = true; };
    rec.onresult = e => {
      let interim = '', fin = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript;
      }
      if (interim && S.showEn && !speaking) showSub('voice', chars[S.speaker], '🎤 …', interim);
      fin = fin.trim();
      if (fin && fin.split(/\s+/).length >= 2 && !speaking) handleLine(fin, chars[S.speaker], 'voice');
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        S.voiceOn = false; save(); updateBtns();
        status('اسمح للموقع باستخدام المايك من إعدادات المتصفح', true);
      }
    };
    rec.onend = () => { recOn = false; resumeRec(); };
  }
  tryStart();
}
function tryStart() { if (rec && !recOn && S.voiceOn && !speaking && mode === 'cam') { try { rec.start(); recOn = true; } catch (e) {} } }
function pauseRec() { if (rec && recOn) { try { rec.abort(); } catch (e) {} } }
function resumeRec() { setTimeout(tryStart, 350); }
function stopRec() { if (rec) { try { rec.abort(); } catch (e) {} } recOn = false; }

/* ---------- وضع الفيديو: سماع الصوت من الفيديو نفسه ---------- */
let segs = [], curSeg = -1, asr = null, prepTok = 0;

async function loadASR() {
  if (asr) return asr;
  let T;
  try { T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3'); }
  catch (e) { T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js'); }
  asr = await T.pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
    progress_callback: p => {
      if (p.status === 'progress' && p.total > 2e6) status('تحميل نموذج سماع الكلام ' + Math.round(p.progress) + '٪ (أول مرة بس)', true);
    }
  });
  return asr;
}

async function fileToPCM(file) {
  const ab = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const buf = await new Promise((res, rej) => {
    const p = ac.decodeAudioData(ab, res, rej);
    if (p && p.then) p.then(res, rej);
  });
  try { ac.close(); } catch (e) {}
  const sr = buf.sampleRate, n = buf.length, chs = buf.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < chs; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / chs; }
  const ratio = sr / 16000, m = Math.floor(n / ratio), out = new Float32Array(m);
  for (let i = 0; i < m; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b && j < n; j++) s += mono[j];
    out[i] = s / (b - a);
  }
  return out;
}

// تقدير طبقة صوت المتكلم الأصلي (بالهرتز)
function estimateF0(x, sr) {
  const frame = 1024, minLag = Math.floor(sr / 400), maxLag = Math.floor(sr / 70), f0s = [];
  for (let p = 0; p + frame + maxLag < x.length; p += 1024) {
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += x[p + i] * x[p + i];
    if (energy / frame < 2e-4) continue;
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < frame; i++) s += x[p + i] * x[p + i + lag];
      if (s > best) { best = s; bestLag = lag; }
    }
    if (bestLag && best / energy > 0.45) f0s.push(sr / bestLag);
  }
  if (f0s.length < 3) return 0;
  f0s.sort((a, b) => a - b);
  return f0s[f0s.length >> 1];
}

function cleanSpeech(t) {
  return String(t || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪/g, ' ').replace(/\s+/g, ' ').trim();
}

async function prepareVoice(file) {
  const tok = ++prepTok;
  segs = []; curSeg = -1;
  try {
    status('أستخرج الصوت من الفيديو…', true);
    const pcm = await fileToPCM(file);
    if (tok !== prepTok) return;
    const secs = pcm.length / 16000;
    if (secs > 600) status('الفيديو طويل، بيطوّل شوي… الأفضل مقطع أقل من ٣ دقايق', true);
    const model = await loadASR();
    if (tok !== prepTok) return;
    status('أسمع كلام الشخصيات في الفيديو… لا تقفل الصفحة', true);
    const r = await model(pcm, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
    if (tok !== prepTok) return;
    const chunks = (r.chunks && r.chunks.length) ? r.chunks : [{ timestamp: [0, secs], text: r.text }];
    const list = chunks.map(c => {
      const st = c.timestamp && c.timestamp[0] != null ? c.timestamp[0] : 0;
      let en = c.timestamp && c.timestamp[1] != null ? c.timestamp[1] : st + 3;
      if (en <= st) en = st + 2;
      return { start: st, end: en, en: cleanSpeech(c.text) };
    }).filter(s => s.en && /[a-z]{2,}/i.test(s.en));
    if (!list.length) { status('ما لقيت كلام إنجليزي في صوت الفيديو', true); return; }
    for (let i = 0; i < list.length; i++) {
      if (tok !== prepTok) return;
      status(`أترجم كلام الشخصيات ${i + 1} من ${list.length}`, true);
      const s = list[i];
      s.f0 = estimateF0(pcm.subarray(Math.floor(s.start * 16000), Math.floor(s.end * 16000)), 16000);
      try { s.ar = await translate(s.en); } catch (e) { s.ar = ''; }
    }
    segs = list.filter(s => s.ar);
    status(`جاهز ✓ ترجمت ${segs.length} جملة من الصوت — شغّل الفيديو`, true);
  } catch (e) {
    if (tok === prepTok) status('ما قدرت أقرأ صوت هذا الفيديو، جرب مقطع ثاني أو تأكد من الإنترنت', true);
  }
}

function playSeg(s) {
  const ch = chars[S.speaker] || chars.narrator;
  showSub('voice', ch, s.ar, s.en);
  if (!S.speakOn) return;
  const dur = Math.max(1, s.end - s.start);
  let rate = ch.rate;
  const need = s.ar.length / (dur * 13);
  if (need > rate) rate = Math.min(1.6, need);
  let pitch = ch.pitch;
  if (S.match && s.f0) pitch = clamp(s.f0 / 115, 0.5, 1.9);
  if (S.muteOrig) video.muted = true;
  speak(s.ar, ch, { pitch, rate, onend: () => { if (mode === 'file') video.muted = false; } });
}
function resetVideoMode() {
  prepTok++; segs = []; curSeg = -1; stopSpeak();
  video.muted = mode === 'cam';
}
function syncTick() {
  if (mode === 'file' && segs.length && !video.paused) {
    const t = video.currentTime;
    const i = segs.findIndex(s => t >= s.start && t < s.end);
    if (i !== -1 && i !== curSeg) { curSeg = i; playSeg(segs[i]); }
  }
  requestAnimationFrame(syncTick);
}
requestAnimationFrame(syncTick);
video.addEventListener('seeking', () => { if (mode !== 'file') return; curSeg = -1; stopSpeak(); video.muted = false; });
video.addEventListener('pause', () => { if (mode !== 'file') return; stopSpeak(); video.muted = false; curSeg = -1; });
video.addEventListener('ended', () => { if (mode === 'file') video.muted = false; });

/* ---------- الأزرار ---------- */
function updateBtns() {
  $('#bOcr').classList.toggle('on', S.ocrOn);
  $('#bVoice').classList.toggle('on', S.voiceOn && mode === 'cam');
  $('#bSpeak').classList.toggle('on', S.speakOn);
  $('#bCam').classList.toggle('on', mode === 'cam');
  $('#bFile').classList.toggle('on', mode === 'file');
}
$('#bOcr').onclick = () => {
  S.ocrOn = !S.ocrOn; save(); updateBtns();
  status(S.ocrOn ? 'قراءة النصوص شغالة' : 'قراءة النصوص طافية');
};
$('#bVoice').onclick = () => {
  if (mode === 'file') { status('في وضع الفيديو الصوت ينسمع ويترجم تلقائياً من الفيديو نفسه'); return; }
  S.voiceOn = !S.voiceOn; save(); updateBtns();
  if (S.voiceOn) { startRec(); status('أسمع أصوات الشخصيات… قرّب الجوال من السماعة'); }
  else { stopRec(); status('سماع الأصوات طافي'); }
};
$('#bSpeak').onclick = () => {
  S.speakOn = !S.speakOn; save(); updateBtns();
  if (!S.speakOn) { stopSpeak(); if (mode === 'file') video.muted = false; }
  status(S.speakOn ? 'النطق العربي شغال' : 'النطق العربي طافي');
};
$('#spk').onchange = e => { S.speaker = e.target.value; save(); status('المتكلم الحين: ' + chars[S.speaker].ar); };
function renderSpk() {
  $('#spk').innerHTML = Object.values(chars).map(c =>
    `<option value="${esc(c.key)}"${c.key === S.speaker ? ' selected' : ''}>🗣️ ${esc(c.ar)}</option>`).join('');
}

/* ---------- اللوحات ---------- */
function closePanels() { $('#pChars').classList.add('hide'); $('#pSet').classList.add('hide'); }
$('#bChars').onclick = () => { closePanels(); renderChars(); $('#pChars').classList.remove('hide'); };
$('#bSet').onclick = () => { closePanels(); fillSettings(); $('#pSet').classList.remove('hide'); };
$('#xChars').onclick = closePanels;
$('#xSet').onclick = closePanels;

function renderChars() {
  const list = $('#charList'), vs = arVoices();
  list.innerHTML = '';
  Object.values(chars).forEach(ch => {
    const d = document.createElement('div');
    d.className = 'char';
    d.innerHTML = `
      <div class="row"><span class="dot" style="background:${color(ch.key)}"></span>
        <input type="text" class="nm" value="${esc(ch.ar)}">
        <button class="t">▶️ تجربة</button>
        ${ch.key !== 'narrator' ? '<button class="x">🗑️</button>' : ''}</div>
      ${ch.en ? `<div class="orig">${esc(ch.en)}</div>` : ''}
      <div class="row"><label>النوع</label>
        <select class="gd">
          <option value="m"${ch.gender === 'm' ? ' selected' : ''}>رجل</option>
          <option value="f"${ch.gender === 'f' ? ' selected' : ''}>امرأة</option>
          <option value="k"${ch.gender === 'k' ? ' selected' : ''}>طفل</option>
        </select></div>
      <div class="row"><label>الصوت</label>
        <select class="vc"><option value="">تلقائي</option>
        ${vs.map(v => `<option value="${esc(v.voiceURI)}"${v.voiceURI === ch.voice ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}
        </select></div>
      <div class="row"><label>طبقة الصوت</label><input type="range" class="pt" min="0.5" max="2" step="0.05" value="${ch.pitch}"></div>
      <div class="row"><label>السرعة</label><input type="range" class="rt" min="0.6" max="1.6" step="0.05" value="${ch.rate}"></div>`;
    d.querySelector('.nm').onchange = e => { ch.ar = e.target.value.trim() || ch.ar; save(); renderSpk(); };
    d.querySelector('.gd').onchange = e => {
      ch.gender = e.target.value;
      ch.pitch = ch.gender === 'm' ? 0.85 : ch.gender === 'f' ? 1.35 : 1.75;
      d.querySelector('.pt').value = ch.pitch; save();
    };
    d.querySelector('.vc').onchange = e => { ch.voice = e.target.value; save(); };
    d.querySelector('.pt').oninput = e => { ch.pitch = +e.target.value; save(); };
    d.querySelector('.rt').oninput = e => { ch.rate = +e.target.value; save(); };
    d.querySelector('.t').onclick = () => speak('أهلاً، أنا ' + ch.ar + '. هذا صوتي في الترجمة.', ch);
    const x = d.querySelector('.x');
    if (x) x.onclick = () => {
      if (!confirm('تحذف ' + ch.ar + '؟')) return;
      delete chars[ch.key]; if (S.speaker === ch.key) S.speaker = 'narrator';
      save(); renderChars(); renderSpk();
    };
    list.appendChild(d);
  });
  if (!vs.length) list.insertAdjacentHTML('afterbegin', '<p class="note">ما لقيت أصوات عربية في جوالك. في الآيفون: الإعدادات ← تسهيلات الاستخدام ← المحتوى المنطوق ← الأصوات ← العربية، ونزّل صوت «ماجد».</p>');
}
$('#bAddChar').onclick = () => {
  const n = prompt('اكتب اسم الشخصية مثل ما يطلع في ترجمة اللعبة (بالإنجليزي):');
  if (!n || !n.trim()) return;
  getChar(n.trim()); renderChars();
};

/* ---------- الإعدادات ---------- */
function applySettings() {
  document.querySelectorAll('.sub').forEach(el => el.style.fontSize = S.font + 'px');
  $('#app').classList.toggle('nocam', S.hideCam);
}
function fillSettings() {
  $('#sMatch').checked = S.match; $('#sMute').checked = S.muteOrig;
  $('#sInt').value = S.interval; $('#vInt').textContent = (S.interval / 1000).toFixed(1) + ' ث';
  $('#sMode').value = S.textMode;
  $('#sThr').value = S.thr; $('#vThr').textContent = S.thr;
  $('#sFont').value = S.font; $('#vFont').textContent = S.font;
  $('#sEn').checked = S.showEn; $('#sHide').checked = S.hideCam;
}
$('#sMatch').onchange = e => { S.match = e.target.checked; save(); };
$('#sMute').onchange = e => { S.muteOrig = e.target.checked; save(); };
$('#sInt').oninput = e => { S.interval = +e.target.value; $('#vInt').textContent = (S.interval / 1000).toFixed(1) + ' ث'; save(); };
$('#sMode').onchange = e => { S.textMode = e.target.value; save(); };
$('#sThr').oninput = e => { S.thr = +e.target.value; $('#vThr').textContent = S.thr; save(); };
$('#sFont').oninput = e => { S.font = +e.target.value; $('#vFont').textContent = S.font; save(); applySettings(); };
$('#sEn').onchange = e => { S.showEn = e.target.checked; save(); };
$('#sHide').onchange = e => { S.hideCam = e.target.checked; save(); applySettings(); };
$('#bClear').onclick = () => { cache.clear(); saveCache(); lastDone = ''; status('انمسحت ذاكرة الترجمات'); };
$('#bReset').onclick = () => {
  if (!confirm('ترجّع كل الإعدادات والشخصيات للبداية؟')) return;
  ['set', 'chars', 'cache'].forEach(k => { try { localStorage.removeItem(KEY + k); } catch (e) {} });
  location.reload();
};
