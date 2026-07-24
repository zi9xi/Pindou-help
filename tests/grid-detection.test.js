const assert = require('node:assert/strict');
const test = require('node:test');

let pageDefinition;
global.Page = (definition) => {
  pageDefinition = definition;
};
require('../miniprogram/pages/index/index.js');

function createNativePattern({
  width = 360,
  height = 300,
  offsetX = 32,
  offsetY = 24,
  pitch = 10,
  cols = 24,
  rows = 18
} = {}) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let p = 0; p < width * height; p++) {
    const o = p * 4;
    data[o] = 248;
    data[o + 1] = 248;
    data[o + 2] = 248;
    data[o + 3] = 255;
  }

  function pixel(x, y, r, g, b) {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const o = (y * width + x) * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
  }

  const colors = [
    [230, 90, 90],
    [80, 170, 220],
    [245, 220, 80]
  ];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const color = colors[(row + col) % colors.length];
      for (let y = offsetY + row * pitch + 1; y < offsetY + (row + 1) * pitch; y++) {
        for (let x = offsetX + col * pitch + 1; x < offsetX + (col + 1) * pitch; x++) {
          pixel(x, y, color[0], color[1], color[2]);
        }
      }
    }
  }

  for (let col = 0; col <= cols; col++) {
    for (let y = offsetY; y <= offsetY + rows * pitch; y++) {
      pixel(offsetX + col * pitch, y, 35, 35, 35);
    }
  }
  for (let row = 0; row <= rows; row++) {
    for (let x = offsetX; x <= offsetX + cols * pitch; x++) {
      pixel(x, offsetY + row * pitch, 35, 35, 35);
    }
  }

  // 原生图纸底部常见的图例/色卡。竖边足够明显，但并不属于豆子网格。
  for (const x of [12, 28, 49, 76, 108, 145, 187, 234, 286, 343]) {
    for (let y = 222; y < 294; y++) {
      pixel(x, y, 20, 20, 20);
      pixel(x + 1, y, 20, 20, 20);
    }
  }

  return { data, width, height, offsetX, offsetY, pitch, cols, rows };
}

function createCoordinatePattern({
  includeLegend = true,
  topOffset = 0,
  axisLikeTitle = false,
  pitch = 12,
  cols = 7,
  rows = 8
} = {}) {
  const totalCols = cols + 2;
  const totalRows = rows + 2;
  const width = totalCols * pitch;
  const height = topOffset + (totalRows + (includeLegend ? 2 : 0)) * pitch;
  const data = new Uint8ClampedArray(width * height * 4);

  function fill(left, top, right, bottom, color) {
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const offset = (y * width + x) * 4;
        data[offset] = color[0];
        data[offset + 1] = color[1];
        data[offset + 2] = color[2];
        data[offset + 3] = 255;
      }
    }
  }
  function mark(col, row) {
    const x = col * pitch + 5;
    const y = topOffset + row * pitch + 3;
    fill(x, y, x + 3, y + 6, [20, 20, 20]);
  }

  fill(0, 0, width, height, [248, 248, 248]);
  if (axisLikeTitle && topOffset >= pitch) {
    // 标题文字恰好落在网格相位上，视觉上会形成一条“浅底 + 大量文字”的假坐标栏。
    for (let col = 1; col <= cols; col++) {
      const left = col * pitch;
      const top = topOffset - pitch;
      fill(left + 3, top + 2, left + 8, top + 8, [20, 20, 20]);
    }
  }
  for (let row = 1; row <= rows; row++) {
    for (let col = 1; col <= cols; col++) {
      const left = col * pitch;
      const top = topOffset + row * pitch;
      for (let y = top + 1; y < top + pitch; y++) {
        for (let x = left + 1; x < left + pitch; x++) {
          const shade = ((x >> 2) + (y >> 2)) % 2 ? 238 : 250;
          fill(x, y, x + 1, y + 1, [shade, shade, shade]);
        }
      }
    }
  }

  // 顶部/底部列号，左右行号。
  for (let col = 1; col <= cols; col++) {
    mark(col, 0);
    mark(col, totalRows - 1);
  }
  for (let row = 1; row <= rows; row++) {
    mark(0, row);
    mark(totalCols - 1, row);
  }

  // 主体中两个带色号文字的格子。
  fill(pitch + 1, topOffset + pitch + 1, pitch * 2, topOffset + pitch * 2, [253, 233, 226]);
  mark(1, 1);
  fill(pitch * 3 + 1, topOffset + pitch * 4 + 1, pitch * 4, topOffset + pitch * 5, [1, 1, 1]);
  fill(pitch * 3 + 5, topOffset + pitch * 4 + 3, pitch * 3 + 8, topOffset + pitch * 4 + 9, [250, 250, 250]);

  if (includeLegend) {
    // 底部图例噪声，不属于主体网格。
    fill(5, topOffset + totalRows * pitch + 5, width - 5, height - 3, [220, 120, 140]);
  }

  // 网格线最后绘制，保证投影中存在完整周期。
  for (let col = 0; col <= totalCols; col++) {
    fill(
      col * pitch,
      topOffset,
      Math.min(width, col * pitch + 1),
      topOffset + totalRows * pitch,
      [185, 185, 185]
    );
  }
  for (let row = 0; row <= totalRows; row++) {
    const y = topOffset + row * pitch;
    fill(0, y, width, Math.min(height, y + 1), [185, 185, 185]);
  }

  return { data, width, height, cols, rows, pitch, topOffset };
}

