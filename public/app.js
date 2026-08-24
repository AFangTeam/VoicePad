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
  makeupGainDb, blendWeights, ffmpegAudioFilter, RANGE,
} from './dsp.js';

// ── 状态 ────────────────────────────────────────────────────

const state = {
  tone: 0,        // -1..1  上下：音色
  balance: 0,     // -1..1  左右：两条输入声道 blend 成一路单声道的配比
  master: 1,      // 0..1.6
  // 双声道监听：只是听一下原始双轨长什么样的**监听工具**，
  // 不影响导出 —— 导出永远是调好的那一路单声道。
  stereoMonitor: false,
  files: [],
  selected: new Set(),
  current: -1,
};

/** ⌘C 存下来的甜点值 */
let clipboard = null;

/**
 * 方向键归谁管。
 *
 * 同一组方向键在两个地方都有意义：在 pad 上是微调音色，在素材区是切换素材。
 * 按"最后点了哪儿"分派 —— 点了视频画面或胶片条就是 'clips'，点了 pad 就是 'pad'。
 * 界面上给出明确的焦点描边，不让用户猜现在按方向键会发生什么。
 */
let focusZone = 'clips';

function setFocusZone(zone) {
  if (focusZone === zone) return;
  focusZone = zone;
  document.querySelector('.stage').classList.toggle('zone-clips', zone === 'clips');
  document.querySelector('.panel').classList.toggle('zone-pad', zone === 'pad');
}

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

  // ⚠️ 声道纠正的关键。
  //
  // MediaElementSource 的输出声道数**跟着媒体走**：单声道视频就是 1 声道。
  // 而 ChannelSplitter 是 discrete 解释 —— 单声道进去，右声道输出是静音。
  // 后果：相机里常见的单声道素材，预览只有左耳有声；往右拽平衡时
  // 近侧是"抬高一条静音轨"，整个声音近乎消失。
  //
  // 导出那条路没这个问题（ffmpeg 侧 aformat 先升立体声），
  // 也就是说这是一个"预览≠导出"—— 本 app 最不能容忍的一类 bug。
  //
  // 修法：入口处放一个 speakers 解释的节点，单声道自动复制到双声道，
  // 立体声素材原样通过。和 ffmpeg 的 mono→stereo 默认升混（两路等增益）一致。
  const upmix = ctx.createGain();
  upmix.channelCount = 2;
  upmix.channelCountMode = 'explicit';
  upmix.channelInterpretation = 'speakers';
  src.connect(upmix);

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

  // 声道 blend：拆成 L/R、各自配重、**合成一路单声道**。
  //
  // 注意 merger 的两个输入都接同一路 blend 结果 —— 这样出来的
  // 左右耳内容完全相同，也就是真正的单声道（只是用双声道容器播）。
  const splitter = ctx.createChannelSplitter(2);
  const gainL = ctx.createGain();
  const gainR = ctx.createGain();
  const blendSum = ctx.createGain();
  const merger = ctx.createChannelMerger(2);

  const master = ctx.createGain();

  // 双声道监听旁路：直接从 upmix 取原始双轨，绕过 EQ 和 blend。
  // 走独立的增益节点，切换时只在两条支路间交叉淡入淡出，不重连图。
  const monitorTap = ctx.createGain();
  const processedTap = ctx.createGain();

  let chain = upmix;
  for (const f of eq) { chain.connect(f); chain = f; }
  chain.connect(makeup);
  makeup.connect(splitter);
  splitter.connect(gainL, 0);
  splitter.connect(gainR, 1);
  gainL.connect(blendSum);
  gainR.connect(blendSum);
  // 同一路送进左右两个输入 = 单声道
  blendSum.connect(merger, 0, 0);
  blendSum.connect(merger, 0, 1);
  merger.connect(processedTap);
  processedTap.connect(master);

  upmix.connect(monitorTap);
  monitorTap.connect(master);

  master.connect(ctx.destination);

  // 左右声道电平表。装它有两个理由：真实音频驱动的动态是最诚实的
  // "界面活着"的信号；而且声道对不对，看一眼两条表就知道，不用戴耳机猜。
  const meterSplit = ctx.createChannelSplitter(2);
  const anL = ctx.createAnalyser();
  const anR = ctx.createAnalyser();
  anL.fftSize = 512;
  anR.fftSize = 512;
  master.connect(meterSplit);
  meterSplit.connect(anL, 0);
  meterSplit.connect(anR, 1);

  nodes = { eq, makeup, gainL, gainR, master, anL, anR, monitorTap, processedTap };
  applyAudio(true);
  startMeters();
}

// ── 电平表动画 ──────────────────────────────────────────────

