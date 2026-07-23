const { LAB_SETS, SIZES } = require('../../utils/palette');

const BASE_CELL = 12;       // 1 倍缩放时每个豆格的尺寸（px）
const MAX_SOURCE_EDGE = 2048; // 保留原图网格细节，同时控制 ImageData 内存
const MAX_CELLS = 600;      // 单边最大豆数（覆盖 500×500 图纸）
const TEXT_CONTRAST = 40;   // 抗锯齿后文字与底色的最小亮度差
const CIRCLE_MIN = 9;       // 格子 >= 该 px 时画圆形豆
const CELL_DETAIL_MIN = 4;  // 格子 < 该 px 时走离屏位图渲染

// 标准导出图使用的显示色与实体豆色卡存在明度差，这组参考色用于还原图中文字色号。
const CHART_COLOR_REFERENCES = {
  A23: [248, 225, 209],
  B25: [102, 135, 110],
  B27: [192, 204, 159],
  B30: [245, 254, 198],
  C20: [45, 134, 202],
  E2: [248, 209, 229],
  E11: [253, 233, 226],
  E17: [245, 229, 239],
  E18: [245, 213, 225],
  F14: [242, 173, 174],
  F19: [178, 77, 78],
  F20: [197, 149, 147],
  F21: [237, 182, 197],
  F23: [230, 133, 109],
  F25: [213, 86, 86],
  H1: [242, 242, 242],
  H2: [255, 253, 254],
  H4: [136, 131, 138],
  H5: [70, 69, 75],
  H7: [1, 1, 1],
  H16: [52, 44, 42],
  H17: [240, 240, 240]
};

