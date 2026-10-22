import { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { api } from '../../../../web/core/api.js';
import { bus, toast } from '../../../../web/core/bus.js';
import { getDevice, hostOf, removeDeviceAction, updateDevice } from '../../../../web/core/devices.js';
import { useConnActions } from '../../lib/conn-context.js';
import { useDevices } from '../../lib/useDevices.js';
import { QrScanner } from '../../components/QrScanner.js';
import { useTheme } from '../../theme.js';
import { Group, Row, SettingsPage } from './ui.js';
import { agoText } from './labels.js';

export function DeviceDetailScreen({ navigation, route }) {
  const { colors } = useTheme();
  const { switchDevice, tryConnectBases } = useConnActions();
  const { list, current } = useDevices();
  const d = list.find((x) => x.id === route.params?.deviceId);
  const isCurrent = !!d && d.id === current;
  const [health, setHealth] = useState(null);
  const [latency, setLatency] = useState(null);
  const [busy, setBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  useEffect(() => {
    if (!isCurrent) return undefined;
    let alive = true;
    const t0 = Date.now();
    api('/api/health')
      .then((h) => { if (alive) { setHealth(h); setLatency(Date.now() - t0); } })
      .catch(() => { if (alive) setHealth(false); });
    return () => { alive = false; };
  }, [isCurrent]);

  if (!d) return <SettingsPage title="设备" />;

  const changed = () => bus.emit('devices');
  const reconnect = async (next) => {
    if (!isCurrent) return;
    setBusy(true);
    await tryConnectBases(next.bases, next.token);
    setBusy(false);
  };

  const rename = () => {
    Alert.prompt('设备名称', undefined, [
      { text: '取消', style: 'cancel' },
      { text: '保存', onPress: (v) => { if (v && v.trim()) { updateDevice(d.id, { name: v }); changed(); } } },
    ], 'plain-text', d.name);
  };

  const addAddress = () => {
    Alert.prompt('添加地址', '例如 http://192.168.1.23:8787', [
      { text: '取消', style: 'cancel' },
      { text: '添加', onPress: (v) => { if (v && v.trim()) { updateDevice(d.id, { bases: [...d.bases, v.trim()] }); changed(); } } },
    ], 'plain-text', 'http://');
  };

  const removeAddress = (b) => {
    if (d.bases.length <= 1) { toast('至少保留一个地址', 'info'); return; }
    Alert.alert('删除这个地址？', hostOf(b), [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => { updateDevice(d.id, { bases: d.bases.filter((x) => x !== b) }); changed(); } },
    ]);
  };

  const doSwitch = async () => {
    setBusy(true);
    // 成功后导航会按新连接整体重挂载回到首页，这里不用手动关 sheet
    const ok = await switchDevice(d.id);
    if (!ok) setBusy(false);
  };

  const remove = () => {
    Alert.alert(`移除「${d.name}」？`, '会清除这台 Mac 的地址和 Token，之后需要重新配对。', [
      { text: '取消', style: 'cancel' },
      {
        text: '移除',
        style: 'destructive',
        onPress: async () => {
          const act = removeDeviceAction(d.id);
          changed();
          if (act.type === 'none') navigation.goBack();
          else if (act.type === 'switch') await switchDevice(act.id);
          else bus.emit('logout');
        },
      },
    ]);
  };

  const onScan = async ({ token: tok, bases }) => {
    setScanOpen(false);
    setBusy(true);
    // 重新配对：拿到新 token / 地址后替换这台设备的凭据
    updateDevice(d.id, { token: tok, bases: [...bases, ...d.bases] });
    changed();
    const ok = await tryConnectBases(bases, tok);
    setBusy(false);
    if (ok) toast('已重新配对', 'info');
  };

  const status = isCurrent
    ? (health === null ? { label: '检查中…', dot: colors.ink3 } : health ? { label: '已连接', dot: colors.ok } : { label: '连不上', dot: colors.danger })
    : { label: '未连接', dot: colors.ink3 };
  const info = (isCurrent && health) ? health : (d.info || {});

  return (
    <SettingsPage title={d.name}>
      <Group title="状态">
        <Row icon="pulse" label={status.label} dot={status.dot} value={isCurrent && latency != null && health ? `${latency} ms` : (!isCurrent && d.lastConnectedAt ? `上次 ${agoText(d.lastConnectedAt)}` : undefined)} />
        <Row icon="info" label="daemon" value={info.version ? `v${info.version}` : '-'} />
        <Row icon="spark" label="Claude CLI" value={info.claudeCliVersion || '-'} />
      </Group>

      <Group title="设备">
        <Row icon="tag" label="名称" value={d.name} onPress={rename} />
        <Row icon="key" label="Token" value={`••••${String(d.token).slice(-4)}`} onPress={() => navigation.navigate('AddDevice', { deviceId: d.id })} />
      </Group>

      <Group title="地址（按顺序尝试）" footer={'自动用第一个能连通的地址。长按地址可删除。'}>
        {d.bases.map((b) => (
          <Row
            key={b}
            icon="globe"
            label={hostOf(b)}
            value={b === d.lastBase ? '上次使用' : undefined}
            onLongPress={() => removeAddress(b)}
          />
        ))}
        <Row label="添加地址" tone="accent" onPress={addAddress} chevron={false} />
      </Group>

      <Group>
        {isCurrent
          ? <Row icon="refresh" label={busy ? '连接中…' : '重新连接'} disabled={busy} onPress={() => reconnect(getDevice(d.id))} />
          : <Row icon="laptop" label={busy ? '连接中…' : '切换到这台设备'} tone="accent" disabled={busy} onPress={doSwitch} />}
        <Row icon="qr" label="重新扫码配对" disabled={busy} onPress={() => setScanOpen(true)} />
      </Group>

      <Group footer="会清除这台 Mac 的地址和 Token">
        <Row label="移除此设备" tone="danger" center onPress={remove} />
      </Group>

      <QrScanner visible={scanOpen} onClose={() => setScanOpen(false)} onResult={onScan} />
    </SettingsPage>
  );
}