const meterBuf = new Float32Array(512);
let meterShown = { l: 0, r: 0 };

function channelLevel(analyser) {
  analyser.getFloatTimeDomainData(meterBuf);
  let sum = 0;
  for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
  const db = 20 * Math.log10(Math.sqrt(sum / meterBuf.length) + 1e-9);
  // -48dB..0dB 映射到 0..1
  return Math.max(0, Math.min(1, (db + 48) / 48));
}

function startMeters() {
  // setInterval 而不是 requestAnimationFrame：RAF 在后台标签页会被完全冻结，
  // 切回来表针会"跳"一下；而这个 tick 只是一次 512 点 RMS + 两次样式写入，
  // 33ms 一次的开销可以忽略。
  setInterval(() => {
    if (!nodes) return;
    const l = channelLevel(nodes.anL);
    const r = channelLevel(nodes.anR);
    // 快攻慢放 —— 表针弹起要快，回落要有阻尼，和硬件 VU 一个手感
    meterShown.l = l > meterShown.l ? l : meterShown.l * 0.86;
    meterShown.r = r > meterShown.r ? r : meterShown.r * 0.86;
    $('meterL').style.height = `${(meterShown.l * 100).toFixed(1)}%`;
    $('meterR').style.height = `${(meterShown.r * 100).toFixed(1)}%`;
  }, 33);
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

  const w = blendWeights(state.balance);
  set(nodes.gainL.gain, w.left);
  set(nodes.gainR.gain, w.right);
  set(nodes.master.gain, state.master);

  // 监听切换：两条支路交叉淡入淡出。用 TAU 平滑而不是直接切，
  // 否则按一下按钮就是"啪"的一声。
  set(nodes.monitorTap.gain, state.stereoMonitor ? 1 : 0);
  set(nodes.processedTap.gain, state.stereoMonitor ? 0 : 1);
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
  if (b <= -0.97) return '仅左声道';
  if (b >= 0.97) return '仅右声道';
  if (Math.abs(b) < 0.06) return '两轨等量';
  return b < 0 ? '偏左声道' : '偏右声道';
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
  const liveFill = (getComputedStyle(document.documentElement)
    .getPropertyValue('--live').trim() || '#f0a44a');
  const grad = cctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, `${liveFill}38`);
  grad.addColorStop(1, `${liveFill}00`);
  cctx.save();
  cctx.lineTo(W, y(0)); cctx.lineTo(0, y(0)); cctx.closePath();
  cctx.fillStyle = grad; cctx.fill();
  cctx.restore();

  cctx.beginPath();
  resp.forEach((db, i) => {
    const x = (i / (resp.length - 1)) * W;
    i ? cctx.lineTo(x, y(db)) : cctx.moveTo(x, y(db));
  });
  const live = getComputedStyle(document.documentElement)
    .getPropertyValue('--live').trim() || '#f0a44a';
  cctx.strokeStyle = live;
  cctx.lineWidth = 1.6 * dpr;
  cctx.lineJoin = 'round';
  cctx.stroke();
}

/**
 * 音色 → 界面"活色"。
 *
 * 苹果调色台的手感有一半来自"界面在跟着你的操作呼吸"。这里让强调色随
 * 音色偏移轻微变温：往明亮方向偏冷白，往磁性方向偏深暖。幅度刻意压得
 * 很小 —— 界面底色保持中性（带色偏会干扰听感判断），只有"当前值"在变。
 */
function blendHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh) => Math.round(((pa >> sh) & 255) + (((pb >> sh) & 255) - ((pa >> sh) & 255)) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

function liveColor() {
  const t = state.tone;
  if (t >= 0) return blendHex('#f0a44a', '#b7d8ff', t * 0.8);   // 明亮 → 冷白
  return blendHex('#f0a44a', '#ff7a45', -t * 0.55);              // 磁性 → 深暖
}

// ── 点阵 pad（方案 C · 语义冷暖）────────────────────────────
//
// 参考 Final Cut Camera 的调色 pad：圆角方形 + 点阵，靠近 puck 的点
// 放大变亮；点色按行从冷白（上 = 通透）渐到琥珀（下 = 磁性）——
// 颜色不是装饰，是方向语义本身，不读字也知道往哪拽是什么音色。

const padCanvas = $('padCanvas');
const padCtx = padCanvas.getContext('2d');
const PAD_GRID = 11;

function roundedRectPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawPad() {
  const cssSize = pad.clientWidth;
  if (cssSize < 10) return;
  const dpr = window.devicePixelRatio || 1;
  const S = Math.round(cssSize * dpr);
  if (padCanvas.width !== S) { padCanvas.width = S; padCanvas.height = S; }

  const c = padCtx;
  const R = S * 0.215;
  // puck 的归一化位置（0..1，原点左上）
  const nx = 0.5 + state.balance * 0.42;
  const ny = 0.5 - state.tone * 0.42;

  c.clearRect(0, 0, S, S);
  roundedRectPath(c, 0, 0, S, S, R);
  c.save();
  c.clip();

  // 底色
  const base = c.createLinearGradient(0, 0, 0, S);
  base.addColorStop(0, '#1b1d21');
  base.addColorStop(1, '#111316');
  c.fillStyle = base;
  c.fillRect(0, 0, S, S);

  // 上冷下暖的语义洇染
  const wash = (fx, fy, fr, color) => {
    const g = c.createRadialGradient(fx * S, fy * S, 0, fx * S, fy * S, fr * S);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
  };
  wash(0.5, -0.08, 0.95, 'rgba(142,186,255,0.17)');
  wash(0.5, 1.08, 0.95, 'rgba(242,158,70,0.22)');

  // puck 周围的活色光晕（强度随偏移量走）
  const deflect = Math.min(1, Math.hypot(state.balance, state.tone));
  if (deflect > 0.02) {
    const live = getComputedStyle(document.documentElement)
      .getPropertyValue('--live').trim() || '#f0a44a';
    wash(nx, ny, 0.4, `${live}${Math.round(66 * deflect).toString(16).padStart(2, '0')}`);
  }

  // 点阵
  const margin = S * 0.085;
  const span = S - margin * 2;
  const sigma = S * 0.20;
  const baseR = S * 0.008;
  const px = nx * S, py = ny * S;

  for (let row = 0; row < PAD_GRID; row++) {
    const t = row / (PAD_GRID - 1);
    // 冷白 → 琥珀
    const rr = 180 + (242 - 180) * t | 0;
    const gg = 204 + (180 - 204) * t | 0;
    const bb = 236 + (122 - 236) * t | 0;
    for (let col = 0; col < PAD_GRID; col++) {
      const x = margin + (col / (PAD_GRID - 1)) * span;
      const y = margin + (row / (PAD_GRID - 1)) * span;
      const d = Math.hypot(x - px, y - py);
      const swell = Math.exp(-(d * d) / (2 * sigma * sigma));
      c.beginPath();
      c.arc(x, y, baseR * (1 + 2.6 * swell), 0, Math.PI * 2);
      c.fillStyle = `rgba(${rr},${gg},${bb},${(0.24 + 0.6 * swell).toFixed(3)})`;
      c.fill();
    }
  }

  // 中心基准环
  c.beginPath();
  c.arc(S / 2, S / 2, S * 0.014, 0, Math.PI * 2);
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = Math.max(1.5, S * 0.004);
  c.stroke();

  c.restore();

  // 边框
  roundedRectPath(c, dpr, dpr, S - dpr * 2, S - dpr * 2, R);
  c.strokeStyle = 'rgba(255,255,255,0.10)';
  c.lineWidth = dpr * 1.4;
  c.stroke();
}

/** 监听模式下的"空转"光点位置（归一化，0..1） */
let ghost = null;

function paintGhost() {
  if (!ghost) return;
  const w = pad.clientWidth;
  $('puck').style.left = `${w * ghost.x}px`;
  $('puck').style.top = `${w * ghost.y}px`;
}

function render() {
  const pad = $('pad');
  document.documentElement.style.setProperty('--live', liveColor());
  const w = pad.clientWidth;
  // 方形面板：两轴各自独立，角落 = 两个维度同时拉满（语义成立：明亮 + 全左）
  const px = w * (0.5 + state.balance * 0.42);
  const py = w * (0.5 - state.tone * 0.42);
  $('puck').style.left = `${px}px`;
  $('puck').style.top = `${py}px`;
  drawPad();

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
  // 双声道监听时：**光点照样跟手，但数值不写回**。
  // 这正是用户要的手感 —— 拖得动、看得见位置，但明确没生效。
  const rect = pad.getBoundingClientRect();
  if (rect.width < 1) return;
  if (state.stereoMonitor) {
    const gx = (e.clientX - rect.left) / rect.width;
    const gy = (e.clientY - rect.top) / rect.height;
    ghost = {
      x: Math.max(0.08, Math.min(0.92, gx)),
      y: Math.max(0.08, Math.min(0.92, gy)),
    };
    paintGhost();
    return;
  }
  // 方形面板：每轴独立夹取。0.42 是点阵可视范围的半宽，
  // 和 render() 里的正向映射必须是同一个数，否则 puck 会跟不上手指
  const dx = (e.clientX - rect.left - rect.width / 2) / (rect.width * 0.42);
  const dy = (e.clientY - rect.top - rect.height / 2) / (rect.height * 0.42);
  state.balance = Math.max(-1, Math.min(1, dx));
  state.tone = Math.max(-1, Math.min(1, -dy));
  render();
}

let dragging = false;

// 点视频画面：拿焦点 + 播放/暂停。这是对着一个播放器最本能的两个期待
video.addEventListener('click', () => {
  setFocusZone('clips');
  ensureAudio();
  video.paused ? video.play() : video.pause();
});
document.querySelector('.viewer').addEventListener('pointerdown', () => setFocusZone('clips'));
$('clipList').addEventListener('pointerdown', () => setFocusZone('clips'));
$('transport').addEventListener('pointerdown', () => setFocusZone('clips'));

// 胶片条：把纵向滚轮转成横向，鼠标用户也能滑
$('clipList').addEventListener('wheel', (e) => {
  const strip = $('clipList');
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;   // 触控板横滑，交给浏览器
  if (strip.scrollWidth <= strip.clientWidth) return;
  e.preventDefault();
  strip.scrollLeft += e.deltaY;
}, { passive: false });

pad.addEventListener('pointerdown', (e) => {
  setFocusZone('pad');
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
  // 回弹动画只在归零时开 —— 拖动期间开着 transition 会让 puck 拖后腿
  pad.classList.add('settle');
  setTimeout(() => pad.classList.remove('settle'), 550);
  state.tone = 0; state.balance = 0;
  render();
});

document.querySelector('.panel').addEventListener('pointerdown', () => setFocusZone('pad'));

$('monitorBtn').addEventListener('click', () => {
  ensureAudio();
  state.stereoMonitor = !state.stereoMonitor;
  $('monitorBtn').setAttribute('aria-pressed', String(state.stereoMonitor));
  pad.classList.toggle('monitoring', state.stereoMonitor);
  if (!state.stereoMonitor) {
    // 退出监听：光点弹回真实参数位置
    ghost = null;
    pad.classList.add('settle');
    setTimeout(() => pad.classList.remove('settle'), 550);
  }
  render();
});

// ── 甜点值 复制 / 粘贴 ──────────────────────────────────────

/**
 * 把面板上的三个值抓成一个普通对象。
 *
 * 只存 tone / balance / master —— 这三个才是"这条素材要怎么调"。
 * stereoMonitor 是监听开关，属于人当下想听什么，不属于素材，故意不进快照：
 * 否则粘贴一次甜点值会顺手把别人的监听状态也改掉。
 */
function snapshotParams() {
  return { tone: state.tone, balance: state.balance, master: state.master };
}

/** 快照写回面板。走 render() 而不是直接改 DOM，声音和画面一起跟上 */
function loadParams(p) {
  if (!p) return;
  state.tone = Math.max(-1, Math.min(1, Number(p.tone) || 0));
  state.balance = Math.max(-1, Math.min(1, Number(p.balance) || 0));
  state.master = Math.max(0, Math.min(1.6, p.master == null ? 1 : Number(p.master)));
  $('master').value = String(Math.round(state.master * 100));
  ensureAudio();
  render();
}

function copyParams() {
  clipboard = snapshotParams();
  const note = $('presetNote');
  note.textContent =
    `已复制：${toneWord(clipboard.tone)} ${clipboard.tone.toFixed(2)} · ` +
    `${balWord(clipboard.balance)} ${clipboard.balance.toFixed(2)} · ` +
    `${Math.round(clipboard.master * 100)}%`;
  note.classList.add('armed');
  $('pasteBtn').disabled = false;
  toast('已复制甜点值 —— 选中其他素材后 ⌘V 应用');
}

function pasteParams() {
  if (!clipboard) return toast('还没有复制过甜点值');
  const targets = [...state.selected];
  if (!targets.length) return toast('先在列表里勾选要应用的素材');

  for (const i of targets) {
    if (state.files[i]) state.files[i].params = { ...clipboard };
  }
  // 当前正在看的这条也在选中集里的话，面板同步更新
  if (targets.includes(state.current)) loadParams({ ...clipboard });
  renderClips();
  toast(`已应用到 ${targets.length} 条素材`);
}

$('copyBtn').addEventListener('click', copyParams);
$('pasteBtn').addEventListener('click', pasteParams);

$('master').addEventListener('input', (e) => {
  ensureAudio();
  state.master = Number(e.target.value) / 100;
  render();
});

// 方向键微调 —— 精调时鼠标不够准
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  // ⌘C / ⌘V —— 甜点值的复制粘贴
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
    e.preventDefault(); copyParams(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') {
    e.preventDefault(); pasteParams(); return;
  }

  // 首尾素材
  if (e.key === 'Home') { e.preventDefault(); open(0); return; }
  if (e.key === 'End') { e.preventDefault(); open(state.files.length - 1); return; }

  // 方向键：素材区切素材，pad 区微调音色
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    if (focusZone === 'clips') {
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
      // 素材区的上下留给播放头：跳 ±5 秒，比切素材更符合直觉
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const d = e.key === 'ArrowUp' ? 5 : -5;
        if (isFinite(video.duration)) {
          video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + d));
        }
      }
      return;
    }
    // pad 区：微调
    const inc = e.shiftKey ? 0.01 : 0.05;
    ensureAudio();
    if (e.key === 'ArrowUp') state.tone = Math.min(1, state.tone + inc);
    if (e.key === 'ArrowDown') state.tone = Math.max(-1, state.tone - inc);
    if (e.key === 'ArrowLeft') state.balance = Math.max(-1, state.balance - inc);
    if (e.key === 'ArrowRight') state.balance = Math.min(1, state.balance + inc);
    render();
    return;
  }

  if (e.code === 'Space' && state.current >= 0) {
    e.preventDefault();
    ensureAudio();
    video.paused ? video.play() : video.pause();
    return;
  }

  // M 切监听、R 归零 —— 常用到值得给个单键
  if (e.key.toLowerCase() === 'm' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault(); $('monitorBtn').click(); return;
  }
  if (e.key.toLowerCase() === 'r' && !e.metaKey && !e.ctrlKey) {
    e.preventDefault(); $('reset').click(); return;
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

/**
 * 胶片条。
 *
 * 原来是纵向细条列表，几十条素材挤在一条狭长区域里上下滚 —— 选片时
 * 既看不见画面也滑不顺手。改成横向铺开 + 特征图（参考 Cubic 调色面板
 * 下方那条），触控板双指左右滑就是最自然的操作。
 */
function renderClips() {
  const strip = $('clipList');
  strip.innerHTML = '';

  state.files.forEach((f, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell' + (i === state.current ? ' active' : '');
    cell.dataset.index = String(i);

    // 缩略图
    const thumb = document.createElement('div');
    thumb.className = 'cell-thumb';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.addEventListener('load', () => thumb.classList.add('ready'));
    img.addEventListener('error', () => thumb.classList.add('failed'));
    thumb.appendChild(img);
    queueThumb(f, img);

    // 勾选：单独一个角标，点它不会连带切换素材
    const pick = document.createElement('button');
    pick.className = 'cell-pick' + (state.selected.has(i) ? ' on' : '');
    pick.type = 'button';
    pick.title = '选中用于批量导出';
    pick.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.selected.has(i)) state.selected.delete(i);
      else state.selected.add(i);
      pick.classList.toggle('on');
      cell.classList.toggle('picked', state.selected.has(i));
      syncSelectAll();
      syncExportButton();
    });
    thumb.appendChild(pick);

    // 时长压在缩略图右下
    const dur = document.createElement('span');
    dur.className = 'cell-dur';
    dur.textContent = fmtDuration(f.duration);
    thumb.appendChild(dur);

    // 已调 / 导出状态
    const badge = document.createElement('span');
    badge.className = 'cell-badge';
    badge.dataset.index = String(i);
    if (f.params) { badge.classList.add('tuned'); badge.textContent = '已调'; }
    thumb.appendChild(badge);

    const name = document.createElement('span');
    name.className = 'cell-name';
    name.textContent = f.name;
    name.title = f.name;

    cell.append(thumb, name);
    if (state.selected.has(i)) cell.classList.add('picked');
    cell.addEventListener('click', () => { focusZone = 'clips'; open(i); });
    strip.appendChild(cell);
  });

  $('clipsCount').textContent = `${state.files.length} 条素材`;
  syncSelectAll();
  syncExportButton();
  scrollCurrentIntoView();
}

