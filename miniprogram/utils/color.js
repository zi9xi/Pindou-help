/**
 * 颜色处理模块
 * 从 ImageData 中提取颜色统计，按容差合并相近色，
 * 输出调色板（palette）与逐像素的网格索引（grid）。
 */

function keyOf(r, g, b) {
  return ((r << 16) | (g << 8) | b) >>> 0;
}

function toHex(key) {
  return '#' + ('000000' + key.toString(16)).slice(-6);
}

/** 加权平方距离（人眼对绿色最敏感） */
function dist2(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr * 0.30 + dg * dg * 0.59 + db * db * 0.11;
}

/**
 * 构建调色板与网格索引
 * @param {Uint8ClampedArray} data ImageData.data
 * @param {number} tolerance 颜色合并容差 0~50，0 = 只合并完全相同颜色
 * @returns {{ palette: Array, grid: Int32Array, totalBeads: number }}
 *   palette[i] = { key, hex, r, g, b, count }
 *   grid[p] = 调色板下标，-1 表示透明/背景像素
 */
function buildPalette(data, tolerance) {
  const pixelCount = data.length / 4;
  const keys = new Int32Array(pixelCount);
  const counts = new Map();

  // 第一遍：精确颜色统计（透明像素跳过）
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < 128) {
      keys[p] = -1;
      continue;
    }
    const k = keyOf(data[i], data[i + 1], data[i + 2]);
    keys[p] = k;
    counts.set(k, (counts.get(k) || 0) + 1);
  }

  let colors = [];
  counts.forEach((count, k) => {
    colors.push({ key: k, r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255, count });
  });

  // JPEG 噪点会导致颜色爆炸：超过 512 色时先按 4bit/通道 降采样合并
  if (colors.length > 512) {
    const bucketCounts = new Map();
    for (const c of colors) {
      const bk = keyOf(c.r & 0xF0, c.g & 0xF0, c.b & 0xF0);
      bucketCounts.set(bk, (bucketCounts.get(bk) || 0) + c.count);
    }
    const remap = new Map();
    for (const c of colors) {
      remap.set(c.key, keyOf(c.r & 0xF0, c.g & 0xF0, c.b & 0xF0));
    }
    for (let p = 0; p < pixelCount; p++) {
      if (keys[p] >= 0) keys[p] = remap.get(keys[p]);
    }
    colors = [];
    bucketCounts.forEach((count, k) => {
      colors.push({ key: k, r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255, count });
    });
  }

  // 按数量降序，保证主色优先吸收杂色
  colors.sort((a, b) => b.count - a.count);

  // 容差合并：小颜色并入最近的更大颜色
  const mergedTo = new Int32Array(colors.length).fill(-1);
  const tol2 = tolerance * tolerance;
  if (tolerance > 0) {
    for (let i = 0; i < colors.length; i++) {
      if (mergedTo[i] >= 0) continue;
      for (let j = i + 1; j < colors.length; j++) {
        if (mergedTo[j] >= 0) continue;
        if (dist2(colors[i], colors[j]) <= tol2) {
          mergedTo[j] = i;
          colors[i].count += colors[j].count;
        }
      }
    }
  }

  // 生成最终调色板与 key -> index 映射
  const palette = [];
  const keyToIndex = new Map();
  colors.forEach((c, i) => {
    if (mergedTo[i] >= 0) return;
    keyToIndex.set(c.key, palette.length);
    palette.push({ key: c.key, hex: toHex(c.key), r: c.r, g: c.g, b: c.b, count: c.count });
  });
  colors.forEach((c, i) => {
    if (mergedTo[i] >= 0) {
      keyToIndex.set(c.key, keyToIndex.get(colors[mergedTo[i]].key));
    }
  });

  // 第二遍：逐像素映射到调色板下标
  const grid = new Int32Array(pixelCount);
  let totalBeads = 0;
  for (let p = 0; p < pixelCount; p++) {
    if (keys[p] < 0) {
      grid[p] = -1;
    } else {
      grid[p] = keyToIndex.get(keys[p]);
      totalBeads++;
    }
  }

  return { palette, grid, totalBeads };
}

module.exports = { buildPalette };
