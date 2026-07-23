const { buildPalette } = require('../../utils/color');

const BASE_CELL = 12;      // 1 倍缩放时每个豆格的尺寸（px）
const MAX_GRID = 500;      // 图纸最大边长（像素）
const CIRCLE_MIN = 9;      // 格子 >= 该 px 时画圆形豆
const CELL_DETAIL_MIN = 4; // 格子 < 该 px 时走离屏位图渲染（总览模式）

Page({
  data: {
    ready: false,
    theme: 'dark',
    gridW: 0,
    gridH: 0,
    totalBeads: 0,
    colors: [],
    selectedIndex: -1,
    tolerance: 12
  },

  onLoad() {
    this.setData({ theme: wx.getStorageSync('theme') || 'dark' });
    // 内部状态（不进 setData，避免大数组序列化）
    this.imageData = null;      // 原始 ImageData（调容差时复用）
    this.palette = null;        // 调色板 [{key,hex,r,g,b,count}]
    this.grid = null;           // Int32Array 逐像素调色板下标
    this.patternCanvas = null;  // 全色离屏位图（1px = 1 豆）
    this.dimCanvas = null;      // 变暗底图
    this.isoCanvas = null;      // 仅选中色的离屏位图
    this.view = { scale: 1, x: 0, y: 0 };
    this.gesture = null;
    this.boardW = 0;
    this.boardH = 0;
  },

  onReady() {
    // canvas 在 wx:else 分支内，此时很可能尚未渲染，找不到属正常
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
          this.setData({ gridW: w, gridH: h });
          this.process();
          wx.hideLoading();
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

  /** 像素 -> 调色板 + 网格索引 + 离屏位图 */
  process() {
    const t0 = Date.now();
    const { palette, grid, totalBeads } = buildPalette(this.imageData.data, this.data.tolerance);
    console.log(`[bead] palette built: ${palette.length} colors in ${Date.now() - t0}ms`);
    this.palette = palette;
    this.grid = grid;
    this.buildPatternCanvases();
    this.setData({
      ready: true,
      colors: palette,
      totalBeads,
      selectedIndex: -1
    }, () => {
      // setData 完成后 canvas 节点才进入 DOM，此时初始化再渲染
      this.initCanvas(() => {
        this.fitView();
        this.render();
      });
    });
  },

  onToleranceChange(e) {
    this.setData({ tolerance: e.detail.value });
    if (this.imageData) this.process();
  },

  /* ================= 离屏位图（总览模式用） ================= */

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
    const { gridW, gridH } = this.data;
    if (!gridW || !gridH || !this.boardW) return;
    const scale = Math.min(
      this.boardW / (gridW * BASE_CELL),
      this.boardH / (gridH * BASE_CELL)
    );
    const s = Math.min(scale, 2);
    this.view = {
      scale: s,
      x: (this.boardW - gridW * BASE_CELL * s) / 2,
      y: (this.boardH - gridH * BASE_CELL * s) / 2
    };
  },

  clampScale(s) {
    return Math.min(20, Math.max(0.05, s));
  },

  /* ================= 渲染（混合：总览位图 / 细节逐格） ================= */

  render() {
    const ctx = this.ctx;
    if (!ctx) return;
    const dark = this.data.theme === 'dark';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = dark ? '#0e0e16' : '#ffffff';
    ctx.fillRect(0, 0, this.boardW, this.boardH);
    if (!this.grid) return;

    const { scale, x, y } = this.view;
    const cell = BASE_CELL * scale;
    const w = this.data.gridW;
    const h = this.data.gridH;
    const sel = this.data.selectedIndex;

    if (cell < CELL_DETAIL_MIN) {
      // 总览：整图位图缩放绘制，O(1) 复杂度
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

    // 细节：只画可见区域，逐格绘制
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

  /* ================= 手势：拖动 / 缩放 / 点按 ================= */

  /** 触摸点转换为画布内坐标 */
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
      // 以双指中心为锚点缩放
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
    const t = e.changedTouches[0];
    if (!t) return;
    const p = this.localTouch(t);
    this.pickColorAt(p.x, p.y);
  },

  /** 点按格子 -> 选中该格颜色 */
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
      // 变暗位图颜色随主题变化，重建
      this.buildPatternCanvases();
      if (this.data.selectedIndex >= 0) this.buildIsoCanvas(this.data.selectedIndex);
    }
    this.render();
  },

  onShareAppMessage() {
    return { title: '拼豆摆豆助手 - 上传图纸，单色高亮快速摆豆', path: '/pages/index/index' };
  }
});