/** 全选框跟随实际勾选状态（含半选） */
function syncSelectAll() {
  const box = $('selectAll');
  const n = state.selected.size, total = state.files.length;
  box.checked = n === total && total > 0;
  box.indeterminate = n > 0 && n < total;
}

/** 让当前素材滚进视野 —— 方向键连按时必须跟着走 */
function scrollCurrentIntoView() {
  const cell = $('clipList').querySelector(`.cell[data-index="${state.current}"]`);
  cell?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

// ── 缩略图取用 ──────────────────────────────────────────────
//
// 限流 3 条并发：文件夹模式每张都要 ffmpeg 抽帧，一次放几十个请求
// 会让服务端排队、页面看起来卡住；拖放模式更要限，那是在浏览器里解码。

const thumbQueue = [];
let thumbActive = 0;

function queueThumb(file, img) {
  thumbQueue.push({ file, img });
  pumpThumbs();
}

function pumpThumbs() {
  while (thumbActive < 3 && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbActive++;
    loadThumb(job.file, job.img).finally(() => { thumbActive--; pumpThumbs(); });
  }
}

async function loadThumb(file, img) {
  // 服务端有路径就交给 ffmpeg 抽 —— 比浏览器解码快得多，也不抢硬解码器
  if (file.path) {
    img.src = `/api/thumb?path=${encodeURIComponent(file.path)}`;
    return;
  }
  // 拖放进来的只有 File 对象，只能在浏览器里抓一帧
  if (file.thumbURL) { img.src = file.thumbURL; return; }
  try {
    file.thumbURL = await grabFrame(file.file);
    img.src = file.thumbURL;
  } catch { img.dispatchEvent(new Event('error')); }
}

/** 用一个离屏 <video> 抓 10% 处的一帧，画进 canvas 转 blob URL */
function grabFrame(fileObj) {
  return new Promise((ok, fail) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'metadata';
    const url = URL.createObjectURL(fileObj);
    let done = false;
    const cleanup = () => { URL.revokeObjectURL(url); v.src = ''; };

    const bail = () => { if (!done) { done = true; cleanup(); fail(new Error('抓帧失败')); } };
    v.onerror = bail;
    // 兜底：某些容器 seek 不回调，别让队列卡死
    const timer = setTimeout(bail, 6000);

    v.onloadedmetadata = () => {
      // 开头常是黑场，取 10% 处
      v.currentTime = Math.min(1, (v.duration || 2) * 0.1);
    };
    v.onseeked = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        const w = 256;
        const h = Math.max(2, Math.round(w * (v.videoHeight / v.videoWidth)) || 144);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(v, 0, 0, w, h);
        cv.toBlob((b) => {
          cleanup();
          b ? ok(URL.createObjectURL(b)) : fail(new Error('编码失败'));
        }, 'image/jpeg', 0.8);
      } catch (e) { cleanup(); fail(e); }
    };
    v.src = url;
  });
}

