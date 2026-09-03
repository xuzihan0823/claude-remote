import Svg, { Line } from 'react-native-svg';
import { useTheme } from '../theme.js';

// 移植自 web/ui/components/spark.js：15 条芒星线，坐标 / 线宽原样保留。
// web 用 stroke="currentColor" + stroke-linecap="round" 设在 <svg> 上由子线继承；
// RN 端 react-native-svg 同样支持从 <Svg> 继承 stroke / strokeLinecap 到 <Line>。
const RAYS = [
  [12, 12, 12.12, 2.61, 2.1],
  [12, 12, 15.74, 4.05, 1.87],
  [12, 12, 19.08, 5.26, 2.11],
  [12, 12, 20.5, 9.21, 2.12],
  [12, 12, 20.99, 13.22, 1.64],
  [12, 12, 20.58, 16.96, 1.93],
  [12, 12, 18, 19.28, 2.09],
  [12, 12, 14.53, 21.37, 1.52],
  [12, 12, 10.46, 20.4, 1.63],
  [12, 12, 6.11, 19.54, 1.52],
  [12, 12, 3.33, 17.48, 1.84],
  [12, 12, 2.92, 12.61, 1.81],
  [12, 12, 3.77, 9.83, 1.89],
  [12, 12, 5.43, 5.94, 1.95],
  [12, 12, 8.02, 3.85, 2.02],
];

// 品牌芒星。color 缺省走主题 accent；暗色自动随 useColorScheme 切换。
export function Spark({ size = 16, color, style }) {
  const { colors } = useTheme();
  const stroke = color ?? colors.accent;
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeLinecap="round"
      style={style}
    >
      {RAYS.map(([x1, y1, x2, y2, w], i) => (
        <Line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={w} />
      ))}
    </Svg>
  );
}
