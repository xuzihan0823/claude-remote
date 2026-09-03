import { Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../theme.js';

// 移植 web/ui/screens/setup.js 的 PairConfirm：全屏 absolute 遮罩 + 居中卡片 +
// 候选地址等宽列表 + 覆盖警告 + 取消/确认连接按钮。
// 渲染于 App.js 根 View 内（导航容器之后），zIndex 置顶；ToastLayer 在其后渲染可叠于其上。
export function PairConfirm({ req, busy, onConfirm, onCancel, hasExisting }) {
  const { colors, fonts, radius } = useTheme();
  if (!req || !Array.isArray(req.bases)) return null;

  return (
    <View
      style={{
        position: 'absolute',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(30,26,22,0.5)',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        zIndex: 100,
        elevation: 100,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 380,
          backgroundColor: colors.card,
          borderWidth: 1,
          borderColor: colors.line,
          borderRadius: radius.md,
          paddingTop: 24,
          paddingHorizontal: 22,
          paddingBottom: 20,
        }}
      >
        <Text
          style={{
            fontFamily: fonts.serifCn,
            fontSize: 24,
            fontWeight: '600',
            color: colors.inkStrong,
            textAlign: 'center',
          }}
        >
          扫码配对
        </Text>
        <Text
          style={{
            color: colors.ink2,
            fontSize: 14,
            marginTop: 2,
            marginBottom: 18,
            textAlign: 'center',
          }}
        >
          将连接以下 Mac 地址（按顺序探测）：
        </Text>

        <View style={{ gap: 6, marginTop: 4, marginBottom: 6 }}>
          {req.bases.map((b, i) => (
            <Text
              key={`${b}-${i}`}
              numberOfLines={1}
              style={{
                fontFamily: fonts.mono,
                fontSize: 13,
                color: colors.inkStrong,
                backgroundColor: colors.bg,
                borderWidth: 1,
                borderColor: colors.line,
                borderRadius: radius.xs,
                paddingHorizontal: 10,
                paddingVertical: 7,
              }}
            >
              {b}
            </Text>
          ))}
        </View>

        {hasExisting ? (
          <Text style={{ color: colors.danger, fontSize: 13, marginTop: 4 }}>
            注意：确认后将覆盖当前已保存的连接配置。
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
          <TouchableOpacity
            onPress={onCancel}
            disabled={busy}
            activeOpacity={0.85}
            style={{
              flex: 1,
              borderRadius: radius.sm,
              paddingVertical: 9,
              borderWidth: 1,
              borderColor: '#e8cfc8',
              backgroundColor: 'transparent',
              alignItems: 'center',
              opacity: busy ? 0.5 : 1,
            }}
          >
            <Text style={{ color: colors.danger, fontSize: 14.5, fontWeight: '500' }}>取消</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onConfirm}
            disabled={busy}
            activeOpacity={0.85}
            style={{
              flex: 1,
              borderRadius: radius.sm,
              paddingVertical: 9,
              borderWidth: 1,
              borderColor: colors.accent,
              backgroundColor: colors.accent,
              alignItems: 'center',
              opacity: busy ? 0.5 : 1,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 14.5, fontWeight: '500' }}>
              {busy ? '连接中…' : '确认连接'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
