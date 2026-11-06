import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { connErrMsg, normalizeBase, probeBases } from '../../../../web/core/api.js';
import { bus, toast } from '../../../../web/core/bus.js';
import { currentDeviceId, getDevice, updateDevice } from '../../../../web/core/devices.js';
import { useConnActions } from '../../lib/conn-context.js';
import { useI18n } from '../../lib/i18n.js';
import { haptics } from '../../lib/haptics.js';
import { useTheme } from '../../theme.js';
import { Group, SettingsPage } from './ui.js';

// 新设备连上后 tryConnectBases 已把它记为当前设备，这里只补上用户填的名称
export function finishNewDevice(name) {
  if (name) { const id = currentDeviceId(); if (id) updateDevice(id, { name }); }
  bus.emit('devices');
}

export function DeviceFields({ name, setName, base, setBase, tok, setTok, onSubmit, autoFocus }) {
  const { t } = useI18n();
  const { colors, fonts, dark } = useTheme();
  const input = { flex: 1, color: colors.inkStrong, fontSize: 16, paddingVertical: 14 };
  const label = { width: 64, color: colors.inkStrong, fontSize: 16.5 };
  const sep = <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 16 }} />;
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
        <Text style={label}>{t('名称')}</Text>
        <TextInput value={name} onChangeText={setName} placeholder={t('例如：家里的 Mac（可不填）')} placeholderTextColor={colors.ink3}
          keyboardAppearance={dark ? 'dark' : 'light'} style={input} returnKeyType="next" autoFocus={autoFocus} />
      </View>
      {sep}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
        <Text style={label}>{t('地址')}</Text>
        <TextInput value={base} onChangeText={setBase} placeholder="http://100.x.x.x:8787" placeholderTextColor={colors.ink3}
          autoCapitalize="none" autoCorrect={false} keyboardType="url" keyboardAppearance={dark ? 'dark' : 'light'}
          style={[input, { fontFamily: fonts.mono, fontSize: 15 }]} />
      </View>
      {sep}
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 }}>
        <Text style={label}>Token</Text>
        <TextInput value={tok} onChangeText={setTok} placeholder="BRIDGE_TOKEN" placeholderTextColor={colors.ink3}
          autoCapitalize="none" autoCorrect={false} secureTextEntry keyboardAppearance={dark ? 'dark' : 'light'}
          style={[input, { fontFamily: fonts.mono, fontSize: 15 }]} onSubmitEditing={onSubmit} returnKeyType="go" />
      </View>
    </View>
  );
}

// 修改已配对设备的地址和 Token（设备详情 → Token）。新增设备在设备页里直接扫码或手动展开表单。
export function AddDeviceScreen({ navigation, route }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const { tryConnectBases } = useConnActions();
  const editing = getDevice(route.params?.deviceId);
  const [name, setName] = useState(editing?.name || '');
  const [base, setBase] = useState(editing ? (editing.lastBase || editing.bases[0] || '') : '');
  const [tok, setTok] = useState(editing?.token || '');
  const [busy, setBusy] = useState(false);

  if (!editing) return <SettingsPage title={t('修改连接')} />;

  const submit = async () => {
    const b = normalizeBase(base);
    const token = tok.trim();
    if (!b || !token || busy) return;
    setBusy(true);
    try {
      await probeBases([b], token);
    } catch (e) { setBusy(false); haptics.error(); toast(connErrMsg(e), 'error'); return; }
    const bases = [b, ...editing.bases.filter((x) => x !== b)];
    updateDevice(editing.id, { token, bases, ...(name.trim() && name.trim() !== editing.name ? { name } : {}) });
    bus.emit('devices');
    if (editing.id === currentDeviceId()) {
      const ok = await tryConnectBases(bases, token, { beforeCommit: () => haptics.success() });
      if (!ok) haptics.error();
    } else haptics.confirm();
    setBusy(false);
    toast(t('已保存'), 'info');
    navigation.goBack();
  };

  const canSubmit = !!base.trim() && !!tok.trim() && !busy;

  return (
    <SettingsPage title={t('修改连接')} keyboard>
      <Group title={t('地址和 Token')} footer={t('保存前会先试连一次')}>
        <DeviceFields name={name} setName={setName} base={base} setBase={setBase} tok={tok} setTok={setTok} onSubmit={submit} />
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
          <Text style={{ color: colors.bg, fontSize: 17, fontWeight: '600' }}>{t('保存')}</Text>
        )}
      </Pressable>
    </SettingsPage>
  );
}
