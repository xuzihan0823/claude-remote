import { useCallback, useEffect, useMemo, useState } from 'react';
import { Keyboard, ScrollView, Text, TouchableOpacity, TouchableWithoutFeedback, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { cacheSessions, fetchSessions, pendingSessionMessages } from '../../../web/core/api.js';
import { useBus } from '../../../web/core/bus.js';
import { ws } from '../../../web/core/ws.js';
import { truncate } from '../lib/format.js';
import { ConversationHeader } from '../components/ConversationHeader.js';
import { Spark } from '../components/Spark.js';
import { NewChatComposer } from '../components/composer/NewChatComposer.js';
import { useTheme } from '../theme.js';

// 移植 web/ui/screens/home.js 的 StartScreen：问候居中 + 底部 composer 浮岛。
export function HomeScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const hour = new Date().getHours();
  const greet = hour < 5 ? '夜深了。' : hour < 12 ? '早上好。' : hour < 18 ? '下午好。' : '晚上好。';

  const [data, setData] = useState({ sessions: [], total: 0 });
  const [error, setError] = useState('');

  const load = useCallback(async (silent = false) => {
    try { setData(await fetchSessions(500)); setError(''); }
    catch (e) { if (e.code !== 'unauthorized') setError(e.code === 'network_error' ? '网络不可达' : `加载失败：${e.code}`); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useBus('ws-open', () => load(true), [load]);
  useBus('ws:status', ({ sessionId, status }) => {
    setData((d) => ({ ...d, sessions: d.sessions.map((s) => (s.sessionId === sessionId ? { ...s, status } : s)) }));
  }, []);

  const sessions = useMemo(() => [...data.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt), [data]);
  const projects = useMemo(() => [...new Set(sessions.map((s) => s.cwd).filter(Boolean))], [sessions]);

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
    navigation.navigate('Chat', { sessionId: result.sessionId });
  }, [navigation]);

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
      <ConversationHeader />

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 24 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Spark size={48} style={{ marginBottom: 20 }} />
        <Text style={{ color: colors.inkStrong, fontSize: 32, fontWeight: '400', letterSpacing: -0.8 }}>{greet}</Text>
        <Text style={{ color: colors.ink2, fontSize: 15, marginTop: 12 }}>在手机上，继续你的工作。</Text>
      </ScrollView>

      <View>
        {error ? (
          <TouchableOpacity onPress={() => load()} style={{ paddingHorizontal: 20, paddingBottom: 6 }}>
            <Text style={{ color: colors.danger, fontSize: 13, textAlign: 'center' }}>{error} · 点击重试</Text>
          </TouchableOpacity>
        ) : null}
        <NewChatComposer projects={projects} onCreated={created} />
      </View>
    </View>
    </TouchableWithoutFeedback>
  );
}
