import { useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { api, baseUrl } from '../../../../web/core/api.js';
import { bus, toast } from '../../../../web/core/bus.js';
import { baseChannel, candidateBases, channelPrefOf, getDevice, hostOf, removeDeviceAction, syncBases, updateDevice } from '../../../../web/core/devices.js';
import { useConnActions } from '../../lib/conn-context.js';
import { useDevices } from '../../lib/useDevices.js';
import { haptics } from '../../lib/haptics.js';
import { QrScanner } from '../../components/QrScanner.js';
import { useTheme } from '../../theme.js';
import { Group, Row, SettingsPage } from './ui.js';
import { agoText } from './labels.js';

const CHANNEL_LABELS = { tailscale: '直连 · Tailscale', lan: '直连 · 局域网', mdns: '直连 · 局域网', relay: 'relay' };
const PREF_OPTIONS = [
  { key: 'auto', label: '自动', sub: '优先直连，直连不通时走 relay' },
  { key: 'direct', label: '只走直连', sub: 'Tailscale / 局域网' },
  { key: 'relay', label: '只走 relay', sub: '经自建 relay 服务器' },
];

export function DeviceDetailScreen({ navigation, route }) {
  const { colors } = useTheme();
  const { switchDevice, tryConnectBases, reselect } = useConnActions();
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
    const ok = await tryConnectBases(candidateBases(next), next.token, { beforeCommit: () => haptics.success() });
    if (!ok) haptics.error();
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
    // 重新配对：二维码里的地址就是 Mac 当前的完整列表，按 daemon 报告的地址同步（手填地址保留）
    updateDevice(d.id, { token: tok });
    const synced = syncBases(d.id, bases);
    changed();
    const ok = await tryConnectBases(synced ? candidateBases(synced) : bases, tok, { beforeCommit: () => haptics.success() });
    if (!ok) haptics.error();
    setBusy(false);
    if (ok) toast('已重新配对', 'info');
  };

  const pref = channelPrefOf(d);
  const setPref = async (key) => {
    if (key === pref) return;
    updateDevice(d.id, { channelPref: key });
    changed();
    if (isCurrent) await reselect();
  };
  const hasRelay = d.bases.some((b) => baseChannel(b) === 'relay');
  const hasDirect = d.bases.some((b) => baseChannel(b) !== 'relay');
  const prefAvailable = (key) => key === 'auto' || (key === 'relay' ? hasRelay : hasDirect);

  const status = isCurrent
    ? (health === null ? { label: '检查中…', dot: colors.ink3 } : health ? { label: '已连接', dot: colors.ok } : { label: '连不上', dot: colors.danger })
    : { label: '未连接', dot: colors.ink3 };
  const info = (isCurrent && health) ? health : (d.info || {});

  return (
    <SettingsPage title={d.name}>
      <Group title="状态">
        <Row icon="pulse" label={status.label} dot={status.dot} value={isCurrent && latency != null && health ? `${latency} ms` : (!isCurrent && d.lastConnectedAt ? `上次 ${agoText(d.lastConnectedAt)}` : undefined)} />
        {isCurrent && health ? <Row icon="globe" label="通道" value={CHANNEL_LABELS[baseChannel(baseUrl)]} /> : null}
        <Row icon="info" label="daemon" value={info.version ? `v${info.version}` : '-'} />
        <Row icon="spark" label="Claude CLI" value={info.claudeCliVersion || '-'} />
      </Group>

      <Group title="设备">
        <Row icon="tag" label="名称" value={d.name} onPress={rename} />
        <Row icon="key" label="Token" value={`••••${String(d.token).slice(-4)}`} onPress={() => navigation.navigate('AddDevice', { deviceId: d.id })} />
      </Group>

      <Group title="通道偏好" footer={hasRelay ? undefined : '这台 Mac 还没有 relay 地址。在 Mac 上执行 cr relay add 后，连上一次就会自动出现。'}>
        {PREF_OPTIONS.map((o) => (
          <Row
            key={o.key}
            label={o.label}
            sub={o.sub}
            checked={pref === o.key}
            disabled={busy || (!prefAvailable(o.key) && pref !== o.key)}
            onPress={() => setPref(o.key)}
          />
        ))}
      </Group>

      <Group title="地址" footer={'同时尝试所有地址，按通道偏好选择。长按地址可删除。'}>
        {d.bases.map((b) => (
          <Row
            key={b}
            icon="globe"
            label={hostOf(b)}
            value={`${CHANNEL_LABELS[baseChannel(b)]}${b === d.lastBase ? ' · 上次使用' : ''}`}
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
