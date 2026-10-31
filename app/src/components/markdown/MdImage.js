// Markdown 图片：本机路径（经 daemon /file 端点带 Bearer 头）与 raster data: 自动加载；
// 远程 http(s) 图片默认显示占位，用户点击后才请求（getSize 也不提前联网，防恶意网页外带数据）。
// 按图片真实宽高算比例，宽度撑满消息列、最高 420；点开复用 ImageViewer 全屏查看。加载失败退回链接样式文字。
import { memo, useEffect, useState } from 'react';
import { Image, Pressable, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { resolveImageSrc } from '../../../../web/core/md-image.js';
import { isSafeHref } from '../../../../web/core/linkify.js';
import { openLink, shareLink } from '../../lib/links.js';
import { Icon } from '../Icon.js';
import { ImageViewer } from '../ImageViewer.js';

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

function shouldAutoLoad(src) {
  return Boolean(src && (src.local || /^data:image\//i.test(src.uri)));
}

function remoteHost(uri) {
  try { return new URL(uri).host; } catch { return ''; }
}

export const MdImage = memo(function MdImage({ href, alt, sessionId, ctx, inline }) {
  const src = resolveImageSrc(href, { sessionId });
  const uri = src?.uri;
  const auto = shouldAutoLoad(src);
  const { width: winW } = useWindowDimensions();
  const [allowedUri, setAllowedUri] = useState(null);
  const allowed = auto || allowedUri === uri;
  const setAllowed = (value) => setAllowedUri(value ? uri : null);
  const [dimensions, setDimensions] = useState(null);
  const size = dimensions?.uri === uri ? dimensions.value : (uri && sizeCache.get(uri)) || null;
  const setSize = (value) => setDimensions({ uri, value });
  const [failed, setFailed] = useState(!src);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setFailed(!src);
    setSize((uri && sizeCache.get(uri)) || null);
  }, [uri, auto, Boolean(src)]);

  useEffect(() => {
    if (!src || !allowed || size) return undefined;
    let alive = true;
    getSize(src).then((s) => alive && setSize(s), () => alive && setFailed(true));
    return () => { alive = false; };
  }, [uri, allowed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed || !src) {
    const remote = isSafeHref(href);
    return (
      <Text
        accessibilityRole={remote ? 'link' : undefined}
        onPress={remote ? () => openLink(href) : undefined}
        onLongPress={remote ? () => shareLink(href) : undefined}
        style={{ color: ctx.colors.accent, textDecorationLine: remote ? 'underline' : 'none' }}
      >
        {alt || href}
      </Text>
    );
  }

  if (!allowed) {
    const host = remoteHost(uri);
    const label = alt ? `点击加载外部图片：${alt}` : '点击加载外部图片';
    if (inline) {
      return (
        <Text
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => setAllowed(true)}
          style={{ color: ctx.colors.accent, textDecorationLine: 'underline' }}
        >
          {`${label}${host ? ` (${host})` : ''}`}
        </Text>
      );
    }
    return (
      <TouchableOpacity
        activeOpacity={0.75}
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={() => setAllowed(true)}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          alignSelf: 'flex-start',
          gap: 8,
          marginVertical: 6,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: ctx.colors.line,
          backgroundColor: ctx.colors.card,
          maxWidth: winW - 48,
        }}
      >
        <Icon name="image" size={18} color={ctx.colors.ink2} />
        <View style={{ flexShrink: 1 }}>
          <Text numberOfLines={1} style={{ color: ctx.colors.ink, fontSize: 14, fontWeight: '500' }}>
            {label}
          </Text>
          {host ? (
            <Text numberOfLines={1} style={{ color: ctx.colors.ink3, fontSize: 12 }}>
              {host}
            </Text>
          ) : null}
        </View>
      </TouchableOpacity>
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
        accessibilityRole="imagebutton"
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
      <ImageViewer source={source} label={alt || '图片'} visible={open} onClose={() => setOpen(false)} />
    </>
  );
});
