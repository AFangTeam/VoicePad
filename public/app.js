//
//  app.js —— 界面与实时音频
//
//  实时链路：<video> → MediaElementSource → [EQ 链] → 声道拆分/增益/合并 → 总音量 → 输出
//
//  拖动时**不重建节点**，只改已有 BiquadFilterNode 的参数并用
//  setTargetAtTime 平滑过渡 —— 直接赋值会在音频线程上产生阶跃，听起来就是"咔"。
//

import {
  buildFilters, frequencyResponse, logFreqs,
  makeupGainDb, balanceGains, ffmpegAudioFilter, RANGE,
} from './dsp.js';

// ── 状态 ────────────────────────────────────────────────────

const state = {
  tone: 0,        // -1..1  上下
  balance: 0,     // -1..1  左右
  master: 1,      // 0..1.6
  files: [],
  selected: new Set(),
  current: -1,
};

const $ = (id) => document.getElementById(id);
const video = $('video');

// ── 音频图 ──────────────────────────────────────────────────
//
// 懒初始化：AudioContext 必须由用户手势触发，页面一加载就 new 会被浏览器挂起。

let ctx = null;
let nodes = null;

let audioFailed = false;

function ensureAudio() {
  if (ctx || audioFailed) return;
  try {
    buildAudioGraph();
  } catch (e) {
    // 音频链起不来（自动播放策略 / 设备被占用）不该连画面一起挡住 ——
    // 至少让用户能看、能选、能导出
    audioFailed = true;
    console.warn('音频链初始化失败：', e);
    toast('实时试听不可用，但调音和导出仍然有效');
  }
}

function buildAudioGraph() {
  ctx = new AudioContext();

  const src = ctx.createMediaElementSource(video);

  // EQ 链。节点数量固定 —— 按最大编制建好，用不到的把增益设 0 即可。
  // 这样拖动时永远不用增删节点，也就永远不会有重连造成的爆音。
  const eq = SLOTS.map(() => {
    const f = ctx.createBiquadFilter();
    f.type = 'peaking';
    f.frequency.value = 1000;
    f.Q.value = 1;
    f.gain.value = 0;
    return f;
  });

  const makeup = ctx.createGain();

  // 声道平衡：拆成 L/R 各自加增益再合回去
  const splitter = ctx.createChannelSplitter(2);
  const gainL = ctx.createGain();
  const gainR = ctx.createGain();
  const merger = ctx.createChannelMerger(2);

  const master = ctx.createGain();

  let chain = src;
  for (const f of eq) { chain.connect(f); chain = f; }
  chain.connect(makeup);
  makeup.connect(splitter);
  splitter.connect(gainL, 0);
  splitter.connect(gainR, 1);
  gainL.connect(merger, 0, 0);
  gainR.connect(merger, 0, 1);
  merger.connect(master);
  master.connect(ctx.destination);

  nodes = { eq, makeup, gainL, gainR, master };
  applyAudio(true);
}


// 最大编制：低沉方向 3 个 + 明亮方向 4 个 + 常开低切 1 个。
// 两个方向不会同时生效，所以 1 + max(3,4) = 5 个槽位够用。
const SLOTS = [0, 1, 2, 3, 4];

