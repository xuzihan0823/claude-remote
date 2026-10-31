import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { toast } from '../../../web/core/bus.js';
import { Icon } from './Icon.js';
import { ZoomableImage } from './ImageViewer.js';
import { MarkdownView } from './markdown/MarkdownView.js';
import { fmtBytes } from '../lib/format.js';
import { openLink } from '../lib/links.js';
import { useTheme } from '../theme.js';
import {
  TEXT_PREVIEW_BYTES, autoDownloads, fetchFileMeta, fileContentRequest, fileErrorText, previewKindFor,
  previewNavigation, tempFileName, textChunks, utf8SafeLength,
} from '../lib/file-preview.js';

const removeTemp = (dir) => {
  try { if (dir.exists) dir.delete(); } catch { /* 缓存目录由系统兜底清理 */ }
};

function readTextHead(file) {
  const handle = file.open(FileMode.ReadOnly);
  try {
    const bytes = handle.readBytes(Math.min(TEXT_PREVIEW_BYTES, file.size ?? TEXT_PREVIEW_BYTES));
    return new TextDecoder('utf-8').decode(bytes.subarray(0, utf8SafeLength(bytes)));
  } finally {
    handle.close();
  }
}

function SandboxedPage({ uri, html }) {
  const { colors } = useTheme();
  const onNavigate = useCallback((req) => {
    const action = previewNavigation(req, uri, Platform.OS);
    if (action === 'external') openLink(req.url);
    return action === 'allow';
  }, [uri]);
  return (
    <WebView
      source={{ uri }}
      originWhitelist={['*']}
      javaScriptEnabled={html}
      incognito
      cacheEnabled={false}
      allowFileAccess={Platform.OS === 'android'}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      allowsLinkPreview={false}
      onShouldStartLoadWithRequest={onNavigate}
      onOpenWindow={(e) => openLink(e.nativeEvent.targetUrl)}
      style={{ flex: 1, backgroundColor: colors.bg }}
    />
  );
}

function TextContent({ text, truncated }) {
  const { colors, fonts } = useTheme();
  const chunks = useMemo(() => textChunks(text), [text]);
  return (
    <FlatList
      data={chunks}
      keyExtractor={(_, i) => String(i)}
      renderItem={({ item }) => (
        <Text selectable style={{ color: colors.ink, fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 }}>{item}</Text>
      )}
      contentContainerStyle={{ padding: 16 }}
      ListFooterComponent={truncated ? <Notice text="只显示前 1MB，完整内容请保存后查看" /> : null}
    />
  );
}

function Notice({ text }) {
  const { colors } = useTheme();
  return <Text style={{ color: colors.ink2, fontSize: 12, lineHeight: 18, paddingHorizontal: 16, paddingVertical: 8 }}>{text}</Text>;
}

function Content({ kind, file, name }) {
  const { colors } = useTheme();
  const [text, setText] = useState(null);
  const truncated = (file.size ?? 0) > TEXT_PREVIEW_BYTES;
  const readsText = kind === 'text' || kind === 'markdown';

  useEffect(() => {
    if (!readsText) return;
    try { setText(readTextHead(file)); } catch { setText(''); }
  }, [file, readsText]);

  if (readsText && text === null) return <ActivityIndicator style={{ flex: 1 }} color={colors.ink3} />;
  if (kind === 'html') {
    return (
      <>
        <Notice text="只支持单文件 HTML，同目录的图片和脚本无法加载" />
        <SandboxedPage uri={file.uri} html />
      </>
    );
  }
  if (kind === 'pdf') return <SandboxedPage uri={file.uri} html={false} />;
  if (kind === 'image') return <ZoomableImage source={{ uri: file.uri }} label={name} />;
  if (kind === 'markdown') {
    return (
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <MarkdownView text={text} />
        {truncated ? <Notice text="只显示前 1MB，完整内容请保存后查看" /> : null}
      </ScrollView>
    );
  }
  return <TextContent text={text} truncated={truncated} />;
}

function Centered({ children }) {
  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 }}>{children}</View>;
}

function ActionButton({ label, onPress }) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity accessibilityRole="button" onPress={onPress}
      style={{ minHeight: 44, paddingHorizontal: 24, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent }}>
      <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600' }}>{label}</Text>
    </TouchableOpacity>
  );
}

