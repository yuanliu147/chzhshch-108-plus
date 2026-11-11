// antd 主题：暗色算法 + 沿用交易终端调色板，保证 antd 控件与自定义视觉同源。
import { theme } from 'antd';
import type { ThemeConfig } from 'antd';

export const 主题: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#4c8dff',
    colorInfo: '#4c8dff',
    colorSuccess: '#2fd08c',
    colorWarning: '#ffb020',
    colorError: '#ff5c5c',
    colorBgBase: '#0f1420',
    colorBgContainer: '#171e2e',
    colorBgElevated: '#1f2840',
    colorBgLayout: '#0f1420',
    colorBorder: '#2a3550',
    colorBorderSecondary: '#22304a',
    colorText: '#d7deef',
    colorTextSecondary: '#8b96b3',
    colorTextTertiary: '#6b7694',
    colorTextQuaternary: '#4d5878',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: '-apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
    colorLink: '#4c8dff',
    controlHeight: 30,
  },
  components: {
    Button: { primaryShadow: 'none', defaultShadow: 'none', fontWeight: 500 },
    Select: { optionSelectedBg: 'rgba(76,141,255,0.18)' },
    Segmented: { itemSelectedBg: '#4c8dff', itemSelectedColor: '#ffffff', trackBg: '#1f2840' },
    Slider: { trackBg: '#4c8dff', trackHoverBg: '#7fb0ff', handleColor: '#4c8dff', railBg: '#2a3550' },
    Tabs: { itemSelectedColor: '#4c8dff', inkBarColor: '#4c8dff' },
    Tag: { defaultBg: '#1f2840', defaultColor: '#8b96b3' },
    Tooltip: { colorBgSpotlight: '#1f2840' },
  },
};