/** 把当前参数灌进音频节点 */
function applyAudio(immediate = false) {
  if (!nodes) return;
  const fs = ctx.sampleRate;
  const filters = buildFilters(state.tone, fs);
  const t = ctx.currentTime;
  // 15ms 时间常数：快到跟手，又足以避免阶跃造成的咔声
  const TAU = 0.015;
  const set = (param, v) => {
    if (immediate) param.setValueAtTime(v, t);
    else param.setTargetAtTime(v, t, TAU);
  };

  nodes.eq.forEach((node, i) => {
    const f = filters[i];
    if (!f) {
      // 空槽位：留在原地但增益归零，等于直通
      set(node.gain, 0);
      return;
    }
    // type 不是 AudioParam，不能平滑；但只在跨越中点时才会变，
    // 而那一刻增益本来就接近 0，听不出来
    const type = f.type === 'highpass' ? 'highpass'
      : f.type === 'lowshelf' ? 'lowshelf'
      : f.type === 'highshelf' ? 'highshelf' : 'peaking';
    if (node.type !== type) node.type = type;
    set(node.frequency, f.freq);
    // ⚠️ Web Audio 对 lowpass/highpass 的 Q 是**分贝**制
    // （alpha = sin(w0)/(2·10^(Q/20))），而 dsp.js 里按 RBJ 用的是无量纲 Q。
    // 不换算的话低频会差好几个 dB —— 实测 80Hz 偏 3.8 dB。
    if (f.Q != null) {
      set(node.Q, type === 'highpass' ? 20 * Math.log10(f.Q) : f.Q);
    }
    // shelf 类型 Web Audio 会忽略 Q，只用 gain + frequency（固定 S=1），
    // dsp.js 那边也已经写死 S=1，两边一致
    set(node.gain, f.gain || 0);
  });

  // 注意是 .gain —— GainNode 本身不是 AudioParam
  set(nodes.makeup.gain, Math.pow(10, makeupGainDb(filters, fs) / 20));

  const bal = balanceGains(state.balance);
  set(nodes.gainL.gain, bal.left);
  set(nodes.gainR.gain, bal.right);
  set(nodes.master.gain, state.master);
}

// ── 读数与曲线 ──────────────────────────────────────────────

function toneWord(t) {
  if (t > 0.62) return '玻璃质感';
  if (t > 0.22) return '通透';
  if (t > -0.22) return '中性';
  if (t > -0.62) return '温暖';
  return '低沉磁性';
}

function balWord(b) {
  if (Math.abs(b) < 0.06) return '居中';
  return b < 0 ? '偏左' : '偏右';
}

const curve = $('curve');
const cctx = curve.getContext('2d');
const FREQS = logFreqs(260);

function drawCurve() {
  const filters = buildFilters(state.tone, 48000);
  const resp = frequencyResponse(filters, FREQS, 48000);

  const dpr = window.devicePixelRatio || 1;
  const W = curve.clientWidth * dpr;
  const H = curve.clientHeight * dpr;
  if (curve.width !== W || curve.height !== H) { curve.width = W; curve.height = H; }

  cctx.clearRect(0, 0, W, H);
  const RANGE_DB = 10;
  const y = (db) => H / 2 - (db / RANGE_DB) * (H / 2) * 0.86;

  // 0 dB 基准线
  cctx.strokeStyle = 'rgba(255,255,255,0.10)';
  cctx.lineWidth = 1 * dpr;
  cctx.beginPath(); cctx.moveTo(0, y(0)); cctx.lineTo(W, y(0)); cctx.stroke();

  // 频率参考刻度
  cctx.fillStyle = 'rgba(255,255,255,0.22)';
  cctx.font = `${9 * dpr}px -apple-system, sans-serif`;
  for (const hz of [100, 1000, 10000]) {
    const x = (Math.log10(hz / 20) / Math.log10(20000 / 20)) * W;
    cctx.fillRect(x, 0, 1 * dpr, H);
    cctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x + 3 * dpr, H - 3 * dpr);
  }

  // 曲线本体 + 填充
  cctx.beginPath();
  resp.forEach((db, i) => {
    const x = (i / (resp.length - 1)) * W;
    i ? cctx.lineTo(x, y(db)) : cctx.moveTo(x, y(db));
  });
  const grad = cctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(240,164,74,0.22)');
  grad.addColorStop(1, 'rgba(240,164,74,0)');
  cctx.save();
  cctx.lineTo(W, y(0)); cctx.lineTo(0, y(0)); cctx.closePath();
  cctx.fillStyle = grad; cctx.fill();
  cctx.restore();

  cctx.beginPath();
  resp.forEach((db, i) => {
    const x = (i / (resp.length - 1)) * W;
    i ? cctx.lineTo(x, y(db)) : cctx.moveTo(x, y(db));
  });
  cctx.strokeStyle = '#f0a44a';
  cctx.lineWidth = 1.6 * dpr;
  cctx.lineJoin = 'round';
  cctx.stroke();
}

