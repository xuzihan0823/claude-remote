// 开屏动画协调（模块级状态，跨组件共享）：
//  - 芒星绽放每次冷启动只播一次：登录页或首页谁先显示谁播，之后重新挂载都不再播。
//  - 登录成功时登录页把芒星的窗口位置交给首页（handoff），首页的芒星从那里滑到自己的位置。
let played = false;
let splashHiddenAt = 0;

// 开屏字标接管层（components/SplashOverlay.js）淡出时长
export const SPLASH_FADE_MS = 420;

/** App 开始收起启动屏时记一下；之后挂载的页面就不用再等启动屏。 */
export function markSplashHidden() {
  if (!splashHiddenAt) splashHiddenAt = Date.now();
}

/**
 * 开屏动画该推迟多久再开始：启动屏还盖着（首页比 hideAsync 先渲染）时，
 * 等它淡出到一半多再绽放，否则前几帧被启动屏挡住，看起来像「卡一下才出来」。
 */
export function introDelay() {
  const lead = Math.round(SPLASH_FADE_MS * 0.5);
  if (!splashHiddenAt) return lead;
  return Math.max(0, splashHiddenAt + lead - Date.now());
}
let handoff = null;

export function takeIntro() {
  if (played) return false;
  played = true;
  return true;
}

export function setHandoff(rect) {
  handoff = rect ? { ...rect, at: Date.now() } : null;
}

/** 取走交接位置；超过 3 秒没被取用的视为过期（比如连接后又被别的流程打断）。 */
export function takeHandoff() {
  const h = handoff;
  handoff = null;
  if (!h || Date.now() - h.at > 3000) return null;
  return { x: h.x, y: h.y, size: h.size };
}