function open(i) {
  const f = state.files[i];
  if (!f) return;

  // 换素材前把当前调好的值存回上一条 —— 否则一切走就白调了
  if (state.current >= 0 && state.files[state.current]) {
    state.files[state.current].params = snapshotParams();
  }

  state.current = i;
  ensureAudio();

  // 这条素材有自己的参数就恢复，没有就沿用当前面板（连续调多条时更顺手）
  if (f.params) loadParams(f.params);

  // 两种来源：
  //   拖进来的 → File 对象，直接 blob URL，瞬时可播、不经服务端
  //   文件夹里的 → 走 /api/media，服务端按 Range 流式给
  if (f.file) {
    if (f.blobURL) URL.revokeObjectURL(f.blobURL);
    f.blobURL = URL.createObjectURL(f.file);
    video.src = f.blobURL;
  } else {
    video.src = `/api/media?path=${encodeURIComponent(f.path)}`;
  }

  video.play().catch(() => {});
  document.querySelector('.viewer').classList.add('has-video');
  $('transport').hidden = false;
  renderClips();
  scrollCurrentIntoView();
}

const badgeEl = (i) => document.querySelector(`.cell-badge[data-index="${i}"]`);

/** 上/下一条素材。到头就停，不绕回 —— 连按方向键时绕回很容易看丢位置 */
function step(delta) {
  if (!state.files.length) return;
  const next = Math.max(0, Math.min(state.files.length - 1, state.current + delta));
  if (next !== state.current) open(next);
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

// 胶片条本身可聚焦，方向键就能用
$('clipList').addEventListener('focus', () => setFocusZone('clips'));

// ── 导出 ────────────────────────────────────────────────────

$('exportBtn').addEventListener('click', async () => {
  const chosen = [...state.selected].sort((a, b) => a - b);
  if (!chosen.length) return;

  // 先把当前面板的值存回正在看的这条，否则刚调完直接导出会丢掉
  if (state.current >= 0 && state.files[state.current]) {
    state.files[state.current].params = snapshotParams();
  }

  // ⚠️ 逐条用**它自己的**参数生成滤镜串。
  //
  // 批量粘贴甜点值之后，每条素材可能各有各的设置（比如有几条单独微调过），
  // 用一个全局参数导出会把那些微调抹掉。
  // 没有自己参数的沿用当前面板 —— 那是用户刚调好还没切走的情形。
  const fallback = snapshotParams();
  const fsRate = ctx ? ctx.sampleRate : 48000;
  const filterFor = (i) =>
    ffmpegAudioFilter(state.files[i]?.params || fallback, fsRate);

  $('exportBtn').disabled = true;
  $('progress').hidden = false;
  // 清掉上一轮的导出状态；「已调」标记要保留
  document.querySelectorAll('.cell-badge').forEach((el) => {
    const i = Number(el.dataset.index);
    el.className = 'cell-badge' + (state.files[i]?.params ? ' tuned' : '');
    el.textContent = state.files[i]?.params ? '已调' : '';
  });

  // 拖进来的素材浏览器不给绝对路径，服务端读不到，只能先传上去。
  // 文件夹模式的素材本来就在服务端，跳过这一步（几个 GB 不用白搬）。
  const picked = [];
  try {
    for (let k = 0; k < chosen.length; k++) {
      const i = chosen[k];
      const f = state.files[i];
      if (f.path) {
        picked.push({ index: i, path: f.path, duration: f.duration,
                      name: f.name, filter: filterFor(i) });
        continue;
      }
      $('progressText').textContent = `上传 ${f.name}（${k + 1}/${chosen.length}）`;
      $('progressText').classList.add('uploading');
      $('progressFill').style.width = `${(k / chosen.length) * 100}%`;
      const el = badgeEl(i);
      if (el) { el.className = 'cell-badge busy'; el.textContent = '上传中'; }

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'X-Filename': encodeURIComponent(f.name),
          'Content-Type': 'application/octet-stream',
        },
        body: f.file,
        duplex: 'half',
      });
      const info = await res.json();
      if (!res.ok) throw new Error(info.error || '上传失败');
      picked.push({
        index: i, path: info.path, duration: info.duration ?? f.duration,
        name: f.name, uploaded: true, filter: filterFor(i),
      });
      if (el) { el.className = 'cell-badge busy'; el.textContent = '待传'; }
    }
  } catch (err) {
    toast(err.message || '上传失败');
    $('exportBtn').disabled = false;
    $('progress').hidden = true;
    $('progressText').classList.remove('uploading');
    return;
  }
  $('progressText').classList.remove('uploading');
  $('progressFill').style.width = '0';

  let doneCount = 0;
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // filter 现在挂在每条上；顶层这个只作兼容兜底
    body: JSON.stringify({ files: picked, filter: picked[0].filter }),
  });

  let lastOutput = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const stateEl = badgeEl;

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
        const el = stateEl(real); if (el) { el.className = 'cell-badge busy'; el.textContent = '导出中'; }
        $('progressText').textContent = `${msg.name}（${doneCount + 1}/${picked.length}）`;
      } else if (msg.type === 'progress') {
        const pct = msg.duration ? Math.min(1, msg.seconds / msg.duration) : 0;
        const overall = (doneCount + pct) / picked.length;
        $('progressFill').style.width = `${overall * 100}%`;
      } else if (msg.type === 'done') {
        doneCount++;
        lastOutput = msg.output;
        const el = stateEl(real); if (el) { el.className = 'cell-badge ok'; el.textContent = '已导出'; }
        $('progressFill').style.width = `${(doneCount / picked.length) * 100}%`;
      } else if (msg.type === 'error') {
        doneCount++;
        const el = stateEl(real); if (el) { el.className = 'cell-badge err'; el.textContent = '失败'; }
        toast(msg.message);
      } else if (msg.type === 'all-done') {
        $('progressText').textContent = '完成';
        const where = picked.some((p) => p.uploaded)
          ? '已存到「影片 / VoicePad」'
          : '已存到素材旁边（_voicepad 后缀）';
        toast(`导出完成，${where}`);
        // 帮用户把成果在 Finder 里点出来，省得自己去找
        if (lastOutput) {
          fetch(`/api/reveal?path=${encodeURIComponent(lastOutput)}`, { method: 'POST' }).catch(() => {});
        }
        setTimeout(() => { $('progress').hidden = true; $('progressFill').style.width = '0'; }, 1600);
      }
    }
  }
  $('exportBtn').disabled = false;
});

