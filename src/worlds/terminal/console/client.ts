import type { ConsoleClientBundle } from '../../../web/shared/client-panel.ts';
import { chatPanel } from './chat.ts';

const bundle: ConsoleClientBundle = {
  panels: {
    chat: chatPanel,
  },
};

export default bundle;
