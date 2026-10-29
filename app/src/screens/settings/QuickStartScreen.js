import { Linking, Text, View } from 'react-native';
import { useTheme } from '../../theme.js';
import { Group, Row, SettingsPage } from './ui.js';
import { REPO_URL } from './labels.js';

export function QuickStartScreen() {
  const { colors, fonts } = useTheme();
  const code = { fontFamily: fonts.mono, fontSize: 13, color: colors.inkStrong };
  const p = { fontSize: 15, color: colors.ink, lineHeight: 23 };
  const steps = [
    <Text style={p}>在 Mac 终端运行 <Text style={code}>cr</Text>，首次会自动完成安装并启动 daemon</Text>,
    <Text style={p}>Mac 和手机装上 <Text style={{ fontWeight: '600', color: colors.inkStrong }}>Tailscale</Text>，登录同一个账号</Text>,
    <Text style={p}>Mac 上运行 <Text style={code}>cr pair</Text>，用这里的「添加设备」扫二维码</Text>,
    <Text style={p}>连不上时，在设备详情里补一个 Tailscale 或局域网地址</Text>,
  ];
  return (
    <SettingsPage title="快速上手">
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
        <Row icon="github" label="在 GitHub 上查看说明" onPress={() => Linking.openURL(REPO_URL).catch(() => {})} />
      </Group>
    </SettingsPage>
  );
}
