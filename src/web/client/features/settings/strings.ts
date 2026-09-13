import { pick } from '../../core/language.ts';

const zh = {
  general: '通用',
  generalDesc: '控制台语言偏好。',
  language: '界面语言 / Language',
  languageDesc: '仅保存在当前浏览器，刷新页面后生效。',
  reloadTitle: '切换界面语言？',
  reloadBody: '页面将刷新，未保存的编辑会丢失。Bot 将继续运行。',
  appearance: '外观',
  appearanceDesc: '控制台主题、明暗模式与自定义配色。',
  runtime: '运行参数',
  runtimeDesc: '框架自己的热更新参数。Persona与各 World 的旋钮在它们各自的页面上。',
  prompts: '系统提示词',
  promptsDesc: '所有固定前缀源的统一管理入口。',
  firstturn: '首轮对话',
  firstturnDesc: '合成的第一轮对话来回(风格锚):只进请求不落盘,内容为空时不注入。',
  storage: '存储',
  storageDesc: '落盘与内存数据的规模和生命周期操作。',
  pageTitle: '设置',
  pageIntro: '控制台与 bot 运行面的统一配置。各项按归属分节，不占用侧栏导航。',
  sectionsAria: '设置分区',
  navLabel: '设置',
};

const en: typeof zh = {
  general: 'General',
  generalDesc: 'Console language preferences.',
  language: '界面语言 / Language',
  languageDesc: 'Saved in this browser; takes effect after reloading.',
  reloadTitle: 'Change interface language?',
  reloadBody: 'The page will reload and unsaved edits will be lost. The bot will keep running.',
  appearance: 'Appearance',
  appearanceDesc: 'Console theme, light/dark mode and custom palettes.',
  runtime: 'Runtime parameters',
  runtimeDesc: 'The framework\'s own hot-reloadable parameters. Persona and World knobs live on their own pages.',
  prompts: 'System prompt',
  promptsDesc: 'One place to manage every fixed prefix source.',
  firstturn: 'First turn',
  firstturnDesc: 'A synthesized first exchange (style anchor): request-only, never persisted to disk, not injected when empty.',
  storage: 'Storage',
  storageDesc: 'Size and lifecycle operations for persisted and in-memory data.',
  pageTitle: 'Settings',
  pageIntro: 'Unified configuration for the console and the bot runtime. Sections are grouped by owner and stay out of the sidebar.',
  sectionsAria: 'Settings sections',
  navLabel: 'Settings',
};

export const S = pick({ zh, en });
