import { useRef, useState } from 'react';
import { Keyboard, Text, TouchableOpacity, View } from 'react-native';
import { modelSelection, modelTriggerLabel } from '../../../../web/core/api.js';
import { GlassMenu } from '../GlassMenu.js';
import { buildModelMenuItems } from './ModelSheet.js';
import { useI18n } from '../../lib/i18n.js';
import { useTheme } from '../../theme.js';
import { haptics } from '../../lib/haptics.js';

// 模型胶囊：点击在按钮上方弹出液态玻璃菜单选模型，收起时以水滴形态缩回胶囊。
export function ModelPicker({ value, onChange, catalog, onOpen }) {
  const { t } = useI18n();
  const { colors } = useTheme();
  const anchorRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const triggerMain = modelTriggerLabel(catalog, value);
  const unavailable = modelSelection(catalog, value).status === 'unavailable';

  const pick = (v) => {
    if (v !== value) haptics.selection();
    onChange(v);
  };

  const openMenu = () => {
    onOpen?.();
    const measure = () => anchorRef.current?.measureInWindow((x, y, width, height) => {
      setMenuAnchor({ x, y, width, height });
      setMenuOpen(true);
    });
    if (!Keyboard.isVisible()) { measure(); return; }
    const sub = Keyboard.addListener('keyboardDidHide', () => { sub.remove(); measure(); });
    Keyboard.dismiss();
  };

  const items = buildModelMenuItems({ value, catalog, onPick: pick, t });

  return (
    <View ref={anchorRef} collapsable={false} style={{ flexShrink: 1 }}>
      <TouchableOpacity
        testID="model-picker-trigger"
        onPress={openMenu}
        accessibilityRole="button"
        accessibilityLabel={t('选择模型，当前{name}', { name: triggerMain })}
        accessibilityState={{ expanded: menuOpen }}
        style={{
          borderRadius: 22,
          borderCurve: 'continuous',
          paddingHorizontal: 12,
          paddingVertical: 10,
          minHeight: 44,
          justifyContent: 'center',
          backgroundColor: unavailable ? colors.glassTintAccent : colors.controlFill,
          borderWidth: 1,
          borderColor: unavailable ? colors.danger : colors.controlBorder,
          flexShrink: 1,
        }}
      >
        <Text numberOfLines={1} style={{ color: unavailable ? colors.danger : colors.ink, fontSize: 13.5, fontWeight: '500' }}>
          {triggerMain}
        </Text>
      </TouchableOpacity>
      <GlassMenu
        visible={menuOpen}
        anchor={menuAnchor}
        title={t('选择模型')}
        items={items}
        placement="above"
        width={268}
        onClose={() => setMenuOpen(false)}
      />
    </View>
  );
}
