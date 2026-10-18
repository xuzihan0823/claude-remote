import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { api } from '../../../../web/core/api.js';
import { toast } from '../../../../web/core/bus.js';
import { getNewSessionMode, setNewSessionMode, setSessionMode } from '../../../../web/core/modes.js';
import { useModelCatalog } from '../../lib/useModelCatalog.js';
import { useTheme } from '../../theme.js';
import { Icon } from '../Icon.js';
import { ComposerActions } from './ComposerActions.js';
import { ComposerCard } from './ComposerCard.js';
import { AttachmentChips } from './AttachmentChips.js';
import { AttachmentPicker } from './AttachmentPicker.js';
import { ModelPicker } from './ModelPicker.js';
import { ModePill } from './ModePill.js';
import { ModeSheet } from './ModeSheet.js';

// 新建会话 composer：cwd = projects[0]（web 同款，无项目选择 UI）；
// 附件走 /api/upload（新建会话专用端点），POST /api/sessions {cwd, text, model?, permissionMode?}；
// 成功 setSessionMode(result.sessionId, mode) + onCreated(result, body)。对应 web/ui/components/composer.js。
export function NewChatComposer({ projects, onCreated }) {
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const catalog = useModelCatalog();
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState('');
  const [mode, setMode] = useState(getNewSessionMode);
  const [modeOpen, setModeOpen] = useState(false);
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [inputH, setInputH] = useState(44);
  const lastH = useRef(44);

  const cwd = projects && projects.length ? projects[0] : '';

  const create = useCallback(async () => {
    let text = draft.trim();
    if (!text || !cwd || busy) return;
    setBusy(true);
    try {
      if (files.length) {
        const uploaded = [];
        for (const f of files) {
          const blob = await (await fetch(f.uri)).blob();
          const r = await api(`/api/upload?filename=${encodeURIComponent(f.name)}`, {
            method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' },
          });
          uploaded.push(r.path);
        }
        text = `${text}\n\n[手机端上传的附件，已保存在本机，可直接读取]\n${uploaded.map((p) => `- ${p}`).join('\n')}`;
      }
      const body = { cwd, text, ...(model ? { model } : {}), ...(mode !== 'default' ? { permissionMode: mode } : {}) };
      const result = await api('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
      setSessionMode(result.sessionId, mode);
      onCreated?.(result, body);
      setDraft('');
      setFiles([]);
    } catch (e) {
      if (e.status === 409) toast('所选项目当前不可创建新会话', 'error');
      else if (e.status === 413) toast('附件过大（上限 25MB）', 'error');
      else if (e.code === 'unknown_model') toast('该模型已不可用，请重新选择', 'error');
      else if (e.code === 'unknown_cwd') toast('该项目已不可用，请刷新后重试', 'error');
      else if (e.code !== 'unauthorized') toast(`新建失败：${e.code}`, 'error');
    } finally { setBusy(false); }
  }, [draft, cwd, model, mode, busy, files, onCreated]);

  const onContentSizeChange = (e) => {
    const h = Math.min(Math.max(Math.ceil(e.nativeEvent.contentSize.height), 44), 150);
    if (h !== lastH.current) { lastH.current = h; setInputH(h); }
  };

  const canSend = !busy && draft.trim() !== '' && !!cwd;

  // 见 ChatComposer 同处注释：安全区间距放子层，避免被 KAV 动画样式在键盘收起时清零。
  // automaticOffset 必开：KAV 默认拿 onLayout 的 y（相对父容器≈0）当屏幕坐标，
  // 停在屏幕底部的 composer 会被算成"离键盘很远"而抬升 0（真机被键盘整个盖住）。
  const padBottom = Math.max(insets.bottom, 12);

  return (
    <KeyboardAvoidingView
      behavior="padding"
      automaticOffset
      keyboardVerticalOffset={-padBottom}
      style={{ paddingLeft: Math.max(insets.left, 16), paddingRight: Math.max(insets.right, 16), paddingTop: 8 }}
    >
      <View style={{ paddingBottom: padBottom }}>
      <ComposerCard disabled={busy}>
        <AttachmentChips files={files} onRemove={(i) => setFiles((xs) => xs.filter((_, idx) => idx !== i))} />
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          editable={!busy}
          placeholder="今天想做什么？"
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
          attachment={<AttachmentPicker disabled={busy} onPicked={(items) => setFiles((xs) => [...xs, ...items])} />}
          model={<ModelPicker value={model} onChange={setModel} catalog={catalog} />}
          mode={<ModePill mode={mode} onOpen={() => setModeOpen(true)} />}
          action={<TouchableOpacity
            onPress={create}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSend, busy }}
            accessibilityLabel="创建会话并发送"
            style={{
              width: 44, height: 44, borderRadius: 22,
              backgroundColor: colors.inkStrong,
              alignItems: 'center', justifyContent: 'center',
              opacity: !canSend ? 0.4 : 1,
            }}
          >
            {busy ? (
              <ActivityIndicator color={colors.bg} size="small" />
            ) : (
              <Icon name="send" color={colors.bg} />
            )}
          </TouchableOpacity>}
        />
      </ComposerCard>
      {files.length > 0 ? (
        <Text style={{ color: colors.ink3, fontSize: 11, marginTop: 6, textAlign: 'center' }}>
          附件将随首条消息一起发送。
        </Text>
      ) : null}
      </View>
      <ModeSheet
        open={modeOpen}
        mode={mode}
        onSelect={(m) => { setMode(m); setNewSessionMode(m); setModeOpen(false); }}
        onClose={() => setModeOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}
