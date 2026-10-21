// 开屏动画每次冷启动只播一次：从会话页回到首页、重连后重新挂载都不再播。
let played = false;
export function takeIntro() {
  if (played) return false;
  played = true;
  return true;
}
