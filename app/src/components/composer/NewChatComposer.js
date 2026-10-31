import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createSession } from '../../lib/create-session.js';
import { tooLargeMessage } from '../../lib/attachments.js';
import { usePref } from '../../lib/prefs.js';
import { haptics } from '../../lib/haptics.js';
import { toast } from '../../../../web/core/bus.js';
import { setSessionMode } from '../../../../web/core/modes.js';
import { token, fetchModels, modelSelection, setSessionModel } from '../../../../web/core/api.js';
import { effortLabel, effortUsable, setSessionEffort } from '../../../../web/core/effort.js';
import { useModelCatalog } from '../../lib/useModelCatalog.js';
import { useEffortLevels } from '../../lib/useEffortLevels.js';
import { useTheme } from '../../theme.js';
import { Icon } from '../Icon.js';
import { ComposerActions } from './ComposerActions.js';
import { KeyboardLift } from './KeyboardLift.js';
import { ComposerCard } from './ComposerCard.js';
import { AttachmentChips } from './AttachmentChips.js';
import { AttachmentPicker } from './AttachmentPicker.js';
import { ModelPicker } from './ModelPicker.js';
import { EffortPicker } from './EffortPicker.js';

// 新建会话 composer：cwd 由父层显式传入（目录入口在顶栏三点菜单；未选目录时点发送也会调 onPickCwd），不做隐式回退；
// 附件走 /api/upload（新建会话专用端点），POST /api/sessions {cwd, text, model?, effort?, permissionMode?}；
// 成功 setSessionMode + setSessionModel + setSessionEffort + onCreated(result, body)。
export function NewChatComposer({ cwd, cwdLabel, cwdKnown = true, onPickCwd, onDraftChange, onCreated, mode }) {
  const { colors, dark } = useTheme();
  const insets = useSafeAreaInsets();
  const catalog = useModelCatalog();
  const [draft, setDraft] = useState('');
  const defaultModel = usePref('defaultModel') || '';
  // null = 本次草稿没手动选过，跟随设置里的默认模型；'' = 手动选了「跟随项目默认」
  const [modelChoice, setModelChoice] = useState(null);
  const model = modelChoice ?? defaultModel;
  const { options: effortOptions, reload: reloadEffortLevels } = useEffortLevels({ cwd: cwd && cwdKnown ? cwd : '', model });
  const [effort, setEffort] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [inputH, setInputH] = useState(44);
  const lastH = useRef(44);

  const createRequest = useRef(null);
  const [effortOpen, setEffortOpen] = useState(false);
  const openEffort = useCallback(() => {
    reloadEffortLevels();
    setEffortOpen(true);
  }, [reloadEffortLevels]);
  const effortOk = effortUsable(effortOptions, effort);
  const effortMenuItem = {
    key: 'effort',
    icon: 'brain',
    label: '思考程度',
    detail: effortLabel(effort),
    detailTone: effortOk ? undefined : 'danger',
    onPress: openEffort,
  };

  const hasDraft = draft.trim() !== '' || files.length > 0;
  useEffect(() => {
    onDraftChange?.(hasDraft);
    return () => onDraftChange?.(false);
  }, [hasDraft, onDraftChange]);

  const create = useCallback(async () => {
    const text = draft.trim() || (files.length ? '请查看我上传的附件。' : '');
    if (!text || !cwd || !cwdKnown || busy) return;
    if (modelSelection(catalog, model).status === 'unavailable') {
      toast('所选模型已不可用，请重新选择', 'error');
      return;
    }
    if (!effortOk) {
      toast(`当前模型不支持思考程度「${effortLabel(effort)}」，请重新选择`, 'error');
      return;
    }
    setBusy(true);
    haptics.confirm();
    const key = JSON.stringify({ cwd, text, model, effort, mode, files: files.map((f) => f.uri) });
    if (createRequest.current?.key !== key || createRequest.current?.token !== token) createRequest.current = { key, token };
    try {
      const { result, body } = await createSession({
        cwd,
        text,
        model,
        effort,
        mode,
        files,
        request: createRequest.current,
      });
      setSessionMode(result.sessionId, mode);
      setSessionModel(result.sessionId, model);
      setSessionEffort(result.sessionId, effort);
      onCreated?.(result, body);
      setDraft('');
      setFiles([]);
      setModelChoice(null);
      setEffort('');
      createRequest.current = null;
    } catch (e) {
      if (e.code !== 'connection_changed' && e.code !== 'unauthorized') haptics.error();
      if (e.status === 409) toast('所选项目当前不可创建新会话', 'error');
      else if (e.status === 413) toast(tooLargeMessage(e), 'error');
      else if (e.code === 'unknown_model') { toast('该模型已不可用，请重新选择', 'error'); fetchModels().catch(() => {}); }
      else if (e.code === 'invalid_effort') toast('思考程度参数无效，请重新选择', 'error');
      else if (e.code === 'unknown_cwd') toast('该项目已不可用，请刷新后重试', 'error');
      else if (e.code === 'connection_changed') toast('连接已切换，请在当前连接重新发送', 'info');
      else if (e.code !== 'unauthorized') toast(`新建失败：${e.code}`, 'error');
    } finally { setBusy(false); }
  }, [draft, cwd, cwdKnown, catalog, model, effort, effortOk, mode, busy, files, onCreated]);

  const onContentSizeChange = (e) => {
    const h = Math.min(Math.max(Math.ceil(e.nativeEvent.contentSize.height), 44), 150);
    if (h !== lastH.current) { lastH.current = h; setInputH(h); }
  };

  const canSend = !busy && (draft.trim() !== '' || files.length > 0);
  const needsCwd = !cwd || !cwdKnown;
  const onSendPress = () => {
    if (needsCwd) { onPickCwd?.(); return; }
    create();
  };

  // 见 ChatComposer 同处注释：安全区间距放子层，避免被 KeyboardLift 的动画 padding 覆盖。
  const padBottom = Math.max(insets.bottom, 12);

  return (
    <KeyboardLift
      innerPad={padBottom}
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
          attachment={<AttachmentPicker disabled={busy} onPicked={(items) => setFiles((xs) => [...xs, ...items])} extraItems={[effortMenuItem]} />}
          model={(
            <ModelPicker
              value={model}
              onChange={setModelChoice}
              catalog={catalog}
              onOpen={() => { fetchModels().catch(() => {}); }}
            />
          )}
          mode={(
            <EffortPicker
              open={effortOpen}
              onOpen={openEffort}
              onClose={() => setEffortOpen(false)}
              effort={effort}
              options={effortOptions}
              onPick={setEffort}
            />
          )}
          action={<TouchableOpacity
            onPress={onSendPress}
            disabled={!canSend}
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSend, busy }}
            accessibilityLabel={needsCwd ? '选择工作目录后发送' : '创建会话并发送'}
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
    </KeyboardLift>
  );
}
