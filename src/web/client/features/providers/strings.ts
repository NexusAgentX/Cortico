import { pick } from '../../core/language.ts';

const zh = {
  pageTitle: '语言模型',
  pageIntro: '模型供应模块与实例。连接、模型档位、报价与授权都由各模块自己声明。',
  modulesAria: '供应模块',
  needHost: '这一页需要内核装配的 provider 宿主。',
  loading: '读取供应模块…',
  none: '没有已注册的供应模块。',
  navLabel: '语言模型',
  navGroup: '系统',
};

const en: typeof zh = {
  pageTitle: 'LLM',
  pageIntro: 'Model provider modules and instances. Connection, model tiers, pricing and authorization are declared by each module.',
  modulesAria: 'Provider modules',
  needHost: 'This page needs the provider host assembled by the kernel.',
  loading: 'Loading provider modules…',
  none: 'No provider modules registered.',
  navLabel: 'LLM',
  navGroup: 'System',
};

export const S = pick({ zh, en });
