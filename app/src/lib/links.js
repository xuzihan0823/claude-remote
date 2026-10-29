// iOS 端「一键直达」：点开链接（本机地址改写到 Mac），长按弹分享面板（可复制/用其他 App 打开）
import { Linking, Share } from 'react-native';
import { baseUrl } from '../../../web/core/api.js';
import { toast } from '../../../web/core/bus.js';
import { isSafeHref, resolveHref } from '../../../web/core/linkify.js';

export function openLink(href) {
  if (!isSafeHref(href)) return;
  const target = resolveHref(href, baseUrl);
  Linking.openURL(target).catch(() => toast('无法打开链接', 'error'));
}

export function shareLink(href) {
  if (!isSafeHref(href)) return;
  Share.share({ url: resolveHref(href, baseUrl) }).catch(() => {});
}
