import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createSession } from '../../lib/create-session.js';
import { tooLargeMessage } from '../../lib/attachments.js';
import { usePref } from '../../lib/prefs.js';
import { toast } from '../../../../web/core/bus.js';
import { setSessionMode } from '../../../../web/core/modes.js';
import { fetchModels, modelSelection, setSessionModel } from '../../../../web/core/api.js';
import {
  effortSelection,
  resolveDeviceKey,
  setSessionEffort,
} from '../../../../web/core/effort.js';
import { useModelCatalog } from '../../lib/useModelCatalog.js';
import { useModelCapabilities } from '../../lib/useModelCapabilities.js';
import { useTheme } from '../../theme.js';
import { Icon } from '../Icon.js';
import { ComposerActions } from './ComposerActions.js';
import { KeyboardLift } from './KeyboardLift.js';
import { ComposerCard } from './ComposerCard.js';
import { AttachmentChips } from './AttachmentChips.js';
import { AttachmentPicker } from './AttachmentPicker.js';
import { ModelPicker } from './ModelPicker.js';

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
  const { capabilities, reload: reloadCapabilities, applyServerCapabilities } = useModelCapabilities({
    cwd: cwd && cwdKnown ? cwd : '',
    model,
  });
  const [effortRecord, setEffortRecord] = useState(() => ({
    effort: '',
    model: '',
    revision: '',
    deviceId: resolveDeviceKey(),
    stale: false,
  }));
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [inputH, setInputH] = useState(44);
  const lastH = useRef(44);

  useEffect(() => {
    if (!effortRecord.effort || effortRecord.stale || effortRecord.revision) return;
    if (!capabilities?.loaded || !capabilities.revision) return;
    const sel = effortSelection(capabilities, effortRecord, { model });
    if (sel.canSend) {
      setEffortRecord((prev) => (
        prev.effort && !prev.revision && !prev.stale
          ? { ...prev, model, revision: capabilities.revision, deviceId: resolveDeviceKey() }
          : prev
      ));
    }
  }, [capabilities, effortRecord, model]);

  const pickEffort = useCallback((nextEffort) => {
    setEffortRecord({
      effort: nextEffort || '',
      model,
      revision: nextEffort ? (capabilities?.revision || '') : '',
      deviceId: resolveDeviceKey(),
      stale: false,
    });
  }, [model, capabilities?.revision]);

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
    let effortCheck = effortSelection(capabilities, effortRecord, { model, deviceId: resolveDeviceKey() });
    if (!effortCheck.canSend) {
      toast(effortCheck.message || '所选思考程度当前不可用，请重新选择', 'error');
      return;
    }
    setBusy(true);
    try {
      if (effortRecord.effort) {
        const latest = await reloadCapabilities();
        if (!latest || latest.error) { toast('无法确认思考配置，请重试或恢复默认', 'error'); return; }
        effortCheck = effortSelection(latest, effortRecord, { model, deviceId: resolveDeviceKey() });
        if (!effortCheck.canSend) { toast(effortCheck.message, 'error'); return; }
      }
      const { result, body } = await createSession({
        cwd,
        text,
        model,
        effort: effortCheck.sendEffort,
        mode,
        files,
      });
      setSessionMode(result.sessionId, mode);
      setSessionModel(result.sessionId, model);
      setSessionEffort(result.sessionId, {
        effort: effortCheck.sendEffort || '',
        model,
        revision: capabilities?.revision || effortRecord.revision || '',
      });
      onCreated?.(result, body);
      setDraft('');
      setFiles([]);
      setModelChoice(null);
      setEffortRecord({
        effort: '',
        model: '',
        revision: '',
        deviceId: resolveDeviceKey(),
        stale: false,
      });
    } catch (e) {
      if (e.status === 409) toast('所选项目当前不可创建新会话', 'error');
      else if (e.status === 413) toast(tooLargeMessage(e), 'error');
      else if (e.code === 'unknown_model') { toast('该模型已不可用，请重新选择', 'error'); fetchModels().catch(() => {}); }
      else if (e.code === 'unsupported_effort') {
        toast(
          e.data?.capabilities?.thinkingEnabled === false
            ? '本机已关闭思考，请将思考程度恢复为默认'
            : '当前模型不支持所选思考程度，请重新选择',
          'error',
        );
        applyServerCapabilities(e.data?.capabilities);
      } else if (e.code === 'invalid_effort') {
        toast('思考程度参数无效，请重新选择', 'error');
      } else if (e.code === 'unknown_cwd') toast('该项目已不可用，请刷新后重试', 'error');
      else if (e.code === 'connection_changed') toast('连接已切换，请在当前连接重新发送', 'info');
      else if (e.code !== 'unauthorized') toast(`新建失败：${e.code}`, 'error');
    } finally { setBusy(false); }
  }, [draft, cwd, cwdKnown, catalog, model, capabilities, effortRecord, mode, busy, files, onCreated, applyServerCapabilities, reloadCapabilities]);

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
          attachment={<AttachmentPicker disabled={busy} onPicked={(items) => setFiles((xs) => [...xs, ...items])} />}
          model={(
            <ModelPicker
              value={model}
              onChange={setModelChoice}
              catalog={catalog}
              effortRecord={effortRecord}
              onEffortChange={pickEffort}
              capabilities={capabilities}
              onOpen={() => { reloadCapabilities(); fetchModels().catch(() => {}); }}
              onRefreshCapabilities={() => { reloadCapabilities({ refresh: true }); fetchModels().catch(() => {}); }}
            />
          )}
          mode={null}
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
