import { useRef, useState } from 'react';
import { Alert, Keyboard, Linking, TouchableOpacity, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { toast } from '../../../../web/core/bus.js';
import { GlassMenu } from '../GlassMenu.js';
import { Icon } from '../Icon.js';
import { MAX_UPLOAD_BYTES, normalizeAsset } from '../../lib/attachments.js';
import { useTheme } from '../../theme.js';

// + 按钮：在按钮上方弹玻璃菜单选 拍照/相册/文件，归一为 {uri,name,size,isImage} 列表回调 onPicked。
// 相机先申请权限，被拒时引导去设置；超过 25MB 的在选择时就跳过，不等上传失败。
// picker 返回值均 guard canceled 与空 assets（image-picker: {assets, canceled}；
// document-picker: {assets, canceled}）。
export function AttachmentPicker({ disabled, onPicked }) {
  const { colors } = useTheme();
  const anchorRef = useRef(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState(null);

  const addAssets = (assets) => {
    if (!assets || !assets.length) return;
    const items = assets.map((a) => normalizeAsset(a));
    const ok = items.filter((f) => !(f.size > MAX_UPLOAD_BYTES));
    const big = items.length - ok.length;
    if (big) toast(`${big} 个文件超过 25MB，已跳过`, 'error');
    if (ok.length) onPicked(ok);
  };

  const askSettings = (what) => {
    Alert.alert(`没有${what}权限`, `请在「设置」里允许 Claude Remote 访问${what}。`, [
      { text: '取消', style: 'cancel' },
      { text: '去设置', onPress: () => Linking.openSettings().catch(() => {}) },
    ]);
  };

  // 选图统一要「兼容」格式：iOS 会把 HEIC 转成 JPEG，Claude 的 Read 不认 HEIC
  const imageOpts = {
    mediaTypes: ['images'],
    preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode?.Compatible ?? 'compatible',
    quality: 0.85,
    exif: false,
  };

  const pickCamera = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) { askSettings('相机'); return; }
      const r = await ImagePicker.launchCameraAsync(imageOpts);
      if (r && !r.canceled && r.assets) addAssets(r.assets);
    } catch (e) {
      toast(`相机打开失败：${e?.message || e}`, 'error');
    }
  };

  const pickLibrary = async () => {
    try {
      // iOS 14+ 走系统 PHPicker，无需相册授权
      const r = await ImagePicker.launchImageLibraryAsync({ ...imageOpts, allowsMultipleSelection: true, selectionLimit: 10 });
      if (r && !r.canceled && r.assets) addAssets(r.assets);
    } catch (e) {
      toast(`相册打开失败：${e?.message || e}`, 'error');
    }
  };

  const pickFiles = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: '*/*' });
      if (r && !r.canceled && r.assets) addAssets(r.assets);
    } catch (e) {
      toast(`文件选择失败：${e?.message || e}`, 'error');
    }
  };

  const items = [
    { key: 'camera', icon: 'camera', label: '拍照', onPress: pickCamera },
    { key: 'photos', icon: 'image', label: '照片', onPress: pickLibrary },
    { key: 'files', icon: 'paperclip', label: '文件', onPress: pickFiles },
  ];

  // 键盘收起后输入栏会下移，等键盘完全收起再量按钮位置，菜单才贴得准
  const openMenu = () => {
    const measure = () => anchorRef.current?.measureInWindow((x, y, width, height) => {
      setMenuAnchor({ x, y, width, height });
      setMenuOpen(true);
    });
    if (!Keyboard.isVisible()) { measure(); return; }
    const sub = Keyboard.addListener('keyboardDidHide', () => { sub.remove(); measure(); });
    Keyboard.dismiss();
  };

  return (
    <View ref={anchorRef} collapsable={false}>
      <TouchableOpacity
        onPress={openMenu}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="上传附件"
        accessibilityState={{ disabled: !!disabled, expanded: menuOpen }}
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          borderCurve: 'continuous',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.controlFill,
          borderWidth: 1,
          borderColor: colors.controlBorder,
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Icon name="plus" />
      </TouchableOpacity>
      <GlassMenu visible={menuOpen} anchor={menuAnchor} items={items} placement="above" size="large" onClose={() => setMenuOpen(false)} />
    </View>
  );
}
