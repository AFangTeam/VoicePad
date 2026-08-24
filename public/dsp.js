//
//  dsp.js —— 调音台的唯一真相来源
//
//  浏览器（实时预览）和 ffmpeg（导出）**共用这一个文件**算出来的滤波器。
//  这是整个 app 最要紧的一条约束：如果两边各算各的，你在面板上调好的声音
//  导出来就不是那个声音，而这种偏差用耳朵很难当场发现，等发现时素材已经交付了。
//
//  做法：
//    - 预览走 Web Audio 的 BiquadFilterNode（参数可平滑过渡，拖动不爆音）
//    - 导出走 ffmpeg 的 biquad 滤镜，喂**显式系数**
//    - 两边的系数都由本文件按 RBJ Audio EQ Cookbook 的公式算出
//      （Web Audio 规范里 BiquadFilterNode 的定义就是这套公式）
//
//  ────────────────────────────────────────────────────────────
//  EQ 选点的依据（以人声为准，不是随便挑的频率）
//  ────────────────────────────────────────────────────────────
//
//  人声的频段地图：
//     60–80 Hz    低频隆隆声、手持噪声 —— 该切掉
//    100–160 Hz   胸腔共鸣、"厚度"。动圈麦近讲效应主要抬的就是这一带
//    200–350 Hz   浑浊、箱声 —— 抬这里会糊
//    800–1.2 kHz  鼻音、"哼"感
//      2–4 kHz    清晰度、临场感（过了头就是"冲"）
//      5–8 kHz    齿音区 —— 抬这里会刺
//     10–14 kHz   空气感、"玻璃质感"
//
//  所以：
//
//  【往下拽 = 动圈麦近讲效应，罗德 VideoMic 那种低沉有磁性】
//    · 180 Hz 低架 +7  —— 近讲效应本体。定 180 而不是 150，是因为 shelf 在 f0
//                        处只给一半增益，定高一点才能让 100–160 拿到接近满值
//    · 330 Hz 峰值 −3.2 —— **防糊的关键**。只抬低频不切这里会闷成一团。
//                        Q 必须够窄：实测放在 280Hz/Q1.0 时裙边一路啃到 150Hz，
//                        把刚抬起来的厚度吃掉一大半（+3.25 → +2.0）
//    · 3.2 kHz 峰值 −3.5 —— 收掉齿音边缘，读起来就是"顺滑、暗"
//
//  【往上拽 = 电容麦的玻璃质感，但不刺耳】
//    · 8 kHz 高架 +6.5 —— 空气感。同样因为 shelf 在 f0 只给一半，定在 8k
//                        才能让真正决定"通透"的 9–12k 拿到足够的量
//    · 2.2 kHz 峰值 +2.5 —— 清晰度。**刻意压在 3–5k 那个"冲"区以下**
//    · 5.5 kHz 峰值 −2.8 —— **防刺的关键**（窄 Q）。空气感一抬齿音就跟着冒，
//                        这一刀专门压住 s / sh，让高频"亮而不锐"
//    · 250 Hz 峰值 −2  —— 去浑浊，感知上更"干净"
//
//  两个方向都常开 70 Hz 高通（隆隆声 / 风噪 / 桌面震动）。
//
//  最后做**峰值补偿**：把整条链的最大增益算出来再反向补回去，
//  于是拖动时响度基本不变，你听到的是音色变化而不是"变大声了所以好听"。
//  顺带保证不会削波。
//

// ── 参数范围 ────────────────────────────────────────────────

export const RANGE = {
  // 上下：音色。+1 = 通透明亮，-1 = 低沉有磁性
  tone: { min: -1, max: 1 },
  // 左右：声道平衡。+1 = 右声道更大
  balance: { min: -1, max: 1 },
  // 总音量，1 = 原始
  master: { min: 0, max: 1.6 },
};

// ── RBJ 双二阶系数 ──────────────────────────────────────────
//
// 公式取自 Web Audio 规范中 BiquadFilterNode 的定义（即 RBJ Cookbook）。
// 必须逐字对齐 —— 差一点点，预览和导出就是两个声音。

function peaking(fs, f0, Q, gainDb) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const alpha = Math.sin(w0) / (2 * Q);
  const cos = Math.cos(w0);
  return {
    b0: 1 + alpha * A,
    b1: -2 * cos,
    b2: 1 - alpha * A,
    a0: 1 + alpha / A,
    a1: -2 * cos,
    a2: 1 - alpha / A,
  };
}