function createCompressedColoredPattern() {
  const pitch = 8;
  const cols = 15;
  const rows = 18;
  const margin = 4;
  const dataLeft = margin + pitch;
  const dataTop = margin + pitch;
  const rightAxis = dataLeft + cols * pitch;
  const bottomAxis = dataTop + rows * pitch;
  const width = margin * 2 + (cols + 2) * pitch;
  const height = bottomAxis + pitch + 32;
  const data = new Uint8ClampedArray(width * height * 4);

  function fill(left, top, right, bottom, color) {
    for (let y = Math.max(0, top); y < Math.min(height, bottom); y++) {
      for (let x = Math.max(0, left); x < Math.min(width, right); x++) {
        const offset = (y * width + x) * 4;
        data[offset] = color[0];
        data[offset + 1] = color[1];
        data[offset + 2] = color[2];
        data[offset + 3] = 255;
      }
    }
  }
  function mark(left, top) {
    fill(left + 3, top + 2, left + 5, top + 6, [25, 25, 25]);
  }

  fill(0, 0, width, height, [250, 250, 250]);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const shade = (row + col) % 2 ? 245 : 252;
      fill(
        dataLeft + col * pitch + 1,
        dataTop + row * pitch + 1,
        dataLeft + (col + 1) * pitch,
        dataTop + (row + 1) * pitch,
        [shade, shade, shade]
      );
      if ((row + col) % 4 === 0) {
        fill(
          dataLeft + col * pitch + 1,
          dataTop + row * pitch + 1,
          dataLeft + (col + 1) * pitch,
          dataTop + (row + 1) * pitch,
          [70, 70, 70]
        );
        fill(
          dataLeft + col * pitch + 3,
          dataTop + row * pitch + 2,
          dataLeft + col * pitch + 5,
          dataTop + row * pitch + 6,
          [245, 245, 245]
        );
      }
    }
  }

  // 四周坐标数字。
  for (let col = 0; col < cols; col++) {
    mark(dataLeft + col * pitch, margin);
    mark(dataLeft + col * pitch, bottomAxis);
  }
  for (let row = 0; row < rows; row++) {
    mark(margin, dataTop + row * pitch);
    mark(rightAxis, dataTop + row * pitch);
  }

  // 淡灰细网格 + 每 5 格一条浅蓝主网格，模拟网页压缩图。
  for (let col = 0; col <= cols; col++) {
    const x = dataLeft + col * pitch;
    fill(x, margin, x + 1, bottomAxis + pitch, [205, 205, 205]);
    if (col % 5 === 0) fill(x, margin, x + 2, bottomAxis + pitch, [150, 215, 220]);
  }
  for (let row = 0; row <= rows; row++) {
    const y = dataTop + row * pitch;
    fill(margin, y, rightAxis + pitch, y + 1, [205, 205, 205]);
    if (row % 5 === 0) fill(margin, y, rightAxis + pitch, y + 2, [150, 215, 220]);
  }

  // 图例噪声必须排除在网格之外。
  fill(8, bottomAxis + pitch + 8, width - 8, height - 4, [215, 120, 150]);
  return { data, width, height, cols, rows, pitch };
}

