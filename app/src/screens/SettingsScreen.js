import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { api, baseUrl, connHost, token } from '../../../web/core/api.js';
import { bus, toast } from '../../../web/core/bus.js';
import { useConnActions } from '../lib/conn-context.js';
import { useTheme } from '../theme.js';
import { ConnForm } from '../components/ConnForm.js';
import { GlassSurface } from '../components/GlassSurface.js';
import { Icon } from '../components/Icon.js';

// 移植 web/ui/screens/settings.js：顶栏（‹ 返回 + 衬线「设置」）+ 三卡（连接 / 状态 / 快速上手）
// + 底部危险按钮（断开并清除本机凭据 -> bus.emit('logout')，App 处理）。
// 包含 ConnForm 文本输入，故同样包 KeyboardAvoidingView（behavior padding）防键盘遮挡。
export function SettingsScreen() {
  const { colors, fonts, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { tryConnect } = useConnActions();
  const [health, setHealth] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api('/api/health')
      .then((h) => { if (alive) setHealth(h); })
      .catch(() => { if (alive) setHealth(null); });
    return () => { alive = false; };
  }, []);

  const submit = async (base, tok) => {
    setBusy(true);
    const ok = await tryConnect(base, tok);
    setBusy(false);
    if (ok) {
      toast('已保存并重新连接', 'info');
      navigation.goBack();
    }
  };

  const cardStyle = {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingVertical: 16,
    paddingHorizontal: 18,
  };
  const h2Style = {
    fontFamily: fonts.serifCn,
    fontSize: 16,
    color: colors.inkStrong,
    marginBottom: 12,
  };
  const codeStyle = {
    fontFamily: fonts.mono,
    fontSize: 12,
    color: colors.ink,
    backgroundColor: colors.bg2,
  };
  const dtStyle = { color: colors.ink2, fontSize: 14, width: 90 };
  const ddStyle = { color: colors.inkStrong, fontSize: 14, flex: 1 };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 }}>
        <GlassSurface interactive variant="pill" style={{ borderRadius: 22 }}>
          <Pressable
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel="返回"
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: pressed ? colors.glassPressed : 'transparent',
            })}
          >
            <Icon name="back" size={20} color={colors.ink} />
          </Pressable>
        </GlassSurface>
        <Text style={{ fontFamily: fonts.serifCn, fontSize: 17, fontWeight: '600', color: colors.inkStrong }}>
          设置
        </Text>
      </View>

      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 4,
            paddingBottom: Math.max(insets.bottom, 30),
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ gap: 14, maxWidth: 560, width: '100%', alignSelf: 'center' }}>
            <View style={cardStyle}>
              <Text style={h2Style}>连接</Text>
              <ConnForm
                initBase={baseUrl}
                initToken={token}
                busy={busy}
                submitLabel="保存并重新连接"
                onSubmit={submit}
              />
            </View>

            <View style={cardStyle}>
              <Text style={h2Style}>状态</Text>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                  <Text style={dtStyle}>服务器</Text>
                  <Text style={[ddStyle, { fontFamily: fonts.mono }]} numberOfLines={1}>
                    {connHost()}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                  <Text style={dtStyle}>daemon</Text>
                  <Text style={ddStyle}>{health ? `v${health.version}` : '未连接'}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                  <Text style={dtStyle}>Claude CLI</Text>
                  <Text style={ddStyle}>{health?.claudeCliVersion || '-'}</Text>
                </View>
              </View>
            </View>

            <View style={cardStyle}>
              <Text style={h2Style}>快速上手</Text>
              <View style={{ gap: 7 }}>
                <Text style={{ fontSize: 13.5, color: colors.ink, lineHeight: 20 }}>
                  {'1. 在 Mac 上安装并启动 daemon：'}
                  <Text style={codeStyle}>{'pnpm dev'}</Text>
                  {'（首次先在 '}
                  <Text style={codeStyle}>{'.env'}</Text>
                  {' 里设置 '}
                  <Text style={codeStyle}>{'BRIDGE_TOKEN'}</Text>
                  {'）'}
                </Text>
                <Text style={{ fontSize: 13.5, color: colors.ink, lineHeight: 20 }}>
                  {'2. Mac 与手机安装 '}
                  <Text style={{ fontWeight: '700', color: colors.inkStrong }}>{'Tailscale'}</Text>
                  {' 并登录同一账号'}
                </Text>
                <Text style={{ fontSize: 13.5, color: colors.ink, lineHeight: 20 }}>
                  {'3. 把 '}
                  <Text style={codeStyle}>{'.env'}</Text>
                  {' 的 '}
                  <Text style={codeStyle}>{'BRIDGE_HOST'}</Text>
                  {' 改为 Mac 的 Tailscale IP 并重启 daemon'}
                </Text>
                <Text style={{ fontSize: 13.5, color: colors.ink, lineHeight: 20 }}>
                  {'4. 在上方填入 '}
                  <Text style={codeStyle}>{'http://«Tailscale IP»:8787'}</Text>
                  {' 与 token，保存即可'}
                </Text>
              </View>
            </View>

            <TouchableOpacity
              onPress={() => bus.emit('logout')}
              activeOpacity={0.85}
              style={{
                borderRadius: radius.sm,
                paddingVertical: 9,
                borderWidth: 1,
                borderColor: '#e8cfc8',
                backgroundColor: 'transparent',
                alignItems: 'center',
              }}
            >
              <Text style={{ color: colors.danger, fontSize: 14.5, fontWeight: '500' }}>
                断开并清除本机凭据
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
