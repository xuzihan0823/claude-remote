import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { connErrMsg, normalizeBase, probeBases } from '../../../../web/core/api.js';
import { bus, toast } from '../../../../web/core/bus.js';
import { currentDeviceId, getDevice, updateDevice } from '../../../../web/core/devices.js';
import { useConnActions } from '../../lib/conn-context.js';
import { QrScanner } from '../../components/QrScanner.js';
import { Icon } from '../../components/Icon.js';
import { useTheme } from '../../theme.js';
import { Group, SettingsPage } from './ui.js';

// 添加设备（扫码 / 手动）；带 params.deviceId 时是「修改这台设备的地址和 Token」。
export function AddDeviceScreen({ navigation, route }) {
  const { colors, fonts, dark } = useTheme();
  const { tryConnectBases } = useConnActions();
  const editing = route.params?.deviceId ? getDevice(route.params.deviceId) : null;
  const [name, setName] = useState(editing?.name || '');
  const [base, setBase] = useState(editing ? (editing.lastBase || editing.bases[0] || '') : '');
  const [tok, setTok] = useState(editing?.token || '');
  const [busy, setBusy] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  useEffect(() => { if (route.params?.scan) setScanOpen(true); }, [route.params?.scan]);

  const finishNew = (nm) => {
    if (nm) { const id = currentDeviceId(); if (id) updateDevice(id, { name: nm }); }
    bus.emit('devices');
  };

  const submit = async () => {
    const b = normalizeBase(base);
    const t = tok.trim();
    if (!b || !t || busy) return;
    setBusy(true);
    if (editing) {
      try {
        await probeBases([b], t);
      } catch (e) { setBusy(false); toast(connErrMsg(e), 'error'); return; }
      const bases = [b, ...editing.bases.filter((x) => x !== b)];
      updateDevice(editing.id, { token: t, bases, ...(name.trim() && name.trim() !== editing.name ? { name } : {}) });
      bus.emit('devices');
      if (editing.id === currentDeviceId()) await tryConnectBases(bases, t);
      setBusy(false);
      toast('已保存', 'info');
      navigation.goBack();
      return;
    }
    const ok = await tryConnectBases([b], t);
    if (ok) finishNew(name.trim());
    else setBusy(false);
  };

  const onScan = async ({ token: t, bases }) => {
    setScanOpen(false);
    setBusy(true);
    const ok = await tryConnectBases(bases, t);
    if (ok) finishNew(name.trim());
    else setBusy(false);
  };

  const input = { flex: 1, color: colors.inkStrong, fontSize: 16, paddingVertical: 14 };
  const label = { width: 64, color: colors.inkStrong, fontSize: 16.5 };
  const sep = <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 16 }} />;
  const canSubmit = !!base.trim() && !!tok.trim() && !busy;

  return (
    <SettingsPage title={editing ? '修改连接' : '添加设备'} keyboard>
      {!editing ? (
        <Pressable
          onPress={() => setScanOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="扫描配对二维码"
          style={({ pressed }) => ({
            backgroundColor: colors.card, borderRadius: 20, borderCurve: 'continuous', alignItems: 'center',
            paddingVertical: 28, marginBottom: 26, opacity: pressed ? 0.85 : 1,
          })}
        >
          <View style={{ width: 72, height: 72, borderRadius: 20, backgroundColor: colors.controlFill, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
            <Icon name="qr" size={38} color={colors.accent} strokeWidth={1.5} />
          </View>
          <Text style={{ color: colors.inkStrong, fontSize: 17, fontWeight: '600' }}>扫描配对二维码</Text>
          <Text style={{ color: colors.ink2, fontSize: 13.5, marginTop: 6 }}>
            在 Mac 上运行 <Text style={{ fontFamily: fonts.mono }}>cr pair</Text> 显示二维码
          </Text>
        </Pressable>
      ) : null}

      <Group title={editing ? '地址和 Token' : '或手动输入'} footer={editing ? '保存前会先试连一次' : '连接成功后会自动切到这台设备'}>
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
            <Text style={label}>名称</Text>
            <TextInput value={name} onChangeText={setName} placeholder="例如：家里的 Mac（可不填）" placeholderTextColor={colors.ink3}
              keyboardAppearance={dark ? 'dark' : 'light'} style={input} returnKeyType="next" />
          </View>
          {sep}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
            <Text style={label}>地址</Text>
            <TextInput value={base} onChangeText={setBase} placeholder="http://100.x.x.x:8787" placeholderTextColor={colors.ink3}
              autoCapitalize="none" autoCorrect={false} keyboardType="url" keyboardAppearance={dark ? 'dark' : 'light'}
              style={[input, { fontFamily: fonts.mono, fontSize: 15 }]} />
          </View>
          {sep}
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
            <Text style={label}>Token</Text>
            <TextInput value={tok} onChangeText={setTok} placeholder="BRIDGE_TOKEN" placeholderTextColor={colors.ink3}
              autoCapitalize="none" autoCorrect={false} secureTextEntry keyboardAppearance={dark ? 'dark' : 'light'}
              style={[input, { fontFamily: fonts.mono, fontSize: 15 }]} onSubmitEditing={submit} returnKeyType="go" />
          </View>
        </View>
      </Group>

      <Pressable
        onPress={submit}
        disabled={!canSubmit}
        accessibilityRole="button"
        style={({ pressed }) => ({
          height: 52, borderRadius: 26, borderCurve: 'continuous', backgroundColor: colors.inkStrong,
          alignItems: 'center', justifyContent: 'center', opacity: !canSubmit ? 0.4 : pressed ? 0.85 : 1,
        })}
      >
        {busy ? <ActivityIndicator color={colors.bg} /> : (
          <Text style={{ color: colors.bg, fontSize: 17, fontWeight: '600' }}>{editing ? '保存' : '连接并保存'}</Text>
        )}
      </Pressable>

      <QrScanner visible={scanOpen} onClose={() => setScanOpen(false)} onResult={onScan} />
    </SettingsPage>
  );
}