// ── 播放进度 ────────────────────────────────────────────────

const scrub = $('scrub');
let scrubbing = false;
/** 拖动期间不让 timeupdate 回写，否则进度条会和手指打架 */
let scrubPreview = 0;

const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

function paintTransport() {
  const dur = video.duration;
  const cur = scrubbing ? scrubPreview : video.currentTime;
  const pct = (isFinite(dur) && dur > 0) ? (cur / dur) * 100 : 0;

  $('scrubFill').style.width = `${pct}%`;
  $('scrubKnob').style.left = `${pct}%`;
  $('timeNow').textContent = fmtTime(cur);
  $('timeTotal').textContent = fmtTime(dur);

  // 已缓冲到哪儿 —— 大文件边下边播时有个交代
  if (video.buffered.length && isFinite(dur) && dur > 0) {
    const end = video.buffered.end(video.buffered.length - 1);
    $('scrubBuffer').style.width = `${Math.min(100, (end / dur) * 100)}%`;
  }
}

function seekFromPointer(e) {
  const r = scrub.getBoundingClientRect();
  // 宽度为 0 时（窗口极窄 / 还没布局完）除法会得到 Infinity，
  // 夹完就是 1 —— 一按就跳片尾。这种"看起来只是边界情况"的除零最坑人
  if (r.width < 1) return;
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const dur = video.duration;
  if (!isFinite(dur) || dur <= 0) return;
  scrubPreview = ratio * dur;
  // 拖动期间实时 seek —— 所见即所听，比松手才跳更好用
  video.currentTime = scrubPreview;
  paintTransport();
}

