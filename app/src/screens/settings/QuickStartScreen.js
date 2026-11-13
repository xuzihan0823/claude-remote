import { Linking, Text, View } from 'react-native';
import { useI18n } from '../../lib/i18n.js';
import { useTheme } from '../../theme.js';
import { Group, Row, SettingsPage } from './ui.js';
import { REPO_URL } from './labels.js';

export function QuickStartScreen() {
  const { t } = useI18n();
  const { colors, fonts } = useTheme();
  const code = { fontFamily: fonts.mono, fontSize: 13, color: colors.inkStrong };
  const p = { fontSize: 15, color: colors.ink, lineHeight: 23 };
  const [runBefore, runAfter] = t('在 Mac 终端运行 {cmd}，首次会自动完成安装并启动 daemon').split('{cmd}');
  const [installBefore, installAfter] = t('Mac 和手机装上 {app}，登录同一个账号').split('{app}');
  const [pairBefore, pairAfter] = t('保持 cr 运行，在另一个 Mac 终端运行 {cmd}，然后用「添加设备」扫码').split('{cmd}');
  const steps = [
    <Text style={p}>{runBefore}<Text style={code}>cr</Text>{runAfter}</Text>,
    <Text style={p}>{installBefore}<Text style={{ fontWeight: '600', color: colors.inkStrong }}>Tailscale</Text>{installAfter}</Text>,
    <Text style={p}>{pairBefore}<Text style={code}>cr pair --tailscale</Text>{pairAfter}</Text>,
    <Text style={p}>{t('同时配置自建 Relay 后，可在设备详情的「通道偏好」切换')}</Text>,
  ];
  return (
    <SettingsPage title={t('快速上手')}>
      <View style={{ backgroundColor: colors.card, borderRadius: 20, borderCurve: 'continuous', paddingVertical: 8, marginBottom: 26 }}>
        {steps.map((s, i) => (
          <View key={i} style={{ flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10, gap: 12 }}>
            <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: colors.controlFill, alignItems: 'center', justifyContent: 'center', marginTop: -1 }}>
              <Text style={{ color: colors.accent, fontSize: 13, fontWeight: '700' }}>{i + 1}</Text>
            </View>
            <View style={{ flex: 1 }}>{s}</View>
          </View>
        ))}
      </View>
      <Group>
        <Row icon="github" label={t('在 GitHub 上查看说明')} onPress={() => Linking.openURL(REPO_URL).catch(() => {})} />
      </Group>
    </SettingsPage>
  );
}
