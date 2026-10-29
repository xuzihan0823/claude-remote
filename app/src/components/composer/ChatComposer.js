import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, fetchModels, getSessionModel, modelSelection, setSessionModel } from '../../../../web/core/api.js';
import { toast } from '../../../../web/core/bus.js';
import { useModelCatalog } from '../../lib/useModelCatalog.js';
import { useTheme } from '../../theme.js';
import { Icon } from '../Icon.js';
import { ComposerActions } from './ComposerActions.js';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { ComposerCard } from './ComposerCard.js';
import { AttachmentChips } from './AttachmentChips.js';
import { AttachmentPicker } from './AttachmentPicker.js';
import { ModelPicker } from './ModelPicker.js';
import { haptics } from '../../lib/haptics.js';
import { tooLargeMessage, uploadAttachments, withAttachmentNote } from '../../lib/attachments.js';

// 聊天 composer（发送/停止/附件/模型 pill/模式 pill/bypass 确认）。
// 契约（不得更改）：props { sessionId, status, isRunning, activeRunId, mode, onModeChange, onSent, onStopped }
// 可选 prop：onStatusConflict(status) -- 409 占用时回传最新 status 给父层（ChatScreen 未接时可空）。
// 可选 prop：onRunMismatch(activeRunId, status) -- 停止请求过期时同步服务端当前运行。
// 可选 prop：onSending(text) -- 点发送即触发（早于上传/POST），父层先显示待发送气泡；
//           onSendFailed() -- 发送失败，父层撤掉该气泡（输入框文字会自动回填）。
// onSent(text, runId, context) 在 POST 成功后触发，context 来自 onSending。
// 行为照抄 web/ui/screens/chat.js 的 composer 部分；视觉对齐 ios-ui-redesign 浮岛 24px 圆角。
export function ChatComposer({
  sessionId, status, isRunning, activeRunId, mode, onModeChange, onSent, onStopped, onStatusConflict,
  onRunMismatch, onSending, onSendFailed,
}) {
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const catalog = useModelCatalog();
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(null); // { done, total }
  const [modelOverride, setModelOverride] = useState(() => getSessionModel(sessionId));
  const pickModel = useCallback((m) => { setModelOverride(m); setSessionModel(sessionId, m); }, [sessionId]);
  const [inputH, setInputH] = useState(36);
  const lastH = useRef(36);
  const [stopping, setStopping] = useState(false);
  const activeRunIdRef = useRef(activeRunId);
  activeRunIdRef.current = activeRunId;
  const stopContext = useRef(0);
  useEffect(() => {
    setStopping(false);
    return () => { stopContext.current += 1; };
  }, [sessionId, isRunning, activeRunId]);

  const canSend = status === 'idle' && !isRunning && !stopping && !sendBusy;
  const hasContent = draft.trim() !== '' || files.length > 0;
  const disabledReason = sendBusy ? (uploadProgress && uploadProgress.done < uploadProgress.total
      ? `上传附件 ${uploadProgress.done + 1}/${uploadProgress.total}…` : '发送中…')
    : status === 'terminal-driving' ? '正在终端上使用，暂不可发送'
    : status === 'daemon-driving' ? 'Claude 正在运行…'
    : status == null ? '状态获取中…' : '';

  const stopRun = useCallback(async () => {
    if (!isRunning || stopping) return;
    const requestedRunId = activeRunId || null;
    const context = stopContext.current;
    setStopping(true);
    try {
      const r = await api(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
        method: 'POST',
        body: JSON.stringify({ runId: requestedRunId || undefined }),
      });
      // 上一轮的迟到响应不得改变新一轮；无 runId 的旧客户端保留原兼容语义
      if (context !== stopContext.current || activeRunIdRef.current !== requestedRunId) return;
      haptics.reject();
      if (r?.status === 'aborted') {
        // 200 只表示停止已受理，真正空闲以对应 run 的终态/status 帧为准
        toast('正在停止当前运行…', 'info');
        return;
      }
      setStopping(false);
      onStopped?.();
      if (r?.sessionStatus) onStatusConflict?.(r.sessionStatus);
      toast('运行已结束', 'info');
    } catch (e) {
      if (context !== stopContext.current || activeRunIdRef.current !== requestedRunId) return;
      if (e.code === 'run_mismatch') {
        setStopping(false);
        onRunMismatch?.(e.data?.activeRunId ?? null, e.data?.status || 'daemon-driving');
        toast('当前已是新一轮运行', 'info');
        return;
      }
      setStopping(false);
      if (e.code === 'no_active_run' || e.code === 'already_finished') {
        onStopped?.();
        toast('运行已结束', 'info');
      } else if (e.code !== 'unauthorized') {
        toast(`停止失败：${e.code}`, 'error');
      }
    }
  }, [sessionId, activeRunId, isRunning, stopping, onStopped, onStatusConflict, onRunMismatch]);

  // 终端占用误判（如上一轮报错后 CLI 收尾写入）时的手动出口：daemon 无 run 时 abort = 解除占用
  const releaseSession = useCallback(async () => {
    try {
      const context = stopContext.current;
      const r = await api(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', body: '{}' });
      if (context !== stopContext.current) return;
      haptics.reject();
      if (r?.status === 'aborted') {
        onRunMismatch?.(r.runId, 'daemon-driving');
        setStopping(true);
        toast('正在停止当前运行…', 'info');
      } else {
        onStopped?.();
        toast('已解除占用', 'info');
      }
    } catch (e) {
      if (e.code !== 'unauthorized') toast(`解除失败：${e.code}`, 'error');
    }
  }, [sessionId, onStopped, onRunMismatch]);

  const doSend = useCallback(async () => {
    if (!hasContent || !canSend) return;
    if (modelSelection(catalog, modelOverride).status === 'unavailable') {
      toast('所选模型已不可用，请重新选择', 'error');
      return;
    }
    setSendBusy(true);
    const typed = draft;
    const shown = draft.trim();
    const context = onSending?.(shown);
    if (shown) setDraft('');
    try {
      // 先传附件（存到 Mac 本地），再把路径写进消息文本让 Claude 直接读；失败重试不会重复上传
      const uploaded = await uploadAttachments(files, `/api/sessions/${encodeURIComponent(sessionId)}/upload`, {
        onProgress: (done, total) => setUploadProgress({ done, total }),
      });
      const text = withAttachmentNote(draft.trim(), uploaded);
      const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text,
          ...(modelOverride ? { model: modelOverride } : {}),
          ...(mode !== 'default' ? { permissionMode: mode } : {}),
        }),
      });
      onSent?.(text, result.runId, context);
      haptics.success();
      setFiles([]);
    } catch (e) {
      haptics.error();
      if (shown) { setDraft((d) => d || typed); onSendFailed?.(); }
      if (e.status === 409) {
        onStatusConflict?.(e.data?.status || null);
        const why = e.data?.status === 'terminal-driving' ? '会话正在终端上使用'
          : e.data?.status === 'daemon-driving' ? 'Claude 正在运行' : '会话被占用';
        toast(`${why}，发送被拒`, 'error');
      } else if (e.status === 413) {
        toast(tooLargeMessage(e), 'error');
      } else if (e.code === 'unknown_model') {
        toast('该模型已不可用，请重新选择', 'error');
        fetchModels().catch(() => {});
      } else if (e.code === 'connection_changed') {
        toast('连接已切换，请重新发送', 'info');
      } else if (e.code !== 'unauthorized') {
        toast(`发送失败：${e.code}`, 'error');
      }
    } finally { setSendBusy(false); setUploadProgress(null); }
  }, [draft, files, hasContent, canSend, sessionId, catalog, modelOverride, mode, onSent, onStatusConflict, onSending, onSendFailed]);

  const onContentSizeChange = (e) => {
    const h = Math.min(Math.max(Math.ceil(e.nativeEvent.contentSize.height), 36), 132);
    if (h !== lastH.current) { lastH.current = h; setInputH(h); }
  };

  const removeFile = (i) => setFiles((xs) => xs.filter((_, idx) => idx !== i));

  // 跟键盘走用平移而非改 padding：键盘动画期间不触发整页重排（ChatScreen 列表同步用 contentInset 让位）。
  // 键盘打开时少移一个底部安全区间距，卡片正好贴住键盘；底色挡住列表滚到输入框四周缝隙里的内容
  const padBottom = Math.max(insets.bottom, 8);

  return (
    <KeyboardStickyView
      offset={{ opened: padBottom }}
      style={{ paddingLeft: Math.max(insets.left, 16), paddingRight: Math.max(insets.right, 16), paddingTop: 8, backgroundColor: colors.bg }}
    >
      <View style={{ paddingBottom: padBottom }}>
      {/* 发送中不出这一行：它只存在几百毫秒，一进一出会让输入框高度跳两次 */}
      {!canSend && !isRunning && !sendBusy && disabledReason ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 6, gap: 8 }}>
          <Text style={{ color: colors.ink3, fontSize: 13, flex: 1 }}>{disabledReason}</Text>
          {status === 'terminal-driving' && !sendBusy ? (
            <TouchableOpacity onPress={releaseSession} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }} accessibilityLabel="解除占用">
              <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '500' }}>解除占用</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      <ComposerCard disabled={!canSend}>
        <AttachmentChips files={files} onRemove={removeFile} />
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          // 始终可编辑：不可编辑会让 iOS 收起键盘，发送那一刻整页重排（跳动）。能否发送由发送按钮控制
          editable
          placeholder={canSend ? '回复 Claude…' : disabledReason}
          placeholderTextColor={colors.ink2}
          accessibilityLabel="消息"
          keyboardAppearance={dark ? 'dark' : 'light'}
          onContentSizeChange={onContentSizeChange}
          style={{
            height: inputH,
            color: colors.inkStrong,
            fontSize: 17,
            lineHeight: 24,
            textAlignVertical: 'top',
            paddingHorizontal: 2,
            paddingVertical: 0,
            marginTop: 4,
          }}
        />
        <ComposerActions
          attachment={<AttachmentPicker disabled={!canSend} onPicked={(items) => setFiles((xs) => [...xs, ...items])} />}
          model={<ModelPicker value={modelOverride} onChange={pickModel} catalog={catalog} />}
          mode={null}
          action={isRunning ? (
            <TouchableOpacity
              onPress={stopRun}
              disabled={stopping}
              accessibilityRole="button"
              accessibilityState={{ disabled: stopping, busy: stopping }}
              accessibilityLabel={stopping ? '正在停止' : '停止生成'}
              style={{
                width: 44, height: 44, borderRadius: 22,
                backgroundColor: colors.inkStrong,
                alignItems: 'center', justifyContent: 'center',
                opacity: stopping ? 0.5 : 1,
              }}
            >
              {stopping ? <ActivityIndicator size="small" color={colors.bg} /> : <Icon name="stop" color={colors.bg} />}
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={doSend}
              disabled={!canSend || !hasContent}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSend || !hasContent }}
              accessibilityLabel="发送"
              style={{
                width: 44, height: 44, borderRadius: 22,
                backgroundColor: colors.inkStrong,
                alignItems: 'center', justifyContent: 'center',
                opacity: (!canSend || !hasContent) ? 0.4 : 1,
              }}
            >
              <Icon name="send" color={colors.bg} />
            </TouchableOpacity>
          )}
        />
      </ComposerCard>
      </View>
    </KeyboardStickyView>
  );
}
