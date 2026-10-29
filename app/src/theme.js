// Native surfaces share semantic tokens across light and dark appearances.
import { useColorScheme } from 'react-native';

export const palettes = {
  light: {
    bg: '#FAF9F6',
    bg2: '#EDEADE',
    card: '#FFFFFF',
    cardHover: '#F7F6F1',
    bubble: '#EAE3D9',
    accent: '#D97757',
    accentDeep: '#C05B3E',
    ink: '#3A3630',
    inkStrong: '#201E1A',
    code: '#9A4A32',
    ink2: '#887E6F',
    ink3: '#B5AA98',
    line: '#E3DDD4',
    ok: '#5B8C5A',
    warn: '#D97757',
    info: '#6889B0',
    danger: '#C0473A',
    syntax: {
      keyword: '#B0452A',
      string: '#4E7A36',
      number: '#9A5A10',
      comment: '#7A7265',
      title: '#3D6896',
      type: '#7B4F9C',
      attr: '#2D7673',
      meta: '#766D61',
    },
    glassTint: 'rgba(255, 253, 249, 0.54)',
    glassTintInteractive: 'rgba(255, 254, 251, 0.66)',
    glassTintAccent: 'rgba(217, 119, 87, 0.15)',
    glassBorder: 'rgba(255, 255, 255, 0.88)',
    glassBorderAccent: 'rgba(217, 119, 87, 0.36)',
    glassEdgeOuter: 'rgba(58, 54, 48, 0.08)',
    glassHighlight: 'rgba(255, 255, 255, 0.72)',
    glassPressed: 'rgba(58, 54, 48, 0.08)',
    controlFill: 'rgba(58, 54, 48, 0.055)',
    controlBorder: 'rgba(58, 54, 48, 0.11)',
  },
  dark: {
    bg: '#141414',
    bg2: '#1C1C1C',
    card: '#282828',
    cardHover: '#333333',
    bubble: '#2C2C2B',
    accent: '#D97757',
    accentDeep: '#C05B3E',
    ink: '#E8E7E2',
    inkStrong: '#F5F4F0',
    code: '#E8A48A',
    ink2: '#AAA9A2',
    ink3: '#92928B',
    line: '#424240',
    ok: '#6BAA6A',
    warn: '#D97757',
    info: '#7A9DC8',
    danger: '#D0604C',
    syntax: {
      keyword: '#E8916F',
      string: '#A8C98A',
      number: '#E3B675',
      comment: '#9C9A92',
      title: '#8FB6E3',
      type: '#C6A6E0',
      attr: '#82C6C1',
      meta: '#A3A29B',
    },
    glassTint: 'rgba(38, 37, 35, 0.58)',
    glassTintInteractive: 'rgba(48, 46, 44, 0.66)',
    glassTintAccent: 'rgba(217, 119, 87, 0.22)',
    glassBorder: 'rgba(255, 255, 255, 0.15)',
    glassBorderAccent: 'rgba(217, 119, 87, 0.42)',
    glassEdgeOuter: 'rgba(0, 0, 0, 0.45)',
    glassHighlight: 'rgba(255, 255, 255, 0.09)',
    glassPressed: 'rgba(255, 255, 255, 0.10)',
    controlFill: 'rgba(255, 255, 255, 0.08)',
    controlBorder: 'rgba(255, 255, 255, 0.13)',
  },
};

// iOS 上 RN 的 fontFamily 不支持回退链：拉丁衬线用 Georgia，中文衬线需显式 Songti SC
// （Georgia 里的中文字符会级联到 PingFang sans，破坏衬线观感）。
export const fonts = {
  serif: 'Georgia',
  serifCn: 'Songti SC',
  mono: 'Menlo',
};

export const radius = { xs: 8, sm: 12, md: 18, island: 28 };
export const dur = { fast: 150, base: 250, slow: 400 };
// 对应 --spring: cubic-bezier(0.32,0.72,0,1)，reanimated 里用 Easing.bezier(...spring)
export const spring = [0.32, 0.72, 0, 1];

export function useTheme() {
  const scheme = useColorScheme();
  const dark = scheme === 'dark';
  return { dark, colors: dark ? palettes.dark : palettes.light, fonts, radius, dur };
}