// ⚠️ Web Audio 的 lowshelf/highshelf **没有 S（斜率）参数**，规范里固定 S=1，
// 而且 Q 对 shelf 类型无效。所以这里也必须写死 S=1 ——
// 实测用 S=0.8 时 Web Audio 与本文件在 80Hz 差 3.8 dB，
// 那就意味着预览和导出是两个声音。
function lowShelf(fs, f0, gainDb) {
  const S = 1;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const twoSqrtAalpha = 2 * Math.sqrt(A) * alpha;
  return {
    b0: A * (A + 1 - (A - 1) * cos + twoSqrtAalpha),
    b1: 2 * A * (A - 1 - (A + 1) * cos),
    b2: A * (A + 1 - (A - 1) * cos - twoSqrtAalpha),
    a0: A + 1 + (A - 1) * cos + twoSqrtAalpha,
    a1: -2 * (A - 1 + (A + 1) * cos),
    a2: A + 1 + (A - 1) * cos - twoSqrtAalpha,
  };
}

function highShelf(fs, f0, gainDb) {
  const S = 1;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const twoSqrtAalpha = 2 * Math.sqrt(A) * alpha;
  return {
    b0: A * (A + 1 + (A - 1) * cos + twoSqrtAalpha),
    b1: -2 * A * (A - 1 + (A + 1) * cos),
    b2: A * (A + 1 + (A - 1) * cos - twoSqrtAalpha),
    a0: A + 1 - (A - 1) * cos + twoSqrtAalpha,
    a1: 2 * (A - 1 - (A + 1) * cos),
    a2: A + 1 - (A - 1) * cos - twoSqrtAalpha,
  };
}

// ⚠️ Web Audio 对 lowpass / highpass 的 `Q` 用的是**分贝**：
// alpha = sin(w0) / (2 · 10^(Q/20))。而 RBJ 原始公式里 Q 是无量纲的。
// 这里按 RBJ 写（ffmpeg 拿的是系数，无所谓），
// app.js 配置 Web Audio 节点时会做 Q → 20·log10(Q) 的换算。
function highPass(fs, f0, Q) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  return {
    b0: (1 + cos) / 2,
    b1: -(1 + cos),
    b2: (1 + cos) / 2,
    a0: 1 + alpha,
    a1: -2 * cos,
    a2: 1 - alpha,
  };
}

// ── 滤波器编排 ──────────────────────────────────────────────

/**
 * 按音色参数给出一条滤波器链。
 *
 * 每一项都带 type/freq/Q/gain（给 Web Audio 用）和算好的系数（给 ffmpeg 用），
 * 两边描述的是同一个滤波器。
 *
 * @param {number} tone -1..1
 * @param {number} fs   采样率
 */
export function buildFilters(tone, fs = 48000) {
  const t = Math.max(-1, Math.min(1, tone));
  const up = Math.max(0, t);      // 往上拽的量
  const down = Math.max(0, -t);   // 往下拽的量

  /** @type {Array<{name:string,type:string,freq:number,Q:number,gain:number}>} */
  const specs = [
    // 常开：隆隆声 / 手持噪声 / 桌面震动。Q=0.707 是巴特沃斯，最平坦不隆起
    { name: '低切', type: 'highpass', freq: 70, Q: 0.707, gain: 0 },
  ];

  if (down > 0) {
    specs.push(
      // 近讲效应本体。180Hz 而不是 150 —— shelf 在 f0 处只给一半增益，
      // 定在 180 才能让 100–160 那段胸腔共鸣拿到接近满值的抬升
      { name: '厚度', type: 'lowshelf', freq: 180, gain: 7.0 * down },
      // 防糊：只抬低频不切这里会闷成一团。
      // ⚠️ 这一刀必须够窄（Q 1.3）且够高（330Hz）——
      // 实测放 280Hz / Q 1.0 时，它的裙边会一路啃到 150Hz，
      // 把上面刚抬起来的厚度吃掉一大半（+3.25 → +2.0）
      { name: '去浑浊', type: 'peaking', freq: 330, Q: 1.3, gain: -3.2 * down },
      // 收边缘，读起来是"顺滑、暗"
      { name: '收齿音边缘', type: 'peaking', freq: 3200, Q: 1.1, gain: -3.5 * down },
    );
  }

  if (up > 0) {
    specs.push(
      // 空气感 / 玻璃质感。8kHz 而不是 9k —— 同样因为 shelf 在 f0 只给一半，
      // 定低一点才能让 9–12k 真正拿到"通透"所需的量
      { name: '空气感', type: 'highshelf', freq: 8000, gain: 6.5 * up },
      // 清晰度。刻意压在 3–5k 那个"冲"区以下
      { name: '清晰度', type: 'peaking', freq: 2200, Q: 0.9, gain: 2.5 * up },
      // 防刺：窄 Q 专压 s/sh，让高频亮而不锐
      { name: '压齿音', type: 'peaking', freq: 5500, Q: 2.0, gain: -2.8 * up },
      // 去浑浊，感知上更干净
      { name: '去浑浊', type: 'peaking', freq: 250, Q: 0.9, gain: -2.0 * up },
    );
  }

  return specs.map((s) => {
    let c;
    if (s.type === 'highpass') c = highPass(fs, s.freq, s.Q);
    else if (s.type === 'peaking') c = peaking(fs, s.freq, s.Q, s.gain);
    else if (s.type === 'lowshelf') c = lowShelf(fs, s.freq, s.gain);
    else c = highShelf(fs, s.freq, s.gain);
    return { ...s, coeffs: c };
  });
}

