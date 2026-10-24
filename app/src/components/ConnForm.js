import { useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../theme.js';

// 移植 web/ui/screens/setup.js 的 ConnForm：地址 TextInput + token TextInput + 提交按钮。
// 文案照抄 web；视觉套 theme token。地址与 token 同表单状态由本组件持有，提交时 trim 后回传。
export function ConnForm({ initBase, initToken, busy, submitLabel, onSubmit }) {
  const { colors, fonts, radius } = useTheme();
  const [base, setBase] = useState(initBase);
  const [tok, setTok] = useState(initToken);

  const disabled = busy || !tok.trim();
  const submit = () => {
    if (disabled) return;
    onSubmit(base.trim(), tok.trim());
  };

  const labelStyle = { fontSize: 13, color: colors.ink, fontWeight: '500' };
  const hintStyle = { fontSize: 11.5, color: colors.ink2 };
  const inputStyle = {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14.5,
    color: colors.inkStrong,
    backgroundColor: colors.bg,
  };

  return (
    <View style={{ gap: 14 }}>
      <View style={{ gap: 4 }}>
        <Text style={labelStyle}>服务器地址</Text>
        <TextInput
          value={base}
          onChangeText={setBase}
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          placeholder="http://100.64.0.5:8787"
          placeholderTextColor={colors.ink3}
          style={inputStyle}
        />
        <Text style={hintStyle}>Mac 的 Tailscale IP 或局域网 IP + 端口，cr 配对页（按 p）里有</Text>
      </View>
      <View style={{ gap: 4 }}>
        <Text style={labelStyle}>访问令牌</Text>
        <TextInput
          value={tok}
          onChangeText={setTok}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          placeholder="BRIDGE_TOKEN"
          placeholderTextColor={colors.ink3}
          style={inputStyle}
        />
        <Text style={hintStyle}>Mac 上 ~/.claude-remote/config.env 里的 BRIDGE_TOKEN</Text>
      </View>
      <TouchableOpacity
        onPress={submit}
        disabled={disabled}
        activeOpacity={0.85}
        style={{
          borderRadius: 24,
          paddingVertical: 13,
          paddingHorizontal: 18,
          borderWidth: 1,
          borderColor: colors.accent,
          backgroundColor: colors.accent,
          alignItems: 'center',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text style={{ color: '#fff', fontSize: 15.5, fontWeight: '500' }}>
          {busy ? '连接中…' : submitLabel}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
