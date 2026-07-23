const { buildPalette } = require('../../utils/color');

const BASE_CELL = 12;      // 1 倍缩放时每个豆格的尺寸（px）
const MAX_GRID = 500;      // 图纸最大边长（像素）
const CIRCLE_MIN = 9;      // 格子的px大于该值时画圆形豆，否则画方块

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
    this.imageData = null;   // 原始 ImageData（调容差时复用）
    this.palette = null;     // 调色板 [{key,hex,r,g,b,count}]
    this.grid = null;        // Int32Array 逐像素调色板下标
    this.view = { scale: 1, x: 0, y: 0 };
    this.gesture = null;     // 手势状态
    this.boardW = 0;
    this.boardH = 0;
  },

  onReady() {
    this.createSelectorQuery()
      .select('#board')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        this.canvas = res[0].node;
        this.ctx = this.canvas.getContext('2d');
        this.dpr = (wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 2) || 2;
        this.boardW = res[0].width;
        this.boardH = res[0].height;
        this.canvas.width = res[0].width * this.dpr;
        this.canvas.height = res[0].height * this.dpr;
        this.render();
      });
  },

  /* ================= 图片上传与像素读取 ================= */

  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      success: (res) => {
        const path = res.tempFiles[0].tempFilePath;
        this.loadImage(path);
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

  /** 像素 -> 调色板 + 网格索引 */
  process() {
    const { data } = this.imageData;
    const t0 = Date.now();
    const { palette, grid, totalBeads } = buildPalette(data, this.data.tolerance);
    console.log(`[bead] palette built: ${palette.length} colors in ${Date.now() - t0}ms`);
    this.palette = palette;
    this.grid = grid;
    this.setData({
      ready: true,
      colors: palette,
      totalBeads,
      selectedIndex: -1
    });
    this.fitView();
    this.render();
  },

  onToleranceChange(e) {
    this.setData({ tolerance: e.detail.value });
    if (this.imageData) this.process();
  },

  /* ================= 视图变换 ================= */

  fitView() {
    const { gridW, gridH } = this.data;
    if (!gridW || !gridH || !this.boardW) return;
    const scale = Math.min(
      this.boardW / (gridW * BASE_CELL),
      this.boardH / (gridH * BASE_CELL)
    );
    this.view = {
      scale: Math.min(scale, 2),
      x: (this.boardW - gridW * BASE_CELL * Math.min(scale, 2)) / 2,
      y: (this.boardH - gridH * BASE_CELL * Math.min(scale, 2)) / 2
    };
  },

  clampScale(s) {
    return Math.min(20, Math.max(0.15, s));
  },

  /* ================= 渲染（只画可见区域） ================= */

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

    const x0 = Math.max(0, Math.floor(-x / cell));
    const y0 = Math.max(0, Math.floor(-y / cell));
    const x1 = Math.min(w - 1, Math.ceil((this.boardW - x) / cell));
    const y1 = Math.min(h - 1, Math.ceil((this.boardH - y) / cell));

    const dimFill = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    const drawCircle = cell >= CIRCLE_MIN;
    const gap = drawCircle ? 0 : Math.max(1, cell * 0.08);

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

  onTouchStart(e) {
    const ts = e.touches;
    if (ts.length === 1) {
      this.gesture = {
        mode: 'pan',
        startT: Date.now(),
        moved: false,
        sx: ts[0].x,
        sy: ts[0].y,
        vx: this.view.x,
        vy: this.view.y
      };
    } else if (ts.length === 2) {
      const dx = ts[1].x - ts[0].x;
      const dy = ts[1].y - ts[0].y;
      this.gesture = {
        mode: 'pinch',
        moved: true,
        dist0: Math.hypot(dx, dy),
        cx: (ts[0].x + ts[1].x) / 2,
        cy: (ts[0].y + ts[1].y) / 2,
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
      const dx = ts[0].x - g.sx;
      const dy = ts[0].y - g.sy;
      if (Math.abs(dx) + Math.abs(dy) > 6) g.moved = true;
      this.view.x = g.vx + dx;
      this.view.y = g.vy + dy;
      this.render();
    } else if (ts.length === 2) {
      if (g.mode === 'pan') { this.onTouchStart(e); return; }
      const dx = ts[1].x - ts[0].x;
      const dy = ts[1].y - ts[0].y;
      const dist = Math.hypot(dx, dy);
      const cx = (ts[0].x + ts[1].x) / 2;
      const cy = (ts[0].y + ts[1].y) / 2;
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
    this.pickColorAt(t.x, t.y);
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
    this.setData({ selectedIndex: ci === this.data.selectedIndex ? -1 : ci });
    this.render();
  },

  /* ================= 颜色选择与主题 ================= */

  onChipTap(e) {
    const index = e.currentTarget.dataset.index;
    this.setData({ selectedIndex: index === this.data.selectedIndex ? -1 : index });
    this.render();
  },

  clearSelect() {
    this.setData({ selectedIndex: -1 });
    this.render();
  },

  toggleTheme() {
    const theme = this.data.theme === 'dark' ? 'light' : 'dark';
    this.setData({ theme });
    wx.setStorageSync('theme', theme);
    this.render();
  },

  onShareAppMessage() {
    return { title: '拼豆摆豆助手 - 上传图纸，单色高亮快速摆豆', path: '/pages/index/index' };
  }
});
