const { buildPalette } = require('../../utils/color');

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
    tolerance: 12,
    cols: 0,          // 校准页：横向豆数
    rows: 0           // 校准页：纵向豆数
  },

  onLoad() {
    this.setData({ theme: wx.getStorageSync('theme') || 'dark' });
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
        // 中心 patch 取主色（量化到 5bit/通道 统计众数）
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
          out[o + 3] = 0; // 全透明 -> 视为空
          continue;
        }
        const R = (((best >> 10) & 31) << 3) | 4;
        const G = (((best >> 5) & 31) << 3) | 4;
        const B = ((best & 31) << 3) | 4;
        if (R > EMPTY_TH && G > EMPTY_TH && B > EMPTY_TH) {
          out[o + 3] = 0; // 近白 -> 空白格
        } else {
          out[o] = R; out[o + 1] = G; out[o + 2] = B; out[o + 3] = 255;
        }
      }
    }

    this.beadImageData = { data: out, width: cols, height: rows };
    this.setData({ gridW: cols, gridH: rows });
    this.process();
  },

  /* ================= 调色板与位图 ================= */

  process() {
    const t0 = Date.now();
    const { palette, grid, totalBeads } = buildPalette(this.beadImageData.data, this.data.tolerance);
    console.log(`[bead] palette built: ${palette.length} colors in ${Date.now() - t0}ms`);
    this.palette = palette;
    this.grid = grid;
    this.buildPatternCanvases();
    this.setData({
      stage: 'ready',
      colors: palette,
      totalBeads,
      selectedIndex: -1
    }, () => {
      this.initCanvas(() => {
        this.fitView();
        this.render();
      });
    });
  },

  onToleranceChange(e) {
    this.setData({ tolerance: e.detail.value });
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