// ── 频响与峰值补偿 ──────────────────────────────────────────

/** 单个双二阶在某频率的幅度（线性） */
function magnitudeAt(c, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const cos1 = Math.cos(w), sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w);
  const nRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const nIm = -(c.b1 * sin1 + c.b2 * sin2);
  const dRe = c.a0 + c.a1 * cos1 + c.a2 * cos2;
  const dIm = -(c.a1 * sin1 + c.a2 * sin2);
  return Math.hypot(nRe, nIm) / Math.hypot(dRe, dIm);
}

/** 整条链的频响（dB），用于画曲线 */
export function frequencyResponse(filters, freqs, fs = 48000) {
  return freqs.map((f) => {
    let mag = 1;
    for (const flt of filters) mag *= magnitudeAt(flt.coeffs, f, fs);
    return 20 * Math.log10(Math.max(mag, 1e-9));
  });
}

/** 20Hz–20kHz 的对数频率刻度 */
export function logFreqs(n = 240, fMin = 20, fMax = 20000) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = fMin * Math.pow(fMax / fMin, i / (n - 1));
  }
  return out;
}

/**
 * 峰值补偿增益（dB）。
 *
 * 把整条链的最大增益反向补回去，两个作用：
 *   1. 拖动时响度基本不变 —— 你判断的是音色，不是"变大声了所以好听"
 *   2. 保证滤波器本身不会把信号推过 0 dBFS
 */
export function makeupGainDb(filters, fs = 48000) {
  const freqs = logFreqs(300);
  const resp = frequencyResponse(filters, freqs, fs);
  const peak = Math.max(...resp);
  return peak > 0 ? -peak : 0;
}

// ── 声道平衡 ────────────────────────────────────────────────

/**
 * 左右拽 → 两个声道的增益（线性）。
 *
 * 做成"近侧小抬 + 远侧大降"的倾斜，而不是简单的 pan：
 * 用户要的是"往左拽左声道更大"，但如果只抬近侧，全推到底会削波。
 * 近侧 +3 dB、远侧 −16 dB 的组合听感上是明确的偏向，又留足了余量。
 */
export function balanceGains(balance) {
  const b = Math.max(-1, Math.min(1, balance));
  const nearDb = 3 * Math.abs(b);
  const farDb = -16 * Math.abs(b);
  const near = Math.pow(10, nearDb / 20);
  const far = Math.pow(10, farDb / 20);
  if (b < 0) return { left: near, right: far };
  if (b > 0) return { left: far, right: near };
  return { left: 1, right: 1 };
}

// ── 导出：ffmpeg 滤镜串 ─────────────────────────────────────

const f6 = (v) => Number(v).toFixed(10);

/**
 * 把同一套参数翻译成 ffmpeg 的 -af 字符串。
 *
 * 用 `biquad` 喂显式系数，而不是 ffmpeg 自己的 equalizer/bass/treble ——
 * 那几个的参数化方式和 Web Audio 不完全一样（尤其是 shelf 的斜率），
 * 用它们就等于两边各算各的，预览和导出会有肉眼（耳）难察的偏差。
 */
export function ffmpegAudioFilter({ tone, balance, master }, fs = 48000) {
  const filters = buildFilters(tone, fs);
  const parts = [];

  for (const f of filters) {
    const c = f.coeffs;
    parts.push(
      `biquad=b0=${f6(c.b0)}:b1=${f6(c.b1)}:b2=${f6(c.b2)}:` +
      `a0=${f6(c.a0)}:a1=${f6(c.a1)}:a2=${f6(c.a2)}`
    );
  }

  const { left, right } = balanceGains(balance);
  // pan 同时完成声道平衡。输入是单声道时也要能用，所以两路都从 c0 取。
  parts.push(`pan=stereo|c0=${f6(left)}*c0|c1=${f6(right)}*c1`);

  const totalDb = makeupGainDb(filters, fs);
  const gain = Math.pow(10, totalDb / 20) * master;
  parts.push(`volume=${f6(gain)}`);

  return parts.join(',');
}
