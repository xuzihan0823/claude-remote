import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { baseUrl } from '../../../web/core/api.js';
import { useTheme } from '../theme.js';
import { Spark } from '../components/Spark.js';
import { ConnForm } from '../components/ConnForm.js';

// 移植 web/ui/screens/setup.js 的 SetupGate：居中卡片 + Spark logo + 标题/副题 + ConnForm + 帮助文案。
// 整屏包 KeyboardAvoidingView（behavior padding）防键盘遮挡；ScrollView 兜底小屏。
export function ConnectScreen({ busy, error, onSubmit }) {
  const { colors, fonts, radius } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingHorizontal: 20,
          alignItems: 'center',
          justifyContent: 'center',
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={{
            width: '100%',
            maxWidth: 380,
            backgroundColor: colors.card,
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: radius.md,
            paddingTop: 34,
            paddingHorizontal: 26,
            paddingBottom: 24,
            alignItems: 'center',
          }}
        >
          <Spark size={42} />
          <Text
            style={{
              color: colors.inkStrong,
              fontFamily: fonts.serif,
              fontSize: 24,
              fontWeight: '600',
              marginTop: 10,
              marginBottom: 2,
            }}
          >
            Claude Remote
          </Text>
          <Text style={{ color: colors.ink2, fontSize: 14, marginBottom: 18 }}>
            连接你 Mac 上的 Claude Code
          </Text>
          <View style={{ width: '100%' }}>
            <ConnForm
              initBase={baseUrl}
              initToken=""
              busy={busy}
              submitLabel="连接"
              onSubmit={onSubmit}
            />
          </View>
          {error ? (
            <Text style={{ color: colors.danger, fontSize: 13, marginTop: 12 }}>{error}</Text>
          ) : null}
          <Text style={{ color: colors.ink2, fontSize: 12, marginTop: 16, lineHeight: 20 }}>
            Mac 端打开配对页，用相机扫码即可
          </Text>
          <Text style={{ color: colors.ink2, fontSize: 12, marginTop: 16, lineHeight: 20 }}>
            {'Mac 端：'}
            <Text
              style={{
                fontFamily: fonts.mono,
                fontSize: 10.8,
                color: colors.ink2,
                backgroundColor: colors.bg2,
              }}
            >
              {'cd claude-remote && pnpm dev'}
            </Text>
            {' 启动 daemon，手机与 Mac 同一 Tailscale 网络'}
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