function detect(pattern) {
  return pageDefinition.detectGrid.call({
    ...pageDefinition,
    imageData: { data: pattern.data },
    srcW: pattern.width,
    srcH: pattern.height
  });
}

test('detects the bead grid and ignores a native chart legend', () => {
  const pattern = createNativePattern();
  const result = detect(pattern);

  assert.equal(result.det, true);
  assert.equal(result.cols, pattern.cols);
  assert.equal(result.rows, pattern.rows);
  assert.ok(Math.abs(result.pitchX - pattern.pitch) <= 0.75);
  assert.ok(Math.abs(result.pitchY - pattern.pitch) <= 0.75);
  assert.ok(Math.abs(result.offX - pattern.offsetX) <= 2);
  assert.ok(Math.abs(result.offY - pattern.offsetY) <= 2);
});

test('removes four coordinate bands from a standard exported chart', () => {
  const pattern = createCoordinatePattern();
  const result = detect(pattern);

  assert.equal(result.coordinateChart, true);
  assert.equal(result.cols, pattern.cols);
  assert.equal(result.rows, pattern.rows);
  assert.ok(Math.abs(result.offY - pattern.pitch) <= 1);
});

test('detects the complete bead grid when the exported chart has no legend', () => {
  const pattern = createCoordinatePattern({ includeLegend: false });
  const result = detect(pattern);

  assert.equal(result.coordinateChart, true);
  assert.equal(result.cols, pattern.cols);
  assert.equal(result.rows, pattern.rows);
});

test('finds a coordinate chart below a title instead of counting the title as rows', () => {
  const pattern = createCoordinatePattern({ topOffset: 30 });
  const result = detect(pattern);

  assert.equal(result.coordinateChart, true);
  assert.equal(result.cols, pattern.cols);
  assert.equal(result.rows, pattern.rows);
  assert.ok(Math.abs(result.offY - (pattern.topOffset + pattern.pitch)) <= 2);
});

test('does not count an axis-like title band as the first bead row', () => {
  const pattern = createCoordinatePattern({
    includeLegend: false,
    topOffset: 30,
    axisLikeTitle: true,
    cols: 27,
    rows: 29
  });
  const result = detect(pattern);

  assert.equal(result.coordinateChart, true);
  assert.equal(result.cols, pattern.cols);
  assert.equal(result.rows, pattern.rows);
  assert.ok(Math.abs(result.offY - (pattern.topOffset + pattern.pitch)) <= 2);
});

test('chooses the coordinate row after an adjacent axis-like title row', () => {
  const metrics = [
    { top: 22, labelRate: 0.8, neutralRate: 1 },
    { top: 59, labelRate: 0.96, neutralRate: 1 },
    { top: 96, labelRate: 0.3, neutralRate: 0.7 }
  ];
  const isAxis = (metric) => metric.labelRate >= 0.7 && metric.neutralRate >= 0.9;

  assert.equal(
    pageDefinition.selectTopCoordinateRow(metrics, 1342, isAxis),
    1
  );
});

test('recovers a compressed chart from its colored five-cell grid lines', () => {
  const pattern = createCompressedColoredPattern();
  const context = {
    ...pageDefinition,
    imageData: { data: pattern.data },
    srcW: pattern.width,
    srcH: pattern.height
  };
  const result = pageDefinition.detectColoredCoordinateChart.call(
    context,
    pattern.data,
    pattern.width,
    pattern.height,
    pattern.pitch
  );

  assert.ok(result);
  assert.equal(result.coordinateChart, true);
  assert.equal(result.coloredGrid, true);
  assert.equal(result.cols, pattern.cols);
  assert.equal(result.rows, pattern.rows);
  assert.ok(Math.abs(result.pitchX - pattern.pitch) < 0.5);
});

test('fits continuous muted grid lines despite stronger isolated title edges', () => {
  const profile = new Float32Array(1080);
  const pitch = 13.34;
  const phase = 6;
  for (let x = phase; x < profile.length; x += pitch) {
    profile[Math.round(x)] = 420;
  }
  // 标题/外框边缘更强，但不具备长周期。
  for (const x of [18, 47, 115, 391, 742, 1068]) profile[x] = 900;

  const result = pageDefinition.fitNeutralGridLattice(profile, 13.2);
  assert.ok(result);
  assert.ok(Math.abs(result.pitch - pitch) < 0.2);
  assert.ok(Math.abs(result.phase - phase) < 2);
});

