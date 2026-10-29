import { useEffect, useRef, useState } from 'react';
import { Linking, Modal, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { parseDeepLink } from '../lib/deep-link.js';

// App 内扫码配对：读 Mac 上 `cr` 配对页（按 p）的二维码，内容是 claude-remote://setup?... 深链。
// expo-camera 是原生模块，旧 dev client 里没有时 require 失败，界面提示重新编译而不是崩溃。
let cam = null;
try { cam = require('expo-camera'); } catch { cam = null; }

const CORNER = 28;
function Corners({ color }) {
  const s = { position: 'absolute', width: CORNER, height: CORNER, borderColor: color };
  return (
    <>
      <View style={[s, { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 10 }]} />
      <View style={[s, { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 10 }]} />
      <View style={[s, { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 10 }]} />
      <View style={[s, { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 10 }]} />
    </>
  );
}

/** onResult({ token, bases }) 在识别到有效配对码时调用一次，随后弹窗关闭。 */
export function QrScanner({ visible, onClose, onResult }) {
  const insets = useSafeAreaInsets();
  const [hint, setHint] = useState('');
  const [found, setFound] = useState(false);
  const lockRef = useRef(false);
  const perm = cam?.useCameraPermissions ? cam.useCameraPermissions() : [null, async () => null];
  const [permission, requestPermission] = perm;

  useEffect(() => {
    if (!visible) return;
    lockRef.current = false;
    setFound(false);
    setHint('');
    if (permission && !permission.granted && permission.canAskAgain) requestPermission();
  }, [visible]);

  const onScanned = ({ data }) => {
    if (lockRef.current) return;
    const link = parseDeepLink(String(data || ''));
    if (!link || link.type !== 'setup') {
      setHint('这不是 Claude Remote 的配对码');
      return;
    }
    lockRef.current = true;
    setFound(true);
    setTimeout(() => { onResult({ token: link.token, bases: link.bases }); onClose(); }, 380);
  };

  const accent = '#D97757';
  let body;
  if (!cam) {
    body = <Text style={{ color: '#fff', textAlign: 'center', lineHeight: 22 }}>当前安装包没有相机模块，需要重新编译 App。{'\n'}也可以用系统相机扫码，或手动输入地址。</Text>;
  } else if (!permission) {
    body = null;
  } else if (!permission.granted) {
    body = (
      <View style={{ alignItems: 'center', gap: 14 }}>
        <Text style={{ color: '#fff', textAlign: 'center', lineHeight: 22 }}>需要相机权限才能扫码</Text>
        <TouchableOpacity
          onPress={() => (permission.canAskAgain ? requestPermission() : Linking.openSettings())}
          style={{ backgroundColor: accent, borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11 }}
        >
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '500' }}>{permission.canAskAgain ? '允许使用相机' : '去设置里打开'}</Text>
        </TouchableOpacity>
      </View>
    );
  } else {
    const { CameraView } = cam;
    body = (
      <View style={{ width: 250, height: 250, borderRadius: 18, overflow: 'hidden' }}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={found ? undefined : onScanned}
        />
        <Corners color={found ? accent : '#fff'} />
      </View>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#181715', alignItems: 'center', paddingTop: 18, paddingBottom: insets.bottom + 20 }}>
        <View style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: '#5a5854' }} />
        <View style={{ width: '100%', flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 20 }}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Text style={{ color: '#cfccc6', fontSize: 15 }}>取消</Text>
          </TouchableOpacity>
        </View>
        <Text style={{ color: '#fff', fontSize: 17, fontWeight: '500', marginTop: 18 }}>对准 Mac 上的二维码</Text>
        <Text style={{ color: '#a9a59d', fontSize: 13, marginTop: 6 }}>在 Mac 上运行 cr，按 p 显示配对二维码</Text>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30 }}>{body}</View>
        <Text style={{ color: found ? '#6BAA6A' : '#e08f78', fontSize: 13.5, minHeight: 20 }}>{found ? '✓ 已识别' : hint}</Text>
      </View>
    </Modal>
  );
}
