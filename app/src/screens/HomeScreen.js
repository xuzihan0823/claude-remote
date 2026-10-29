import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, ScrollView, Text, TouchableOpacity, TouchableWithoutFeedback, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute } from '@react-navigation/native';
import { cacheSessions, pendingSessionMessages } from '../../../web/core/api.js';
import { getNewSessionMode, setNewSessionMode } from '../../../web/core/modes.js';
import { useBus } from '../../../web/core/bus.js';
import { ws } from '../../../web/core/ws.js';
import { truncate } from '../lib/format.js';
import { useProjects } from '../lib/projects-context.js';
import { isKnownCwd, pathTail, projectForCwd, projectTitles } from '../lib/projects.js';
import { ConversationHeader } from '../components/ConversationHeader.js';
import { Icon } from '../components/Icon.js';
import { ProjectPicker } from '../components/ProjectPicker.js';
import { useReducedMotion } from 'react-native-reanimated';
import { BloomSpark } from '../components/Spark.js';
import { FadeIn } from '../components/FadeIn.js';
import { introDelay, takeHandoff, takeIntro } from '../lib/intro.js';
import { NewChatComposer } from '../components/composer/NewChatComposer.js';
import { useTheme } from '../theme.js';

// 移植 web/ui/screens/home.js 的 StartScreen：问候居中 + 底部 composer 浮岛。
// 新建目标 cwd 来自共享项目上下文（显式选择 / 抽屉所选项目 / 从会话继承），不取 projects[0]。
export function HomeScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute();
  const hour = new Date().getHours();
  const greet = hour < 5 ? '夜深了。' : hour < 12 ? '早上好。' : hour < 18 ? '下午好。' : '晚上好。';

  // 冷启动第一次进入首页时播放开屏：芒星原位绽放，其余元素依次渐入（系统开了「减弱动态效果」则跳过）
  const reduceMotion = useReducedMotion();
  // 刚在登录页连接成功：芒星从登录页的位置滑过来（不再二次绽放），其余元素更早渐入
  const [glideFrom] = useState(() => (reduceMotion ? null : takeHandoff()));
  const [intro] = useState(() => (takeIntro() || !!glideFrom) && !reduceMotion);
  // 滑入模式整体提前；冷启动时再整体推后，等原生启动屏淡出
  const [d0] = useState(() => (glideFrom ? -350 : introDelay()));

  const { catalog, catalogLoaded, catalogError, target, setTarget, inheritCwd, noteCreated, setDraftActive, refresh } = useProjects();
  const [mode, setMode] = useState(getNewSessionMode);
  useBus('new-session-mode', setMode, []);
  const pickerRef = useRef(null);
  const openPicker = useCallback((anc) => { Keyboard.dismiss(); pickerRef.current?.present(anc); }, []);

  // 从会话页「新建」带来的实际 cwd；nonce 保证同一 cwd 重复进入也生效
  const fromNonce = route.params?.nonce;
  useEffect(() => {
    if (fromNonce) inheritCwd(route.params?.fromCwd || '');
  }, [fromNonce]);

  const isHome = !!catalog.homeCwd && target === catalog.homeCwd;
  const owner = projectForCwd(catalog.projects, target);
  const ownerTitle = owner ? projectTitles(catalog.projects).get(owner.id) : '';
  const cwdLabel = !target ? '' : isHome
    ? '主目录 (~)'
    : owner && owner.cwds.length > 1
      ? `${ownerTitle} · ${pathTail(target, 1)}`
      : ownerTitle || pathTail(target);
  // 目录未加载成功时交给服务端白名单校验，避免网络抖动把可用目标判成不可用
  const cwdKnown = !catalogLoaded || isHome || isKnownCwd(catalog.projects, target);

  const created = useCallback((result, body) => {
    const summary = {
      sessionId: result.sessionId,
      cwd: body.cwd,
      title: truncate(body.text, 60),
      lastPreview: truncate(body.text, 80),
      lastActiveAt: Date.now(),
      sizeBytes: 0,
      status: 'daemon-driving',
    };
    cacheSessions([summary]);
    pendingSessionMessages.set(result.sessionId, body.text);
    ws.subscribe(result.sessionId);
    setDraftActive(false);
    noteCreated(summary);
    navigation.navigate('Chat', { sessionId: result.sessionId, fromNew: true });
  }, [navigation, noteCreated, setDraftActive]);

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
      <FadeIn play={intro} delay={800 + d0} dy={-6}>
      <ConversationHeader
        mode={mode}
        onModeChange={(m) => { setMode(m); setNewSessionMode(m); }}
        showModeSelector
        onPickCwd={openPicker}
        cwdLabel={target ? cwdLabel : ''}
        subtitle={catalogLoaded || target ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%' }}>
            <Icon name="folder" size={13} color={target && cwdKnown ? colors.ink3 : colors.danger} />
            <Text numberOfLines={1} ellipsizeMode="middle" style={{ flexShrink: 1, color: target && cwdKnown ? colors.ink2 : colors.danger, fontSize: 12.5 }}>
              {!target ? '未选择工作目录' : cwdKnown ? cwdLabel : `${cwdLabel}（不可用）`}
            </Text>
          </View>
        ) : null}
      />
      </FadeIn>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <BloomSpark size={48} play={intro && !glideFrom} delay={Math.max(0, d0)} glideFrom={glideFrom} style={{ marginBottom: 20 }} />
        <FadeIn play={intro} delay={600 + d0}>
          <Text style={{ color: colors.inkStrong, fontSize: 32, fontWeight: '400', letterSpacing: -0.8 }}>{greet}</Text>
        </FadeIn>
        <FadeIn play={intro} delay={700 + d0}>
          <Text style={{ color: colors.ink2, fontSize: 15, marginTop: 12 }}>在手机上，继续你的工作。</Text>
        </FadeIn>
      </ScrollView>

      <FadeIn play={intro} delay={850 + d0} dy={18} duration={420}>
        {catalogError && !catalogLoaded ? (
          <TouchableOpacity onPress={refresh} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 20, paddingBottom: 6 }}>
            <Text style={{ color: colors.danger, fontSize: 13, textAlign: 'center' }}>{catalogError} · 点击重试</Text>
          </TouchableOpacity>
        ) : null}
        <NewChatComposer
          cwd={target}
          cwdLabel={cwdLabel}
          cwdKnown={cwdKnown}
          onPickCwd={openPicker}
          onDraftChange={setDraftActive}
          onCreated={created}
          mode={mode}
        />
      </FadeIn>
      <ProjectPicker
        sheetRef={pickerRef}
        variant="target"
        catalog={catalog}
        value={target}
        onPick={setTarget}
        loaded={catalogLoaded}
        error={catalogError}
        onRetry={refresh}
      />
    </View>
    </TouchableWithoutFeedback>
  );
}
