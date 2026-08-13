// design tokens 移植自 web/style.css 的 :root 明暗两套，token 名一一对应方便对照。
import { useColorScheme } from 'react-native';

export const palettes = {
  light: {
    bg: '#F5F4EF',
    bg2: '#EDEADE',
    card: '#FFFFFF',
    cardHover: '#F7F6F1',
    bubble: '#EAE3D9',
    accent: '#D97757',
    accentDeep: '#C05B3E',
    ink: '#3A3630',
    inkStrong: '#201E1A',
    ink2: '#887E6F',
    ink3: '#B5AA98',
    line: '#E3DDD4',
    ok: '#5B8C5A',
    warn: '#D97757',
    info: '#6889B0',
    danger: '#C0473A',
  },
  dark: {
    bg: '#1E1C18',
    bg2: '#262319',
    card: '#2E2B24',
    cardHover: '#353129',
    bubble: '#33302A',
    accent: '#D97757',
    accentDeep: '#C05B3E',
    ink: '#D6D0C4',
    inkStrong: '#EDEADE',
    ink2: '#7A7264',
    ink3: '#564E44',
    line: '#3A3730',
    ok: '#6BAA6A',
    warn: '#D97757',
    info: '#7A9DC8',
    danger: '#D0604C',
  },
};

// iOS 上 RN 的 fontFamily 不支持回退链：拉丁衬线用 Georgia，中文衬线需显式 Songti SC
// （Georgia 里的中文字符会级联到 PingFang sans，破坏衬线观感）。
export const fonts = {
  serif: 'Georgia',
  serifCn: 'Songti SC',
  mono: 'Menlo',
};

export const radius = { xs: 8, sm: 12, md: 18, island: 24 };
export const dur = { fast: 150, base: 250, slow: 400 };
// 对应 --spring: cubic-bezier(0.32,0.72,0,1)，reanimated 里用 Easing.bezier(...spring)
export const spring = [0.32, 0.72, 0, 1];

export function useTheme() {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  return { dark, colors: dark ? palettes.dark : palettes.light, fonts, radius, dur };
}