scrub.addEventListener('pointerdown', (e) => {
  ensureAudio();
  scrubbing = true;
  scrub.classList.add('dragging');
  try { scrub.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  seekFromPointer(e);
});
scrub.addEventListener('pointermove', (e) => { if (scrubbing) seekFromPointer(e); });
const endScrub = (e) => {
  if (!scrubbing) return;
  scrubbing = false;
  scrub.classList.remove('dragging');
  try { scrub.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
};
scrub.addEventListener('pointerup', endScrub);
scrub.addEventListener('pointercancel', endScrub);
window.addEventListener('pointerup', endScrub);

video.addEventListener('timeupdate', paintTransport);
video.addEventListener('loadedmetadata', paintTransport);
video.addEventListener('progress', paintTransport);
video.addEventListener('play', () => { $('playIcon').innerHTML = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'; });
video.addEventListener('pause', () => { $('playIcon').innerHTML = '<path d="M8 5v14l11-7z"/>'; });

$('playBtn').addEventListener('click', () => {
  ensureAudio();
  video.paused ? video.play() : video.pause();
});

// ── 拖放载入 ────────────────────────────────────────────────

const stage = document.querySelector('.stage');
let dragDepth = 0;   // dragenter/leave 会在子元素间反复触发，用计数才不闪

['dragenter', 'dragover'].forEach((ev) => {
  stage.addEventListener(ev, (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (ev === 'dragenter') dragDepth++;
    stage.classList.add('dragover');
  });
});

stage.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; stage.classList.remove('dragover'); }
});

stage.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  stage.classList.remove('dragover');
  const files = await collectFiles(e.dataTransfer);
  loadLocalFiles(files);
});

