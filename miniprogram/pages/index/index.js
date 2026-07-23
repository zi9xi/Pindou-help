const { LAB_SETS, SIZES, nearestIndex } = require('../../utils/palette');

const BASE_CELL = 12;       // 1 倍缩放时每个豆格的尺寸（px）
const MAX_GRID = 800;       // 源图最大边长（像素，仅用于读像素，不是豆数）
const CIRCLE_MIN = 9;       // 格子 >= 该 px 时画圆形豆
const CELL_DETAIL_MIN = 4;  // 格子 < 该 px 时走离屏位图渲染
const EMPTY_TH = 245;       // 采样色三通道均高于此值视为空白格

Page({
  data: {
    stage: 'empty',   // empty | adjust | ready
    theme: 'dark',
    gridW: 0,         // 豆子矩阵宽（颗）
    gridH: 0,         // 豆子矩阵高（颗）
    totalBeads: 0,
    colors: [],
    selectedIndex: -1,
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
    if (this.ctx) {
      cb && cb();
      return;
    }
    this.createSelectorQuery()
      .select('#board')
      .fields({ node: true, size: true, rect: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        this.canvas = res[0].node;
        this.ctx = this.canvas.getContext('2d');
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

  loadImage(path) {
    wx.showLoading({ title: '解析图纸中' });
    wx.getImageInfo({
      src: path,
      success: (info) => {
        let w = info.width;
        let h = info.height;
        if (Math.max(w, h) > MAX_GRID) {
          const k = MAX_GRID / Math.max(w, h);
          w = Math.round(w * k);
          h = Math.round(h * k);
        }
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

    // 灰度（透明像素视为白）
    const g = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) {
      const o = p * 4;
      g[p] = data[o + 3] < 128
        ? 255
        : data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
    }

    // 列边缘强度（隔行采样提速）
    const colE = new Float32Array(W - 1);
    for (let y = 0; y < H; y += 2) {
      const base = y * W;
      for (let x = 0; x < W - 1; x++) {
        colE[x] += Math.abs(g[base + x] - g[base + x + 1]);
      }
    }
    // 行边缘强度（隔列采样提速）
    const rowE = new Float32Array(H - 1);
    for (let x = 0; x < W; x += 2) {
      for (let y = 0; y < H - 1; y++) {
        rowE[y] += Math.abs(g[y * W + x] - g[(y + 1) * W + x]);
      }
    }

    const specX = this.analyzeProjection(colE, W);
    const specY = this.analyzeProjection(rowE, H);

    if (specX && specY) {
      return {
        det: true,
        pitchX: specX.pitch, offX: specX.offset, cols: specX.cells,
        pitchY: specY.pitch, offY: specY.offset, rows: specY.cells
      };
    }
    if (specX) {
      const rows = Math.max(2, Math.round(H / specX.pitch));
      return {
        det: true,
        pitchX: specX.pitch, offX: specX.offset, cols: specX.cells,
        pitchY: specX.pitch, offY: 0, rows
      };
    }
    if (specY) {
      const cols = Math.max(2, Math.round(W / specY.pitch));
      return {
        det: true,
        pitchX: specY.pitch, offX: 0, cols,
        pitchY: specY.pitch, offY: specY.offset, rows: specY.cells
      };
    }
    // 检测失败：默认 50 宽、正方形格子铺满
    const cols = 50;
    const rows = Math.max(2, Math.round(H / (W / cols)));
    return {
      det: false,
      pitchX: W / cols, offX: 0, cols,
      pitchY: H / rows, offY: 0, rows
    };
  },

  /** 在投影数组中找周期尖峰，返回 { pitch, offset, cells } 或 null */
  analyzeProjection(arr, len) {
    let max = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    if (max <= 0) return null;
    const th = max * 0.3;
    const peaks = [];
    for (let i = 1; i < arr.length - 1; i++) {
      if (arr[i] >= th && arr[i] >= arr[i - 1] && arr[i] >= arr[i + 1]) {
        if (peaks.length && i - peaks[peaks.length - 1] < 3) continue;
        peaks.push(i);
      }
    }
    if (peaks.length < 6) return null;
    const pitch = (peaks[peaks.length - 1] - peaks[0]) / (peaks.length - 1);
    const cells = peaks.length - 1;
    if (pitch < 3 || pitch > len / 2 || cells < 4 || cells > 400) return null;
    return { pitch, offset: peaks[0], cells };
  },

  /** 校准页步进器 */
  onStep(e) {
    const k = e.currentTarget.dataset.k;
    const d = parseInt(e.currentTarget.dataset.d, 10);
    const val = Math.min(400, Math.max(2, this.data[k] + d));
    this.setData({ [k]: val });
    // 检测失败模式下：pitch 跟随豆数变化，网格铺满全图
    if (this.gridSpec && !this.gridSpec.det) {
      if (k === 'cols') this.gridSpec.pitchX = this.srcW / val;
      if (k === 'rows') this.gridSpec.pitchY = this.srcH / val;
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
    const half = Math.max(1, Math.round(Math.min(pitchX, pitchY) * 0.18));
    const out = new Uint8ClampedArray(cols * rows * 4);

    for (let r = 0; r < rows; r++) {
      const cy = offY + (r + 0.5) * pitchY;
      for (let c = 0; c < cols; c++) {
        const cx = offX + (c + 0.5) * pitchX;
        // ---- 1) 中心 patch 取主色（5bit 量化众数） ----
        const hist = {};
        let best = -1;
        let bestN = 0;
        const x0 = Math.max(0, Math.round(cx - half));
        const x1 = Math.min(W - 1, Math.round(cx + half));
        const y0 = Math.max(0, Math.round(cy - half));
        const y1 = Math.min(H - 1, Math.round(cy + half));
        for (let yy = y0; yy <= y1; yy++) {
          const base = yy * W;
          for (let xx = x0; xx <= x1; xx++) {
            const o = (base + xx) * 4;
            if (data[o + 3] < 128) continue;
            const q = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
            const n = (hist[q] || 0) + 1;
            hist[q] = n;
            if (n > bestN) { bestN = n; best = q; }
          }
        }
        const o = (r * cols + c) * 4;
        if (best < 0) {
          out[o + 3] = 0;
          continue;
        }
        const R = (((best >> 10) & 31) << 3) | 4;
        const G = (((best >> 5) & 31) << 3) | 4;
        const B = ((best & 31) << 3) | 4;

        // ---- 2) 近白色格：靠"格内是否印有深色色号文字"区分白豆与空白 ----
        if (R > EMPTY_TH && G > EMPTY_TH && B > EMPTY_TH) {
          // 扫描格内 15%~85% 区域的深色像素（文字墨迹）
          const ix0 = Math.max(0, Math.round(offX + (c + 0.15) * pitchX));
          const ix1 = Math.min(W - 1, Math.round(offX + (c + 0.85) * pitchX));
          const iy0 = Math.max(0, Math.round(offY + (r + 0.15) * pitchY));
          const iy1 = Math.min(H - 1, Math.round(offY + (r + 0.85) * pitchY));
          let ink = 0;
          let total = 0;
          for (let yy = iy0; yy <= iy1; yy++) {
            const base = yy * W;
            for (let xx = ix0; xx <= ix1; xx++) {
              const oo = (base + xx) * 4;
              if (data[oo + 3] < 128) continue;
              total++;
              const lum = data[oo] * 0.299 + data[oo + 1] * 0.587 + data[oo + 2] * 0.114;
              if (lum < 150) ink++;
            }
          }
          const inkRatio = total > 0 ? ink / total : 0;
          if (inkRatio < 0.01) {
            out[o + 3] = 0; // 无文字 -> 空白格
            continue;
          }
        }

        out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = 255;
      }
    }

    this.beadImageData = { data: out, width: cols, height: rows };
    this.setData({ gridW: cols, gridH: rows });
    this.process();
  },

  /* ================= 色号映射与位图 ================= */

  /**
   * 采样矩阵 -> Mard 色号映射
   * 每颗豆在当前豆盘中找 Lab 色差最小的色号，统计各色号豆数
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
        idx = nearestIndex(size, raw[i], raw[i + 1], raw[i + 2]);
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
      selectedIndex: -1
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
    const w = isAdjust ? this.srcW : this.data.gridW;
    const h = isAdjust ? this.srcH : this.data.gridH;
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
    return { x: t.x - (this.boardLeft || 0), y: t.y - (this.boardTop || 0) };
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
    const gx = Math.floor((px - this.view.x) / cell);
    const gy = Math.floor((py - this.view.y) / cell);
    if (gx < 0 || gy < 0 || gx >= this.data.gridW || gy >= this.data.gridH) return;
    const ci = this.grid[gy * this.data.gridW + gx];
    if (ci < 0) return;
    this.applySelection(ci === this.data.selectedIndex ? -1 : ci);
  },

  /* ================= 颜色选择与主题 ================= */

  applySelection(index) {
    if (index >= 0) this.buildIsoCanvas(index);
    this.setData({ selectedIndex: index });
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
