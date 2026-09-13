import { pick } from '../../core/language.ts';

const zh = {
  pageTitle: '运行参数',
  pageIntro: '框架自己的机械旋钮。Persona与各 World 的参数在它们各自的页面上。',
  sheetTitle: '机械参数',
  sheetDesc: '每一组都由拥有那些参数的人自己声明（JSON Schema），控制台按声明通用渲染。'
    + '**这一页放没有归属页的那些**——World 的旋钮在 World 自己那一页，Persona的在人格页，'
    + '外加声明方指定放回这里的（如上下文交接阈值）。'
    + '**改了就存**：一改动就写回 config.json，重启后保留。标「重启生效」的要重启才热生效，其余立即。',
  loading: '加载中…',
  allClaimed: '(所有参数都已归到各自的页面上——World 的在 World 页，Persona的在人格页)',
  navLabel: '运行参数',
  optionCurrent: '(当前)',
  ownerPersona: 'Persona',
  chooseFile: '选择文件',
  chooseDirectory: '选择目录',
  recommendedDir: (dir: string) => `推荐目录：${dir}`,
  download: '下载',
  on: '开启',
  leaveBlank: '留空',
  saving: '保存中…',
  saveFailed: (err: string) => '失败: ' + err,
  emptyDefault: '(这里没有参数——各方的旋钮都在各自的页面上)',
  noSchema: '(服务端未挂载配置项声明)',
  restartWorld: '重启 World 生效',
  restartProcess: '重启生效',
  loadFailed: (err: string) => '配置项加载失败: ' + err,
};

const en: typeof zh = {
  pageTitle: 'Runtime parameters',
  pageIntro: 'The framework\'s own mechanical knobs. Persona and World parameters live on their own pages.',
  sheetTitle: 'Mechanical parameters',
  sheetDesc: 'Each group is declared by whoever owns those parameters (JSON Schema); the console renders it generically.'
    + ' **This page holds the groups without a home page** — World knobs are on the World\'s page, Persona knobs on the persona page,'
    + ' plus the ones their owner explicitly sends back here (such as the context handoff threshold).'
    + ' **Changes save immediately**: every edit is written back to config.json and survives a restart. Items marked "takes effect after restart" need a restart; the rest apply at once.',
  loading: 'Loading…',
  allClaimed: '(All parameters have moved to their own pages — World knobs on the World pages, Persona on the persona page)',
  navLabel: 'Runtime parameters',
  optionCurrent: '(current)',
  ownerPersona: 'Persona',
  chooseFile: 'Choose file',
  chooseDirectory: 'Choose directory',
  recommendedDir: (dir: string) => `Recommended directory: ${dir}`,
  download: 'Download',
  on: 'On',
  leaveBlank: 'Leave blank',
  saving: 'Saving…',
  saveFailed: (err: string) => 'Failed: ' + err,
  emptyDefault: '(No parameters here — every owner\'s knobs are on its own page)',
  noSchema: '(The server has no config schema mounted)',
  restartWorld: 'takes effect after World restart',
  restartProcess: 'takes effect after restart',
  loadFailed: (err: string) => 'Failed to load config: ' + err,
};

export const S = pick({ zh, en });