function render() {
  const pad = $('pad');
  const r = pad.clientWidth / 2;
  // puck 限制在半径内 —— 圆形面板，超出去看着就是坏的
  const px = r + state.balance * r * 0.84;
  const py = r - state.tone * r * 0.84;
  $('puck').style.left = `${px}px`;
  $('puck').style.top = `${py}px`;
  $('padGlow').style.left = `${px}px`;
  $('padGlow').style.top = `${py}px`;
  $('padGlow').style.opacity = Math.min(1, Math.hypot(state.balance, state.tone));

  // puck 靠近哪一侧，就把那一侧的提示淡掉
  const near = Math.abs(state.tone) > Math.abs(state.balance)
    ? (state.tone > 0.55 ? 't' : state.tone < -0.55 ? 'b' : '')
    : (state.balance > 0.55 ? 'r' : state.balance < -0.55 ? 'l' : '');
  pad.dataset.near = near;

  $('toneLabel').textContent = toneWord(state.tone);
  $('toneValue').textContent = state.tone.toFixed(2);
  $('balLabel').textContent = balWord(state.balance);
  $('balValue').textContent = state.balance.toFixed(2);
  $('masterValue').textContent = `${Math.round(state.master * 100)}%`;

  drawCurve();
  applyAudio();
}

// ── 面板拖动 ────────────────────────────────────────────────

const pad = $('pad');

function padUpdate(e) {
  const rect = pad.getBoundingClientRect();
  const r = rect.width / 2;
  let dx = (e.clientX - rect.left - r) / (r * 0.84);
  let dy = (e.clientY - rect.top - r) / (r * 0.84);
  // 夹在单位圆内，保持圆形面板的语义（角落不该比边缘更极端）
  const len = Math.hypot(dx, dy);
  if (len > 1) { dx /= len; dy /= len; }
  state.balance = Math.max(-1, Math.min(1, dx));
  state.tone = Math.max(-1, Math.min(1, -dy));
  render();
}

let dragging = false;

pad.addEventListener('pointerdown', (e) => {
  ensureAudio();
  // 捕获失败不该中断手势本身 —— 拖动比"指针锁定"重要，
  // 而且捕获在某些注入/无障碍场景下会抛
  try { pad.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  dragging = true;
  pad.classList.add('dragging');
  padUpdate(e);
});
pad.addEventListener('pointermove', (e) => {
  if (dragging) padUpdate(e);
});
const endDrag = (e) => {
  if (!dragging) return;
  dragging = false;
  try { pad.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
  pad.classList.remove('dragging');
};
pad.addEventListener('pointerup', endDrag);
pad.addEventListener('pointercancel', endDrag);
// 指针在面板外松开也要收尾，否则会一直粘着鼠标
window.addEventListener('pointerup', endDrag);

$('reset').addEventListener('click', () => {
  state.tone = 0; state.balance = 0;
  render();
});

$('master').addEventListener('input', (e) => {
  ensureAudio();
  state.master = Number(e.target.value) / 100;
  render();
});

// 方向键微调 —— 精调时鼠标不够准
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const step = e.shiftKey ? 0.01 : 0.05;
  const map = {
    ArrowUp: () => state.tone = Math.min(1, state.tone + step),
    ArrowDown: () => state.tone = Math.max(-1, state.tone - step),
    ArrowLeft: () => state.balance = Math.max(-1, state.balance - step),
    ArrowRight: () => state.balance = Math.min(1, state.balance + step),
  };
  if (map[e.key]) { e.preventDefault(); ensureAudio(); map[e.key](); render(); }
  if (e.code === 'Space' && state.current >= 0) {
    e.preventDefault();
    ensureAudio();
    video.paused ? video.play() : video.pause();
  }
});

// ── 素材 ────────────────────────────────────────────────────

