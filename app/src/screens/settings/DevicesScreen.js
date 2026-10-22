import { hostOf } from '../../../../web/core/devices.js';
import { useDevices } from '../../lib/useDevices.js';
import { useTheme } from '../../theme.js';
import { Group, Row, SettingsPage } from './ui.js';
import { agoText } from './labels.js';

export function DevicesScreen({ navigation }) {
  const { colors } = useTheme();
  const { list, current } = useDevices();
  return (
    <SettingsPage title="设备" right={{ icon: 'plus', label: '添加设备', onPress: () => navigation.navigate('AddDevice') }}>
      {list.length ? (
        <Group title="已配对" footer="点开设备可以切换、改名或移除">
          {list.map((d) => {
            const on = d.id === current;
            return (
              <Row
                key={d.id}
                icon="laptop"
                iconColor={on ? colors.ok : colors.ink3}
                label={d.name}
                sub={on ? `${hostOf(d.lastBase || d.bases[0])} · 已连接` : `上次连接 ${agoText(d.lastConnectedAt) || '未知'}`}
                checked={on ? true : undefined}
                chevron
                onPress={() => navigation.navigate('DeviceDetail', { deviceId: d.id })}
              />
            );
          })}
        </Group>
      ) : null}
      <Group title="添加">
        <Row icon="qr" label="扫描配对二维码" sub="在 Mac 上运行 cr pair" onPress={() => navigation.navigate('AddDevice', { scan: true })} />
        <Row icon="key" label="手动输入地址和 Token" onPress={() => navigation.navigate('AddDevice')} />
      </Group>
    </SettingsPage>
  );
}