const VIDEO_RE = /\.(mp4|mov|m4v|mkv|avi|mts|m2ts|webm)$/i;

/** 支持拖文件夹：webkitGetAsEntry 能递归枚举 */
async function collectFiles(dt) {
  const entries = [...(dt.items || [])]
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (!entries.length) return [...dt.files].filter((f) => VIDEO_RE.test(f.name));

  const out = [];
  const walk = (entry) => new Promise((done) => {
    if (entry.isFile) {
      entry.file((f) => { if (VIDEO_RE.test(f.name)) out.push(f); done(); }, done);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => reader.readEntries(async (batch) => {
        // readEntries 一次最多给 100 条，必须反复读到空为止
        if (!batch.length) return done();
        for (const child of batch) await walk(child);
        readBatch();
      }, done);
      readBatch();
    } else done();
  });

  for (const entry of entries) await walk(entry);
  return out;
}

function loadLocalFiles(files) {
  if (!files.length) return toast('没找到可用的视频文件');
  state.files = files.map((f) => ({
    name: f.name, file: f, size: f.size, duration: null, path: null,
  }));
  state.selected = new Set(state.files.map((_, i) => i));
  state.current = -1;
  $('clips').hidden = false;
  renderClips();
  open(0);
  // 时长要等元数据，逐条探完再刷新列表
  probeDurations();
}

/** 用一个隐藏的 <video> 把每条的时长读出来 */
async function probeDurations() {
  for (const item of state.files) {
    if (!item.file || item.duration != null) continue;
    item.duration = await new Promise((done) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      const url = URL.createObjectURL(item.file);
      v.onloadedmetadata = () => { URL.revokeObjectURL(url); done(isFinite(v.duration) ? v.duration : null); };
      v.onerror = () => { URL.revokeObjectURL(url); done(null); };
      v.src = url;
    });
    renderClips();
  }
}

$('pickFiles').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  loadLocalFiles([...e.target.files].filter((f) => VIDEO_RE.test(f.name)));
  e.target.value = '';
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

document.querySelector('.stage').classList.add('zone-clips');

const saved = localStorage.getItem('voicepad.dir');
if (saved) $('dir').value = saved;

render();
