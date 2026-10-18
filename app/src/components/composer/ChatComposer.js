import { useCallback, useRef, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { api } from '../../../../web/core/api.js';
import { toast } from '../../../../web/core/bus.js';
import { useModelCatalog } from '../../lib/useModelCatalog.js';
import { useTheme } from '../../theme.js';
import { Icon } from '../Icon.js';
import { ComposerActions } from './ComposerActions.js';
import { ComposerCard } from './ComposerCard.js';
import { AttachmentChips } from './AttachmentChips.js';
import { AttachmentPicker } from './AttachmentPicker.js';
import { ModelPicker } from './ModelPicker.js';

// 聊天 composer（发送/停止/附件/模型 pill/模式 pill/bypass 确认）。
// 契约（不得更改）：props { sessionId, status, isRunning, activeRunId, mode, onModeChange, onSent, onStopped }
// 可选 prop：onStatusConflict(status) -- 409 占用时回传最新 status 给父层（ChatScreen 未接时可空）。
// 行为照抄 web/ui/screens/chat.js 的 composer 部分；视觉对齐 ios-ui-redesign 浮岛 24px 圆角。
export function ChatComposer({
  sessionId, status, isRunning, activeRunId, mode, onModeChange, onSent, onStopped, onStatusConflict,
}) {
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const catalog = useModelCatalog();
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [modelOverride, setModelOverride] = useState('');
  const [inputH, setInputH] = useState(36);
  const lastH = useRef(36);

  const canSend = status === 'idle' && !sendBusy;
  const hasContent = draft.trim() !== '' || files.length > 0;
  const disabledReason = sendBusy ? '发送中…'
    : status === 'terminal-driving' ? '终端驾驶中，暂不可发送'
    : status === 'daemon-driving' ? 'Claude 正在运行…'
    : status == null ? '状态获取中…' : '';

  const stopRun = useCallback(async () => {
    if (!isRunning) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
        method: 'POST',
        body: JSON.stringify({ runId: activeRunId || undefined }),
      });
      onStopped?.();
      toast('已停止当前运行', 'info');
    } catch (e) {
      if (e.status === 404 || e.status === 409 || e.code === 'no_active_run' || e.code === 'already_finished') {
        onStopped?.();
        toast('运行已结束', 'info');
      } else if (e.code !== 'unauthorized') {
        toast(`停止失败：${e.code}`, 'error');
      }
    }
  }, [sessionId, activeRunId, isRunning, onStopped]);

  const doSend = useCallback(async () => {
    if (!hasContent || !canSend) return;
    setSendBusy(true);
    try {
      // 先传附件（存到 Mac 本地），再把路径写进消息文本让 Claude 直接读
      const uploaded = [];
      for (const f of files) {
        const blob = await (await fetch(f.uri)).blob();
        const r = await api(`/api/sessions/${encodeURIComponent(sessionId)}/upload?filename=${encodeURIComponent(f.name)}`, {
          method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' },
        });
        uploaded.push(r.path);
      }
      let text = draft.trim();
      if (uploaded.length) {
        const list = uploaded.map((p) => `- ${p}`).join('\n');
        text = `${text || '请查看我上传的附件。'}\n\n[手机端上传的附件，已保存在本机，可直接读取]\n${list}`;
      }
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          text,
          ...(modelOverride ? { model: modelOverride } : {}),
          ...(mode !== 'default' ? { permissionMode: mode } : {}),
        }),
      });
      onSent?.(text);
      setDraft('');
      setFiles([]);
    } catch (e) {
      if (e.status === 409) {
        onStatusConflict?.(e.data?.status || null);
        const why = e.data?.status === 'terminal-driving' ? '会话正被终端驾驶'
          : e.data?.status === 'daemon-driving' ? 'Claude 正在运行' : '会话被占用';
        toast(`${why}，发送被拒`, 'error');
      } else if (e.status === 413) {
        toast('附件过大（上限 25MB）', 'error');
      } else if (e.code !== 'unauthorized') {
        toast(`发送失败：${e.code}`, 'error');
      }
    } finally { setSendBusy(false); }
  }, [draft, files, hasContent, canSend, sessionId, modelOverride, mode, onSent, onStatusConflict]);

  const onContentSizeChange = (e) => {
    const h = Math.min(Math.max(Math.ceil(e.nativeEvent.contentSize.height), 36), 132);
    if (h !== lastH.current) { lastH.current = h; setInputH(h); }
  };

  const removeFile = (i) => setFiles((xs) => xs.filter((_, idx) => idx !== i));

  // 底部安全区间距必须放在 KAV 的子层：KAV(behavior=padding) 的动画样式排在 style 之后，
  // 会整体覆盖 paddingBottom——写在 KAV 自身上时键盘收起（progress=0）就被清零，输入框贴住 home indicator。
  // keyboardVerticalOffset=-padBottom 抵消内层静态间距，使键盘打开时总间距仍恰好等于键盘高度。
  // automaticOffset：让 KAV 用原生窗口坐标算自身位置（默认用相对父容器的 onLayout.y≈0，会算出抬升 0）。
  const padBottom = Math.max(insets.bottom, 8);

  return (
    <KeyboardAvoidingView
      behavior="padding"
      automaticOffset
      keyboardVerticalOffset={-padBottom}
      style={{ paddingLeft: Math.max(insets.left, 16), paddingRight: Math.max(insets.right, 16), paddingTop: 8 }}
    >
      <View style={{ paddingBottom: padBottom }}>
      {isRunning ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 6, gap: 8 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.info }} />
          <Text style={{ color: colors.ink2, fontSize: 13, flex: 1 }}>Claude 正在运行…</Text>
          <TouchableOpacity onPress={stopRun} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }} accessibilityLabel="停止运行">
            <Text style={{ color: colors.danger, fontSize: 13, fontWeight: '500' }}>停止</Text>
          </TouchableOpacity>
        </View>
      ) : null}
      {!canSend && !isRunning && disabledReason ? (
        <View style={{ paddingHorizontal: 4, paddingVertical: 6 }}>
          <Text style={{ color: colors.ink3, fontSize: 13 }}>{disabledReason}</Text>
        </View>
      ) : null}
      <ComposerCard disabled={!canSend}>
        <AttachmentChips files={files} onRemove={removeFile} />
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          editable={canSend}
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
          model={<ModelPicker value={modelOverride} onChange={setModelOverride} catalog={catalog} />}
          mode={null}
          action={isRunning ? (
            <TouchableOpacity
              onPress={stopRun}
              accessibilityRole="button"
              accessibilityLabel="停止生成"
              style={{
                width: 44, height: 44, borderRadius: 22,
                backgroundColor: colors.inkStrong,
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <Icon name="stop" color={colors.bg} />
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
    </KeyboardAvoidingView>
  );
}
