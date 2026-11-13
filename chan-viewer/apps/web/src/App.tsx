import { useEffect } from 'react';
import { Alert, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useStore } from './store.ts';
import { terminalTheme } from './theme.ts';
import { TopBar } from './components/TopBar.tsx';
import { LearnMode } from './modes/LearnMode.tsx';
import { CompareMode } from './modes/CompareMode.tsx';
import { PracticeMode } from './modes/PracticeMode.tsx';
import { TerminalMode } from './modes/TerminalMode.tsx';

export function App() {
  const mode = useStore((s) => s.mode);
  const error = useStore((s) => s.error);
  const load = useStore((s) => s.load);

  useEffect(() => {
    const { code, adjust } = useStore.getState();
    void load(code, adjust);
  }, [load]);

  return (
    <ConfigProvider locale={zhCN} theme={terminalTheme}>
      <div className="app">
        <TopBar />
        {error && <Alert type="error" banner message={error} />}
        {mode === 'learn' && <LearnMode />}
        {mode === 'compare' && <CompareMode />}
        {mode === 'practice' && <PracticeMode />}
        {mode === 'multi' && <TerminalMode />}
      </div>
    </ConfigProvider>
  );
}