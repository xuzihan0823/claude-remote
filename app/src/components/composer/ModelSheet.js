import { useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { defaultModelDescription, findModel, modelMainName, modelValue } from '../../../../web/core/api.js';
import {
  EFFORT_DESCRIPTIONS,
  EFFORT_LEVELS,
  effortLabel,
  effortSelection,
} from '../../../../web/core/effort.js';
import { Icon } from '../Icon.js';
import { useTheme } from '../../theme.js';

// 模型与思考程度 sheet 内容：
// - 选择模型后弹层保留，继续查看/选择该模型的思考程度档位
// - 支持 known / unknown（可展开手动五档）/ unsupported（禁用调整但可清除旧值）/ thinkingEnabled===false 提示
// - 全部可交互项满足 ≥44px 触摸高度
export function ModelSheetContent({
  value,
  catalog,
  onPick,
  effortRecord,
  capabilities,
  onPickEffort,
  onRefreshCapabilities,
  onClose,
}) {
  const { colors } = useTheme();
  const { models = [] } = catalog || {};
  const sel = findModel(models, value);
  const caps = capabilities || { status: 'unknown', effortLevels: [], thinkingEnabled: true, loaded: false, loading: false, error: '' };
  const currentEffort = typeof effortRecord === 'string' ? effortRecord : (effortRecord?.effort || '');
  const effortState = effortSelection(caps, effortRecord, { model: value });
  const [manualOpen, setManualOpen] = useState(false);

  const row = {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 16,
  };
  const main = { color: colors.inkStrong, fontSize: 15 };
  const sub = { color: colors.ink2, fontSize: 12, marginTop: 2 };
  const check = { color: colors.accent, fontSize: 16, marginLeft: 8 };

  const thinkingOff = Boolean(caps.loaded && caps.thinkingEnabled === false);
  const isUnsupported = Boolean(caps.loaded && !thinkingOff && caps.status === 'unsupported');
  const isKnown = Boolean(caps.loaded && !thinkingOff && caps.status === 'known');
  const isUnknown = !thinkingOff && !isUnsupported && !isKnown;
  const showManualLevels = isUnknown && (manualOpen || Boolean(currentEffort));

  const renderEffortRow = (level, { disabled = false, unconfirmed = false } = {}) => {
    const isCurrent = currentEffort === level;
    const isStaleCurrent = isCurrent && effortState.status === 'stale';
    const isValidCurrent = isCurrent && effortState.canSend;
    const label = effortLabel(level);
    const desc = unconfirmed
      ? `${EFFORT_DESCRIPTIONS[level]} · 兼容性未确认`
      : EFFORT_DESCRIPTIONS[level];

    return (
      <TouchableOpacity
        key={level}
        testID={`effort-option-${level}`}
        disabled={disabled}
        onPress={() => onPickEffort?.(level)}
        accessibilityRole="button"
        accessibilityState={{ disabled, selected: isValidCurrent }}
        accessibilityLabel={`思考程度：${label}${unconfirmed ? '，兼容性未确认' : ''}`}
        style={[row, disabled ? { opacity: 0.42 } : null]}
      >
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={main}>{label}</Text>
          {desc ? <Text style={sub}>{desc}</Text> : null}
        </View>
        {isStaleCurrent ? (
          <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '600', marginLeft: 8 }}>
            已过期 · 点击重选
          </Text>
        ) : isValidCurrent ? (
          <Text style={check}>✓</Text>
        ) : null}
      </TouchableOpacity>
    );
  };

  return (
    <BottomSheetScrollView contentContainerStyle={{ paddingBottom: 28 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 8,
          minHeight: 44,
        }}
      >
        <TouchableOpacity
          testID="effort-refresh-button"
          onPress={() => onRefreshCapabilities?.()}
          disabled={Boolean(caps.loading)}
          accessibilityRole="button"
          accessibilityLabel="刷新模型与思考能力"
          style={{
            minHeight: 44,
            minWidth: 44,
            paddingHorizontal: 10,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
          }}
        >
          {caps.loading ? (
            <ActivityIndicator size="small" color={colors.ink2} />
          ) : (
            <Icon name="refresh" size={16} color={colors.ink2} />
          )}
          <Text style={{ color: colors.ink2, fontSize: 13 }}>刷新</Text>
        </TouchableOpacity>

        <Text accessibilityRole="header" style={{ color: colors.inkStrong, fontSize: 15, fontWeight: '600' }}>
          模型与思考程度
        </Text>

        {onClose ? (
          <TouchableOpacity
            testID="model-sheet-done"
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="完成"
            style={{
              minHeight: 44,
              minWidth: 44,
              paddingHorizontal: 10,
              alignItems: 'flex-end',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: colors.accent, fontSize: 14, fontWeight: '600' }}>完成</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ minWidth: 44 }} />
        )}
      </View>

      {!effortState.canSend && currentEffort ? (
        <View
          testID="effort-warning-banner"
          style={{
            marginHorizontal: 16,
            marginTop: 6,
            marginBottom: 4,
            paddingHorizontal: 12,
            paddingVertical: 10,
            borderRadius: 12,
            backgroundColor: colors.glassTintAccent,
            borderWidth: 1,
            borderColor: colors.danger,
          }}
        >
          <Text style={{ color: colors.danger, fontSize: 13, lineHeight: 18 }}>
            {effortState.message}
          </Text>
          <TouchableOpacity
            testID="effort-clear-button"
            onPress={() => onPickEffort?.('')}
            accessibilityRole="button"
            accessibilityLabel="清除思考程度并恢复默认"
            style={{
              minHeight: 44,
              marginTop: 4,
              alignSelf: 'flex-start',
              justifyContent: 'center',
              paddingHorizontal: 12,
              borderRadius: 10,
              backgroundColor: colors.card,
              borderWidth: 1,
              borderColor: colors.controlBorder,
            }}
          >
            <Text style={{ color: colors.inkStrong, fontSize: 13, fontWeight: '600' }}>
              清除旧选择（恢复默认）
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={{ paddingTop: 8, paddingBottom: 4, paddingHorizontal: 16 }}>
        <Text accessibilityRole="header" style={{ color: colors.inkStrong, fontSize: 14, fontWeight: '600' }}>
          选择模型
        </Text>
      </View>

      <TouchableOpacity
        testID="model-option-default"
        onPress={() => onPick('')}
        accessibilityRole="button"
        accessibilityState={{ selected: !value }}
        style={row}
      >
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={main}>跟随项目默认</Text>
          <Text style={sub}>{defaultModelDescription(catalog)}</Text>
        </View>
        {!value ? <Text style={check}>✓</Text> : null}
      </TouchableOpacity>

      {models.map((m) => {
        const v = modelValue(m);
        const on = !!(sel && sel.alias === m.alias && sel.id === m.id);
        return (
          <TouchableOpacity
            key={v}
            testID={`model-option-${v}`}
            onPress={() => onPick(v)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={row}
          >
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={main}>{modelMainName(m)}</Text>
              {m.alias && m.alias !== m.id ? <Text style={sub}>别名 {m.alias}</Text> : null}
            </View>
            {on ? <Text style={check}>✓</Text> : null}
          </TouchableOpacity>
        );
      })}

      { onPickEffort ? (
        <View
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTopWidth: 1,
            borderTopColor: colors.line,
          }}
        >
          <View style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
            <Text accessibilityRole="header" style={{ color: colors.inkStrong, fontSize: 14, fontWeight: '600' }}>
              思考程度
            </Text>
            {thinkingOff ? (
              <Text testID="effort-thinking-off-hint" style={{ color: colors.danger, fontSize: 12.5, marginTop: 4, lineHeight: 18 }}>
                本机已关闭思考（MAX_THINKING_TOKENS=0 或 alwaysThinkingEnabled=false），思考档位不会生效，仅保留跟随默认。
              </Text>
            ) : isUnsupported ? (
              <Text testID="effort-unsupported-hint" style={{ color: colors.ink2, fontSize: 12.5, marginTop: 4, lineHeight: 18 }}>
                {caps.reason === 'effort_env_override' ? '思考程度已由本机环境固定，请恢复默认或在电脑上修改。' : '当前模型不支持调整思考程度。'}{currentEffort ? '请清除旧选择以恢复默认。' : ''}
              </Text>
            ) : isKnown ? (
              <Text style={{ color: colors.ink2, fontSize: 12.5, marginTop: 4 }}>
                当前模型支持 {caps.effortLevels.map(effortLabel).join(' / ')} 档位
              </Text>
            ) : (
              <Text style={{ color: colors.ink2, fontSize: 12.5, marginTop: 4 }}>
                {caps.loading && !caps.loaded
                  ? '正在获取当前模型的思考能力…'
                  : caps.error
                    ? '未能获取模型思考能力，不影响默认对话；也可展开手动指定或点击右上角刷新'
                    : '未能确认当前模型的思考档位兼容性'}
              </Text>
            )}
          </View>

          <TouchableOpacity
            testID="effort-option-default"
            onPress={() => onPickEffort('')}
            accessibilityRole="button"
            accessibilityState={{ selected: !currentEffort }}
            style={row}
          >
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={main}>跟随默认</Text>
              <Text style={sub}>
                {thinkingOff
                  ? '本机已关闭思考，实际运行不启用思考预算'
                  : effortState.status === 'stale'
                    ? '已因连接或本机配置变化需要重选；点击恢复本机默认'
                    : EFFORT_DESCRIPTIONS['']}
              </Text>
            </View>
            {!currentEffort ? <Text style={check}>✓</Text> : null}
          </TouchableOpacity>

          {thinkingOff || isUnsupported ? (
            EFFORT_LEVELS.map((level) => renderEffortRow(level, { disabled: true }))
          ) : null}

          {isKnown ? (
            caps.effortLevels.map((level) => renderEffortRow(level))
          ) : null}

          {isUnknown ? (
            <>
              <TouchableOpacity
                testID="effort-manual-toggle"
                onPress={() => setManualOpen((o) => !o)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showManualLevels }}
                accessibilityLabel="手动指定（兼容性未确认）"
                style={[
                  row,
                  {
                    backgroundColor: colors.controlFill,
                    marginHorizontal: 12,
                    marginTop: 4,
                    borderRadius: 12,
                    paddingHorizontal: 12,
                  },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.inkStrong, fontSize: 14, fontWeight: '500' }}>
                    手动指定（兼容性未确认）
                  </Text>
                  <Text style={sub}>
                    展开标准五档（低 / 中 / 高 / 超高 / 最大）手动传递
                  </Text>
                </View>
                <Text style={{ color: colors.ink2, fontSize: 12.5, marginLeft: 8 }}>
                  {showManualLevels ? '收起' : '展开'}
                </Text>
              </TouchableOpacity>
              {showManualLevels ? (
                <View style={{ marginTop: 4 }}>
                  {EFFORT_LEVELS.map((level) => renderEffortRow(level, { unconfirmed: true }))}
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
    </BottomSheetScrollView>
  );
}
