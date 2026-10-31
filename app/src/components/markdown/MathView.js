// LaTeX 公式：MathJax 产 SVG，react-native-svg 的 SvgXml 显示（currentColor 跟随正文色）。
// 行内公式嵌在 <Text> 里（RN 支持 Text 内嵌 View），按 MathJax 给的 vertical-align 下沉对齐基线。
// 块级公式过宽时横向滚动。语法错误时退回等宽原文，不打断整条消息。
import { memo, useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { exToPx, texToSvg } from '../../lib/tex-svg.js';

function Raw({ tex, display, ctx, fontSize }) {
  return (
    <Text style={{ fontFamily: ctx.fonts.mono, fontSize: fontSize * 0.86, color: ctx.colors.ink2 }}>
      {display ? `$$${tex}$$` : `$${tex}$`}
    </Text>
  );
}

export const MathView = memo(function MathView({ tex, display, ctx, fontSize }) {
  const r = useMemo(() => texToSvg(tex, display), [tex, display]);
  if (r.error) return <Raw tex={tex} display={display} ctx={ctx} fontSize={fontSize} />;
  const scale = display ? 1.08 : 1;
  const w = Math.max(1, exToPx(r.widthEx, fontSize) * scale);
  const h = Math.max(1, exToPx(r.heightEx, fontSize) * scale);
  const svg = <SvgXml xml={r.xml} width={w} height={h} color={ctx.colors.inkStrong} />;
  if (!display) {
    // 行内：基线对齐近似——把 SVG 往下挪 vertical-align 那么多
    const dy = -exToPx(r.valignEx, fontSize);
    return (
      <View accessible accessibilityLabel={tex} style={{ width: w, height: h, transform: [{ translateY: dy }] }}>
        {svg}
      </View>
    );
  }
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginVertical: 8 }}
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingVertical: 2 }}
      accessible
      accessibilityLabel={tex}
    >
      {svg}
    </ScrollView>
  );
});
