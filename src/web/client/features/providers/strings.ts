import { pick } from '../../core/language.ts';

const zh = {
  pageTitle: 'Provider',
  pageIntro: '模型供应模块与实例。连接、模型档位、报价与授权都由各模块自己声明。',
  modulesAria: 'Provider 模块',
  needHost: '这一页需要内核装配的 provider 宿主。',
  loading: '读取 Provider 模块…',
  none: '没有已注册的 Provider 模块。',
  navLabel: 'Provider',
  navGroup: '系统',
};

const en: typeof zh = {
  pageTitle: 'Provider',
  pageIntro: 'Model provider worlds and instances. Connection, model tiers, pricing and authorization are declared by each module.',
  modulesAria: 'Provider worlds',
  needHost: 'This page needs the provider host assembled by the kernel.',
  loading: 'Loading provider worlds…',
  none: 'No provider worlds registered.',
  navLabel: 'Provider',
  navGroup: 'System',
};

export const S = pick({ zh, en });