function fmtDuration(sec) {
  if (!sec) return '—';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function renderClips() {
  const ul = $('clipList');
  ul.innerHTML = '';
  state.files.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = i === state.current ? 'active' : '';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(i);
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      cb.checked ? state.selected.add(i) : state.selected.delete(i);
      syncExportButton();
    });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${fmtDuration(f.duration)} · ${fmtSize(f.size)}`;

    const st = document.createElement('span');
    st.className = 'state';
    st.dataset.index = String(i);

    li.append(cb, name, meta, st);
    li.addEventListener('click', () => open(i));
    ul.appendChild(li);
  });
  $('clipsCount').textContent = `${state.files.length} 条素材`;
  syncExportButton();
}

function open(i) {
  const f = state.files[i];
  if (!f) return;
  state.current = i;
  ensureAudio();
  video.src = `/api/media?path=${encodeURIComponent(f.path)}`;
  video.play().catch(() => {});
  document.querySelector('.viewer').classList.add('has-video');
  renderClips();
}

function syncExportButton() {
  const n = state.selected.size;
  $('exportBtn').disabled = n === 0;
  $('exportBtn').textContent = n > 1 ? `导出选中 ${n} 条` : '导出选中素材';
}

$('picker').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dir = $('dir').value.trim();
  if (!dir) return;
  try {
    const res = await fetch(`/api/browse?dir=${encodeURIComponent(dir)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (!data.files.length) return toast('这个目录里没有视频');
    state.files = data.files;
    state.selected = new Set(data.files.map((_, i) => i));
    state.current = -1;
    $('clips').hidden = false;
    renderClips();
    open(0);
    localStorage.setItem('voicepad.dir', dir);
  } catch (err) {
    toast(err.message || '打开失败');
  }
});

$('selectAll').addEventListener('change', (e) => {
  state.selected = e.target.checked
    ? new Set(state.files.map((_, i) => i))
    : new Set();
  renderClips();
});

// ── 导出 ────────────────────────────────────────────────────

$('exportBtn').addEventListener('click', async () => {
  const picked = [...state.selected].sort((a, b) => a - b).map((i) => ({
    index: i,
    path: state.files[i].path,
    duration: state.files[i].duration,
  }));
  if (!picked.length) return;

  // 导出用的滤镜串由**同一个 dsp.js**生成，和预览听到的是同一套系数
  const filter = ffmpegAudioFilter(
    { tone: state.tone, balance: state.balance, master: state.master },
    ctx ? ctx.sampleRate : 48000
  );

  $('exportBtn').disabled = true;
  $('progress').hidden = false;
  document.querySelectorAll('.state').forEach((el) => { el.textContent = ''; el.className = 'state'; });

  let doneCount = 0;
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: picked, filter }),
  });

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const stateEl = (i) => document.querySelector(`.state[data-index="${i}"]`);

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop();
    for (const chunk of chunks) {
      const line = chunk.replace(/^data: /, '');
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const real = picked[msg.index]?.index;

      if (msg.type === 'start') {
        const el = stateEl(real); if (el) el.textContent = '导出中';
        $('progressText').textContent = `${msg.name}（${doneCount + 1}/${picked.length}）`;
      } else if (msg.type === 'progress') {
        const pct = msg.duration ? Math.min(1, msg.seconds / msg.duration) : 0;
        const overall = (doneCount + pct) / picked.length;
        $('progressFill').style.width = `${overall * 100}%`;
      } else if (msg.type === 'done') {
        doneCount++;
        const el = stateEl(real); if (el) { el.textContent = '已导出'; el.className = 'state ok'; }
        $('progressFill').style.width = `${(doneCount / picked.length) * 100}%`;
      } else if (msg.type === 'error') {
        doneCount++;
        const el = stateEl(real); if (el) { el.textContent = '失败'; el.className = 'state err'; }
        toast(msg.message);
      } else if (msg.type === 'all-done') {
        $('progressText').textContent = '完成';
        toast(`导出完成，文件在素材旁边（_voicepad 后缀）`);
        setTimeout(() => { $('progress').hidden = true; $('progressFill').style.width = '0'; }, 1600);
      }
    }
  }
  $('exportBtn').disabled = false;
});

// ── 杂项 ────────────────────────────────────────────────────

let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

window.addEventListener('resize', render);

const saved = localStorage.getItem('voicepad.dir');
if (saved) $('dir').value = saved;

render();
