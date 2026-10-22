import { Pressable, Text, View } from 'react-native';
import { MarkdownView } from '../../components/markdown/MarkdownView.js';
import { FONT_SCALE_LABELS, FONT_SCALES, setPref, usePref } from '../../lib/prefs.js';
import { haptics } from '../../lib/haptics.js';
import { useTheme } from '../../theme.js';
import { SettingsPage } from './ui.js';

const SAMPLE = '这里是 Claude 的回复预览。修改字号后，对话里的**消息正文**和 `代码` 都会一起变大或变小。';

export function FontSizeScreen() {
  const { colors } = useTheme();
  const scale = usePref('fontScale');
  const idx = Math.max(0, FONT_SCALES.indexOf(scale));
  const pick = (i) => { if (i !== idx) { setPref('fontScale', FONT_SCALES[i]); haptics.tap(); } };

  return (
    <SettingsPage title="字体大小">
      <View style={{ backgroundColor: colors.card, borderRadius: 20, borderCurve: 'continuous', padding: 16, marginBottom: 26 }}>
        <View style={{ alignSelf: 'flex-end', backgroundColor: colors.bubble, borderRadius: 22, borderCurve: 'continuous', paddingHorizontal: 16, paddingVertical: 10, maxWidth: '85%', marginBottom: 12 }}>
          <Text style={{ color: colors.inkStrong, fontSize: 17 * scale, lineHeight: Math.round(26 * scale) }}>帮我看看这个 bug</Text>
        </View>
        <MarkdownView text={SAMPLE} />
      </View>

      <View style={{ backgroundColor: colors.card, borderRadius: 20, borderCurve: 'continuous', paddingHorizontal: 16, paddingVertical: 18 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: colors.ink2, fontSize: 13, width: 22 }}>A</Text>
          <View style={{ flex: 1, height: 36, justifyContent: 'center' }}>
            <View style={{ position: 'absolute', left: 10, right: 10, height: 4, borderRadius: 2, backgroundColor: colors.controlBorder }}>
              <View style={{ width: `${(idx / (FONT_SCALES.length - 1)) * 100}%`, height: 4, borderRadius: 2, backgroundColor: colors.accent }} />
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              {FONT_SCALES.map((v, i) => (
                <Pressable
                  key={v}
                  onPress={() => pick(i)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`字号${FONT_SCALE_LABELS[i]}`}
                  accessibilityState={{ selected: i === idx }}
                  style={{ width: 20, height: 36, alignItems: 'center', justifyContent: 'center' }}
                >
                  {i === idx ? (
                    <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff', borderWidth: 0.5, borderColor: colors.line,
                      shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } }} />
                  ) : (
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: i < idx ? colors.accent : colors.ink3 }} />
                  )}
                </Pressable>
              ))}
            </View>
          </View>
          <Text style={{ color: colors.ink2, fontSize: 21, width: 22, textAlign: 'right' }}>A</Text>
        </View>
        <Text style={{ textAlign: 'center', color: colors.ink2, fontSize: 13, marginTop: 8 }}>{FONT_SCALE_LABELS[idx]}</Text>
      </View>
    </SettingsPage>
  );
}
