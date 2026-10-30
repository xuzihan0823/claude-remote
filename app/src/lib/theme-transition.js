// 浅色 / 深色主题切换时的平滑色彩插值与共享动画驱动。
// 稳态（progress === 0 或 1）直接返回原始 palette 引用，过渡帧在预编译的颜色通道上做预乘 alpha 插值。

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGBA_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i;

export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  const hexMatch = s.match(HEX_RE);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1, hex: true };
  }
  const rgbaMatch = s.match(RGBA_RE);
  if (rgbaMatch) {
    return {
      r: Number(rgbaMatch[1]),
      g: Number(rgbaMatch[2]),
      b: Number(rgbaMatch[3]),
      a: rgbaMatch[4] != null ? Number(rgbaMatch[4]) : 1,
      hex: false,
    };
  }
  return null;
}

function toHexByte(n) {
  const clamped = Math.max(0, Math.min(255, Math.round(n)));
  return clamped < 16 ? `0${clamped.toString(16)}` : clamped.toString(16);
}

export function mixParsedColor(from, to, t) {
  if (!from || !to) return t < 0.5 ? from : to;
  if (from.hex && to.hex && from.a === 1 && to.a === 1) {
    const r = from.r + (to.r - from.r) * t;
    const g = from.g + (to.g - from.g) * t;
    const b = from.b + (to.b - from.b) * t;
    return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
  }
  const a = from.a + (to.a - from.a) * t;
  let r;
  let g;
  let b;
  if (a > 1e-4) {
    r = (from.r * from.a + (to.r * to.a - from.r * from.a) * t) / a;
    g = (from.g * from.a + (to.g * to.a - from.g * from.a) * t) / a;
    b = (from.b * from.a + (to.b * to.a - from.b * from.a) * t) / a;
  } else {
    r = from.r + (to.r - from.r) * t;
    g = from.g + (to.g - from.g) * t;
    b = from.b + (to.b - from.b) * t;
  }
  const alpha = Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000;
  return `rgba(${Math.max(0, Math.min(255, Math.round(r)))}, ${Math.max(0, Math.min(255, Math.round(g)))}, ${Math.max(0, Math.min(255, Math.round(b)))}, ${alpha})`;
}

function compileTree(lightObj, darkObj) {
  const entries = [];
  for (const key of Object.keys(lightObj)) {
    const lv = lightObj[key];
    const dv = darkObj?.[key];
    if (typeof lv === 'string' && typeof dv === 'string') {
      const lp = parseColor(lv);
      const dp = parseColor(dv);
      entries.push({ key, kind: lp && dp ? 'color' : 'raw', lp, dp, lv, dv });
    } else if (lv && typeof lv === 'object' && !Array.isArray(lv) && dv && typeof dv === 'object') {
      entries.push({ key, kind: 'group', children: compileTree(lv, dv) });
    } else {
      entries.push({ key, kind: 'raw', lv, dv });
    }
  }
  return entries;
}

function evalTree(entries, t) {
  const out = {};
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.kind === 'color') {
      out[e.key] = mixParsedColor(e.lp, e.dp, t);
    } else if (e.kind === 'group') {
      out[e.key] = evalTree(e.children, t);
    } else {
      out[e.key] = t < 0.5 ? e.lv : e.dv;
    }
  }
  return out;
}

export function easeTheme(t) {
  const clamped = Math.max(0, Math.min(1, t));
  return 1 - (1 - clamped) ** 3;
}

export function interpolatePalette(lightPalette, darkPalette, t) {
  if (t <= 0) return lightPalette;
  if (t >= 1) return darkPalette;
  return evalTree(compileTree(lightPalette, darkPalette), t);
}

export function createThemeTransition({
  lightPalette,
  darkPalette,
  initialDark = false,
  duration = 260,
  now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()),
  raf = (cb) => requestAnimationFrame(cb),
  caf = (id) => cancelAnimationFrame(id),
  isReduceMotion = () => false,
}) {
  const compiled = compileTree(lightPalette, darkPalette);
  const listeners = new Set();

  let targetDark = !!initialDark;
  let progress = targetDark ? 1 : 0;
  let rafId = null;
  let snapshot = {
    dark: targetDark,
    progress,
    colors: targetDark ? darkPalette : lightPalette,
  };

  const emit = () => {
    listeners.forEach((fn) => fn(snapshot));
  };

  const stopAnim = () => {
    if (rafId !== null) {
      caf(rafId);
      rafId = null;
    }
  };

  const buildColors = (p) => {
    if (p <= 0) return lightPalette;
    if (p >= 1) return darkPalette;
    return evalTree(compiled, p);
  };

  const commit = (nextDark, nextProgress) => {
    const nextColors = buildColors(nextProgress);
    if (
      snapshot.dark === nextDark
      && snapshot.progress === nextProgress
      && snapshot.colors === nextColors
    ) {
      return;
    }
    snapshot = {
      dark: nextDark,
      progress: nextProgress,
      colors: nextColors,
    };
    emit();
  };

  const setDark = (nextDarkInput, { animate = true } = {}) => {
    const nextDark = !!nextDarkInput;
    const goal = nextDark ? 1 : 0;
    targetDark = nextDark;

    if (!animate || isReduceMotion() || duration <= 0 || Math.abs(goal - progress) < 1e-3) {
      stopAnim();
      progress = goal;
      commit(targetDark, progress);
      return;
    }

    stopAnim();
    const startProgress = progress;
    const delta = goal - startProgress;
    const span = Math.abs(delta);
    const totalMs = Math.max(110, Math.round(duration * span));
    const startTime = now();

    if (snapshot.dark !== targetDark) {
      snapshot = {
        dark: targetDark,
        progress,
        colors: snapshot.colors,
      };
      emit();
    }

    const step = (ts) => {
      rafId = null;
      const currentNow = typeof ts === 'number' && ts >= startTime ? ts : now();
      const raw = Math.min(1, Math.max(0, (currentNow - startTime) / totalMs));
      if (raw >= 1) {
        progress = goal;
        commit(targetDark, progress);
        return;
      }
      const eased = easeTheme(raw);
      progress = startProgress + delta * eased;
      commit(targetDark, progress);
      rafId = raf(step);
    };

    rafId = raf(step);
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  return {
    getSnapshot: () => snapshot,
    setDark,
    subscribe,
  };
}