test('rejects strong edges that do not form a periodic grid', () => {
  const projection = new Float32Array(100);
  for (const x of [10, 20, 31, 45, 61, 80]) projection[x] = 100;

  assert.equal(pageDefinition.analyzeProjection(projection, 100), null);
});

test('recognizes a scaled non-integer grid with a few obscured lines', () => {
  const projection = new Float32Array(800);
  const pitch = 6.4;
  const offset = 23;
  const cells = 80;
  const obscured = new Set([17, 39, 62]);
  for (let i = 0; i <= cells; i++) {
    if (!obscured.has(i)) projection[Math.round(offset + i * pitch)] = 100;
  }

  const result = pageDefinition.analyzeProjection(projection, 800);
  assert.ok(result);
  assert.ok(Math.abs(result.pitch - pitch) < 0.1);
  assert.ok(Math.abs(result.offset - offset) < 1);
  assert.equal(result.cells, cells);
});

test('keeps enough source resolution for small cells in an original chart', () => {
  assert.deepEqual(pageDefinition.scaledImageSize(1600, 1200), {
    width: 1600,
    height: 1200
  });
  assert.deepEqual(pageDefinition.scaledImageSize(3600, 2400), {
    width: 2048,
    height: 1365
  });
});

test('upscales small cells to a readable integer size without exceeding memory cap', () => {
  assert.equal(
    pageDefinition.enhancementFactor(
      { det: true, pitchX: 12.2, pitchY: 12.2 },
      1080,
      1456
    ),
    2
  );
  assert.equal(
    pageDefinition.enhancementFactor(
      { det: true, pitchX: 24, pitchY: 24 },
      1080,
      1456
    ),
    1
  );
});

test('manual cell-count correction redistributes cells inside detected bounds', () => {
  const context = {
    data: { cols: 24, rows: 18 },
    srcW: 360,
    srcH: 300,
    gridSpec: {
      det: true,
      offX: 32,
      offY: 24,
      pitchX: 10,
      pitchY: 10,
      endX: 272,
      endY: 204
    },
    setData(update) {
      Object.assign(this.data, update);
    },
    render() {}
  };

  pageDefinition.onStep.call(context, {
    currentTarget: { dataset: { k: 'cols', d: '1' } }
  });

  assert.equal(context.data.cols, 25);
  assert.equal(context.gridSpec.pitchX, 240 / 25);
  assert.equal(context.gridSpec.endX, 272);
});

test('only contrasting text cells are treated as labeled', () => {
  const width = 24;
  const height = 12;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const shade = x < 12 && ((x >> 2) + (y >> 2)) % 2 ? 232 : 250;
      data[offset] = shade;
      data[offset + 1] = shade;
      data[offset + 2] = shade;
      data[offset + 3] = 255;
    }
  }
  for (let y = 3; y < 9; y++) {
    for (let x = 17; x < 20; x++) {
      const offset = (y * width + x) * 4;
      data[offset] = 15;
      data[offset + 1] = 15;
      data[offset + 2] = 15;
    }
  }

  const empty = pageDefinition.sampleCellAppearance(data, width, height, 0, 0, 12, 12);
  const labeled = pageDefinition.sampleCellAppearance(data, width, height, 12, 0, 24, 12);
  assert.equal(empty.hasLabel, false);
  assert.equal(labeled.hasLabel, true);
});

test('keeps antialiased light text on a medium-color cell', () => {
  const width = 16;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const glyph = x >= 6 && x <= 9 && y >= 4 && y <= 11;
      const color = glyph ? [215, 205, 195] : [230, 133, 109];
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }

  const cell = pageDefinition.sampleCellAppearance(
    data, width, height, 0, 0, width, height
  );
  assert.equal(cell.hasLabel, true);
});

test('requires a contrasting printed label before a cell can become a bead-code candidate', () => {
  const width = 48;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const offset = p * 4;
    data[offset] = 230;
    data[offset + 1] = 133;
    data[offset + 2] = 109;
    data[offset + 3] = 255;
  }
  function ink(left, right, top = 7, bottom = 17) {
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const offset = (y * width + x) * 4;
        data[offset] = 255;
        data[offset + 1] = 255;
        data[offset + 2] = 255;
      }
    }
  }

  // 第一个格子模拟 H2；第二格只有底色，没有任何印刷编号。
  ink(5, 10);
  ink(13, 18);

  const beadCode = pageDefinition.sampleCellAppearance(data, width, height, 0, 0, 24, 24);
  const unlabeled = pageDefinition.sampleCellAppearance(data, width, height, 24, 0, 48, 24);
  assert.equal(beadCode.hasBeadCode, true);
  assert.equal(unlabeled.hasLabel, false);
  assert.equal(unlabeled.hasBeadCode, false);
});

