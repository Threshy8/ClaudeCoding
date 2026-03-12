import { createContext, useContext } from 'react';

export const DemoModeContext = createContext(false);

export function useDemoMask() {
  const demoMode = useContext(DemoModeContext);
  return {
    demoMode,
    mc: (val) => demoMode ? '$••••' : val,
    mn: (val) => demoMode ? '••' : val,
    mp: (val) => demoMode ? '••%' : `${val}%`,
    mname: (name) => {
      if (!demoMode || !name || name === '—') return name || '—';
      const parts = name.trim().split(/\s+/);
      return parts.length > 1 ? parts[0] + ' ••••' : '••••';
    },
  };
}
