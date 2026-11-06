import { useState } from 'react';
import { Keyboard } from 'react-native';
import { normalizeBase } from '../../../../web/core/api.js';
import { hostOf } from '../../../../web/core/devices.js';
import { useConnActions } from '../../lib/conn-context.js';
import { useDevices } from '../../lib/useDevices.js';
import { useI18n } from '../../lib/i18n.js';
import { haptics } from '../../lib/haptics.js';
import { QrScanner } from '../../components/QrScanner.js';
import { useTheme } from '../../theme.js';
import { Collapse, Group, Row, SettingsPage } from './ui.js';
import { agoText } from './labels.js';
import { DeviceFields, finishNewDevice } from './AddDeviceScreen.js';

export function DevicesScreen({ navigation }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { switchDevice, tryConnectBases } = useConnActions();
  const { list, current } = useDevices();
  const [switching, setSwitching] = useState(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [name, setName] = useState('');
  const [base, setBase] = useState('');
  const [tok, setTok] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const busy = !!switching || scanBusy || manualBusy;

  const toggleManual = () => {
    haptics.selection();
    setManualOpen((v) => {
      if (v) Keyboard.dismiss();
      return !v;
    });
  };
  // 切换、扫码、手动添加成功后，导航都会按新连接整体重挂载回到首页，这里只需处理失败
  const doSwitch = async (id) => {
    setSwitching(id);
    const ok = await switchDevice(id);
    if (!ok) setSwitching(null);
  };

  const onScan = async ({ token, bases }) => {
    setScanOpen(false);
    setScanBusy(true);
    const ok = await tryConnectBases(bases, token, { beforeCommit: () => haptics.success() });
    if (ok) finishNewDevice('');
    else { setScanBusy(false); haptics.error(); }
  };

  const canSubmit = !!base.trim() && !!tok.trim() && !busy;
  const submitManual = async () => {
    const b = normalizeBase(base);
    const token = tok.trim();
    if (!b || !token || busy) return;
    setManualBusy(true);
    const ok = await tryConnectBases([b], token, { manual: true, beforeCommit: () => haptics.success() });
    if (ok) finishNewDevice(name.trim());
    else { setManualBusy(false); haptics.error(); }
  };

  return (
    <SettingsPage title={t('设备')} keyboard>
      {list.length ? (
        <Group title={t('已配对')} footer={t('点设备直接切换，点右侧 ⓘ 查看详情、改名或移除')}>
          {list.map((d) => {
            const on = d.id === current;
            return (
              <Row
                key={d.id}
                icon="laptop"
                iconColor={on ? colors.ok : colors.ink3}
                label={d.name}
                sub={switching === d.id ? t('连接中…') : on ? t('{host} · 已连接', { host: hostOf(d.lastBase || d.bases[0]) }) : t('上次连接 {time}', { time: agoText(d.lastConnectedAt) || t('未知') })}
                checked={on ? true : undefined}
                disabled={busy}
                onPress={on ? undefined : () => doSwitch(d.id)}
                onDetail={() => navigation.navigate('DeviceDetail', { deviceId: d.id })}
              />
            );
          })}
        </Group>
      ) : null}
      <Group title={t('添加')} footer={manualOpen ? t('连接成功后会自动切到这台设备') : undefined}>
        <Row
          icon="qr"
          label={t('扫描配对二维码')}
          sub={scanBusy ? t('连接中…') : t('在 Mac 上运行 cr pair')}
          disabled={busy}
          onPress={() => setScanOpen(true)}
        />
        <Row
          icon="key"
          label={t('手动输入地址和 Token')}
          chevron={manualOpen ? 'chevronUp' : 'chevron'}
          disabled={busy}
          onPress={toggleManual}
        />
        <Collapse open={manualOpen}>
          <DeviceFields name={name} setName={setName} base={base} setBase={setBase} tok={tok} setTok={setTok} onSubmit={submitManual} autoFocus />
          <Row label={manualBusy ? t('连接中…') : t('连接并保存')} tone="accent" center disabled={!canSubmit} onPress={submitManual} />
        </Collapse>
      </Group>

      <QrScanner visible={scanOpen} onClose={() => setScanOpen(false)} onResult={onScan} />
    </SettingsPage>
  );
}