test('rejects gray and oversized watermarks on empty light cells', () => {
  const width = 72;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const offset = p * 4;
    data[offset] = 242;
    data[offset + 1] = 242;
    data[offset + 2] = 242;
    data[offset + 3] = 255;
  }
  function ink(cell, left, right, top, bottom, shade) {
    const origin = cell * 24;
    for (let y = top; y < bottom; y++) {
      for (let x = origin + left; x < origin + right; x++) {
        const offset = (y * width + x) * 4;
        data[offset] = shade;
        data[offset + 1] = shade;
        data[offset + 2] = shade;
      }
    }
  }

  // H1：两个紧凑黑色字符；灰色斜水印；占据大面积的标题/水印。
  ink(0, 5, 8, 7, 17, 20);
  ink(0, 11, 14, 7, 17, 20);
  ink(1, 5, 14, 9, 13, 155);
  ink(2, 4, 18, 5, 19, 20);

  const code = pageDefinition.sampleCellAppearance(data, width, height, 0, 0, 24, 24);
  const grayWatermark = pageDefinition.sampleCellAppearance(data, width, height, 24, 0, 48, 24);
  const oversizedWatermark = pageDefinition.sampleCellAppearance(data, width, height, 48, 0, 72, 24);
  assert.equal(code.hasBeadCode, true);
  assert.equal(grayWatermark.hasLabel, true);
  assert.equal(grayWatermark.hasBeadCode, false);
  assert.equal(oversizedWatermark.hasLabel, true);
  assert.equal(oversizedWatermark.hasBeadCode, false);
});

test('generates printed-code counts from grid cells without reading a legend', () => {
  const raw = new Uint8ClampedArray([
    253, 233, 226, 255, // E11
    213, 86, 86, 255,   // F25
    255, 253, 254, 255, // H2
    245, 213, 225, 255  // E18
  ]);
  const context = {
    ...pageDefinition,
    data: { paletteSize: 221, gridW: 4, gridH: 1, theme: 'dark' },
    beadImageData: { data: raw, width: 4, height: 1 },
    gridSpec: { coordinateChart: true },
    buildPatternCanvases() {},
    setData(update) {
      Object.assign(this.data, update);
    }
  };

  pageDefinition.process.call(context);
  const counts = Object.fromEntries(context.palette.map((color) => [color.code, color.count]));
  assert.deepEqual(counts, { E11: 1, F25: 1, H2: 1, E18: 1 });
  assert.equal(context.data.totalBeads, 4);
});

test('maps Beads Creator exported display colors to their printed codes', () => {
  const raw = new Uint8ClampedArray([
    248, 225, 209, 255, // A23
    45, 134, 202, 255,  // C20
    52, 44, 42, 255,    // H16
    240, 240, 240, 255  // H17
  ]);
  const context = {
    ...pageDefinition,
    data: { paletteSize: 221, gridW: 4, gridH: 1, theme: 'dark' },
    beadImageData: { data: raw, width: 4, height: 1 },
    gridSpec: { coordinateChart: true },
    buildPatternCanvases() {},
    setData(update) {
      Object.assign(this.data, update);
    }
  };

  pageDefinition.process.call(context);
  const counts = Object.fromEntries(context.palette.map((color) => [color.code, color.count]));
  assert.deepEqual(counts, { A23: 1, C20: 1, H16: 1, H17: 1 });
});

test('keeps JPEG variants of the same G4 chart color under one printed code', () => {
  const raw = new Uint8ClampedArray([
    222, 177, 129, 255,
    225, 178, 129, 255
  ]);
  const context = {
    ...pageDefinition,
    data: { paletteSize: 221, gridW: 2, gridH: 1, theme: 'dark' },
    beadImageData: { data: raw, width: 2, height: 1 },
    gridSpec: { coordinateChart: true },
    buildPatternCanvases() {},
    setData(update) {
      Object.assign(this.data, update);
    }
  };

  pageDefinition.process.call(context);
  assert.deepEqual(
    context.palette.map((color) => [color.code, color.count]),
    [['G4', 2]]
  );
});