function nearestChartIndex(set, r, g, b) {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < set.length; i++) {
    const reference = CHART_COLOR_REFERENCES[set[i].c];
    if (!reference) continue;
    const dr = r - reference[0];
    const dg = g - reference[1];
    const db = b - reference[2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return bestDistance <= 20 * 20 ? best : -1;
}

function nearestPrintedPaletteIndex(set, r, g, b) {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < set.length; i++) {
    const dr = r - set[i].r;
    const dg = g - set[i].g;
    const db = b - set[i].b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  // 标准图纸底色允许少量导出偏色，但拒绝与当前色卡明显无关的色块。
  return bestDistance <= 48 * 48 ? best : -1;
}

Page({
  data: {
    stage: 'empty',   // empty | adjust | ready
    theme: 'dark',
    gridW: 0,         // 豆子矩阵宽（颗）
    gridH: 0,         // 豆子矩阵高（颗）
    totalBeads: 0,
    colors: [],
    selectedIndex: -1,
    selectedCode: '',
    selectedCount: 0,
    paletteSize: 221, // 当前豆盘色数
    sizes: SIZES,     // 可选豆盘档位
    cols: 0,          // 校准页：横向豆数
    rows: 0           // 校准页：纵向豆数
  },

  onLoad() {
    this.setData({
      theme: wx.getStorageSync('theme') || 'dark',
      paletteSize: wx.getStorageSync('paletteSize') || 221
    });
    // ===== 内部状态（不进 setData） =====
    this.imageData = null;      // 源图 ImageData
    this.srcW = 0;
    this.srcH = 0;
    this.srcCanvas = null;      // 源图离屏 canvas（校准页预览用）
    this.gridSpec = null;       // { pitchX, pitchY, offX, offY, det }
    this.beadImageData = null;  // 采样重建后的豆子矩阵 ImageData
    this.palette = null;
    this.grid = null;
    this.patternCanvas = null;
    this.dimCanvas = null;
    this.isoCanvas = null;
    this.view = { scale: 1, x: 0, y: 0 };
    this.gesture = null;
    this.boardW = 0;
    this.boardH = 0;
    this.boardLeft = 0;
    this.boardTop = 0;
  },

  onReady() {
    this.initCanvas();
  },

  /** 初始化画布节点（可重复调用；成功后执行回调） */
  initCanvas(cb) {
    this.createSelectorQuery()
      .select('#board')
      .fields({ node: true, size: true, rect: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        if (this.canvas !== res[0].node || !this.ctx) {
          this.canvas = res[0].node;
          this.ctx = this.canvas.getContext('2d');
        }
        this.dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;
        this.boardW = res[0].width;
        this.boardH = res[0].height;
        this.boardLeft = res[0].left || 0;
        this.boardTop = res[0].top || 0;
        this.canvas.width = res[0].width * this.dpr;
        this.canvas.height = res[0].height * this.dpr;
        cb && cb();
      });
  },

  /* ================= 图片上传与像素读取 ================= */

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        this.loadImage(res.tempFiles[0].tempFilePath);
      }
    });
  },

  /** 等比限制解码尺寸，避免把原生图纸的小网格过早压没 */
  scaledImageSize(width, height) {
    const edge = Math.max(width, height);
    if (edge <= MAX_SOURCE_EDGE) return { width, height };
    const scale = MAX_SOURCE_EDGE / edge;
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  },

  loadImage(path) {
    wx.showLoading({ title: '解析图纸中' });
    wx.getImageInfo({
      src: path,
      success: (info) => {
        const size = this.scaledImageSize(info.width, info.height);
        const w = size.width;
        const h = size.height;
        const off = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
        const octx = off.getContext('2d');
        const img = off.createImage();
        img.onload = () => {
          octx.drawImage(img, 0, 0, w, h);
          this.imageData = octx.getImageData(0, 0, w, h);
          this.srcW = w;
          this.srcH = h;
          // 源图位图（校准页预览用）
          const src = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
          src.getContext('2d').putImageData(this.imageData, 0, 0);
          this.srcCanvas = src;
          wx.hideLoading();
          this.enterAdjust();
        };
        img.onerror = () => {
          wx.hideLoading();
          wx.showToast({ title: '图片加载失败', icon: 'none' });
        };
        img.src = path;
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({ title: '图片读取失败', icon: 'none' });
      }
    });
  },

  /* ================= 网格识别与校准 ================= */

  enterAdjust() {
    const spec = this.detectGrid();
    this.gridSpec = spec;
    this.setData({
      stage: 'adjust',
      cols: spec.cols,
      rows: spec.rows,
      selectedIndex: -1
    }, () => {
      this.initCanvas(() => {
        this.fitView();
        this.render();
      });
    });
  },

  /**
   * 投影法检测网格线：
   * 网格线横贯整个图幅，在列/行边缘强度投影上形成周期性尖峰。
   * 峰间距 -> pitch，首个峰 -> offset。
   */
  detectGrid() {
    const { data } = this.imageData;
    const W = this.srcW;
    const H = this.srcH;

    // 直接从 RGBA 计算投影，不再额外分配 W×H 的灰度数组。
    // 原图可以保留到 2048px，细网格不会因 800px 缩放而消失。
    const luminance = (offset) => data[offset + 3] < 128
      ? 255
      : data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114;

    const columnProjection = (startY = 0, endY = H) => {
      const projection = new Float32Array(W - 1);
      for (let y = startY; y < endY; y += 2) {
        const base = y * W * 4;
        for (let x = 0; x < W - 1; x++) {
          const offset = base + x * 4;
          projection[x] += Math.min(32, Math.abs(luminance(offset) - luminance(offset + 4)));
        }
      }
      return projection;
    };
    const rowProjection = (startX = 0, endX = W) => {
      const projection = new Float32Array(H - 1);
      for (let x = startX; x < endX; x += 2) {
        for (let y = 0; y < H - 1; y++) {
          const offset = (y * W + x) * 4;
          projection[y] += Math.min(32, Math.abs(luminance(offset) - luminance(offset + W * 4)));
        }
      }
      return projection;
    };

    const fullColumns = columnProjection();
    const fullRows = rowProjection();
    const estimatedX = this.estimateProjectionPitch(fullColumns);
    const estimatedY = this.estimateProjectionPitch(fullRows);
    const estimatesAgree = estimatedX && estimatedY
      && Math.abs(estimatedX - estimatedY) / Math.max(estimatedX, estimatedY) < 0.15;
    const squarePitch = estimatesAgree ? (estimatedX + estimatedY) / 2 : null;

    const coordinateChart = squarePitch
      ? this.detectCoordinateChart(data, W, H, squarePitch, fullRows)
      : null;
    if (coordinateChart) return coordinateChart;

    let specX = this.analyzeProjection(fullColumns, W, squarePitch || estimatedX);
    let specY = this.analyzeProjection(fullRows, H, squarePitch || estimatedY);

    // 第二遍只查看另一轴已确认的网格范围。这样底部图例、四周坐标和标题
    // 即使边缘比网格更黑，也不会被合并进豆子矩阵。
    if (specY) {
      const startY = Math.max(0, Math.floor(specY.offset));
      const endY = Math.min(H, Math.ceil(specY.offset + specY.pitch * specY.cells) + 1);
      specX = this.analyzeProjection(
        columnProjection(startY, endY),
        W,
        squarePitch || estimatedX
      ) || specX;
    }
    if (specX) {
      const startX = Math.max(0, Math.floor(specX.offset));
      const endX = Math.min(W, Math.ceil(specX.offset + specX.pitch * specX.cells) + 1);
      specY = this.analyzeProjection(
        rowProjection(startX, endX),
        H,
        squarePitch || estimatedY
      ) || specY;
    }

    if (specX && specY) {
      return {
        det: true,
        pitchX: specX.pitch, offX: specX.offset, cols: specX.cells,
        pitchY: specY.pitch, offY: specY.offset, rows: specY.cells,
        endX: specX.offset + specX.pitch * specX.cells,
        endY: specY.offset + specY.pitch * specY.cells
      };
    }
    if (specX) {
      const rows = Math.min(MAX_CELLS, Math.max(2, Math.round(H / specX.pitch)));
      return {
        det: true,
        pitchX: specX.pitch, offX: specX.offset, cols: specX.cells,
        pitchY: specX.pitch, offY: 0, rows,
        endX: specX.offset + specX.pitch * specX.cells,
        endY: Math.min(H, specX.pitch * rows)
      };
    }
    if (specY) {
      const cols = Math.min(MAX_CELLS, Math.max(2, Math.round(W / specY.pitch)));
      return {
        det: true,
        pitchX: specY.pitch, offX: 0, cols,
        pitchY: specY.pitch, offY: specY.offset, rows: specY.cells,
        endX: Math.min(W, specY.pitch * cols),
        endY: specY.offset + specY.pitch * specY.cells
      };
    }
    // 检测失败：默认 50 宽、正方形格子铺满
    const cols = 50;
    const rows = Math.max(2, Math.round(H / (W / cols)));
    return {
      det: false,
      pitchX: W / cols, offX: 0, cols,
      pitchY: H / rows, offY: 0, rows,
      endX: W, endY: H
    };
  },

  /** 用归一化自相关估计基础格距，避免把格内文字的半周期当成网格。 */
  estimateProjectionPitch(arr) {
    if (arr.length < 12) return null;
    let mean = 0;
    for (let i = 0; i < arr.length; i++) mean += arr[i];
    mean /= arr.length;

    const maxLag = Math.min(120, Math.floor(arr.length / 4));
    const correlations = new Float64Array(maxLag + 1);
    let best = 0;
    for (let lag = 3; lag <= maxLag; lag++) {
      let product = 0;
      let energyA = 0;
      let energyB = 0;
      for (let i = 0; i < arr.length - lag; i++) {
        const a = arr[i] - mean;
        const b = arr[i + lag] - mean;
        product += a * b;
        energyA += a * a;
        energyB += b * b;
      }
      const correlation = energyA && energyB ? product / Math.sqrt(energyA * energyB) : 0;
      correlations[lag] = correlation;
      if (correlation > best) best = correlation;
    }
    if (best < 0.2) return null;

    // 倍频通常更强；选择第一个达到主峰 65% 的局部峰作为基础格距。
    const threshold = Math.max(0.2, best * 0.65);
    for (let lag = 3; lag <= maxLag; lag++) {
      if (correlations[lag] < threshold) continue;
      if (correlations[lag] >= correlations[lag - 1]
        && correlations[lag] >= correlations[lag + 1]) {
        const left = correlations[lag - 1];
        const center = correlations[lag];
        const right = correlations[lag + 1];
        const denominator = left - 2 * center + right;
        const adjustment = denominator
          ? 0.5 * (left - right) / denominator
          : 0;
        return lag + Math.max(-0.5, Math.min(0.5, adjustment));
      }
    }
    return null;
  },

  /**
   * 标准图纸四周带完整坐标栏。通过浅色背景 + 深色数字识别四条坐标栏，
   * 返回坐标栏内部的真正豆子矩阵。
   */
  detectCoordinateChart(data, width, height, estimatedPitch, rowProjection) {
    const totalCols = Math.round(width / estimatedPitch);
    if (totalCols < 6 || totalCols > MAX_CELLS + 2) return null;
    const pitch = width / totalCols;
    if (Math.abs(pitch - estimatedPitch) / estimatedPitch > 0.06) return null;

    // 标题可能位于网格上方。先在整张图的横向边缘投影中寻找网格周期相位，
    // 再沿该相位寻找真正的顶部/底部坐标栏，而不是假设坐标栏从 y=0 开始。
    let bestPhase = 0;
    let bestPhaseScore = -1;
    const phaseStep = Math.max(0.25, pitch / 160);
    for (let phase = 0; phase < pitch; phase += phaseStep) {
      let score = 0;
      for (let y = phase; y < height - 1; y += pitch) {
        const center = Math.round(y);
        let strength = 0;
        for (let delta = -1; delta <= 1; delta++) {
          const index = center + delta;
          if (index >= 0 && index < rowProjection.length) {
            strength = Math.max(strength, rowProjection[index]);
          }
        }
        score += Math.min(strength, 5000);
      }
      if (score > bestPhaseScore) {
        bestPhaseScore = score;
        bestPhase = phase;
      }
    }

    const measureRow = (top) => {
      let labels = 0;
      let neutral = 0;
      for (let col = 0; col < totalCols; col++) {
        const cell = this.sampleCellAppearance(
          data,
          width,
          height,
          col * pitch,
          top,
          (col + 1) * pitch,
          top + pitch
        );
        if (cell.hasLabel) labels++;
        if (cell.luminance > 170 && cell.chroma < 35) neutral++;
      }
      return {
        labelRate: labels / totalCols,
        neutralRate: neutral / totalCols
      };
    };

    const isAxisBand = (metric) => metric
      && metric.labelRate >= 0.5
      && metric.neutralRate >= 0.85;

    // 旧格式的顶部坐标栏紧贴图片 y=0。外边界不一定会在边缘投影中形成峰，
    // 因此它应优先于相位搜索结果，否则整张网格会被错误下移半格左右。
    if (isAxisBand(measureRow(0))) bestPhase = 0;

    const axisCandidates = [];
    for (let step = 0; ; step++) {
      const top = bestPhase + step * pitch;
      if (top + pitch > height) break;
      const metric = measureRow(top);
      if (isAxisBand(metric)) axisCandidates.push({ step, top, metric });
    }

    const columnMetric = (col, topAxis, rows) => {
      let labels = 0;
      let neutral = 0;
      for (let row = 1; row <= rows; row++) {
        const cell = this.sampleCellAppearance(
          data,
          width,
          height,
          col * pitch,
          topAxis + row * pitch,
          (col + 1) * pitch,
          topAxis + (row + 1) * pitch
        );
        if (cell.hasLabel) labels++;
        if (cell.luminance > 170 && cell.chroma < 35) neutral++;
      }
      return {
        labelRate: labels / rows,
        neutralRate: neutral / rows
      };
    };

    let bestPair = null;
    for (let start = 0; start < axisCandidates.length; start++) {
      const top = axisCandidates[start];
      if (top.top > height * 0.45) continue;
      for (let end = start + 1; end < axisCandidates.length; end++) {
        const bottom = axisCandidates[end];
        if (bottom.top < height * 0.5) continue;
        const rows = bottom.step - top.step - 1;
        if (rows < 2 || rows > MAX_CELLS) continue;

        const left = columnMetric(0, top.top, rows);
        const right = columnMetric(totalCols - 1, top.top, rows);
        if (left.labelRate < 0.5 || right.labelRate < 0.5
          || left.neutralRate < 0.85 || right.neutralRate < 0.85) {
          continue;
        }
        const sideLabelRate = Math.min(left.labelRate, right.labelRate);
        const score = sideLabelRate * 100 + Math.min(rows, 100) * 0.01;
        if (!bestPair || score > bestPair.score) {
          bestPair = { score, top: top.top, bottom: bottom.top, rows };
        }
      }
    }
    if (!bestPair) return null;

    const cols = totalCols - 2;
    return {
      det: true,
      coordinateChart: true,
      pitchX: pitch,
      offX: pitch,
      cols,
      pitchY: pitch,
      offY: bestPair.top + pitch,
      rows: bestPair.rows,
      endX: pitch * (totalCols - 1),
      endY: bestPair.bottom
    };
  },

  /**
   * 读取单格的底色和文字对比度。只把与底色亮度差明显的笔画像素视为文字；
   * 透明图常见的浅灰棋盘格不会因此被误判。
   */
  sampleCellAppearance(data, width, height, left, top, right, bottom) {
    const cellWidth = right - left;
    const cellHeight = bottom - top;
    const x0 = Math.max(0, Math.round(left + cellWidth * 0.12));
    const x1 = Math.min(width - 1, Math.round(right - cellWidth * 0.12));
    const y0 = Math.max(0, Math.round(top + cellHeight * 0.12));
    const y1 = Math.min(height - 1, Math.round(bottom - cellHeight * 0.12));
    const histogram = Object.create(null);
    let bestKey = -1;
    let bestCount = 0;
    let sampleCount = 0;

    for (let y = y0; y <= y1; y++) {
      const base = y * width;
      for (let x = x0; x <= x1; x++) {
        const offset = (base + x) * 4;
        if (data[offset + 3] < 128) continue;
        sampleCount++;
        const key = ((data[offset] >> 2) << 12)
          | ((data[offset + 1] >> 2) << 6)
          | (data[offset + 2] >> 2);
        const count = (histogram[key] || 0) + 1;
        histogram[key] = count;
        if (count > bestCount) {
          bestCount = count;
          bestKey = key;
        }
      }
    }

    if (bestKey < 0) {
      return {
        r: 255, g: 255, b: 255,
        luminance: 255, chroma: 0,
        contrastRatio: 0, hasLabel: false
      };
    }

    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let backgroundCount = 0;
    for (let y = y0; y <= y1; y++) {
      const base = y * width;
      for (let x = x0; x <= x1; x++) {
        const offset = (base + x) * 4;
        const key = ((data[offset] >> 2) << 12)
          | ((data[offset + 1] >> 2) << 6)
          | (data[offset + 2] >> 2);
        if (key !== bestKey) continue;
        sumR += data[offset];
        sumG += data[offset + 1];
        sumB += data[offset + 2];
        backgroundCount++;
      }
    }
    const r = backgroundCount ? sumR / backgroundCount : 255;
    const g = backgroundCount ? sumG / backgroundCount : 255;
    const b = backgroundCount ? sumB / backgroundCount : 255;
    const luminance = r * 0.299 + g * 0.587 + b * 0.114;
    let mediumContrast = 0;
    let strongContrast = 0;
    let codeContrast = 0;
    let codeInkChromaSum = 0;
    let total = 0;
    for (let y = y0; y <= y1; y++) {
      const base = y * width;
      for (let x = x0; x <= x1; x++) {
        const offset = (base + x) * 4;
        if (data[offset + 3] < 128) continue;
        const pixelLuminance = data[offset] * 0.299
          + data[offset + 1] * 0.587
          + data[offset + 2] * 0.114;
        const difference = Math.abs(pixelLuminance - luminance);
        if (difference > TEXT_CONTRAST) mediumContrast++;
        if (difference > 65) strongContrast++;
        if (difference > 110) {
          codeContrast++;
          codeInkChromaSum += Math.max(
            data[offset],
            data[offset + 1],
            data[offset + 2]
          ) - Math.min(
            data[offset],
            data[offset + 1],
            data[offset + 2]
          );
        }
        total++;
      }
    }
    const mediumContrastRatio = total ? mediumContrast / total : 0;
    const contrastRatio = total ? strongContrast / total : 0;
    const codeContrastRatio = total ? codeContrast / total : 0;
    const codeInkChroma = codeContrast
      ? codeInkChromaSum / codeContrast
      : 0;
    const hasLabel = mediumContrastRatio >= 0.06;
    const lightNeutralCell = luminance > 225
      && Math.max(r, g, b) - Math.min(r, g, b) < 10;
    const plausibleCodeInk = codeContrastRatio <= 0.35
      && (!lightNeutralCell
        || (codeContrastRatio >= 0.03
          && codeContrastRatio <= 0.25
          && codeInkChroma < 40));

    return {
      r, g, b,
      luminance,
      chroma: Math.max(r, g, b) - Math.min(r, g, b),
      contrastRatio,
      codeContrastRatio,
      codeInkChroma,
      mediumContrastRatio,
      backgroundRatio: sampleCount ? bestCount / sampleCount : 0,
      hasLabel,
      // 这是文字候选；process() 还会用当前色卡校验底色，二者同时通过才计数。
      hasBeadCode: hasLabel && plausibleCodeInk
    };
  },

  /**
   * 在投影中寻找最长的连续周期峰列。
   * 图例、坐标文字可以产生更强的孤立边缘，但不能组成长周期序列。
   */
  analyzeProjection(arr, len, preferredPitch = null) {
    let max = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    if (max <= 0) return null;

    const threshold = max * 0.12;
    const peaks = [];
    for (let i = 1; i < arr.length - 1; i++) {
      if (arr[i] < threshold || arr[i] < arr[i - 1] || arr[i] < arr[i + 1]) continue;
      const previous = peaks[peaks.length - 1];
      if (previous && i - previous.position < 3) {
        if (arr[i] > previous.strength) {
          previous.position = i;
          previous.strength = arr[i];
        }
      } else {
        peaks.push({ position: i, strength: arr[i] });
      }
    }
    if (peaks.length < 6) return null;

    const candidates = new Set();
    const addCandidate = (pitch) => {
      if (pitch < 3 || pitch > len / 2) return;
      candidates.add(Math.round(pitch * 20) / 20);
    };

    if (preferredPitch) {
      for (let pitch = preferredPitch - 1.5; pitch <= preferredPitch + 1.5; pitch += 0.05) {
        addCandidate(pitch);
      }
    } else {
      // 常见图纸缩放后的格距通常小于 80px，先覆盖连续候选。
      for (let pitch = 3; pitch <= Math.min(80, len / 2); pitch += 0.25) {
        addCandidate(pitch);
      }
      // 大格图纸和非整数缩放，从邻近峰差推导候选格距。
      for (let i = 0; i < peaks.length; i++) {
        const end = Math.min(peaks.length, i + 13);
        for (let j = i + 1; j < end; j++) {
          const distance = peaks[j].position - peaks[i].position;
          addCandidate(distance / (j - i));
          for (let steps = 1; steps <= 4; steps++) addCandidate(distance / steps);
        }
      }
    }

    function nearestPeak(expected, tolerance, startIndex) {
      let best = null;
      for (let i = startIndex; i < peaks.length; i++) {
        const delta = peaks[i].position - expected;
        if (delta > tolerance) break;
        if (Math.abs(delta) <= tolerance && (!best || Math.abs(delta) < best.distance)) {
          best = { index: i, distance: Math.abs(delta), peak: peaks[i] };
        }
      }
      return best;
    }

    let best = null;
    candidates.forEach((candidatePitch) => {
      const tolerance = Math.max(1.5, candidatePitch * 0.2);
      for (let start = 0; start < peaks.length; start++) {
        const matched = [{ peak: peaks[start], step: 0 }];
        let searchFrom = start + 1;
        let missing = 0;
        let consecutiveMissing = 0;
        for (let step = 1; step <= MAX_CELLS; step++) {
          const expected = peaks[start].position + candidatePitch * step;
          if (expected >= len) break;
          const found = nearestPeak(expected, tolerance, searchFrom);
          if (!found) {
            missing++;
            consecutiveMissing++;
            if (missing > 8 || consecutiveMissing > 1) break;
            continue;
          }
          matched.push({ peak: found.peak, step });
          searchFrom = found.index + 1;
          consecutiveMissing = 0;
        }
        if (matched.length < 6) continue;

        // 对匹配峰做线性回归，得到亚像素格距，并检查残差。
        const count = matched.length;
        let meanIndex = 0;
        let meanPosition = 0;
        for (const item of matched) {
          meanIndex += item.step;
          meanPosition += item.peak.position;
        }
        meanIndex /= count;
        meanPosition /= count;
        let numerator = 0;
        let denominator = 0;
        for (let i = 0; i < count; i++) {
          const di = matched[i].step - meanIndex;
          numerator += di * (matched[i].peak.position - meanPosition);
          denominator += di * di;
        }
        const pitch = numerator / denominator;
        const offset = meanPosition - pitch * meanIndex;
        let squaredError = 0;
        let strength = 0;
        for (let i = 0; i < count; i++) {
          const error = matched[i].peak.position - (offset + pitch * matched[i].step);
          squaredError += error * error;
          strength += matched[i].peak.strength / max;
        }
        const rms = Math.sqrt(squaredError / count);
        if (rms > Math.max(1.25, pitch * 0.15)) continue;

        const cells = matched[matched.length - 1].step;
        const occupancy = count / (cells + 1);
        const preferredPenalty = preferredPitch
          ? Math.abs(candidatePitch - preferredPitch) * 500
          : 0;
        const score = cells * 100 + occupancy * 10 + strength / count
          - rms - missing * 2 - preferredPenalty;
        if (!best || score > best.score) {
          best = { score, pitch, offset, cells };
        }
      }
    });

    if (!best || best.cells < 4 || best.cells > MAX_CELLS) return null;
    return { pitch: best.pitch, offset: best.offset, cells: best.cells };
  },

  /** 校准页步进器 */
  onStep(e) {
    const k = e.currentTarget.dataset.k;
    const d = parseInt(e.currentTarget.dataset.d, 10);
    const val = Math.min(MAX_CELLS, Math.max(2, this.data[k] + d));
    this.setData({ [k]: val });
    // 保持已识别的网格边界不动，在边界内按新豆数重新均分。
    if (this.gridSpec) {
      if (k === 'cols') {
        const endX = this.gridSpec.endX == null ? this.srcW : this.gridSpec.endX;
        this.gridSpec.pitchX = (endX - this.gridSpec.offX) / val;
      }
      if (k === 'rows') {
        const endY = this.gridSpec.endY == null ? this.srcH : this.gridSpec.endY;
        this.gridSpec.pitchY = (endY - this.gridSpec.offY) / val;
      }
    }
    this.render();
  },

  /** 确认网格 -> 采样重建豆子矩阵 */
  confirmGrid() {
    const { cols, rows } = this.data;
    const { pitchX, pitchY, offX, offY } = this.gridSpec;
    const { data } = this.imageData;
    const W = this.srcW;
    const H = this.srcH;
    const out = new Uint8ClampedArray(cols * rows * 4);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = this.sampleCellAppearance(
          data,
          W,
          H,
          offX + c * pitchX,
          offY + r * pitchY,
          offX + (c + 1) * pitchX,
          offY + (r + 1) * pitchY
        );
        const o = (r * cols + c) * 4;
        if (!cell.hasBeadCode) {
          out[o + 3] = 0;
          continue;
        }

        out[o] = Math.round(cell.r);
        out[o + 1] = Math.round(cell.g);
        out[o + 2] = Math.round(cell.b);
        out[o + 3] = 255;
      }
    }

    this.beadImageData = { data: out, width: cols, height: rows };
    this.setData({ gridW: cols, gridH: rows });
    this.process();
  },

  /* ================= 色号映射与位图 ================= */

  /**
   * 采样矩阵 -> Mard 色号映射。
   * 数量完全由主体网格中带编号的格子逐格生成，不读取、也不依赖图片底部图例。
   * 每颗豆在当前豆盘中找最接近的印刷色号，再按识别结果统计各色号豆数。
   */
  process() {
    const t0 = Date.now();
    const raw = this.beadImageData.data;
    const size = this.data.paletteSize;
    const set = LAB_SETS[size] || LAB_SETS[221];
    const pixelCount = raw.length / 4;
    const gridRaw = new Int32Array(pixelCount);
    const counts = new Map(); // 套装下标 -> 豆数
    const cache = new Map();  // 6bit 量化色 -> 套装下标（加速）

    for (let i = 0, p = 0; i < raw.length; i += 4, p++) {
      if (raw[i + 3] < 128) {
        gridRaw[p] = -1;
        continue;
      }
      const q = ((raw[i] >> 2) << 12) | ((raw[i + 1] >> 2) << 6) | (raw[i + 2] >> 2);
      let idx = cache.get(q);
      if (idx === undefined) {
        idx = this.gridSpec && this.gridSpec.coordinateChart
          ? nearestChartIndex(set, raw[i], raw[i + 1], raw[i + 2])
          : -1;
        if (idx < 0) idx = nearestPrintedPaletteIndex(set, raw[i], raw[i + 1], raw[i + 2]);
        if (idx < 0) {
          gridRaw[p] = -1;
          continue;
        }
        cache.set(q, idx);
      }
      gridRaw[p] = idx;
      counts.set(idx, (counts.get(idx) || 0) + 1);
    }

    // 使用到的色号，按豆数降序
    const used = [];
    counts.forEach((count, idx) => {
      const c = set[idx];
      used.push({ code: c.c, hex: c.h, r: c.r, g: c.g, b: c.b, count, setIdx: idx });
    });
    used.sort((a, b) => b.count - a.count);
    const remap = new Map();
    used.forEach((c, i) => remap.set(c.setIdx, i));

    const grid = new Int32Array(pixelCount);
    let totalBeads = 0;
    for (let p = 0; p < pixelCount; p++) {
      if (gridRaw[p] < 0) {
        grid[p] = -1;
      } else {
        grid[p] = remap.get(gridRaw[p]);
        totalBeads++;
      }
    }

    console.log(`[bead] mapped to ${used.length} codes (${size}-set) in ${Date.now() - t0}ms`);
    this.palette = used;
    this.grid = grid;
    this.buildPatternCanvases();
    this.setData({
      stage: 'ready',
      colors: used,
      totalBeads,
      selectedIndex: -1,
      selectedCode: '',
      selectedCount: 0
    }, () => {
      this.initCanvas(() => {
        this.fitView();
        this.render();
      });
    });
  },

  /** 切换豆盘档位 */
  onSizeTap(e) {
    const paletteSize = parseInt(e.currentTarget.dataset.size, 10);
    if (paletteSize === this.data.paletteSize) return;
    this.setData({ paletteSize });
    wx.setStorageSync('paletteSize', paletteSize);
    if (this.beadImageData) this.process();
  },

  /** 全色位图 + 变暗位图 */
  buildPatternCanvases() {
    const w = this.data.gridW;
    const h = this.data.gridH;
    const dark = this.data.theme === 'dark';

    const full = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
    const fctx = full.getContext('2d');
    const fimg = fctx.createImageData(w, h);
    const fd = fimg.data;

    const dim = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
    const dctx = dim.getContext('2d');
    const dimg = dctx.createImageData(w, h);
    const dd = dimg.data;
    const dimR = dark ? 40 : 232;
    const dimG = dark ? 40 : 232;
    const dimB = dark ? 52 : 240;

    for (let p = 0; p < this.grid.length; p++) {
      const ci = this.grid[p];
      if (ci < 0) continue;
      const c = this.palette[ci];
      const o = p * 4;
      fd[o] = c.r; fd[o + 1] = c.g; fd[o + 2] = c.b; fd[o + 3] = 255;
      dd[o] = dimR; dd[o + 1] = dimG; dd[o + 2] = dimB; dd[o + 3] = 255;
    }
    fctx.putImageData(fimg, 0, 0);
    dctx.putImageData(dimg, 0, 0);
    this.patternCanvas = full;
    this.dimCanvas = dim;
    this.isoCanvas = null;
  },

  /** 仅包含选中颜色的位图 */
  buildIsoCanvas(sel) {
    const w = this.data.gridW;
    const h = this.data.gridH;
    const iso = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
    const ictx = iso.getContext('2d');
    const img = ictx.createImageData(w, h);
    const d = img.data;
    const c = this.palette[sel];
    for (let p = 0; p < this.grid.length; p++) {
      if (this.grid[p] !== sel) continue;
      const o = p * 4;
      d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b; d[o + 3] = 255;
    }
    ictx.putImageData(img, 0, 0);
    this.isoCanvas = iso;
  },

  /* ================= 视图变换 ================= */

  fitView() {
    const isAdjust = this.data.stage === 'adjust';
    const coordinatePadding = !isAdjust && this.gridSpec && this.gridSpec.coordinateChart ? 2 : 0;
    const w = isAdjust ? this.srcW : this.data.gridW + coordinatePadding;
    const h = isAdjust ? this.srcH : this.data.gridH + coordinatePadding;
    if (!w || !h || !this.boardW) return;
    const scale = Math.min(
      this.boardW / (w * BASE_CELL),
      this.boardH / (h * BASE_CELL)
    );
    const s = Math.min(scale, 2);
    this.view = {
      scale: s,
      x: (this.boardW - w * BASE_CELL * s) / 2,
      y: (this.boardH - h * BASE_CELL * s) / 2
    };
  },

  clampScale(s) {
    return Math.min(20, Math.max(0.05, s));
  },

  /* ================= 渲染 ================= */

  render() {
    const ctx = this.ctx;
    if (!ctx) return;
    const dark = this.data.theme === 'dark';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = dark ? '#0e0e16' : '#ffffff';
    ctx.fillRect(0, 0, this.boardW, this.boardH);

    if (this.data.stage === 'adjust') {
      this.renderAdjust();
      return;
    }
    if (!this.grid) return;
    this.renderBeads();
  },

  /** 校准页：源图 + 红色网格叠加 */
  renderAdjust() {
    const ctx = this.ctx;
    if (!this.srcCanvas || !this.gridSpec) return;
    const { scale, x, y } = this.view;
    const unit = BASE_CELL * scale; // 源图 1px 对应屏幕 px
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(this.srcCanvas, x, y, this.srcW * unit, this.srcH * unit);

    const { pitchX, pitchY, offX, offY } = this.gridSpec;
    const { cols, rows } = this.data;
    const gx = x + offX * unit;
    const gy = y + offY * unit;
    const gw = cols * pitchX * unit;
    const gh = rows * pitchY * unit;

    ctx.strokeStyle = 'rgba(255, 80, 80, 0.85)';
    ctx.lineWidth = 1;
    // 外框加粗提示
    ctx.strokeRect(gx, gy, gw, gh);
    // 间距过密时只画外框，避免一片红
    if (pitchX * unit >= 5) {
      ctx.beginPath();
      for (let i = 1; i < cols; i++) {
        const lx = gx + i * pitchX * unit;
        ctx.moveTo(lx, gy);
        ctx.lineTo(lx, gy + gh);
      }
      ctx.stroke();
    }
    if (pitchY * unit >= 5) {
      ctx.beginPath();
      for (let i = 1; i < rows; i++) {
        const ly = gy + i * pitchY * unit;
        ctx.moveTo(gx, ly);
        ctx.lineTo(gx + gw, ly);
      }
      ctx.stroke();
    }
  },

  /** 摆豆页：混合渲染 */
  renderBeads() {
    const ctx = this.ctx;
    const dark = this.data.theme === 'dark';
    const { scale, x, y } = this.view;
    const cell = BASE_CELL * scale;
    const w = this.data.gridW;
    const h = this.data.gridH;
    const sel = this.data.selectedIndex;

    if (this.gridSpec && this.gridSpec.coordinateChart) {
      this.renderCoordinateChart(cell, x, y, sel);
      return;
    }

    if (cell < CELL_DETAIL_MIN) {
      ctx.imageSmoothingEnabled = false;
      const dw = w * cell;
      const dh = h * cell;
      if (sel >= 0 && this.isoCanvas) {
        ctx.drawImage(this.dimCanvas, x, y, dw, dh);
        ctx.drawImage(this.isoCanvas, x, y, dw, dh);
      } else {
        ctx.drawImage(this.patternCanvas, x, y, dw, dh);
      }
      return;
    }

    const x0 = Math.max(0, Math.floor(-x / cell));
    const y0 = Math.max(0, Math.floor(-y / cell));
    const x1 = Math.min(w - 1, Math.ceil((this.boardW - x) / cell));
    const y1 = Math.min(h - 1, Math.ceil((this.boardH - y) / cell));

    const dimFill = dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
    const drawCircle = cell >= CIRCLE_MIN;
    const gap = cell >= 6 ? Math.max(1, cell * 0.08) : 0;

    for (let gy = y0; gy <= y1; gy++) {
      const rowBase = gy * w;
      const py = y + gy * cell;
      for (let gx = x0; gx <= x1; gx++) {
        const ci = this.grid[rowBase + gx];
        if (ci < 0) continue;
        const dimmed = sel >= 0 && ci !== sel;
        const px = x + gx * cell;
        if (drawCircle) {
          ctx.beginPath();
          ctx.fillStyle = dimmed ? dimFill : this.palette[ci].hex;
          ctx.arc(px + cell / 2, py + cell / 2, cell / 2 - Math.max(0.5, cell * 0.05), 0, 6.2832);
          ctx.fill();
        } else {
          ctx.fillStyle = dimmed ? dimFill : this.palette[ci].hex;
          ctx.fillRect(px + gap / 2, py + gap / 2, cell - gap, cell - gap);
        }
      }
    }

    this.renderGridOverlay(cell, x, y, x0, y0, x1, y1, sel);
  },

  /** 标准图纸矢量重绘：方格、色号文字、四边完整行列坐标。 */
  renderCoordinateChart(cell, x, y, sel) {
    const ctx = this.ctx;
    const dark = this.data.theme === 'dark';
    const w = this.data.gridW;
    const h = this.data.gridH;
    const totalW = w + 2;
    const totalH = h + 2;
    const dataX = x + cell;
    const dataY = y + cell;
    const lineColor = dark ? 'rgba(255,255,255,0.20)' : 'rgba(20,30,45,0.20)';
    const majorColor = dark ? 'rgba(255,174,104,0.55)' : 'rgba(224,132,61,0.48)';
    const headerFill = dark ? '#252b36' : '#eef6ff';
    const emptyA = dark ? '#20202a' : '#fafafa';
    const emptyB = dark ? '#252530' : '#f0f0f0';
    const dimFill = dark ? '#343440' : '#e5e5ea';

    ctx.fillStyle = headerFill;
    ctx.fillRect(x + cell, y, w * cell, cell);
    ctx.fillRect(x + cell, y + (h + 1) * cell, w * cell, cell);
    ctx.fillRect(x, y + cell, cell, h * cell);
    ctx.fillRect(x + (w + 1) * cell, y + cell, cell, h * cell);

    const x0 = Math.max(0, Math.floor((0 - dataX) / cell));
    const y0 = Math.max(0, Math.floor((0 - dataY) / cell));
    const x1 = Math.min(w - 1, Math.ceil((this.boardW - dataX) / cell));
    const y1 = Math.min(h - 1, Math.ceil((this.boardH - dataY) / cell));
    const checkSize = cell / 4;

    for (let row = y0; row <= y1; row++) {
      const py = dataY + row * cell;
      const rowBase = row * w;
      for (let col = x0; col <= x1; col++) {
        const px = dataX + col * cell;
        const colorIndex = this.grid[rowBase + col];
        if (colorIndex < 0) {
          ctx.fillStyle = emptyA;
          ctx.fillRect(px, py, cell, cell);
          if (cell >= 7) {
            ctx.fillStyle = emptyB;
            for (let cy = 0; cy < 4; cy++) {
              for (let cx = 0; cx < 4; cx++) {
                if ((cx + cy) % 2 === 0) {
                  ctx.fillRect(px + cx * checkSize, py + cy * checkSize, checkSize, checkSize);
                }
              }
            }
          }
          continue;
        }

        const color = this.palette[colorIndex];
        const dimmed = sel >= 0 && colorIndex !== sel;
        ctx.fillStyle = dimmed ? dimFill : color.hex;
        ctx.fillRect(px, py, cell, cell);

        if (!dimmed) {
          const luminance = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
          ctx.fillStyle = luminance > 155 ? '#17171c' : '#ffffff';
          ctx.font = `600 ${Math.max(4, Math.floor(cell * 0.34))}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(color.code, px + cell / 2, py + cell / 2, cell * 0.9);
        }
      }
    }

    // 每格细线。
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let col = 0; col <= totalW; col++) {
      const px = x + col * cell;
      ctx.moveTo(px, y);
      ctx.lineTo(px, y + totalH * cell);
    }
    for (let row = 0; row <= totalH; row++) {
      const py = y + row * cell;
      ctx.moveTo(x, py);
      ctx.lineTo(x + totalW * cell, py);
    }
    ctx.stroke();

    // 原图每 8 格一条强调线。
    ctx.strokeStyle = majorColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let col = 8; col < w; col += 8) {
      const px = dataX + col * cell;
      ctx.moveTo(px, dataY);
      ctx.lineTo(px, dataY + h * cell);
    }
    for (let row = 8; row < h; row += 8) {
      const py = dataY + row * cell;
      ctx.moveTo(dataX, py);
      ctx.lineTo(dataX + w * cell, py);
    }
    ctx.stroke();

    if (cell >= 6) {
      ctx.fillStyle = dark ? '#f4f6fb' : '#111318';
      ctx.font = `600 ${Math.max(5, Math.floor(cell * 0.42))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let col = 0; col < w; col++) {
        const px = dataX + (col + 0.5) * cell;
        ctx.fillText(String(col + 1), px, y + cell / 2);
        ctx.fillText(String(col + 1), px, y + (h + 1.5) * cell);
      }
      for (let row = 0; row < h; row++) {
        const py = dataY + (row + 0.5) * cell;
        ctx.fillText(String(row + 1), x + cell / 2, py);
        ctx.fillText(String(row + 1), x + (w + 1.5) * cell, py);
      }
    }
  },

  /**
   * 网格叠加层：格子线 + 每 5 格粗线 + 边缘坐标 + 格内色号文字
   * 单色高亮时只为选中色画色号标注
   */
  renderGridOverlay(cell, x, y, x0, y0, x1, y1, sel) {
    if (cell < 6) return;
    const ctx = this.ctx;
    const dark = this.data.theme === 'dark';
    const w = this.data.gridW;
    const h = this.data.gridH;

    // ---- 细网格线（每格） ----
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const top = y + y0 * cell;
    const bottom = y + (y1 + 1) * cell;
    const left = x + x0 * cell;
    const right = x + (x1 + 1) * cell;
    for (let gx = x0; gx <= x1 + 1; gx++) {
      const px = x + gx * cell;
      ctx.moveTo(px, top);
      ctx.lineTo(px, bottom);
    }
    for (let gy = y0; gy <= y1 + 1; gy++) {
      const py = y + gy * cell;
      ctx.moveTo(left, py);
      ctx.lineTo(right, py);
    }
    ctx.stroke();

    // ---- 粗网格线（每 5 格） ----
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let gx = Math.ceil(x0 / 5) * 5; gx <= x1 + 1; gx += 5) {
      const px = x + gx * cell;
      ctx.moveTo(px, top);
      ctx.lineTo(px, bottom);
    }
    for (let gy = Math.ceil(y0 / 5) * 5; gy <= y1 + 1; gy += 5) {
      const py = y + gy * cell;
      ctx.moveTo(left, py);
      ctx.lineTo(right, py);
    }
    ctx.stroke();

    // ---- 边缘坐标（每 5 格，钉在屏幕边缘，随滚动跟随） ----
    if (cell >= 10) {
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)';
      for (let gx = x0; gx <= x1; gx++) {
        if ((gx + 1) % 5 !== 0) continue;
        const px = x + (gx + 0.5) * cell;
        if (px < 14 || px > this.boardW - 14) continue;
        ctx.fillText(String(gx + 1), px, 12);
      }
      for (let gy = y0; gy <= y1; gy++) {
        if ((gy + 1) % 5 !== 0) continue;
        const py = y + (gy + 0.5) * cell;
        if (py < 20 || py > this.boardH - 12) continue;
        ctx.fillText(String(gy + 1), 10, py);
      }
    }

    // ---- 格内色号文字（格子够大时） ----
    if (cell >= 20) {
      const fontSize = Math.max(8, Math.floor(cell * 0.32));
      ctx.font = fontSize + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let gy = y0; gy <= y1; gy++) {
        const rowBase = gy * w;
        const py = y + gy * cell;
        for (let gx = x0; gx <= x1; gx++) {
          const ci = this.grid[rowBase + gx];
          if (ci < 0) continue;
          if (sel >= 0 && ci !== sel) continue; // 单色模式只标注选中色
          const c = this.palette[ci];
          const lum = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
          ctx.fillStyle = lum > 150 ? 'rgba(0,0,0,0.72)' : 'rgba(255,255,255,0.85)';
          ctx.fillText(c.code, x + gx * cell + cell / 2, py + cell / 2);
        }
      }
    }
  },

  /* ================= 手势 ================= */

  localTouch(t) {
    if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
      return { x: t.x, y: t.y };
    }
    return {
      x: t.clientX - (this.boardLeft || 0),
      y: t.clientY - (this.boardTop || 0)
    };
  },

  onTouchStart(e) {
    const ts = e.touches;
    if (ts.length === 1) {
      const t = this.localTouch(ts[0]);
      this.gesture = {
        mode: 'pan',
        startT: Date.now(),
        moved: false,
        sx: t.x,
        sy: t.y,
        vx: this.view.x,
        vy: this.view.y
      };
    } else if (ts.length === 2) {
      const t0 = this.localTouch(ts[0]);
      const t1 = this.localTouch(ts[1]);
      const dx = t1.x - t0.x;
      const dy = t1.y - t0.y;
      this.gesture = {
        mode: 'pinch',
        moved: true,
        dist0: Math.hypot(dx, dy),
        cx: (t0.x + t1.x) / 2,
        cy: (t0.y + t1.y) / 2,
        scale0: this.view.scale,
        vx: this.view.x,
        vy: this.view.y
      };
    }
  },

  onTouchMove(e) {
    const g = this.gesture;
    if (!g) return;
    const ts = e.touches;

    if (g.mode === 'pan' && ts.length === 1) {
      const t = this.localTouch(ts[0]);
      const dx = t.x - g.sx;
      const dy = t.y - g.sy;
      if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
      this.view.x = g.vx + dx;
      this.view.y = g.vy + dy;
      this.render();
    } else if (ts.length === 2) {
      if (g.mode === 'pan') { this.onTouchStart(e); return; }
      const t0 = this.localTouch(ts[0]);
      const t1 = this.localTouch(ts[1]);
      const dx = t1.x - t0.x;
      const dy = t1.y - t0.y;
      const dist = Math.hypot(dx, dy);
      const cx = (t0.x + t1.x) / 2;
      const cy = (t0.y + t1.y) / 2;
      const scale = this.clampScale(g.scale0 * (dist / g.dist0));
      const k = scale / g.scale0;
      this.view.scale = scale;
      this.view.x = cx - (g.cx - g.vx) * k;
      this.view.y = cy - (g.cy - g.vy) * k;
      this.render();
    }
  },

  onTouchEnd(e) {
    const g = this.gesture;
    this.gesture = null;
    if (!g || g.mode !== 'pan' || g.moved) return;
    if (Date.now() - g.startT > 400) return;
    if (this.data.stage !== 'ready') return;
    const t = e.changedTouches[0];
    if (!t) return;
    const p = this.localTouch(t);
    this.pickColorAt(p.x, p.y);
  },

  pickColorAt(px, py) {
    if (!this.grid) return;
    const cell = BASE_CELL * this.view.scale;
    const coordinateOffset = this.gridSpec && this.gridSpec.coordinateChart ? 1 : 0;
    const gx = Math.floor((px - this.view.x) / cell) - coordinateOffset;
    const gy = Math.floor((py - this.view.y) / cell) - coordinateOffset;
    if (gx < 0 || gy < 0 || gx >= this.data.gridW || gy >= this.data.gridH) return;
    const ci = this.grid[gy * this.data.gridW + gx];
    if (ci < 0) return;
    this.applySelection(ci === this.data.selectedIndex ? -1 : ci);
  },

  /* ================= 颜色选择与主题 ================= */

  applySelection(index) {
    if (index >= 0) this.buildIsoCanvas(index);
    const selected = index >= 0 ? this.palette[index] : null;
    this.setData({
      selectedIndex: index,
      selectedCode: selected ? selected.code : '',
      selectedCount: selected ? selected.count : 0
    });
    this.render();
  },

  onChipTap(e) {
    const index = e.currentTarget.dataset.index;
    this.applySelection(index === this.data.selectedIndex ? -1 : index);
  },

  clearSelect() {
    this.applySelection(-1);
  },

  toggleTheme() {
    const theme = this.data.theme === 'dark' ? 'light' : 'dark';
    this.setData({ theme });
    wx.setStorageSync('theme', theme);
    if (this.grid) {
      this.buildPatternCanvases();
      if (this.data.selectedIndex >= 0) this.buildIsoCanvas(this.data.selectedIndex);
    }
    this.render();
  },

  onShareAppMessage() {
    return { title: '拼豆摆豆助手 - 上传图纸，单色高亮快速摆豆', path: '/pages/index/index' };
  }
});
