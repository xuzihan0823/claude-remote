import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import Animated, { FadeIn as EnterFade, FadeOut as ExitFade, useReducedMotion } from 'react-native-reanimated';
import { baseUrl } from '../../../web/core/api.js';
import { useTheme } from '../theme.js';
import { BloomSpark, measureSpark } from '../components/Spark.js';
import { ConnForm } from '../components/ConnForm.js';
import { FadeIn } from '../components/FadeIn.js';
import { Icon } from '../components/Icon.js';
import { QrScanner } from '../components/QrScanner.js';
import { haptics } from '../lib/haptics.js';
import { setHandoff, takeIntro } from '../lib/intro.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (base) => String(base || '').replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '');

// 登录 / 配对页。
//   选择：芒星绽放 + 标题，主按钮「扫码连接」（App 内相机），次按钮「输入地址和令牌」
//   连接中：按钮淡出，芒星不转，各光束像星星闪烁一样轻微伸缩，下方「正在连接 xxx…」
//   成功：变绿「已连接」+ 触感，标题淡出，把芒星位置交给首页（intro.setHandoff），首页芒星从这里滑过去
//   失败：芒星左右抖一下 + 错误文案，回到原来的按钮
// onSubmit(base, token, opts) / onScan(bases, token, opts) 由 App 提供，opts.beforeCommit 在探测成功、
// 切到首页之前调用，用来播放上面的成功衔接。
export function ConnectScreen({ busy, error, onSubmit, onScan }) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  // 冷启动带 token 自动重连时（busy）不抢开屏，留给首页绽放
  const [intro] = useState(() => !busy && !reduceMotion && takeIntro());
  const [view, setView] = useState('choose'); // choose | manual
  const [scanOpen, setScanOpen] = useState(false);
  const [phase, setPhase] = useState('idle'); // idle | connecting | success | leaving
  const [target, setTarget] = useState('');
  const [shake, setShake] = useState(0);
  const sparkRef = useRef(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // 冷启动自动重连（App 在 auth=checking 时传 busy）也显示连接中
  const connecting = phase === 'connecting' || (busy && phase === 'idle');
  const showForm = phase === 'idle' && !busy;

  const beforeCommit = async () => {
    if (!mounted.current) return;
    setPhase('success');
    haptics.success();
    await sleep(reduceMotion ? 150 : 480);
    if (!mounted.current) return;
    setPhase('leaving');
    await sleep(reduceMotion ? 0 : 200);
    if (!reduceMotion) setHandoff(await measureSpark(sparkRef));
  };

  const run = async (label, fn) => {
    setTarget(label);
    setPhase('connecting');
    const ok = await fn({ beforeCommit });
    if (!ok && mounted.current) {
      setPhase('idle');
      setShake((n) => n + 1);
      haptics.error();
    }
  };

  const submitManual = (base, tok) => run(hostOf(base || baseUrl), (opts) => onSubmit(base, tok, opts));
  const submitScan = ({ token: tok, bases }) => run(hostOf(bases?.[0]), (opts) => onScan(bases, tok, opts));

  const statusText = phase === 'success' || phase === 'leaving'
    ? `已连接 ${target}`.trim()
    : `正在连接${target ? ` ${target}` : ''}…`;
  const statusColor = phase === 'success' || phase === 'leaving' ? colors.ok : colors.ink2;
  const titleHidden = phase === 'leaving';

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top,
          paddingBottom: insets.bottom + 16,
          paddingHorizontal: 24,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flex: view === 'manual' ? 0 : 1, minHeight: view === 'manual' ? 0 : 340, alignItems: 'center', justifyContent: 'center', paddingTop: view === 'manual' ? 36 : 0 }}>
          <View ref={sparkRef} collapsable={false}>
            <BloomSpark size={view === 'manual' ? 44 : 60} play={intro} busy={connecting} shake={shake} />
          </View>
          <View style={{ alignItems: 'center', opacity: titleHidden ? 0 : 1 }}>
            <FadeIn play={intro} delay={550}>
              <Text style={{ color: colors.inkStrong, fontFamily: fonts.serif, fontSize: view === 'manual' ? 24 : 30, marginTop: 18, letterSpacing: -0.4 }}>
                Claude Remote
              </Text>
            </FadeIn>
            {view === 'choose' ? (
              <FadeIn play={intro} delay={650}>
                <Text style={{ color: colors.ink2, fontSize: 15, marginTop: 8 }}>连接你 Mac 上的 Claude Code</Text>
              </FadeIn>
            ) : null}
            <View style={{ minHeight: 44, justifyContent: 'center' }}>
              {connecting || phase === 'success' || phase === 'leaving' ? (
                <Animated.Text entering={EnterFade.duration(250)} style={{ color: statusColor, fontSize: 13.5 }}>
                  {phase === 'success' || phase === 'leaving' ? '✓ ' : ''}{statusText}
                </Animated.Text>
              ) : error ? (
                <Text style={{ color: colors.danger, fontSize: 13.5, textAlign: 'center' }}>{error}</Text>
              ) : null}
            </View>
          </View>
        </View>

        {showForm && view === 'choose' ? (
          <Animated.View exiting={ExitFade.duration(200)} style={{ gap: 12, paddingBottom: 8 }}>
            <FadeIn play={intro} delay={800} dy={14}>
              <TouchableOpacity
                onPress={() => setScanOpen(true)}
                activeOpacity={0.85}
                accessibilityRole="button"
                style={{ flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent, borderRadius: 26, paddingVertical: 15 }}
              >
                <Icon name="scan" size={20} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '500' }}>扫码连接</Text>
              </TouchableOpacity>
            </FadeIn>
            <FadeIn play={intro} delay={880} dy={14}>
              <TouchableOpacity
                onPress={() => setView('manual')}
                activeOpacity={0.7}
                accessibilityRole="button"
                style={{ alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 26, paddingVertical: 14 }}
              >
                <Text style={{ color: colors.ink, fontSize: 15.5 }}>输入地址和令牌</Text>
              </TouchableOpacity>
            </FadeIn>
            <FadeIn play={intro} delay={960} dy={0}>
              <Text style={{ color: colors.ink3, fontSize: 12, textAlign: 'center', marginTop: 18, lineHeight: 18 }}>
                {'在 Mac 上运行 '}
                <Text style={{ fontFamily: fonts.mono, color: colors.ink2 }}>cr</Text>
                {'，按 p 显示配对二维码\n手机和 Mac 需在同一 Tailscale 或局域网'}
              </Text>
            </FadeIn>
          </Animated.View>
        ) : null}

        {showForm && view === 'manual' ? (
          <Animated.View entering={EnterFade.duration(250)} exiting={ExitFade.duration(200)} style={{ marginTop: 8 }}>
            <View style={{ backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 20, padding: 18 }}>
              <ConnForm initBase={baseUrl} initToken="" busy={false} submitLabel="连接" onSubmit={submitManual} />
            </View>
            <TouchableOpacity onPress={() => setView('choose')} style={{ alignSelf: 'center', paddingVertical: 14 }} hitSlop={{ top: 6, bottom: 6, left: 10, right: 10 }}>
              <Text style={{ color: colors.ink2, fontSize: 14 }}>← 返回扫码</Text>
            </TouchableOpacity>
          </Animated.View>
        ) : null}
      </ScrollView>
      <QrScanner visible={scanOpen} onClose={() => setScanOpen(false)} onResult={submitScan} />
    </KeyboardAvoidingView>
  );
}