test('rejects labeled color blocks that do not match the active bead palette', () => {
  const raw = new Uint8ClampedArray([
    253, 233, 226, 255, // E11
    0, 0, 255, 255      // 与 Mard 色卡明显无关的纯蓝色块
  ]);
  const context = {
    ...pageDefinition,
    data: { paletteSize: 221, gridW: 2, gridH: 1, theme: 'dark' },
    beadImageData: { data: raw, width: 2, height: 1 },
    gridSpec: { coordinateChart: true },
    buildPatternCanvases() {},
    setData(update) {
      Object.assign(this.data, update);
    }
  };

  pageDefinition.process.call(context);
  assert.equal(context.data.totalBeads, 1);
  assert.deepEqual(context.palette.map((color) => color.code), ['E11']);
});

test('uses canvas-relative touch coordinates without subtracting the board offset twice', () => {
  const context = { boardLeft: 24, boardTop: 120 };
  assert.deepEqual(
    pageDefinition.localTouch.call(context, { x: 50, y: 60 }),
    { x: 50, y: 60 }
  );
  assert.deepEqual(
    pageDefinition.localTouch.call(context, { clientX: 74, clientY: 180 }),
    { x: 50, y: 60 }
  );
});

test('history keeps newest valid uploads and adds display timestamps', () => {
  const items = [
    { id: 'old', path: 'old.jpg', createdAt: 1000 },
    null,
    { id: 'new', path: 'new.jpg', createdAt: 2000 },
    { id: 'broken', createdAt: 3000 }
  ];
  const history = pageDefinition.normalizeHistory.call(pageDefinition, items);

  assert.deepEqual(history.map((item) => item.id), ['new', 'old']);
  assert.equal(typeof history[0].dateText, 'string');
  assert.ok(history[0].dateText.length > 0);
});

test('right swipe returns home only from the left edge with horizontal intent', () => {
  const edgeGesture = { mode: 'back', sx: 12, sy: 100 };
  assert.equal(
    pageDefinition.isBackSwipe(edgeGesture, { x: 112, y: 116 }),
    true
  );
  assert.equal(
    pageDefinition.isBackSwipe(edgeGesture, { x: 70, y: 110 }),
    false
  );
  assert.equal(
    pageDefinition.isBackSwipe(edgeGesture, { x: 112, y: 190 }),
    false
  );
  assert.equal(
    pageDefinition.isBackSwipe({ mode: 'pan', sx: 12, sy: 100 }, { x: 150, y: 100 }),
    false
  );
});

test('vector chart renders cell codes and all four coordinate bands', () => {
  const text = [];
  const codeWidths = [];
  const context = {
    ctx: {
      fillRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fillText(value, x, y, maxWidth) {
        text.push(String(value));
        if (value === 'H2') codeWidths.push(maxWidth);
      }
    },
    data: { theme: 'light', gridW: 2, gridH: 2 },
    grid: new Int32Array([0, -1, -1, 0]),
    palette: [{ code: 'H2', hex: '#fbfbfb', r: 251, g: 251, b: 251 }],
    boardW: 200,
    boardH: 200
  };

  pageDefinition.renderCoordinateChart.call(context, 20, 0, 0, -1);
  assert.equal(text.filter((value) => value === 'H2').length, 2);
  assert.deepEqual(codeWidths, [18, 18]);
  // 列号上下各一次，行号左右各一次。
  assert.equal(text.filter((value) => value === '1').length, 4);
  assert.equal(text.filter((value) => value === '2').length, 4);
});

test('vector chart keeps color codes visible at phone-fit cell size', () => {
  const text = [];
  const context = {
    ctx: {
      fillRect() {},
      beginPath() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      fillText(value) {
        text.push(String(value));
      }
    },
    data: { theme: 'light', gridW: 1, gridH: 1 },
    grid: new Int32Array([0]),
    palette: [{ code: 'F23', hex: '#e6856d', r: 230, g: 133, b: 109 }],
    boardW: 40,
    boardH: 40
  };

  pageDefinition.renderCoordinateChart.call(context, 8, 0, 0, -1);
  assert.equal(text.filter((value) => value === 'F23').length, 1);
});