// phase: loading 取文件信息 / ready 等用户确认下载 / downloading / done / error
export function FilePreview({ sessionId, path, onClose }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState('loading');
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [file, setFile] = useState(null);
  const session = useRef(null);

  const kind = meta ? previewKindFor(meta, Platform.OS) : 'none';

  const share = useCallback(async (target, info) => {
    try {
      if (!(await Sharing.isAvailableAsync())) { toast('当前设备不支持分享', 'error'); return; }
      await Sharing.shareAsync(target.uri, { mimeType: info.mime.split(';')[0], dialogTitle: info.name });
    } catch { toast('保存失败', 'error'); }
  }, []);

  const download = useCallback(async (info, { shareAfter = false } = {}) => {
    const current = session.current;
    setPhase('downloading');
    setProgress(0);
    const dir = new Directory(Paths.cache, 'file-preview', String(Date.now()));
    current.dir = dir;
    try {
      dir.create({ intermediates: true, idempotent: true });
      const { url, headers } = fileContentRequest(sessionId, info.path);
      const task = File.createDownloadTask(url, new File(dir, tempFileName(info.name)), {
        headers,
        // 后台会话不保证立即开始，预览时用户在等结果
        sessionType: 'foreground',
        onProgress: ({ bytesWritten, totalBytes }) => {
          if (current.alive) setProgress(totalBytes > 0 ? bytesWritten / totalBytes : 0);
        },
      });
      current.task = task;
      const saved = await task.downloadAsync();
      if (!current.alive) { removeTemp(dir); return; }
      setFile(saved);
      setPhase('done');
      if (shareAfter) await share(saved, info);
    } catch {
      removeTemp(dir);
      if (!current.alive) return;
      setError('下载失败，请重试');
      setPhase('error');
    }
  }, [sessionId, share]);

  useEffect(() => {
    const current = { alive: true, task: null, dir: null };
    session.current = current;
    // 上次预览时 App 被杀掉会留下临时文件，这里顺手清掉
    removeTemp(new Directory(Paths.cache, 'file-preview'));
    fetchFileMeta(sessionId, path).then((info) => {
      if (!current.alive) return;
      setMeta(info);
      if (autoDownloads(previewKindFor(info, Platform.OS), info.sizeBytes)) download(info);
      else setPhase('ready');
    }).catch((e) => {
      if (!current.alive) return;
      setError(fileErrorText(e.code));
      setPhase('error');
    });
    return () => {
      current.alive = false;
      current.task?.cancel();
      if (current.dir) removeTemp(current.dir);
    };
  }, [sessionId, path, download]);

  const large = kind !== 'none';
  return (
    <Modal visible animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.line }}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="关闭预览" onPress={onClose}
            style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={20} color={colors.ink} />
          </TouchableOpacity>
          <Text numberOfLines={1} style={{ flex: 1, textAlign: 'center', color: colors.ink, fontSize: 15, fontWeight: '600' }}>
            {meta?.name || path.split('/').pop()}
          </Text>
          {phase === 'done' ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel="保存或分享" onPress={() => share(file, meta)}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="share" size={20} color={colors.ink} />
            </TouchableOpacity>
          ) : <View style={{ width: 44 }} />}
        </View>

        {phase === 'loading' ? <Centered><ActivityIndicator color={colors.ink3} /></Centered> : null}
        {phase === 'error' ? (
          <Centered><Text style={{ color: colors.ink2, fontSize: 15, textAlign: 'center' }}>{error}</Text></Centered>
        ) : null}
        {phase === 'ready' ? (
          <Centered>
            <Text style={{ color: colors.ink, fontSize: 15, textAlign: 'center' }}>{meta.name}</Text>
            <Text style={{ color: colors.ink2, fontSize: 13, textAlign: 'center' }}>
              {fmtBytes(meta.sizeBytes)} · {large ? '文件较大，确认后再下载' : '这个文件无法预览'}
            </Text>
            <ActionButton label="下载" onPress={() => download(meta, { shareAfter: !large })} />
          </Centered>
        ) : null}
        {phase === 'downloading' ? (
          <Centered>
            <Text style={{ color: colors.ink2, fontSize: 13 }}>正在下载 {Math.round(progress * 100)}%</Text>
            <View style={{ alignSelf: 'stretch', height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: 'hidden' }}>
              <View style={{ width: `${Math.round(progress * 100)}%`, height: 4, backgroundColor: colors.accent }} />
            </View>
            <TouchableOpacity accessibilityRole="button" onPress={onClose} style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 16 }}>
              <Text style={{ color: colors.ink2, fontSize: 15 }}>取消</Text>
            </TouchableOpacity>
          </Centered>
        ) : null}
        {phase === 'done' && kind !== 'none' ? (
          <View style={{ flex: 1 }}><Content kind={kind} file={file} name={meta.name} /></View>
        ) : null}
        {phase === 'done' && kind === 'none' ? (
          <Centered>
            <Text style={{ color: colors.ink, fontSize: 15, textAlign: 'center' }}>{meta.name}</Text>
            <ActionButton label="保存" onPress={() => share(file, meta)} />
          </Centered>
        ) : null}
      </View>
    </Modal>
  );
}
