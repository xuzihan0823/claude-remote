// Markdown 图片：远程直接加载；本机路径经 daemon /file 端点（带 Bearer 头）。
// 先按图片真实宽高算比例，宽度撑满消息列、最高 420；点开全屏查看。加载失败退回链接样式文字。
import { memo, useEffect, useState } from 'react';
import { Image, Linking, Modal, Pressable, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { resolveImageSrc } from '../../../../web/core/md-image.js';

const MAX_H = 420;
const sizeCache = new Map();

function getSize(src) {
  if (sizeCache.has(src.uri)) return Promise.resolve(sizeCache.get(src.uri));
  return new Promise((ok, bad) => {
    const done = (w, h) => { sizeCache.set(src.uri, { w, h }); ok({ w, h }); };
    if (src.headers) Image.getSizeWithHeaders(src.uri, src.headers, done, bad);
    else Image.getSize(src.uri, done, bad);
  });
}

export const MdImage = memo(function MdImage({ href, alt, sessionId, ctx, inline }) {
  const src = resolveImageSrc(href, { sessionId });
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [size, setSize] = useState(() => (src && sizeCache.get(src.uri)) || null);
  const [failed, setFailed] = useState(!src);
  const [open, setOpen] = useState(false);
  const uri = src?.uri;

  useEffect(() => {
    if (!src || size) return undefined;
    let alive = true;
    getSize(src).then((s) => alive && setSize(s), () => alive && setFailed(true));
    return () => { alive = false; };
  }, [uri]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) {
    const remote = /^https?:/i.test(href || '');
    return (
      <Text
        onPress={remote ? () => Linking.openURL(href).catch(() => {}) : undefined}
        style={{ color: ctx.colors.accent, textDecorationLine: remote ? 'underline' : 'none' }}
      >
        {`🖼 ${alt || href}`}
      </Text>
    );
  }

  const maxW = inline ? 220 : winW - 48;
  let w = maxW;
  let h = 160;
  if (size && size.w > 0 && size.h > 0) {
    w = Math.min(maxW, size.w);
    h = (w * size.h) / size.w;
    if (h > MAX_H) { h = MAX_H; w = (h * size.w) / size.h; }
  }
  const source = { uri, headers: src.headers };
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="image"
        accessibilityLabel={alt || '图片'}
        style={{ marginVertical: inline ? 0 : 6, alignSelf: 'flex-start' }}
      >
        <Image
          source={source}
          onError={() => setFailed(true)}
          resizeMode="contain"
          style={{
            width: w, height: h, borderRadius: 10, borderWidth: 1,
            borderColor: ctx.colors.line, backgroundColor: ctx.colors.card,
          }}
        />
      </Pressable>
      {open ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setOpen(false)} statusBarTranslucent>
          <Pressable onPress={() => setOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.94)', justifyContent: 'center' }}>
            <Image source={source} resizeMode="contain" style={{ width: winW, height: winH - insets.top - insets.bottom }} />
            {alt ? (
              <View style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 16 }}>
                <Text style={{ color: '#fff', textAlign: 'center', fontSize: 14 }}>{alt}</Text>
              </View>
            ) : null}
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
});
