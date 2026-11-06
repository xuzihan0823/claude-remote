// 旧 dev client 可能没有编入 expo-clipboard，加载失败时提示更新而不是崩溃。
import { toast } from '../../../web/core/bus.js';

let C = null;
try {
  // eslint-disable-next-line global-require
  C = require('expo-clipboard');
} catch {
  C = null;
}

export async function copyText(text) {
  if (!C) {
    toast('文本复制：当前安装包不支持复制', 'error');
    return false;
  }
  try {
    return await C.setStringAsync(text);
  } catch {
    toast('文本复制：复制失败', 'error');
    return false;
  }
}
